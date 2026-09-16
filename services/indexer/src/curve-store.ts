import { and, asc, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { boolean, index, numeric, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type { Db } from "./db.js";

export const TOKEN_SUPPLY = 1_000_000_000;

// ─── Tables ─────────────────────────────────────────────

export const curveTokens = pgTable(
  "curve_tokens",
  {
    tokenAddress: text("token_address").primaryKey(),
    /** ComposeCurve that issued the token; reads are scoped to the configured curve. */
    curveAddress: text("curve_address").notNull().default(""),
    pairAddress: text("pair_address").notNull(),
    shareAddress: text("share_address").notNull(),
    creatorWallet: text("creator_wallet").notNull(),
    name: text("name").notNull(),
    symbol: text("symbol").notNull(),
    startQuote: text("start_quote").notNull(),
    virtualQuote: text("virtual_quote").notNull(),
    tokenReserve: text("token_reserve").notNull(),
    graduationQuote: text("graduation_quote").notNull(),
    graduated: boolean("graduated").notNull().default(false),
    priceUsd: numeric("price_usd", { precision: 38, scale: 18 }).notNull().default("0"),
    marketCapUsd: numeric("market_cap_usd", { precision: 24, scale: 4 }).notNull().default("0"),
    startMarketCapUsd: numeric("start_market_cap_usd", { precision: 24, scale: 4 }).notNull().default("0"),
    sharePriceUsd: numeric("share_price_usd", { precision: 18, scale: 8 }).notNull().default("1"),
    tradesCount: numeric("trades_count").notNull().default("0"),
    txHash: text("tx_hash").notNull().default(""),
    /**
     * Where the token's market lives: "compose" (ComposeCurve, quoted in pair
     * shares) or "pons" (a Pons v2 bonding curve quoted in one stock / USDG).
     * For Pons rows the quote-denominated columns above (start/virtual/
     * graduation quote, trade shares) hold QUOTE units scaled to 18 decimals,
     * and `sharePriceUsd` holds the quote token's USD price, so every USD
     * figure downstream is computed the same way for both venues.
     */
    venue: text("venue").notNull().default("compose"),
    /** The Pons bonding curve contract of the token (pons rows only). */
    ponsCurve: text("pons_curve"),
    quoteToken: text("quote_token"),
    quoteSymbol: text("quote_symbol"),
    quoteDecimals: numeric("quote_decimals").notNull().default("18"),
    /** The pair's own share price (USD) at the last update — the "two stocks" lens for pons rows. */
    pairSharePriceUsd: numeric("pair_share_price_usd", { precision: 18, scale: 8 }).notNull().default("1"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [index("curve_tokens_pair_idx").on(t.pairAddress), index("curve_tokens_curve_idx").on(t.curveAddress)],
);

export const curveTrades = pgTable(
  "curve_trades",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tokenAddress: text("token_address").notNull(),
    trader: text("trader").notNull(),
    isBuy: boolean("is_buy").notNull(),
    shares: text("shares").notNull(),
    tokens: text("tokens").notNull(),
    fee: text("fee").notNull(),
    priceUsd: numeric("price_usd", { precision: 38, scale: 18 }).notNull(),
    marketCapUsd: numeric("market_cap_usd", { precision: 24, scale: 4 }).notNull(),
    valueUsd: numeric("value_usd", { precision: 18, scale: 4 }).notNull(),
    txHash: text("tx_hash").notNull(),
    logIndex: numeric("log_index").notNull().default("0"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("curve_trades_tx_log_idx").on(t.txHash, t.logIndex),
    index("curve_trades_token_ts_idx").on(t.tokenAddress, t.createdAt),
  ],
);

export type CurveTokenRow = typeof curveTokens.$inferSelect;
export type CurveTradeRow = typeof curveTrades.$inferSelect;

// ─── Writes ─────────────────────────────────────────────

export interface CurveTokenInput {
  tokenAddress: string;
  /** The ComposeCurve contract the TokenCreated event came from. */
  curveAddress: string;
  pairAddress: string;
  shareAddress: string;
  creatorWallet: string;
  name: string;
  symbol: string;
  startQuote: bigint;
  graduationQuote: bigint;
  sharePriceUsd: number;
  txHash: string;
  createdAt: Date;
  /** Pons launches only; compose rows leave this undefined. */
  pons?: {
    curve: string;
    quoteToken: string;
    quoteSymbol: string;
    quoteDecimals: number;
    /** The pair's share price (USD) at launch. */
    pairSharePriceUsd: number;
  };
}

export async function recordToken(db: Db, i: CurveTokenInput) {
  const startMarketCapUsd = (Number(i.startQuote) / 1e18) * i.sharePriceUsd;
  await db
    .insert(curveTokens)
    .values({
      tokenAddress: i.tokenAddress.toLowerCase(),
      curveAddress: i.curveAddress.toLowerCase(),
      pairAddress: i.pairAddress.toLowerCase(),
      shareAddress: i.shareAddress.toLowerCase(),
      creatorWallet: i.creatorWallet.toLowerCase(),
      name: i.name,
      symbol: i.symbol,
      startQuote: i.startQuote.toString(),
      virtualQuote: i.startQuote.toString(),
      tokenReserve: (10n ** 27n).toString(),
      graduationQuote: i.graduationQuote.toString(),
      priceUsd: (startMarketCapUsd / TOKEN_SUPPLY).toFixed(18),
      marketCapUsd: startMarketCapUsd.toFixed(4),
      startMarketCapUsd: startMarketCapUsd.toFixed(4),
      sharePriceUsd: i.sharePriceUsd.toFixed(8),
      txHash: i.txHash,
      ...(i.pons
        ? {
            venue: "pons",
            ponsCurve: i.pons.curve.toLowerCase(),
            quoteToken: i.pons.quoteToken.toLowerCase(),
            quoteSymbol: i.pons.quoteSymbol,
            quoteDecimals: String(i.pons.quoteDecimals),
            pairSharePriceUsd: i.pons.pairSharePriceUsd.toFixed(8),
          }
        : {}),
      createdAt: i.createdAt,
      updatedAt: i.createdAt,
    })
    .onConflictDoNothing();
}

/** Price and market cap (USD) after a trade, from the curve's reserves. */
export function tradeMetrics(virtualQuote: bigint, tokenReserve: bigint, sharePriceUsd: number) {
  const priceShares = Number(virtualQuote) / Number(tokenReserve);
  return {
    priceUsd: priceShares * sharePriceUsd,
    marketCapUsd: priceShares * TOKEN_SUPPLY * sharePriceUsd,
  };
}

export interface CurveTradeInput {
  tokenAddress: string;
  trader: string;
  isBuy: boolean;
  shares: bigint;
  tokens: bigint;
  fee: bigint;
  virtualQuote: bigint;
  tokenReserve: bigint;
  sharePriceUsd: number;
  txHash: string;
  logIndex: number;
  createdAt: Date;
  /** Pons trades: the pair's share price (USD) at the trade block. */
  pairSharePriceUsd?: number;
}

/** Stores a Trade event once and rolls the token's state forward; null if already indexed. */
export async function recordTrade(db: Db, i: CurveTradeInput) {
  const token = i.tokenAddress.toLowerCase();
  const { priceUsd, marketCapUsd } = tradeMetrics(i.virtualQuote, i.tokenReserve, i.sharePriceUsd);
  const valueUsd = (Number(i.shares) / 1e18) * i.sharePriceUsd;
  const [row] = await db
    .insert(curveTrades)
    .values({
      tokenAddress: token,
      trader: i.trader.toLowerCase(),
      isBuy: i.isBuy,
      shares: i.shares.toString(),
      tokens: i.tokens.toString(),
      fee: i.fee.toString(),
      priceUsd: priceUsd.toFixed(18),
      marketCapUsd: marketCapUsd.toFixed(4),
      valueUsd: valueUsd.toFixed(4),
      txHash: i.txHash,
      logIndex: String(i.logIndex),
      createdAt: i.createdAt,
    })
    .onConflictDoNothing({ target: [curveTrades.txHash, curveTrades.logIndex] })
    .returning();
  if (!row) return null;

  await db
    .update(curveTokens)
    .set({
      virtualQuote: i.virtualQuote.toString(),
      tokenReserve: i.tokenReserve.toString(),
      priceUsd: priceUsd.toFixed(18),
      marketCapUsd: marketCapUsd.toFixed(4),
      sharePriceUsd: i.sharePriceUsd.toFixed(8),
      ...(i.pairSharePriceUsd != null ? { pairSharePriceUsd: i.pairSharePriceUsd.toFixed(8) } : {}),
      tradesCount: sql`${curveTokens.tradesCount} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(curveTokens.tokenAddress, token));

  return { row, priceUsd, marketCapUsd, valueUsd };
}

export async function markGraduated(db: Db, tokenAddress: string) {
  await db
    .update(curveTokens)
    .set({ graduated: true, updatedAt: new Date() })
    .where(eq(curveTokens.tokenAddress, tokenAddress.toLowerCase()));
}

// ─── Reads ──────────────────────────────────────────────
//
// Every token read is scoped to one ComposeCurve address. Tokens issued by an
// abandoned curve deployment stay in the table but are invisible, which the
// web renders as "not a Compose creator token".

/** One ComposeCurve / PonsLauncher address, or every configured one. */
export type CurveScope = string | string[];

function curveFilter(scope: CurveScope) {
  if (Array.isArray(scope)) {
    const addrs = scope.map((a) => a.toLowerCase());
    // An empty scope matches nothing, like an unconfigured single address.
    return addrs.length > 0 ? inArray(curveTokens.curveAddress, addrs) : eq(curveTokens.curveAddress, "");
  }
  return eq(curveTokens.curveAddress, scope.toLowerCase());
}

/** Every Pons-launched token row (to bootstrap the Pons indexer's curve set). */
export async function listPonsTokens(db: Db, launcherAddress: string) {
  return db
    .select()
    .from(curveTokens)
    .where(and(curveFilter(launcherAddress), eq(curveTokens.venue, "pons")));
}

export async function getToken(db: Db, curveAddress: CurveScope, tokenAddress: string) {
  const [row] = await db
    .select()
    .from(curveTokens)
    .where(and(curveFilter(curveAddress), eq(curveTokens.tokenAddress, tokenAddress.toLowerCase())))
    .limit(1);
  return row ?? null;
}

export async function getTokenByPair(db: Db, curveAddress: CurveScope, pairAddress: string) {
  const [row] = await db
    .select()
    .from(curveTokens)
    .where(and(curveFilter(curveAddress), eq(curveTokens.pairAddress, pairAddress.toLowerCase())))
    .limit(1);
  return row ?? null;
}

export async function listTokensByPair(db: Db, curveAddress: CurveScope, pairAddress: string) {
  return db
    .select()
    .from(curveTokens)
    .where(and(curveFilter(curveAddress), eq(curveTokens.pairAddress, pairAddress.toLowerCase())))
    .orderBy(desc(curveTokens.createdAt))
    .limit(200);
}

export type TokenListSort = "new" | "mcap" | "volume";

export function isTokenListSort(v: string): v is TokenListSort {
  return v === "new" || v === "mcap" || v === "volume";
}

export interface TokenListRow {
  row: CurveTokenRow;
  volume24hUsd: number;
  /** Distinct wallets that have bought the token (see `holderCounts`). */
  holders: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 24h volume per token in one grouped query.
 * Returns a map keyed by lower-cased token address; tokens with no trades are absent.
 */
export async function volume24hByToken(db: Db, curveAddress: CurveScope): Promise<Map<string, number>> {
  const cutoff = new Date(Date.now() - DAY_MS);
  const rows = await db
    .select({
      tokenAddress: curveTrades.tokenAddress,
      total: sql<string>`COALESCE(SUM(${curveTrades.valueUsd}), 0)`,
    })
    .from(curveTrades)
    .innerJoin(curveTokens, eq(curveTokens.tokenAddress, curveTrades.tokenAddress))
    .where(and(curveFilter(curveAddress), gte(curveTrades.createdAt, cutoff)))
    .groupBy(curveTrades.tokenAddress);
  return new Map(rows.map((r) => [r.tokenAddress, Number(r.total)]));
}

/**
 * Holder count per token: distinct wallets whose buys minus sells leave a
 * positive token balance, from the indexed trades alone (no balanceOf calls).
 * Transfers outside the curve are not seen, so this is "distinct net buyers".
 */
export async function holderCounts(db: Db, curveAddress: CurveScope): Promise<Map<string, number>> {
  const balances = db
    .select({
      tokenAddress: curveTrades.tokenAddress,
      trader: curveTrades.trader,
      net: sql<string>`SUM(CASE WHEN ${curveTrades.isBuy} THEN ${curveTrades.tokens}::numeric ELSE -(${curveTrades.tokens}::numeric) END)`.as(
        "net",
      ),
    })
    .from(curveTrades)
    .innerJoin(curveTokens, eq(curveTokens.tokenAddress, curveTrades.tokenAddress))
    .where(curveFilter(curveAddress))
    .groupBy(curveTrades.tokenAddress, curveTrades.trader)
    .as("balances");
  const rows = await db
    .select({
      tokenAddress: balances.tokenAddress,
      holders: sql<string>`COUNT(*)`,
    })
    .from(balances)
    .where(sql`${balances.net} > 0`)
    .groupBy(balances.tokenAddress);
  return new Map(rows.map((r) => [r.tokenAddress, Number(r.holders)]));
}

/** Tokens of one curve with their 24h volume and holder count, sorted for the launchpad list. */
export async function listTokens(
  db: Db,
  curveAddress: CurveScope,
  opts: { sort: TokenListSort; limit: number },
): Promise<TokenListRow[]> {
  const [volumes, holders] = await Promise.all([volume24hByToken(db, curveAddress), holderCounts(db, curveAddress)]);
  const query = db.select().from(curveTokens).where(curveFilter(curveAddress));
  let rows: CurveTokenRow[];
  if (opts.sort === "volume") {
    // Volume lives in the trades table; rank in memory over the curve's tokens.
    rows = (await query).sort(
      (a, b) =>
        (volumes.get(b.tokenAddress) ?? 0) - (volumes.get(a.tokenAddress) ?? 0) ||
        Number(b.marketCapUsd) - Number(a.marketCapUsd),
    );
    rows = rows.slice(0, opts.limit);
  } else {
    rows = await query
      .orderBy(opts.sort === "mcap" ? desc(curveTokens.marketCapUsd) : desc(curveTokens.createdAt))
      .limit(opts.limit);
  }
  return rows.map((row) => ({
    row,
    volume24hUsd: volumes.get(row.tokenAddress) ?? 0,
    holders: holders.get(row.tokenAddress) ?? 0,
  }));
}

export interface TokenStats {
  tokens: number;
  totalMarketCapUsd: number;
  volume24hUsd: number;
}

/** Launchpad header numbers for one curve. */
export async function getTokenStats(db: Db, curveAddress: CurveScope): Promise<TokenStats> {
  const cutoff = new Date(Date.now() - DAY_MS);
  const [[totals], [vol]] = await Promise.all([
    db
      .select({
        tokens: sql<string>`COUNT(*)`,
        totalMarketCapUsd: sql<string>`COALESCE(SUM(${curveTokens.marketCapUsd}), 0)`,
      })
      .from(curveTokens)
      .where(curveFilter(curveAddress)),
    db
      .select({ volume24hUsd: sql<string>`COALESCE(SUM(${curveTrades.valueUsd}), 0)` })
      .from(curveTrades)
      .innerJoin(curveTokens, eq(curveTokens.tokenAddress, curveTrades.tokenAddress))
      .where(and(curveFilter(curveAddress), gte(curveTrades.createdAt, cutoff))),
  ]);
  return {
    tokens: Number(totals?.tokens ?? 0),
    totalMarketCapUsd: Number(totals?.totalMarketCapUsd ?? 0),
    volume24hUsd: Number(vol?.volume24hUsd ?? 0),
  };
}

export async function getTrades(db: Db, tokenAddress: string, limit = 50) {
  return db
    .select()
    .from(curveTrades)
    .where(eq(curveTrades.tokenAddress, tokenAddress.toLowerCase()))
    .orderBy(desc(curveTrades.createdAt))
    .limit(limit);
}

export async function volume24hUsd(db: Db, tokenAddress: string): Promise<number> {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const [row] = await db
    .select({ total: sql<string>`COALESCE(SUM(${curveTrades.valueUsd}), 0)` })
    .from(curveTrades)
    .where(and(eq(curveTrades.tokenAddress, tokenAddress.toLowerCase()), gte(curveTrades.createdAt, cutoff)));
  return Number(row?.total ?? 0);
}

export interface Candle {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
}

/**
 * Market-cap candles built from real trades. Each candle opens at the previous
 * close; empty buckets carry it forward; nothing is drawn before the launch.
 */
export async function getTokenCandles(db: Db, token: CurveTokenRow, bucketMs: number, limit: number): Promise<Candle[]> {
  const addr = token.tokenAddress;
  const endBucket = Math.floor(Date.now() / bucketMs) * bucketMs;
  const launchBucket = Math.floor(token.createdAt.getTime() / bucketMs) * bucketMs;
  const startBucket = Math.max(endBucket - (limit - 1) * bucketMs, launchBucket);
  const cutoff = new Date(startBucket);

  const [before] = await db
    .select()
    .from(curveTrades)
    .where(and(eq(curveTrades.tokenAddress, addr), lt(curveTrades.createdAt, cutoff)))
    .orderBy(desc(curveTrades.createdAt))
    .limit(1);
  const rows = await db
    .select()
    .from(curveTrades)
    .where(and(eq(curveTrades.tokenAddress, addr), gte(curveTrades.createdAt, cutoff)))
    .orderBy(asc(curveTrades.createdAt));

  const candles: Candle[] = [];
  let lastClose = before ? Number(before.marketCapUsd) : Number(token.startMarketCapUsd);
  let i = 0;
  for (let t = startBucket; t <= endBucket; t += bucketMs) {
    const bucketEnd = t + bucketMs;
    const open = lastClose;
    let high = open;
    let low = open;
    let close = open;
    while (i < rows.length && rows[i]!.createdAt.getTime() < bucketEnd) {
      const v = Number(rows[i]!.marketCapUsd);
      high = Math.max(high, v);
      low = Math.min(low, v);
      close = v;
      i++;
    }
    candles.push({ time: new Date(t).toISOString(), open, high, low, close });
    lastClose = close;
  }
  return candles;
}

export type TokenHistoryRange = "1h" | "24h" | "7d" | "30d" | "all";

export const TOKEN_HISTORY_RANGE_MS: Record<Exclude<TokenHistoryRange, "all">, number> = {
  "1h": 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};

export function isTokenHistoryRange(v: string): v is TokenHistoryRange {
  return v === "1h" || v === "24h" || v === "7d" || v === "30d" || v === "all";
}

export interface TokenHistoryPoint {
  timestamp: string;
  marketCapUsd: number;
  priceUsd: number;
  isBuy?: boolean;
  txHash?: string;
  trader?: string;
}

const MAX_HISTORY_POINTS = 5000;

/**
 * Per-trade market-cap history: the launch (or the last trade before the
 * window, carried forward), every trade inside the window as its own point,
 * and a synthetic "now" point so the line reaches the right edge.
 */
export async function getTokenHistory(db: Db, token: CurveTokenRow, range: TokenHistoryRange): Promise<TokenHistoryPoint[]> {
  const addr = token.tokenAddress;
  const launchMs = token.createdAt.getTime();
  const startMs = range === "all" ? launchMs : Math.max(launchMs, Date.now() - TOKEN_HISTORY_RANGE_MS[range]);
  const cutoff = new Date(startMs);
  const startMcap = Number(token.startMarketCapUsd);

  const points: TokenHistoryPoint[] = [];
  if (startMs <= launchMs) {
    points.push({ timestamp: token.createdAt.toISOString(), marketCapUsd: startMcap, priceUsd: startMcap / TOKEN_SUPPLY });
  } else {
    const [before] = await db
      .select()
      .from(curveTrades)
      .where(and(eq(curveTrades.tokenAddress, addr), lt(curveTrades.createdAt, cutoff)))
      .orderBy(desc(curveTrades.createdAt), desc(curveTrades.logIndex))
      .limit(1);
    const mcap = before ? Number(before.marketCapUsd) : startMcap;
    const price = before ? Number(before.priceUsd) : startMcap / TOKEN_SUPPLY;
    points.push({ timestamp: cutoff.toISOString(), marketCapUsd: mcap, priceUsd: price });
  }

  // Newest first with a cap, then flipped: a busy token keeps its most recent trades.
  const rows = await db
    .select()
    .from(curveTrades)
    .where(and(eq(curveTrades.tokenAddress, addr), gte(curveTrades.createdAt, cutoff)))
    .orderBy(desc(curveTrades.createdAt), desc(curveTrades.logIndex))
    .limit(MAX_HISTORY_POINTS - 2);
  rows.reverse();
  for (const r of rows) {
    points.push({
      timestamp: r.createdAt.toISOString(),
      marketCapUsd: Number(r.marketCapUsd),
      priceUsd: Number(r.priceUsd),
      isBuy: r.isBuy,
      txHash: r.txHash,
      trader: r.trader,
    });
  }

  const last = points[points.length - 1]!;
  points.push({ timestamp: new Date().toISOString(), marketCapUsd: last.marketCapUsd, priceUsd: last.priceUsd });
  return points;
}

// ─── JSON ───────────────────────────────────────────────

export function toTokenJson(
  row: CurveTokenRow,
  extra: {
    tickerA?: string;
    tickerB?: string;
    pairName?: string;
    pairDescription?: string;
    imageUrl?: string;
    logoUrl?: string;
    volume24hUsd?: number;
    holders?: number;
  } = {},
) {
  const start = BigInt(row.startQuote);
  const virtualQuote = BigInt(row.virtualQuote);
  const graduation = BigInt(row.graduationQuote);
  const real = virtualQuote > start ? virtualQuote - start : 0n;
  const progressBps = graduation > 0n ? Math.min(10_000, Number((real * 10_000n) / graduation)) : 0;
  const ratio = start > 0n ? (Number(start) + Number(graduation)) / Number(start) : 0;
  const startMarketCapUsd = Number(row.startMarketCapUsd);
  const isPons = row.venue === "pons";
  const priceUsd = Number(row.priceUsd);
  const pairSharePriceUsd = isPons ? Number(row.pairSharePriceUsd) : Number(row.sharePriceUsd);
  return {
    tokenAddress: row.tokenAddress,
    pairAddress: row.pairAddress,
    shareAddress: row.shareAddress,
    creatorWallet: row.creatorWallet,
    name: row.name,
    symbol: row.symbol,
    graduated: row.graduated,
    priceUsd,
    marketCapUsd: Number(row.marketCapUsd),
    startMarketCapUsd,
    graduationMarketCapUsd: startMarketCapUsd * ratio * ratio,
    /** Compose rows: the pair share price. Pons rows: the quote token's USD price (see `quotePriceUsd`). */
    sharePriceUsd: Number(row.sharePriceUsd),
    progressBps,
    /** "compose" (ComposeCurve, pair-share quote) or "pons" (Pons v2 curve, one-stock quote). */
    venue: isPons ? ("pons" as const) : ("compose" as const),
    ponsCurve: isPons ? row.ponsCurve : null,
    quoteToken: isPons ? row.quoteToken : null,
    quoteSymbol: isPons ? row.quoteSymbol : null,
    quoteDecimals: isPons ? Number(row.quoteDecimals) : null,
    /** USD price of the Pons quote token at the last update (null for compose rows). */
    quotePriceUsd: isPons ? Number(row.sharePriceUsd) : null,
    /** The pair's own share price (USD); for compose rows this equals `sharePriceUsd`. */
    pairSharePriceUsd,
    /** Pair shares per token: the same price re-quoted in the two-stock share. */
    priceShares: pairSharePriceUsd > 0 ? priceUsd / pairSharePriceUsd : 0,
    ponsUrl: isPons ? ponsTokenUrl(row.tokenAddress) : null,
    tradesCount: Number(row.tradesCount),
    txHash: row.txHash,
    createdAt: row.createdAt.toISOString(),
    ...extra,
  };
}

/** The token's page on the Pons site (path pattern not published; the launchpad route with the token address). */
export function ponsTokenUrl(tokenAddress: string) {
  return `https://www.ponsfamily.com/launchpad/${tokenAddress.toLowerCase()}`;
}

export function toTradeJson(row: CurveTradeRow) {
  return {
    trader: row.trader,
    isBuy: row.isBuy,
    shares: row.shares,
    tokens: row.tokens,
    priceUsd: Number(row.priceUsd),
    marketCapUsd: Number(row.marketCapUsd),
    valueUsd: Number(row.valueUsd),
    txHash: row.txHash,
    logIndex: Number(row.logIndex),
    timestamp: row.createdAt.toISOString(),
  };
}
