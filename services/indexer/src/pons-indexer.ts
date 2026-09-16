import { parseAbi, parseAbiItem, type Address, type Log, type PublicClient } from "viem";
import { mainnetDeployment, testnetDeployment } from "@compose/config";
import { createDb } from "./db.js";
import { getPublicClient, launchpadStartBlock, oracleAddress, ponsLauncherAddress, USE_TESTNET } from "./chain-client.js";
import * as launchpadStore from "./launchpad-store.js";
import * as curveStore from "./curve-store.js";
import { publishTokenTrade } from "./pair-live.js";

/**
 * Pons v2 indexer — tokens a pair creator launched on Pons through PonsLauncher.
 *
 * One market, two lenses: the token trades on the Pons bonding curve, quoted in
 * one of the pair's stocks (or USDG). Every trade there is stored in the same
 * curve_tokens / curve_trades tables as ComposeCurve tokens, with the quote
 * asset's amounts scaled to 18 decimals and the quote token's USD price in the
 * `sharePriceUsd` column, so price, market cap, volume, candles and history
 * come out of the existing code paths. The pair's own share price is kept in
 * `pairSharePriceUsd` so the web can re-quote the token in pair shares.
 */

const TokenLaunchedEvent = parseAbiItem(
  "event TokenLaunched(address indexed token, address indexed pair, address indexed creator, address curve, address quoteToken, string name, string symbol, uint256 launchConfigId)",
);
const CurveBuyEvent = parseAbiItem(
  "event CurveBuy(address indexed buyer, address indexed recipient, uint256 quoteIn, uint256 tokensOut, uint256 fee, uint256 tax)",
);
const CurveSellEvent = parseAbiItem(
  "event CurveSell(address indexed seller, address indexed recipient, uint256 tokensIn, uint256 quoteOut, uint256 fee, uint256 tax)",
);
const CurveCompletedEvent = parseAbiItem("event CurveCompleted(address recipient, uint256 quoteOut, uint256 tokenOut)");

type LaunchedLog = Log<bigint, number, false, typeof TokenLaunchedEvent>;
type BuyLog = Log<bigint, number, false, typeof CurveBuyEvent>;
type SellLog = Log<bigint, number, false, typeof CurveSellEvent>;
type CompletedLog = Log<bigint, number, false, typeof CurveCompletedEvent>;

const curveAbi = parseAbi([
  "function getReserves() view returns (uint256 quoteReserve, uint256 tokenReserve)",
  "function phantomQuote() view returns (uint256)",
  "function graduationThreshold() view returns (uint256)",
]);
const vaultAbi = parseAbi(["function sharePrice() view returns (uint256)"]);
const oracleAbi = parseAbi(["function getPriceUnchecked(address token) view returns (uint256)"]);
const erc20Abi = parseAbi(["function symbol() view returns (string)", "function decimals() view returns (uint8)"]);

const CHUNK = BigInt(process.env.INDEXER_LOG_CHUNK ?? 5_000);
const POLL_MS = Number(process.env.INDEXER_POLL_MS ?? 1_500);
const DEFAULT_LOOKBACK = 100_000n;

/** First block to scan without a cursor: `PONS_START_BLOCK`, else `CURVE_START_BLOCK`, else the launchpad start. */
function ponsStartBlock(): bigint {
  for (const raw of [process.env.PONS_START_BLOCK, process.env.CURVE_START_BLOCK]) {
    if (!raw) continue;
    try {
      return BigInt(raw);
    } catch {
      /* try the next */
    }
  }
  return launchpadStartBlock();
}

function usdgAddress(): string {
  const value = USE_TESTNET ? testnetDeployment().contracts.usdg : mainnetDeployment().contracts.usdg;
  return (value ?? "").toLowerCase();
}

/** Scale a quote amount to 18 decimals so the shared USD maths treats it like a share amount. */
function to18(amount: bigint, decimals: number): bigint {
  if (decimals === 18) return amount;
  if (decimals < 18) return amount * 10n ** BigInt(18 - decimals);
  return amount / 10n ** BigInt(decimals - 18);
}

const blockTimes = new Map<bigint, Date>();
async function blockTime(client: PublicClient, blockNumber: bigint): Promise<Date> {
  const cached = blockTimes.get(blockNumber);
  if (cached) return cached;
  const block = await client.getBlock({ blockNumber });
  const time = new Date(Number(block.timestamp) * 1000);
  if (blockTimes.size > 1_000) blockTimes.clear();
  blockTimes.set(blockNumber, time);
  return time;
}

/** Pair share price (USD) at the event block, falling back to the latest, then $1. */
async function sharePriceUsd(client: PublicClient, pair: Address, blockNumber: bigint): Promise<number> {
  const read = (atBlock?: bigint) =>
    client.readContract({ address: pair, abi: vaultAbi, functionName: "sharePrice", blockNumber: atBlock });
  try {
    return Number(await read(blockNumber)) / 1e8;
  } catch {
    try {
      return Number(await read()) / 1e8;
    } catch {
      return 1;
    }
  }
}

interface PonsTokenInfo {
  token: string;
  pair: Address;
  curve: Address;
  quoteToken: Address;
  quoteDecimals: number;
}

/** Polls PonsLauncher launches and every launched curve's trades with a persisted cursor. */
export function startPonsIndexer(): (() => void) | null {
  const client = getPublicClient();
  const launcher = ponsLauncherAddress();
  const oracle = oracleAddress();
  const db = createDb();
  if (!client || !launcher) {
    console.log("[pons-indexer] No RPC or PonsLauncher configured, skipping");
    return null;
  }
  if (!db) {
    console.log("[pons-indexer] No DATABASE_URL, skipping");
    return null;
  }

  const launcherAddr: string = launcher;
  const cursorId = `pons:${launcher.toLowerCase()}`;
  /** curve address (lower-case) → token info */
  const byCurve = new Map<string, PonsTokenInfo>();
  const usdg = usdgAddress();
  let bootstrapped = false;
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;

  /** Quote token USD price (8 → float) at a block; USDG without a feed reads as $1. */
  async function quotePriceUsd(quote: Address, blockNumber: bigint): Promise<number> {
    if (!oracle) return quote.toLowerCase() === usdg ? 1 : 0;
    const read = (atBlock?: bigint) =>
      client!.readContract({
        address: oracle,
        abi: oracleAbi,
        functionName: "getPriceUnchecked",
        args: [quote],
        blockNumber: atBlock,
      });
    try {
      return Number(await read(blockNumber)) / 1e8;
    } catch {
      try {
        return Number(await read()) / 1e8;
      } catch {
        return quote.toLowerCase() === usdg ? 1 : 0;
      }
    }
  }

  async function reservesAt(curve: Address, blockNumber: bigint): Promise<[bigint, bigint]> {
    const read = (atBlock?: bigint) =>
      client!.readContract({ address: curve, abi: curveAbi, functionName: "getReserves", blockNumber: atBlock });
    try {
      return (await read(blockNumber)) as [bigint, bigint];
    } catch {
      return (await read()) as [bigint, bigint];
    }
  }

  async function bootstrap() {
    const rows = await curveStore.listPonsTokens(db!, launcherAddr);
    for (const row of rows) {
      if (!row.ponsCurve || !row.quoteToken) continue;
      byCurve.set(row.ponsCurve, {
        token: row.tokenAddress,
        pair: row.pairAddress as Address,
        curve: row.ponsCurve as Address,
        quoteToken: row.quoteToken as Address,
        quoteDecimals: Number(row.quoteDecimals),
      });
    }
    bootstrapped = true;
    if (rows.length) console.log(`[pons-indexer] Tracking ${byCurve.size} Pons curve(s) from the DB`);
  }

  async function handleLaunched(log: LaunchedLog) {
    const { token, pair, creator, curve, quoteToken, name, symbol } = log.args;
    if (!token || !pair || !creator || !curve || !quoteToken || log.blockNumber == null) return;
    const [createdAt, pairPrice, quotePrice, phantom, threshold, quoteSymbol, quoteDecimals] = await Promise.all([
      blockTime(client!, log.blockNumber),
      sharePriceUsd(client!, pair, log.blockNumber),
      quotePriceUsd(quoteToken, log.blockNumber),
      client!.readContract({ address: curve, abi: curveAbi, functionName: "phantomQuote" }),
      client!.readContract({ address: curve, abi: curveAbi, functionName: "graduationThreshold" }),
      client!.readContract({ address: quoteToken, abi: erc20Abi, functionName: "symbol" }).catch(() => ""),
      client!.readContract({ address: quoteToken, abi: erc20Abi, functionName: "decimals" }).catch(() => 18),
    ]);
    const dec = Number(quoteDecimals);
    await curveStore.recordToken(db!, {
      tokenAddress: token,
      curveAddress: launcherAddr,
      pairAddress: pair,
      shareAddress: pair,
      creatorWallet: creator,
      name: name ?? "",
      symbol: symbol ?? "",
      startQuote: to18(phantom, dec),
      graduationQuote: to18(threshold, dec),
      sharePriceUsd: quotePrice,
      txHash: log.transactionHash ?? "",
      createdAt,
      pons: {
        curve,
        quoteToken,
        quoteSymbol: quoteSymbol || "",
        quoteDecimals: dec,
        pairSharePriceUsd: pairPrice,
      },
    });
    byCurve.set(curve.toLowerCase(), { token: token.toLowerCase(), pair, curve, quoteToken, quoteDecimals: dec });
    console.log(`[pons-indexer] TokenLaunched ${symbol} ${token} on Pons curve ${curve} (quote ${quoteSymbol})`);
  }

  async function handleTrade(
    log: BuyLog | SellLog,
    isBuy: boolean,
    recipient: Address,
    quoteAmount: bigint,
    tokens: bigint,
    fee: bigint,
  ) {
    if (log.blockNumber == null || !log.transactionHash || !log.address) return;
    const info = byCurve.get(log.address.toLowerCase());
    if (!info) return;
    const [createdAt, quotePrice, pairPrice, [quoteReserve, tokenReserve]] = await Promise.all([
      blockTime(client!, log.blockNumber),
      quotePriceUsd(info.quoteToken, log.blockNumber),
      sharePriceUsd(client!, info.pair, log.blockNumber),
      reservesAt(info.curve, log.blockNumber),
    ]);
    const result = await curveStore.recordTrade(db!, {
      tokenAddress: info.token,
      trader: recipient,
      isBuy,
      shares: to18(quoteAmount, info.quoteDecimals),
      tokens,
      fee: to18(fee, info.quoteDecimals),
      virtualQuote: to18(quoteReserve, info.quoteDecimals),
      tokenReserve: tokenReserve > 0n ? tokenReserve : 1n,
      sharePriceUsd: quotePrice,
      pairSharePriceUsd: pairPrice,
      txHash: log.transactionHash,
      logIndex: log.logIndex ?? 0,
      createdAt,
    });
    if (!result) return;
    publishTokenTrade({ tokenAddress: info.token, ...curveStore.toTradeJson(result.row) });
    console.log(
      `[pons-indexer] ${isBuy ? "Buy" : "Sell"} ${info.token} $${result.valueUsd.toFixed(2)} → mcap $${result.marketCapUsd.toFixed(2)}`,
    );
  }

  function sortLogs<T extends { blockNumber: bigint | null; logIndex: number | null }>(logs: T[]) {
    return logs.sort((a, b) =>
      a.blockNumber === b.blockNumber
        ? (a.logIndex ?? 0) - (b.logIndex ?? 0)
        : (a.blockNumber ?? 0n) < (b.blockNumber ?? 0n)
          ? -1
          : 1,
    );
  }

  async function processRange(from: bigint, to: bigint) {
    // Launches first, so a dev buy in the launch block finds its curve.
    const launched = sortLogs(
      await client!.getLogs({ address: launcher!, event: TokenLaunchedEvent, fromBlock: from, toBlock: to }),
    );
    for (const log of launched) await handleLaunched(log as unknown as LaunchedLog);

    const curves = [...byCurve.values()].map((c) => c.curve);
    if (curves.length > 0) {
      const logs = sortLogs(
        await client!.getLogs({
          address: curves,
          events: [CurveBuyEvent, CurveSellEvent, CurveCompletedEvent],
          fromBlock: from,
          toBlock: to,
        }),
      );
      for (const log of logs) {
        if (log.eventName === "CurveBuy") {
          const l = log as unknown as BuyLog;
          const { recipient, quoteIn, tokensOut, fee, tax } = l.args;
          if (recipient) await handleTrade(l, true, recipient, quoteIn ?? 0n, tokensOut ?? 0n, (fee ?? 0n) + (tax ?? 0n));
        } else if (log.eventName === "CurveSell") {
          const l = log as unknown as SellLog;
          const { recipient, tokensIn, quoteOut, fee, tax } = l.args;
          if (recipient) await handleTrade(l, false, recipient, quoteOut ?? 0n, tokensIn ?? 0n, (fee ?? 0n) + (tax ?? 0n));
        } else if (log.eventName === "CurveCompleted") {
          const l = log as unknown as CompletedLog;
          const info = l.address ? byCurve.get(l.address.toLowerCase()) : undefined;
          if (info) {
            await curveStore.markGraduated(db!, info.token);
            console.log(`[pons-indexer] Graduated ${info.token} (Pons curve ${info.curve})`);
          }
        }
      }
    }
    await launchpadStore.setCursor(db!, cursorId, to);
  }

  async function tick() {
    if (!bootstrapped) await bootstrap();
    const latest = await client!.getBlockNumber();
    const cursor = await launchpadStore.getCursor(db!, cursorId);
    const configuredStart = ponsStartBlock();
    let from =
      cursor != null
        ? cursor + 1n
        : configuredStart > 0n
          ? configuredStart
          : latest > DEFAULT_LOOKBACK
            ? latest - DEFAULT_LOOKBACK
            : 0n;
    while (!stopped && from <= latest) {
      const to = from + CHUNK - 1n < latest ? from + CHUNK - 1n : latest;
      await processRange(from, to);
      from = to + 1n;
    }
  }

  async function run() {
    try {
      await tick();
    } catch (e) {
      console.error("[pons-indexer] sync error:", e instanceof Error ? e.message : e);
    }
    if (!stopped) timer = setTimeout(run, POLL_MS);
  }

  console.log(`[pons-indexer] Indexing PonsLauncher ${launcher}`);
  void run();

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
