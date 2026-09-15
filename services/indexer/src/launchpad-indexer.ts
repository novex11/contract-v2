import {
  formatUnits,
  parseAbi,
  parseAbiItem,
  type Address,
  type Log,
  type PublicClient,
} from "viem";
import { getTokenByAddress } from "@compose/config";
import { fileURLToPath } from "node:url";
import { createDb, type Db } from "./db.js";
import { createVerificationQueue, verifyPairContracts } from "./contract-verifier.js";
import {
  AUTO_VERIFY_CONTRACTS,
  explorerApiUrl,
  getPublicClient,
  launchpadStartBlock,
  oracleAddress,
  pairFactoryAddress,
} from "./chain-client.js";
import * as launchpadStore from "./launchpad-store.js";
import { recordAndPublishSnapshot } from "./pair-live.js";

const PairLaunchedEvent = parseAbiItem(
  "event PairLaunched(address indexed pair, address indexed receiptToken, address indexed creator, address tokenA, address tokenB, uint16 weightABps, uint16 creatorFeeBps)",
);
const PoolSeededEvent = parseAbiItem(
  "event PoolSeeded(address indexed pair, address indexed pool, address indexed creator, uint256 positionId, uint256 shares, uint256 quoteAmount)",
);
const DepositedEvent = parseAbiItem(
  "event Deposited(address indexed user, uint256 amountA, uint256 amountB, uint256 sharesMinted, uint256 feeShares, uint256 navUsd8)",
);
const RedeemedEvent = parseAbiItem(
  "event Redeemed(address indexed user, uint256 sharesBurned, uint256 amountA, uint256 amountB, uint256 valueUsd8)",
);

type LaunchLog = Log<bigint, number, false, typeof PairLaunchedEvent>;
type PoolLog = Log<bigint, number, false, typeof PoolSeededEvent>;
type DepositLog = Log<bigint, number, false, typeof DepositedEvent>;
type RedeemLog = Log<bigint, number, false, typeof RedeemedEvent>;

const erc20MetaAbi = parseAbi([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
]);
const vaultAbi = parseAbi([
  "function creator() view returns (address)",
  "function tokenA() view returns (address)",
  "function tokenB() view returns (address)",
  "function weightABps() view returns (uint16)",
  "function creatorFeeBps() view returns (uint16)",
  "function receiptToken() view returns (address)",
  "function navUsd8() view returns (uint256)",
  "function sharePrice() view returns (uint256)",
  "function totalShares() view returns (uint256)",
]);
const factoryAbi = parseAbi(["function isPair(address) view returns (bool)"]);
const oracleAbi = parseAbi(["function getPriceUnchecked(address) view returns (uint256)"]);

const CHUNK = BigInt(process.env.INDEXER_LOG_CHUNK ?? 5_000);
const POLL_MS = Number(process.env.INDEXER_POLL_MS ?? 1_500);
const VERIFICATION_INPUTS_DIR = fileURLToPath(new URL("../verification", import.meta.url));

/** Without a configured start block, only look back this far on first sync. */
const DEFAULT_LOOKBACK = 100_000n;

interface PairInfo {
  tokenA: Address;
  tokenB: Address;
  decimalsA: number;
  decimalsB: number;
}

function pairKeyOf(a: string, b: string): string {
  return `0x${[a, b]
    .map((x) => x.toLowerCase().replace(/^0x/, ""))
    .sort()
    .join("")}`;
}

async function readReceiptMeta(client: PublicClient, receipt: Address) {
  try {
    const [name, symbol] = await Promise.all([
      client.readContract({ address: receipt, abi: erc20MetaAbi, functionName: "name" }),
      client.readContract({ address: receipt, abi: erc20MetaAbi, functionName: "symbol" }),
    ]);
    return { name: String(name).trim(), symbol: String(symbol).trim() };
  } catch {
    return { name: "", symbol: "" };
  }
}

async function tokenDecimals(client: PublicClient, token: Address): Promise<number> {
  const known = getTokenByAddress(token);
  if (known) return known.decimals;
  try {
    return Number(await client.readContract({ address: token, abi: erc20MetaAbi, functionName: "decimals" }));
  } catch {
    return 18;
  }
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

/** Oracle price at the event's block, falling back to the latest price. */
async function priceAt(client: PublicClient, token: Address, blockNumber: bigint): Promise<bigint> {
  const oracle = oracleAddress();
  if (!oracle) return 0n;
  const read = (atBlock?: bigint) =>
    client.readContract({
      address: oracle,
      abi: oracleAbi,
      functionName: "getPriceUnchecked",
      args: [token],
      blockNumber: atBlock,
    });
  try {
    return await read(blockNumber);
  } catch {
    try {
      return await read();
    } catch {
      return 0n;
    }
  }
}

function usd(amount: bigint, price8: bigint, decimals: number): number {
  return Number(formatUnits(amount * price8, decimals + 8));
}

/** Record a pair from its on-chain state. */
async function indexPairFromChain(
  db: Db,
  client: PublicClient,
  pair: Address,
  factory: Address,
  extra: { txHash?: string; createdAt?: Date } = {},
): Promise<PairInfo> {
  const [creator, tokenA, tokenB, weightABps, creatorFeeBps, receiptToken] = await Promise.all([
    client.readContract({ address: pair, abi: vaultAbi, functionName: "creator" }),
    client.readContract({ address: pair, abi: vaultAbi, functionName: "tokenA" }),
    client.readContract({ address: pair, abi: vaultAbi, functionName: "tokenB" }),
    client.readContract({ address: pair, abi: vaultAbi, functionName: "weightABps" }),
    client.readContract({ address: pair, abi: vaultAbi, functionName: "creatorFeeBps" }),
    client.readContract({ address: pair, abi: vaultAbi, functionName: "receiptToken" }),
  ]);
  const [meta, decimalsA, decimalsB] = await Promise.all([
    readReceiptMeta(client, receiptToken),
    tokenDecimals(client, tokenA),
    tokenDecimals(client, tokenB),
  ]);
  const tokA = getTokenByAddress(tokenA);
  const tokB = getTokenByAddress(tokenB);

  await launchpadStore.recordLaunch(db, {
    pairKey: pairKeyOf(tokenA, tokenB),
    pairAddress: pair,
    receiptAddress: receiptToken,
    receiptSymbol: meta.symbol || `p${tokA?.ticker ?? "?"}-${tokB?.ticker ?? "?"}`,
    displayName: meta.name,
    creatorWallet: creator,
    tokenA,
    tokenB,
    tickerA: tokA?.ticker ?? "?",
    tickerB: tokB?.ticker ?? "?",
    categoryA: tokA?.category ?? "unknown",
    categoryB: tokB?.category ?? "unknown",
    weightABps: Number(weightABps),
    creatorFeeBps: Number(creatorFeeBps),
    factoryAddress: factory,
    txHash: extra.txHash,
    createdAt: extra.createdAt,
  });

  return { tokenA, tokenB, decimalsA, decimalsB };
}

/**
 * Make sure a pair launched by the active factory has a row, reading it from
 * chain if the event loop hasn't reached it yet. Returns false for non-pairs.
 */
export async function ensurePairIndexed(pair: Address): Promise<boolean> {
  const db = createDb();
  const client = getPublicClient();
  const factory = pairFactoryAddress();
  if (!db || !client || !factory) return false;
  if (await launchpadStore.getPair(db, pair)) return true;
  const isPair = await client.readContract({
    address: factory,
    abi: factoryAbi,
    functionName: "isPair",
    args: [pair],
  });
  if (!isPair) return false;
  await indexPairFromChain(db, client, pair, factory);
  return true;
}

/**
 * Polls PairFactory + pair vault logs with a persisted block cursor, so the
 * indexer backfills anything it missed while offline. Each event is stored
 * once (unique tx hash + log index).
 */
export function startLaunchpadIndexer(): (() => void) | null {
  const client = getPublicClient();
  const factory = pairFactoryAddress();
  const db = createDb();
  if (!client || !factory) {
    console.log("[launchpad-indexer] No RPC or PairFactory configured, skipping");
    return null;
  }
  if (!db) {
    console.log("[launchpad-indexer] No DATABASE_URL, skipping");
    return null;
  }

  const cursorId = `launchpad:${factory.toLowerCase()}`;
  const log = (m: string) => console.log(`[verifier] ${m}`);
  const queueVerification = AUTO_VERIFY_CONTRACTS
    ? createVerificationQueue(async (pair) => {
        try {
          const result = await verifyPairContracts(
            client,
            { explorerApiUrl: explorerApiUrl(), inputsDir: VERIFICATION_INPUTS_DIR, log },
            pair,
          );
          log(`${pair}: vault ${result.vault}, share ${result.share}`);
        } catch (e) {
          log(`${pair}: ${e instanceof Error ? e.message : e}`);
        }
      })
    : () => undefined;
  const pairs = new Map<string, PairInfo>();
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;

  async function loadKnownPairs() {
    const rows = await launchpadStore.listPairs(db!, {
      sort: "new",
      limit: 10_000,
      factoryAddress: factory,
    });
    for (const row of rows) {
      pairs.set(row.pairAddress.toLowerCase(), {
        tokenA: row.tokenA as Address,
        tokenB: row.tokenB as Address,
        decimalsA: getTokenByAddress(row.tokenA)?.decimals ?? 18,
        decimalsB: getTokenByAddress(row.tokenB)?.decimals ?? 18,
      });
      queueVerification(row.pairAddress as Address);
    }
  }

  async function handleLaunch(log: LaunchLog) {
    const pair = log.args.pair;
    if (!pair || log.blockNumber == null) return;
    const createdAt = await blockTime(client!, log.blockNumber);
    const info = await indexPairFromChain(db!, client!, pair, factory!, {
      txHash: log.transactionHash ?? "",
      createdAt,
    });
    pairs.set(pair.toLowerCase(), info);
    console.log(`[launchpad-indexer] PairLaunched ${pair} (block ${log.blockNumber})`);
    queueVerification(pair);
  }

  /** Chart point right after a buy/sell, read at the event's block. */
  async function snapshotAtBlock(pair: Address, blockNumber: bigint, createdAt: Date) {
    const readAll = (atBlock?: bigint) =>
      Promise.all([
        client!.readContract({ address: pair, abi: vaultAbi, functionName: "navUsd8", blockNumber: atBlock }),
        client!.readContract({ address: pair, abi: vaultAbi, functionName: "sharePrice", blockNumber: atBlock }),
        client!.readContract({ address: pair, abi: vaultAbi, functionName: "totalShares", blockNumber: atBlock }),
      ]);
    try {
      let values: [bigint, bigint, bigint];
      try {
        values = await readAll(blockNumber);
      } catch {
        values = await readAll();
      }
      const [nav8, price8, shares] = values;
      const navUsd = Number(nav8) / 1e8;
      await recordAndPublishSnapshot(db!, {
        pairAddress: pair,
        navUsd,
        sharePrice: Number(price8) / 1e8,
        totalShares: shares.toString(),
        createdAt,
        reason: "trade",
      });
      await launchpadStore.updatePairTvl(db!, pair, navUsd);
    } catch (e) {
      console.error(`[launchpad-indexer] snapshot ${pair} failed:`, e instanceof Error ? e.message : e);
    }
  }

  async function handleDeposit(log: DepositLog) {
    const info = pairs.get(log.address.toLowerCase());
    const { user, amountA, amountB, sharesMinted, feeShares } = log.args;
    if (!info || !user || log.blockNumber == null || !log.transactionHash) return;
    const [priceA, priceB, createdAt] = await Promise.all([
      priceAt(client!, info.tokenA, log.blockNumber),
      priceAt(client!, info.tokenB, log.blockNumber),
      blockTime(client!, log.blockNumber),
    ]);
    const valueUsd = usd(amountA ?? 0n, priceA, info.decimalsA) + usd(amountB ?? 0n, priceB, info.decimalsB);
    const minted = sharesMinted ?? 0n;
    const fee = feeShares ?? 0n;
    const creatorFeeUsd = minted + fee > 0n ? (valueUsd * Number(fee)) / Number(minted + fee) : 0;

    const row = await launchpadStore.recordPairDeposit(db!, {
      pairAddress: log.address,
      wallet: user,
      valueUsd,
      amountA: (amountA ?? 0n).toString(),
      amountB: (amountB ?? 0n).toString(),
      sharesMinted: minted.toString(),
      creatorFeeUsd,
      txHash: log.transactionHash,
      logIndex: log.logIndex ?? 0,
      createdAt,
    });
    if (row) {
      console.log(`[launchpad-indexer] Deposit ${log.address} $${valueUsd.toFixed(2)} by ${user}`);
      await snapshotAtBlock(log.address, log.blockNumber, createdAt);
    }
  }

  async function handleRedeem(log: RedeemLog) {
    const { user, sharesBurned, amountA, amountB, valueUsd8 } = log.args;
    if (!pairs.has(log.address.toLowerCase()) || !user || log.blockNumber == null || !log.transactionHash) return;
    const valueUsd = Number(valueUsd8 ?? 0n) / 1e8;
    const createdAt = await blockTime(client!, log.blockNumber);
    const row = await launchpadStore.recordPairRedeem(db!, {
      pairAddress: log.address,
      wallet: user,
      valueUsd,
      amountA: (amountA ?? 0n).toString(),
      amountB: (amountB ?? 0n).toString(),
      sharesBurned: (sharesBurned ?? 0n).toString(),
      txHash: log.transactionHash,
      logIndex: log.logIndex ?? 0,
      createdAt,
    });
    if (row) {
      console.log(`[launchpad-indexer] Redeem ${log.address} $${valueUsd.toFixed(2)} by ${user}`);
      await snapshotAtBlock(log.address, log.blockNumber, createdAt);
    }
  }

  async function handlePoolSeeded(log: PoolLog) {
    const { pair, pool } = log.args;
    if (!pair || !pool) return;
    await launchpadStore.setPairPool(db!, pair, pool);
    console.log(`[launchpad-indexer] PoolSeeded ${pair} -> ${pool}`);
  }

  async function processRange(from: bigint, to: bigint) {
    const launches = await client!.getLogs({
      address: factory!,
      event: PairLaunchedEvent,
      fromBlock: from,
      toBlock: to,
    });
    for (const log of launches) await handleLaunch(log as LaunchLog);

    const poolLogs = await client!.getLogs({
      address: factory!,
      event: PoolSeededEvent,
      fromBlock: from,
      toBlock: to,
    });
    for (const log of poolLogs) await handlePoolSeeded(log as PoolLog);

    if (pairs.size > 0) {
      const logs = await client!.getLogs({
        address: [...pairs.keys()] as Address[],
        events: [DepositedEvent, RedeemedEvent],
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
        if (log.eventName === "Deposited") await handleDeposit(log as unknown as DepositLog);
        else if (log.eventName === "Redeemed") await handleRedeem(log as unknown as RedeemLog);
      }
    }

    await launchpadStore.setCursor(db!, cursorId, to);
  }

  async function tick() {
    const latest = await client!.getBlockNumber();
    const cursor = await launchpadStore.getCursor(db!, cursorId);
    const configuredStart = launchpadStartBlock();
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
      console.error("[launchpad-indexer] sync error:", e instanceof Error ? e.message : e);
    }
    if (!stopped) timer = setTimeout(run, POLL_MS);
  }

  console.log(`[launchpad-indexer] Indexing PairFactory ${factory}`);
  loadKnownPairs()
    .catch((e) => console.error("[launchpad-indexer] failed to load pairs:", e))
    .finally(() => void run());

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
