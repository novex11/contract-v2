import { serve, type ServerType } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { requestId } from "hono/request-id";
import { secureHeaders } from "hono/secure-headers";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { desc, sql, eq } from "drizzle-orm";
import * as jsonStore from "./store.js";
import * as dbStore from "./db-store.js";
import * as launchpadStore from "./launchpad-store.js";
import { createDb, type Db } from "./db.js";
import { ensureSchema } from "./migrate.js";
import { parseAbi } from "viem";
import { pairMetadataMessage, corsOrigins } from "@compose/config";
import { startChainListener } from "./chain-listener.js";
import { VerifyError, verifyDeposit, verifyRedeem } from "./basket-verify.js";
import { ensurePairIndexed, startLaunchpadIndexer } from "./launchpad-indexer.js";
import { chainId, composeCurveAddress, getPublicClient, pairFactoryAddress, vaultFactoryAddress } from "./chain-client.js";
import * as verificationStore from "./verification-store.js";
import { startMarkToMarket } from "./mark-to-market.js";
import {
  getVaults,
  initVaultRegistry,
  startVaultDiscovery,
  vaultRegistrySource,
} from "./vault-registry.js";
import { subscribePairSnapshots } from "./pair-live.js";
import { getPairCandles, isCandleInterval } from "./pair-candles.js";
import { ClaimError, getClaimedShares, recordCreatorClaim } from "./creator-claims.js";
import { startCurveIndexer } from "./curve-indexer.js";
import * as curveStore from "./curve-store.js";
import { subscribeTokenTrades } from "./pair-live.js";
import { CANDLE_INTERVALS } from "./pair-candles.js";
import { redisConfigured, getRedis, closeRedis } from "./redis.js";
import {
  storeImage,
  fetchImage,
  publicImageUrl,
  isValidImageId,
} from "./image-store.js";
import {
  swapEvents,
  depositEvents,
  redeemEvents,
  dailyVolume,
  tvlSnapshots,
} from "./schema.js";

await ensureSchema();

const db = createDb();
const useDb = db !== null;

if (useDb) {
  console.log("[indexer] PostgreSQL mode: DATABASE_URL configured");
} else {
  console.log("[indexer] JSON file mode: no DATABASE_URL");
}

const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY ?? "";

/*
 * Browser-submitted ledger writes. Only `wallet` + `txHash` (+ the cosmetic
 * allocation breakdown) are trusted from the client; every amount, the vault and
 * the Stockback paid are read back from the on-chain receipt in basket-verify.ts.
 */
const HexHash = z.string().regex(/^0x[0-9a-fA-F]{64}$/, "txHash must be a transaction hash");
const HexAddress = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "wallet must be an address");

const DepositSchema = z.object({
  wallet: HexAddress,
  txHash: HexHash,
  allocation: z
    .array(
      z.object({
        ticker: z.string().max(16),
        weight: z.number().min(0).max(1),
        usd: z.number().min(0),
      }),
    )
    .max(32)
    .default([]),
  // Accepted for backwards compatibility; ignored in favour of on-chain values.
  depositTicker: z.string().optional(),
  depositUsd: z.number().optional(),
  strategy: z.string().optional(),
  openingNetUsd: z.number().optional(),
  stockbackUsd: z.number().optional(),
  vaultId: z.string().optional(),
});

const RedeemSchema = z.object({
  wallet: HexAddress,
  txHash: HexHash,
  valueUsd: z.number().optional(),
  vaultId: z.string().optional(),
});

const TradeSchema = z.object({
  wallet: z.string().min(1),
  ticker: z.string().min(1).max(12),
  side: z.enum(["buy", "sell"]),
  qty: z.number().positive(),
  priceUsd: z.number().positive(),
  valueUsd: z.number().positive(),
  txHash: z.string().optional(),
});

// ─── Launchpad schemas ──────────────────────────────────

const LaunchpadMetadataSchema = z.object({
  pairAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  displayName: z.string().max(64).optional(),
  description: z.string().max(500).optional(),
  imageUrl: z.string().max(512).optional(),
  logoUrl: z.string().max(512).optional(),
  websiteUrl: z.string().max(512).optional(),
  numeraireTicker: z.string().max(12).optional(),
  issuedAt: z.string().min(1),
  signature: z.string().regex(/^0x[0-9a-fA-F]+$/),
});

type LaunchpadMetadataBody = z.infer<typeof LaunchpadMetadataSchema>;

const SIGNATURE_MAX_AGE_MS = 15 * 60 * 1000;
const pairVerifyAbi = parseAbi([
  "function isPair(address) view returns (bool)",
  "function creator() view returns (address)",
]);

/** Accept profile edits only when signed by the pair's on-chain creator (EOA or smart wallet). */
async function verifyPairMetadata(
  body: LaunchpadMetadataBody,
): Promise<{ ok: true } | { ok: false; status: 400 | 403 | 404 | 503; error: string }> {
  const client = getPublicClient();
  const factory = pairFactoryAddress();
  if (!client || !factory) {
    return { ok: false, status: 503, error: "Chain access is not configured on the indexer" };
  }
  const issued = Date.parse(body.issuedAt);
  if (!Number.isFinite(issued) || Math.abs(Date.now() - issued) > SIGNATURE_MAX_AGE_MS) {
    return { ok: false, status: 400, error: "Signature expired, please sign again" };
  }
  const pair = body.pairAddress as `0x${string}`;
  const isPair = await client.readContract({
    address: factory,
    abi: pairVerifyAbi,
    functionName: "isPair",
    args: [pair],
  });
  if (!isPair) return { ok: false, status: 404, error: "Not a pair launched by this factory" };
  const creator = await client.readContract({ address: pair, abi: pairVerifyAbi, functionName: "creator" });
  const valid = await client.verifyMessage({
    address: creator,
    message: pairMetadataMessage(body),
    signature: body.signature as `0x${string}`,
  });
  if (!valid) return { ok: false, status: 403, error: "Signature does not match the pair creator" };
  return { ok: true };
}

const app = new Hono();

// ─── Global middleware ──────────────────────────────────
app.use("/*", cors({ origin: corsOrigins() }));
app.use("/*", logger());
app.use("/*", requestId());
app.use(
  "/*",
  secureHeaders({
    // Images are loaded by the frontend on :3000 from the indexer on :3003.
    // Default CORP=same-origin blocks <img> with ERR_BLOCKED_BY_RESPONSE.NotSameOrigin.
    crossOriginResourcePolicy: "cross-origin",
  }),
);

// API key auth for write endpoints (skip health + read-only GETs)
app.use("/deposits", async (c, next) => {
  if (INTERNAL_API_KEY && c.req.header("x-api-key") !== INTERNAL_API_KEY) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  await next();
});
app.use("/redeems", async (c, next) => {
  if (INTERNAL_API_KEY && c.req.header("x-api-key") !== INTERNAL_API_KEY) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  await next();
});
app.use("/trades", async (c, next) => {
  if (INTERNAL_API_KEY && c.req.header("x-api-key") !== INTERNAL_API_KEY) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  await next();
});
app.use("/events/*", async (c, next) => {
  if (INTERNAL_API_KEY && c.req.header("x-api-key") !== INTERNAL_API_KEY) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  await next();
});

// ─── Global error handler ───────────────────────────────
app.onError((err, c) => {
  console.error(`[indexer] Unhandled error on ${c.req.method} ${c.req.path}:`, err);
  const message = err instanceof Error ? err.message : "Internal server error";
  return c.json({ error: message, requestId: c.get("requestId") }, 500);
});

app.get("/health", (c) =>
  c.json({
    status: "ok",
    service: "indexer",
    version: "3.0.0",
    storage: useDb ? "postgresql" : "json",
    imageStorage: redisConfigured() ? "redis" : "disabled",
    vaults: getVaults().length,
  }),
);

// Managed-basket vaults discovered from the VaultFactory (or the legacy env
// vault) so the web app can find them without per-vault env configuration.
app.get("/vaults", (c) =>
  c.json({
    source: vaultRegistrySource(),
    factory: vaultFactoryAddress() ?? null,
    vaults: getVaults().map((v) => ({
      vaultId: v.vaultId,
      vault: v.vault,
      receiptToken: v.receiptToken,
      depositAsset: v.depositAsset,
      depositTicker: v.depositTicker,
      strategy: v.strategy,
    })),
  }),
);

app.get("/wallet/:wallet/stockback-total", async (c) => {
  const wallet = c.req.param("wallet");
  const total = useDb
    ? await dbStore.getWalletStockbackTotal(db!, wallet)
    : jsonStore.getWalletStockbackTotal(wallet);
  return c.json({ wallet, totalStockbackUsd: total });
});

app.get("/portfolio/:wallet", async (c) => {
  const wallet = c.req.param("wallet");
  const portfolio = useDb
    ? await dbStore.getPortfolio(db!, wallet)
    : jsonStore.getPortfolio(wallet);
  if (!portfolio) {
    return c.json({
      wallet,
      currentValueUsd: 0,
      netPerformanceUsd: 0,
      totalStockbackUsd: 0,
      receiptBalance: "0",
      strategy: null,
      depositAsset: null,
      allocation: [],
      directHoldings: [],
      empty: true,
    });
  }
  return c.json(portfolio);
});

app.get("/holdings/:wallet", async (c) => {
  const wallet = c.req.param("wallet");
  const list = useDb
    ? await dbStore.getDirectHoldings(db!, wallet)
    : jsonStore.getDirectHoldings(wallet);
  return c.json({ wallet, holdings: list });
});

app.post("/trades", async (c) => {
  try {
    const body = await c.req.json();
    const parsed = TradeSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: parsed.error.flatten() }, 400);
    }
    const result = useDb
      ? await dbStore.recordTrade(db!, parsed.data)
      : jsonStore.recordTrade(parsed.data);
    return c.json({
      ok: true,
      holding: result.holding,
      activity: result.activity,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Trade failed";
    return c.json({ error: message }, 400);
  }
});

app.get("/activity/:wallet", async (c) => {
  const wallet = c.req.param("wallet");
  const records = useDb
    ? await dbStore.getActivity(db!, wallet)
    : jsonStore.getActivity(wallet);
  return c.json({ records });
});

app.get("/vault/:id", async (c) => {
  const id = c.req.param("id");
  const vault = useDb
    ? await dbStore.getVault(db!, id)
    : jsonStore.getVault(id);
  if (!vault) {
    return c.json({ error: "Vault not found" }, 404);
  }
  return c.json(vault);
});

app.post("/deposits", async (c) => {
  try {
    const body = await c.req.json();
    const parsed = DepositSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: parsed.error.flatten() }, 400);
    }
    const { wallet, txHash, allocation } = parsed.data;

    const verified = await verifyDeposit(txHash, wallet);
    const duplicate = useDb
      ? await dbStore.hasActivityTx(db!, txHash)
      : jsonStore.hasActivityTx(txHash);
    if (duplicate) {
      return c.json({ ok: true, duplicate: true, txHash });
    }

    const input = {
      wallet: verified.wallet,
      txHash: verified.txHash,
      depositTicker: verified.vault.depositTicker,
      depositUsd: verified.valueUsd,
      strategy: verified.vault.strategy,
      openingNetUsd: verified.valueUsd + verified.stockbackUsd,
      stockbackUsd: verified.stockbackUsd,
      allocation,
      vaultId: verified.vault.vaultId,
      sharesMinted: verified.sharesMinted,
    };
    const result = useDb
      ? await dbStore.recordDeposit(db!, input)
      : jsonStore.recordDeposit(input);
    return c.json({
      ok: true,
      position: result.position,
      activity: result.activity,
    });
  } catch (err) {
    if (err instanceof VerifyError) return c.json({ error: err.message }, err.status);
    const message = err instanceof Error ? err.message : "Deposit failed";
    return c.json({ error: message }, 500);
  }
});

app.post("/redeems", async (c) => {
  try {
    const body = await c.req.json();
    const parsed = RedeemSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: parsed.error.flatten() }, 400);
    }
    const { wallet, txHash } = parsed.data;

    const verified = await verifyRedeem(txHash, wallet);
    const duplicate = useDb
      ? await dbStore.hasActivityTx(db!, txHash)
      : jsonStore.hasActivityTx(txHash);
    if (duplicate) {
      return c.json({ ok: true, duplicate: true, txHash });
    }

    const input = {
      wallet: verified.wallet,
      valueUsd: verified.valueUsd,
      txHash: verified.txHash,
      vaultId: verified.vault.vaultId,
      remainingShares: verified.remainingShares,
    };
    const act = useDb
      ? await dbStore.recordRedeem(db!, input)
      : jsonStore.recordRedeem(input);
    return c.json({ ok: true, activity: act });
  } catch (err) {
    if (err instanceof VerifyError) return c.json({ error: err.message }, err.status);
    const message = err instanceof Error ? err.message : "Redeem failed";
    return c.json({ error: message }, 500);
  }
});

app.get("/multiplier-events", (c) => {
  const events = jsonStore.getMultiplierEvents();
  return c.json({ events });
});

// ─── Analytics API ──────────────────────────────────────

app.get("/analytics/volume", async (c) => {
  if (!useDb) return c.json({ error: "DB not configured" }, 503);
  const days = Number(c.req.query("days") ?? 30);
  const rows = await db!
    .select()
    .from(dailyVolume)
    .orderBy(desc(dailyVolume.date))
    .limit(days);
  const totalVolumeUsd = rows.reduce(
    (sum, r) =>
      sum +
      Number(r.volumeUsd) +
      Number(r.depositVolumeUsd) +
      Number(r.redeemVolumeUsd),
    0,
  );
  return c.json({
    totalVolumeUsd,
    days: rows.length,
    daily: rows.map((r) => ({
      date: r.date,
      volumeUsd: Number(r.volumeUsd),
      depositVolumeUsd: Number(r.depositVolumeUsd),
      redeemVolumeUsd: Number(r.redeemVolumeUsd),
      swapCount: Number(r.swapCount),
      depositCount: Number(r.depositCount),
      redeemCount: Number(r.redeemCount),
      uniqueWallets: Number(r.uniqueWallets),
    })),
  });
});

app.get("/analytics/tvl", async (c) => {
  if (!useDb) return c.json({ error: "DB not configured" }, 503);
  const latest = await db!
    .select()
    .from(tvlSnapshots)
    .orderBy(desc(tvlSnapshots.createdAt))
    .limit(1);
  if (!latest[0]) return c.json({ navUsd: 0, sharePrice: 0, totalShares: "0" });
  const row = latest[0];
  return c.json({
    vaultId: row.vaultId,
    navUsd: Number(row.navUsd),
    sharePrice: Number(row.sharePrice),
    totalShares: row.totalShares,
    snapshotAt: row.createdAt.toISOString(),
  });
});

app.get("/analytics/tvl/history", async (c) => {
  if (!useDb) return c.json({ error: "DB not configured" }, 503);
  const limit = Number(c.req.query("limit") ?? 100);
  const rows = await db!
    .select()
    .from(tvlSnapshots)
    .orderBy(desc(tvlSnapshots.createdAt))
    .limit(limit);
  return c.json({
    snapshots: rows.map((r) => ({
      navUsd: Number(r.navUsd),
      sharePrice: Number(r.sharePrice),
      totalShares: r.totalShares,
      vaultId: r.vaultId,
      timestamp: r.createdAt.toISOString(),
    })),
  });
});

app.get("/analytics/swaps", async (c) => {
  if (!useDb) return c.json({ error: "DB not configured" }, 503);
  const limit = Number(c.req.query("limit") ?? 50);
  const rows = await db!
    .select()
    .from(swapEvents)
    .orderBy(desc(swapEvents.createdAt))
    .limit(limit);
  return c.json({
    swaps: rows.map((r) => ({
      txHash: r.txHash,
      blockNumber: r.blockNumber,
      tokenIn: r.tokenIn,
      tokenOut: r.tokenOut,
      amountIn: r.amountIn,
      amountOut: r.amountOut,
      valueUsd: Number(r.valueUsd),
      timestamp: r.createdAt.toISOString(),
    })),
  });
});

app.get("/analytics/summary", async (c) => {
  if (!useDb) return c.json({ error: "DB not configured" }, 503);

  const [latestTvl] = await db!
    .select()
    .from(tvlSnapshots)
    .orderBy(desc(tvlSnapshots.createdAt))
    .limit(1);

  const today = new Date().toISOString().slice(0, 10);
  const [todayVol] = await db!
    .select()
    .from(dailyVolume)
    .where(eq(dailyVolume.date, today))
    .limit(1);

  const allTimeVol = await db!
    .select({
      total: sql<string>`COALESCE(SUM(CAST(volume_usd AS numeric) + CAST(deposit_volume_usd AS numeric) + CAST(redeem_volume_usd AS numeric)), 0)`,
      deposits: sql<string>`COALESCE(SUM(CAST(deposit_count AS numeric)), 0)`,
      redeems: sql<string>`COALESCE(SUM(CAST(redeem_count AS numeric)), 0)`,
      swaps: sql<string>`COALESCE(SUM(CAST(swap_count AS numeric)), 0)`,
    })
    .from(dailyVolume);

  return c.json({
    tvl: latestTvl
      ? {
          navUsd: Number(latestTvl.navUsd),
          sharePrice: Number(latestTvl.sharePrice),
        }
      : { navUsd: 0, sharePrice: 0 },
    todayVolume: todayVol
      ? {
          volumeUsd:
            Number(todayVol.volumeUsd) +
            Number(todayVol.depositVolumeUsd) +
            Number(todayVol.redeemVolumeUsd),
          depositCount: Number(todayVol.depositCount),
          redeemCount: Number(todayVol.redeemCount),
          swapCount: Number(todayVol.swapCount),
        }
      : { volumeUsd: 0, depositCount: 0, redeemCount: 0, swapCount: 0 },
    allTime: {
      totalVolumeUsd: Number(allTimeVol[0]?.total ?? 0),
      totalDeposits: Number(allTimeVol[0]?.deposits ?? 0),
      totalRedeems: Number(allTimeVol[0]?.redeems ?? 0),
      totalSwaps: Number(allTimeVol[0]?.swaps ?? 0),
    },
  });
});

// ─── Launchpad API ──────────────────────────────────────

/** Upload a pair cover image from the user's device (stored in Redis). */
app.post("/launchpad/upload-image", async (c) => {
  if (!redisConfigured()) {
    return c.json({ error: "Image storage not configured (set REDIS_* in .env)" }, 503);
  }
  try {
    const body = await c.req.parseBody({ all: true });
    const raw = body.file ?? body.image;
    if (!raw || typeof raw === "string") {
      return c.json({ error: "No file uploaded — use field name 'file'" }, 400);
    }

    const file = raw as File;
    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const contentType =
      file.type ||
      (file.name.endsWith(".png")
          ? "image/png"
          : file.name.endsWith(".webp")
            ? "image/webp"
            : file.name.endsWith(".gif")
              ? "image/gif"
              : "image/jpeg");

    const id = await storeImage(buffer, contentType);
    const imageUrl = publicImageUrl(id);
    return c.json({ ok: true, id, imageUrl });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Upload failed";
    const status =
      message.includes("not configured") ||
      message.includes("Redis unavailable")
        ? 503
        : 400;
    return c.json({ error: message }, status);
  }
});

/** Serve a stored pair cover image by id. */
app.get("/launchpad/images/:id", async (c) => {
  const id = c.req.param("id");
  if (!isValidImageId(id)) {
    return c.text("Not found", 404);
  }
  const img = await fetchImage(id);
  if (!img) {
    return c.text("Not found", 404);
  }
  return c.body(new Uint8Array(img.buffer), 200, {
    "Content-Type": img.contentType,
    "Cache-Control": "public, max-age=31536000, immutable",
    "Cross-Origin-Resource-Policy": "cross-origin",
    "Access-Control-Allow-Origin": "*",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'",
  });
});

async function saveMetadata(raw: unknown) {
  if (!useDb) return { status: 503 as const, body: { error: "DB not configured" } };
  const parsed = LaunchpadMetadataSchema.safeParse(raw);
  if (!parsed.success) return { status: 400 as const, body: { error: parsed.error.flatten() } };
  const verified = await verifyPairMetadata(parsed.data);
  if (!verified.ok) return { status: verified.status, body: { error: verified.error } };

  const pairAddress = parsed.data.pairAddress;
  if (!(await ensurePairIndexed(pairAddress as `0x${string}`))) {
    return { status: 404 as const, body: { error: "Pair not found" } };
  }
  const trim = (v?: string) => (v === undefined ? undefined : v.trim());
  const row = await launchpadStore.updatePairMetadata(db!, pairAddress, {
    displayName: trim(parsed.data.displayName),
    description: trim(parsed.data.description),
    imageUrl: trim(parsed.data.imageUrl),
    logoUrl: trim(parsed.data.logoUrl),
    websiteUrl: trim(parsed.data.websiteUrl),
    numeraireTicker: trim(parsed.data.numeraireTicker),
  });
  return { status: 200 as const, body: { ok: true, pair: row } };
}

/** Save a launched pair's profile (creator signature required). */
app.post("/launchpad/launch", async (c) => {
  const result = await saveMetadata(await c.req.json().catch(() => null));
  return c.json(result.body, result.status);
});

app.patch("/launchpad/pair/:address/metadata", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const result = await saveMetadata({ ...body, pairAddress: c.req.param("address") });
  return c.json(result.body, result.status);
});

app.get("/launchpad/pairs", async (c) => {
  if (!useDb) return c.json({ pairs: [] });
  const sort = c.req.query("sort") as "tvl" | "new" | "depositors" | undefined;
  const limit = Number(c.req.query("limit") ?? 100);
  const rows = await launchpadStore.listPairs(db!, {
    sort,
    limit,
    factoryAddress: pairFactoryAddress(),
  });
  return c.json({
    pairs: rows.map((r) => ({
      pairAddress: r.pairAddress,
      receiptAddress: r.receiptAddress,
      receiptSymbol: r.receiptSymbol,
      creatorWallet: r.creatorWallet,
      tickerA: r.tickerA,
      tickerB: r.tickerB,
      categoryA: r.categoryA,
      categoryB: r.categoryB,
      weightABps: Number(r.weightABps),
      creatorFeeBps: Number(r.creatorFeeBps),
      tvlUsd: Number(r.tvlUsd),
      totalDepositsUsd: Number(r.totalDepositsUsd),
      totalDepositors: Number(r.totalDepositors),
      creatorEarningsUsd: Number(r.creatorEarningsUsd),
      displayName: r.displayName ?? "",
      description: r.description ?? "",
      imageUrl: r.imageUrl ?? "",
      logoUrl: r.logoUrl ?? "",
      websiteUrl: r.websiteUrl ?? "",
      numeraireTicker: r.numeraireTicker ?? "",
      status: r.status,
      createdAt: r.createdAt.toISOString(),
    })),
  });
});

app.get("/launchpad/pair/:address", async (c) => {
  if (!useDb) return c.json({ error: "DB not configured" }, 503);
  const addr = c.req.param("address");
  const pair = await launchpadStore.getPair(db!, addr);
  if (!pair) return c.json({ error: "Pair not found" }, 404);
  const activity = await launchpadStore.getPairActivity(db!, addr);
  const verifications = await verificationStore.getVerifications(db!, [pair.pairAddress, pair.receiptAddress]);
  const verificationOf = (address: string) =>
    verificationStore.toVerificationJson(verifications.get(address.toLowerCase()) ?? null, chainId(), address);
  return c.json({
    pair: {
      pairAddress: pair.pairAddress,
      receiptAddress: pair.receiptAddress,
      receiptSymbol: pair.receiptSymbol,
      creatorWallet: pair.creatorWallet,
      tokenA: pair.tokenA,
      tokenB: pair.tokenB,
      tickerA: pair.tickerA,
      tickerB: pair.tickerB,
      categoryA: pair.categoryA,
      categoryB: pair.categoryB,
      weightABps: Number(pair.weightABps),
      creatorFeeBps: Number(pair.creatorFeeBps),
      tvlUsd: Number(pair.tvlUsd),
      totalDepositsUsd: Number(pair.totalDepositsUsd),
      totalDepositors: Number(pair.totalDepositors),
      creatorEarningsUsd: Number(pair.creatorEarningsUsd),
      displayName: pair.displayName ?? "",
      description: pair.description ?? "",
      imageUrl: pair.imageUrl ?? "",
      logoUrl: pair.logoUrl ?? "",
      websiteUrl: pair.websiteUrl ?? "",
      numeraireTicker: pair.numeraireTicker ?? "",
      status: pair.status,
      createdAt: pair.createdAt.toISOString(),
      /** Source-verification state of the vault and its share token (published automatically after launch). */
      verification: { vault: verificationOf(pair.pairAddress), receipt: verificationOf(pair.receiptAddress) },
    },
    activity: {
      deposits: activity.deposits.map((d) => ({
        wallet: d.wallet,
        valueUsd: Number(d.usdgAmount),
        amountA: d.amountA,
        amountB: d.amountB,
        sharesMinted: d.sharesMinted,
        creatorFeeUsd: Number(d.creatorFeeUsd),
        txHash: d.txHash,
        timestamp: d.createdAt.toISOString(),
      })),
      redeems: activity.redeems.map((r) => ({
        wallet: r.wallet,
        valueUsd: Number(r.usdgOut),
        amountA: r.amountA,
        amountB: r.amountB,
        sharesBurned: r.sharesBurned,
        txHash: r.txHash,
        timestamp: r.createdAt.toISOString(),
      })),
    },
  });
});

/**
 * Time-series history for a launched pair.
 *
 * `?range=` accepts 1h / 24h / 7d / 30d / all (default: 24h).
 *
 * If no on-chain snapshots have been collected yet (fresh pair, indexer
 * still warming up, or the DB is unavailable) we synthesise a curve from
 * recorded deposit / redeem events so the chart never renders blank.
 */
app.get("/launchpad/pair/:address/history", async (c) => {
  const address = c.req.param("address");
  const range = (c.req.query("range") ?? "24h").toLowerCase();
  const rangeMs =
    range === "1h"
      ? 60 * 60 * 1000
      : range === "7d"
        ? 7 * 24 * 60 * 60 * 1000
        : range === "30d"
          ? 30 * 24 * 60 * 60 * 1000
          : range === "all"
            ? 365 * 24 * 60 * 60 * 1000
            : 24 * 60 * 60 * 1000;

  if (!useDb) {
    return c.json({ range, points: [] });
  }

  const points = await launchpadStore.getPairHistory(db!, address, rangeMs);
  if (points.length > 0) {
    return c.json({ range, points, source: "snapshots" });
  }

  // Fallback — no snapshots yet. Reconstruct a rough curve from
  // deposit + redeem events so the chart still renders on new pairs.
  const pair = await launchpadStore.getPair(db!, address);
  if (!pair) return c.json({ range, points: [] });
  const activity = await launchpadStore.getPairActivity(db!, address, 500);
  const events: { createdAt: Date; delta: number; sharesDelta: number }[] = [];
  for (const d of activity.deposits) {
    events.push({
      createdAt: d.createdAt,
      delta: Number(d.usdgAmount) - Number(d.creatorFeeUsd),
      sharesDelta: Number(d.sharesMinted) / 1e18,
    });
  }
  for (const r of activity.redeems) {
    events.push({
      createdAt: r.createdAt,
      delta: -Number(r.usdgOut),
      sharesDelta: -Number(r.sharesBurned) / 1e18,
    });
  }
  events.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

  const cutoff = Date.now() - rangeMs;
  let nav = 0;
  let shares = 0;
  const reconstructed: {
    timestamp: string;
    navUsd: number;
    sharePrice: number;
    totalShares: string;
  }[] = [];
  for (const ev of events) {
    nav = Math.max(0, nav + ev.delta);
    shares = Math.max(0, shares + ev.sharesDelta);
    if (ev.createdAt.getTime() >= cutoff) {
      reconstructed.push({
        timestamp: ev.createdAt.toISOString(),
        navUsd: nav,
        sharePrice: shares > 0 ? nav / shares : 1,
        totalShares: String(shares),
      });
    }
  }

  // Append a synthetic "now" point holding the last value so the curve
  // extends to the right edge of the chart even between events.
  if (reconstructed.length > 0) {
    const last = reconstructed[reconstructed.length - 1]!;
    reconstructed.push({ ...last, timestamp: new Date().toISOString() });
  }

  return c.json({ range, points: reconstructed, source: "reconstructed" });
});

// ─── Bonding-curve creator tokens ───────────────────────

/** The ComposeCurve every token read is scoped to ("" when none is configured → nothing matches). */
const curveScope = () => composeCurveAddress() ?? "";

type PairProfile = Awaited<ReturnType<typeof launchpadStore.getPair>> | null;

/** A token carries its pair's identity: the pair's name, description, banner and logo are the token's. */
function tokenIdentity(pair: PairProfile) {
  return {
    tickerA: pair?.tickerA ?? "",
    tickerB: pair?.tickerB ?? "",
    pairName: pair?.displayName ?? "",
    pairDescription: pair?.description ?? "",
    imageUrl: pair?.imageUrl ?? "",
    logoUrl: pair?.logoUrl ?? "",
  };
}

async function tokenJson(row: curveStore.CurveTokenRow, withVolume = false, pair?: PairProfile) {
  const profile = pair === undefined ? await launchpadStore.getPair(db!, row.pairAddress) : pair;
  return curveStore.toTokenJson(row, {
    ...tokenIdentity(profile),
    ...(withVolume ? { volume24hUsd: await curveStore.volume24hUsd(db!, row.tokenAddress) } : {}),
  });
}

/** Look each distinct pair up once for a list of tokens. */
async function pairProfiles(rows: curveStore.CurveTokenRow[]) {
  const pairs = new Map<string, PairProfile>();
  for (const addr of new Set(rows.map((r) => r.pairAddress))) {
    pairs.set(addr, await launchpadStore.getPair(db!, addr));
  }
  return pairs;
}

/** Token JSON for a list, looking each distinct pair up once. */
async function tokensJson(rows: curveStore.CurveTokenRow[]) {
  const pairs = await pairProfiles(rows);
  return Promise.all(rows.map((r) => tokenJson(r, false, pairs.get(r.pairAddress) ?? null)));
}

/**
 * Launchpad token cards. `?sort=new|mcap|volume` (default mcap), `?limit` ≤ 200.
 * Each token carries its pair identity plus `volume24hUsd` and `holders`.
 */
app.get("/launchpad/tokens", async (c) => {
  if (!useDb) return c.json({ tokens: [] });
  const sortParam = (c.req.query("sort") ?? "mcap").toLowerCase();
  const sort = curveStore.isTokenListSort(sortParam) ? sortParam : "mcap";
  const limit = Math.min(200, Math.max(1, Number(c.req.query("limit") ?? 100) || 100));
  const list = await curveStore.listTokens(db!, curveScope(), { sort, limit });
  const pairs = await pairProfiles(list.map((t) => t.row));
  const tokens = list.map((t) =>
    curveStore.toTokenJson(t.row, {
      ...tokenIdentity(pairs.get(t.row.pairAddress) ?? null),
      volume24hUsd: t.volume24hUsd,
      holders: t.holders,
    }),
  );
  return c.json({ tokens }, 200, { "Cache-Control": "no-store" });
});

/** Launchpad header: token count, summed market cap, 24h volume. */
app.get("/launchpad/tokens/stats", async (c) => {
  if (!useDb) return c.json({ tokens: 0, totalMarketCapUsd: 0, volume24hUsd: 0 });
  const stats = await curveStore.getTokenStats(db!, curveScope());
  return c.json(stats, 200, { "Cache-Control": "no-store" });
});

app.get("/launchpad/token/:address", async (c) => {
  if (!useDb) return c.json({ error: "DB not configured" }, 503);
  const row = await curveStore.getToken(db!, curveScope(), c.req.param("address"));
  if (!row) return c.json({ error: "Token not found" }, 404);
  const trades = await curveStore.getTrades(db!, row.tokenAddress, 50);
  const verification = verificationStore.toVerificationJson(
    await verificationStore.getVerification(db!, row.tokenAddress),
    chainId(),
    row.tokenAddress,
  );
  return c.json(
    { token: { ...(await tokenJson(row, true)), verification }, trades: trades.map(curveStore.toTradeJson) },
    200,
    { "Cache-Control": "no-store" },
  );
});

/** Source-verification status of a launched contract (pair vault, share token or creator token). */
app.get("/launchpad/verification/:address", async (c) => {
  if (!useDb) return c.json({ error: "DB not configured" }, 503);
  const addr = c.req.param("address");
  const row = await verificationStore.getVerification(db!, addr);
  return c.json({ verification: verificationStore.toVerificationJson(row, chainId(), addr) }, 200, {
    "Cache-Control": "no-store",
  });
});

app.get("/launchpad/pair/:address/token", async (c) => {
  if (!useDb) return c.json({ token: null });
  const row = await curveStore.getTokenByPair(db!, curveScope(), c.req.param("address"));
  return c.json({ token: row ? await tokenJson(row) : null }, 200, { "Cache-Control": "no-store" });
});

/** Every token launched on a pair, newest first. */
app.get("/launchpad/pair/:address/tokens", async (c) => {
  if (!useDb) return c.json({ tokens: [] });
  const rows = await curveStore.listTokensByPair(db!, curveScope(), c.req.param("address"));
  return c.json({ tokens: await tokensJson(rows) }, 200, { "Cache-Control": "no-store" });
});

/** Market-cap candles from real trades. */
app.get("/launchpad/token/:address/candles", async (c) => {
  const interval = c.req.query("interval") ?? "1m";
  if (!isCandleInterval(interval)) return c.json({ error: "interval must be 1m, 5m, 15m or 1h" }, 400);
  if (!useDb) return c.json({ interval, candles: [] });
  const row = await curveStore.getToken(db!, curveScope(), c.req.param("address"));
  if (!row) return c.json({ interval, candles: [] });
  const limit = Math.min(500, Math.max(10, Number(c.req.query("limit") ?? 180) || 180));
  const candles = await curveStore.getTokenCandles(db!, row, CANDLE_INTERVALS[interval], limit);
  return c.json({ interval, candles }, 200, { "Cache-Control": "no-store" });
});

/**
 * Per-trade market-cap history of a creator token.
 *
 * `?range=` accepts 1h / 24h / 7d / 30d / all (default: 24h). Every trade in
 * the window is its own point, preceded by the launch (or the value carried
 * in from before the window) and followed by a synthetic "now" point.
 */
app.get("/launchpad/token/:address/history", async (c) => {
  const range = (c.req.query("range") ?? "24h").toLowerCase();
  if (!curveStore.isTokenHistoryRange(range)) return c.json({ error: "range must be 1h, 24h, 7d, 30d or all" }, 400);
  if (!useDb) return c.json({ error: "DB not configured" }, 503);
  const row = await curveStore.getToken(db!, curveScope(), c.req.param("address"));
  if (!row) return c.json({ error: "Token not found" }, 404);
  const points = await curveStore.getTokenHistory(db!, row, range);
  return c.json({ range, points }, 200, { "Cache-Control": "no-store" });
});

/** Server-sent events: every trade of a creator token as it is indexed. */
app.get("/launchpad/token/:address/stream", (c) => {
  const address = c.req.param("address").toLowerCase();
  return streamSSE(c, async (stream) => {
    let open = true;
    const unsubscribe = subscribeTokenTrades(address, (trade) => {
      void stream.writeSSE({ event: "trade", data: JSON.stringify(trade) });
    });
    stream.onAbort(() => {
      open = false;
      unsubscribe();
    });
    while (open) {
      await stream.writeSSE({ event: "ping", data: String(Date.now()) });
      await stream.sleep(15_000);
    }
  });
});

/** Creator fee shares already cashed out for a pair. */
app.get("/launchpad/pair/:address/creator-claims", async (c) => {
  if (!useDb) return c.json({ claimedShares: "0" });
  const claimed = await getClaimedShares(db!, c.req.param("address"));
  return c.json({ claimedShares: claimed.toString() }, 200, { "Cache-Control": "no-store" });
});

/** Record a creator reward claim; the redeem is verified from the transaction receipt. */
app.post("/launchpad/pair/:address/creator-claims", async (c) => {
  if (!useDb) return c.json({ error: "DB not configured" }, 503);
  const client = getPublicClient();
  if (!client) return c.json({ error: "RPC not configured" }, 503);
  const body = (await c.req.json().catch(() => ({}))) as { txHash?: unknown };
  const txHash = typeof body.txHash === "string" ? body.txHash : "";
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) return c.json({ error: "txHash is required" }, 400);
  try {
    const result = await recordCreatorClaim(db!, client, c.req.param("address"), txHash);
    return c.json({
      ok: true,
      claimedShares: result.claimedShares.toString(),
      recordedShares: result.recordedShares.toString(),
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Claim could not be recorded";
    return c.json({ error: message }, e instanceof ClaimError ? 400 : 500);
  }
});

/** OHLC candles of a pair's share price (default) or NAV. */
app.get("/launchpad/pair/:address/candles", async (c) => {
  const address = c.req.param("address");
  const interval = c.req.query("interval") ?? "1m";
  const metric = c.req.query("metric") === "navUsd" ? "navUsd" : "sharePrice";
  if (!isCandleInterval(interval)) {
    return c.json({ error: "interval must be 1m, 5m, 15m or 1h" }, 400);
  }
  const limit = Math.min(500, Math.max(10, Number(c.req.query("limit") ?? 180) || 180));
  if (!useDb) return c.json({ interval, metric, candles: [] });
  const candles = await getPairCandles(db!, address, interval, metric, limit);
  return c.json({ interval, metric, candles }, 200, { "Cache-Control": "no-store" });
});

/** Server-sent events: a snapshot the moment a pair trades or its price moves. */
app.get("/launchpad/pair/:address/stream", (c) => {
  const address = c.req.param("address").toLowerCase();
  return streamSSE(c, async (stream) => {
    let open = true;
    const unsubscribe = subscribePairSnapshots(address, (snapshot) => {
      void stream.writeSSE({ event: "snapshot", data: JSON.stringify(snapshot) });
    });
    stream.onAbort(() => {
      open = false;
      unsubscribe();
    });
    while (open) {
      await stream.writeSSE({ event: "ping", data: String(Date.now()) });
      await stream.sleep(15_000);
    }
  });
});

app.get("/launchpad/creator/:wallet", async (c) => {
  if (!useDb) return c.json({ pairs: [] });
  const wallet = c.req.param("wallet");
  const rows = await launchpadStore.listByCreator(db!, wallet, pairFactoryAddress());
  return c.json({
    pairs: rows.map((r) => ({
      pairAddress: r.pairAddress,
      receiptSymbol: r.receiptSymbol,
      tickerA: r.tickerA,
      tickerB: r.tickerB,
      tvlUsd: Number(r.tvlUsd),
      creatorEarningsUsd: Number(r.creatorEarningsUsd),
      totalDepositors: Number(r.totalDepositors),
      creatorFeeBps: Number(r.creatorFeeBps),
      createdAt: r.createdAt.toISOString(),
    })),
  });
});

app.get("/launchpad/stats", async (c) => {
  if (!useDb) {
    return c.json({
      totalPairs: 0,
      totalTvlUsd: 0,
      totalCreatorEarningsUsd: 0,
      totalCreators: 0,
    });
  }
  const stats = await launchpadStore.getLaunchpadStats(db!, pairFactoryAddress());
  return c.json(stats);
});

// Legacy endpoint
app.post("/events/deposit", async (c) => {
  const body = await c.req.json();
  const input = {
    wallet: body.wallet,
    txHash: body.txHash,
    depositTicker: body.assets?.[0] ?? "NVDA",
    depositUsd: body.valueUsd ?? 500,
    strategy: "balanced",
    openingNetUsd: (body.valueUsd ?? 500) + (body.stockbackUsd ?? 0),
    stockbackUsd: body.stockbackUsd ?? 0,
    allocation: [],
  };
  const result = useDb
    ? await dbStore.recordDeposit(db!, input)
    : jsonStore.recordDeposit(input);
  return c.json(result.activity);
});

const port = Number(process.env.INDEXER_PORT ?? 3003);

let server: ServerType;
let chainListenerCleanup: (() => void) | null = null;
let launchpadIndexerCleanup: (() => void) | null = null;
let curveIndexerCleanup: (() => void) | null = null;
let vaultDiscoveryCleanup: (() => void) | null = null;
let markToMarketTimer: NodeJS.Timeout | null = null;

server = serve({ fetch: app.fetch, port, hostname: "0.0.0.0" }, async () => {
  console.log(`[indexer] API listening on :${port}`);
  if (redisConfigured()) {
    await getRedis();
  } else {
    console.log("[indexer] Redis not configured — image upload disabled");
  }
  // Discover basket vaults before the listener / mark-to-market start so
  // they watch the full set from the first tick.
  await initVaultRegistry();
  vaultDiscoveryCleanup = startVaultDiscovery();
  chainListenerCleanup = startChainListener();
  launchpadIndexerCleanup = startLaunchpadIndexer();
  curveIndexerCleanup = startCurveIndexer();
  markToMarketTimer = startMarkToMarket();
});

function gracefulShutdown(signal: string) {
  console.log(`[indexer] ${signal} received, shutting down gracefully...`);

  if (chainListenerCleanup) {
    chainListenerCleanup();
  }
  if (launchpadIndexerCleanup) {
    launchpadIndexerCleanup();
  }
  if (curveIndexerCleanup) {
    curveIndexerCleanup();
  }
  if (vaultDiscoveryCleanup) {
    vaultDiscoveryCleanup();
  }
  if (markToMarketTimer) {
    clearInterval(markToMarketTimer);
  }

  server.close(async () => {
    await closeRedis();
    console.log("[indexer] HTTP server closed");
    process.exit(0);
  });

  setTimeout(() => {
    console.error("[indexer] Forced shutdown after timeout");
    process.exit(1);
  }, 10_000);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
