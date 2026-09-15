import { parseAbi, parseAbiItem, type Address, type Log, type PublicClient } from "viem";
import { createDb } from "./db.js";
import { fileURLToPath } from "node:url";
import {
  AUTO_VERIFY_CONTRACTS,
  composeCurveAddress,
  explorerApiUrl,
  getPublicClient,
  launchpadStartBlock,
} from "./chain-client.js";
import { createVerificationQueue, verifyCreatorToken } from "./contract-verifier.js";
import * as launchpadStore from "./launchpad-store.js";
import * as curveStore from "./curve-store.js";
import { publishTokenTrade } from "./pair-live.js";

const VERIFICATION_INPUTS_DIR = fileURLToPath(new URL("../verification", import.meta.url));

const TokenCreatedEvent = parseAbiItem(
  "event TokenCreated(address indexed token, address indexed pair, address indexed creator, address share, string name, string symbol, uint256 virtualQuote, uint256 graduationQuote)",
);
const TradeEvent = parseAbiItem(
  "event Trade(address indexed token, address indexed trader, bool isBuy, uint256 shares, uint256 tokens, uint256 fee, uint256 virtualQuote, uint256 tokenReserve)",
);
const GraduatedEvent = parseAbiItem(
  "event Graduated(address indexed token, uint256 realQuote, uint256 marketCapShares)",
);

type CreatedLog = Log<bigint, number, false, typeof TokenCreatedEvent>;
type TradeLog = Log<bigint, number, false, typeof TradeEvent>;
type GraduatedLog = Log<bigint, number, false, typeof GraduatedEvent>;

const vaultAbi = parseAbi(["function sharePrice() view returns (uint256)"]);

const CHUNK = BigInt(process.env.INDEXER_LOG_CHUNK ?? 5_000);
const POLL_MS = Number(process.env.INDEXER_POLL_MS ?? 1_500);
const DEFAULT_LOOKBACK = 100_000n;

/**
 * First block to scan when no cursor is stored for this curve address.
 * `CURVE_START_BLOCK` (the curve's deploy block) wins; otherwise the launchpad
 * start block, which a redeployed curve would rescan from unnecessarily.
 */
function curveStartBlock(): bigint {
  const raw = process.env.CURVE_START_BLOCK;
  if (raw) {
    try {
      return BigInt(raw);
    } catch {
      /* fall through */
    }
  }
  return launchpadStartBlock();
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

/** Pair share price (USD) at the event block, falling back to the latest. */
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

/** Polls ComposeCurve events with a persisted cursor (backfills anything missed). */
export function startCurveIndexer(): (() => void) | null {
  const client = getPublicClient();
  const curve = composeCurveAddress();
  const db = createDb();
  if (!client || !curve) {
    console.log("[curve-indexer] No RPC or ComposeCurve configured, skipping");
    return null;
  }
  if (!db) {
    console.log("[curve-indexer] No DATABASE_URL, skipping");
    return null;
  }

  const curveAddr: string = curve;
  const cursorId = `curve:${curve.toLowerCase()}`;
  const verifierLog = (m: string) => console.log(`[verifier] ${m}`);
  const queueVerification = AUTO_VERIFY_CONTRACTS
    ? createVerificationQueue(async (token) => {
        try {
          const result = await verifyCreatorToken(
            client!,
            { explorerApiUrl: explorerApiUrl(), inputsDir: VERIFICATION_INPUTS_DIR, log: verifierLog },
            token,
            curve,
          );
          verifierLog(`${token}: creator token ${result}`);
        } catch (e) {
          verifierLog(`${token}: ${e instanceof Error ? e.message : e}`);
        }
      })
    : () => undefined;
  const pairOfToken = new Map<string, Address>();
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;

  async function pairFor(token: string): Promise<Address | null> {
    const key = token.toLowerCase();
    const cached = pairOfToken.get(key);
    if (cached) return cached;
    const row = await curveStore.getToken(db!, curveAddr, key);
    if (!row) return null;
    pairOfToken.set(key, row.pairAddress as Address);
    return row.pairAddress as Address;
  }

  async function handleCreated(log: CreatedLog) {
    const { token, pair, creator, share, name, symbol, virtualQuote, graduationQuote } = log.args;
    if (!token || !pair || !creator || !share || log.blockNumber == null) return;
    const [createdAt, price] = await Promise.all([
      blockTime(client!, log.blockNumber),
      sharePriceUsd(client!, pair, log.blockNumber),
    ]);
    await curveStore.recordToken(db!, {
      tokenAddress: token,
      curveAddress: curveAddr,
      pairAddress: pair,
      shareAddress: share,
      creatorWallet: creator,
      name: name ?? "",
      symbol: symbol ?? "",
      startQuote: virtualQuote ?? 0n,
      graduationQuote: graduationQuote ?? 0n,
      sharePriceUsd: price,
      txHash: log.transactionHash ?? "",
      createdAt,
    });
    pairOfToken.set(token.toLowerCase(), pair);
    console.log(`[curve-indexer] TokenCreated ${symbol} ${token} on pair ${pair}`);
    queueVerification(token);
  }

  async function handleTrade(log: TradeLog) {
    const { token, trader, isBuy, shares, tokens, fee, virtualQuote, tokenReserve } = log.args;
    if (!token || !trader || log.blockNumber == null || !log.transactionHash) return;
    const pair = await pairFor(token);
    if (!pair) return;
    const [createdAt, price] = await Promise.all([
      blockTime(client!, log.blockNumber),
      sharePriceUsd(client!, pair, log.blockNumber),
    ]);
    const result = await curveStore.recordTrade(db!, {
      tokenAddress: token,
      trader,
      isBuy: isBuy ?? false,
      shares: shares ?? 0n,
      tokens: tokens ?? 0n,
      fee: fee ?? 0n,
      virtualQuote: virtualQuote ?? 0n,
      tokenReserve: tokenReserve ?? 1n,
      sharePriceUsd: price,
      txHash: log.transactionHash,
      logIndex: log.logIndex ?? 0,
      createdAt,
    });
    if (!result) return;
    publishTokenTrade({
      tokenAddress: token.toLowerCase(),
      ...curveStore.toTradeJson(result.row),
    });
    console.log(
      `[curve-indexer] ${isBuy ? "Buy" : "Sell"} ${token} $${result.valueUsd.toFixed(2)} → mcap $${result.marketCapUsd.toFixed(2)}`,
    );
  }

  async function processRange(from: bigint, to: bigint) {
    const logs = await client!.getLogs({
      address: curve!,
      events: [TokenCreatedEvent, TradeEvent, GraduatedEvent],
      fromBlock: from,
      toBlock: to,
    });
    logs.sort((a, b) =>
      a.blockNumber === b.blockNumber
        ? (a.logIndex ?? 0) - (b.logIndex ?? 0)
        : (a.blockNumber ?? 0n) < (b.blockNumber ?? 0n)
          ? -1
          : 1,
    );
    for (const log of logs) {
      if (log.eventName === "TokenCreated") await handleCreated(log as unknown as CreatedLog);
      else if (log.eventName === "Trade") await handleTrade(log as unknown as TradeLog);
      else if (log.eventName === "Graduated") {
        const g = log as unknown as GraduatedLog;
        if (g.args.token) {
          await curveStore.markGraduated(db!, g.args.token);
          console.log(`[curve-indexer] Graduated ${g.args.token}`);
        }
      }
    }
    await launchpadStore.setCursor(db!, cursorId, to);
  }

  async function tick() {
    const latest = await client!.getBlockNumber();
    const cursor = await launchpadStore.getCursor(db!, cursorId);
    const configuredStart = curveStartBlock();
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
      console.error("[curve-indexer] sync error:", e instanceof Error ? e.message : e);
    }
    if (!stopped) timer = setTimeout(run, POLL_MS);
  }

  console.log(`[curve-indexer] Indexing ComposeCurve ${curve}`);
  void run();

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
