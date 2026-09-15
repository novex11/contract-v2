import type { PreviewResponse } from "@compose/sdk";

export const ALLOCATOR_URL =
  process.env.NEXT_PUBLIC_ALLOCATOR_URL ?? "http://localhost:3001";
export const QUOTE_URL =
  process.env.NEXT_PUBLIC_QUOTE_URL ?? "http://localhost:3002";
export const INDEXER_URL =
  process.env.NEXT_PUBLIC_INDEXER_URL ?? "http://localhost:3003";

async function parseJson<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const raw = (err as { error?: unknown }).error;
    throw new Error(
      typeof raw === "string" ? raw : `Request failed (${res.status})`,
    );
  }
  return res.json() as Promise<T>;
}

export type Strategy = "defensive" | "balanced" | "aggressive";

export interface PreviewBody {
  depositTicker: string;
  depositUsd: number;
  strategy: Strategy;
  preferred?: string[];
  excluded?: string[];
  /** Max tokens in the basket (default 5). 0 = all eligible. */
  maxTokens?: number;
  /** The vault's fixed on-chain mix; when set the allocator prices exactly this basket. */
  allocation?: Array<{ ticker: string; weight: number }>;
}

export type { PreviewResponse };

export async function fetchPreview(
  body: PreviewBody,
  walletAddress?: string,
  signal?: AbortSignal,
): Promise<PreviewResponse> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (walletAddress) {
    headers["x-wallet-address"] = walletAddress;
  }

  const res = await fetch(`${ALLOCATOR_URL}/preview`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal,
  });
  return parseJson<PreviewResponse>(res);
}

export interface DepositCosts {
  platformFeeUsd: number;
  estimatedGasUsd: number;
  estimatedMarketCostUsd: number;
  estimatedTotalExternalUsd: number;
  swapLegs: number;
  source?: string;
}

export async function fetchDepositCosts(
  depositUsd: number,
  allocation?: Array<{ ticker: string; usd: number }>,
  depositTicker?: string,
): Promise<DepositCosts> {
  const res = await fetch(`${QUOTE_URL}/estimate-deposit-costs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ depositUsd, allocation, depositTicker }),
  });
  return parseJson<DepositCosts>(res);
}

/**
 * Tell the indexer about a mined basket deposit. The indexer verifies the
 * receipt and takes every amount from the chain; only the allocation breakdown
 * (cosmetic) and the hints are used from here.
 */
export async function recordDeposit(body: {
  wallet: string;
  txHash: string;
  allocation: Array<{ ticker: string; weight: number; usd: number }>;
  depositTicker?: string;
  strategy?: string;
  vaultId?: string;
}) {
  const res = await fetch(`${INDEXER_URL}/deposits`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return parseJson(res);
}

export async function recordRedeem(body: {
  wallet: string;
  txHash: string;
  valueUsd?: number;
  vaultId?: string;
}) {
  const res = await fetch(`${INDEXER_URL}/redeems`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return parseJson(res);
}

// ─── Direct trades ──────────────────────────────────────

export type TradeSide = "buy" | "sell";

export interface TradeBody {
  wallet: string;
  ticker: string;
  side: TradeSide;
  qty: number;
  priceUsd: number;
  valueUsd: number;
  txHash?: string;
}

export interface DirectHolding {
  ticker: string;
  qty: number;
  avgPriceUsd: number;
  costUsd: number;
  updatedAt: string;
}

export async function recordTrade(body: TradeBody) {
  const res = await fetch(`${INDEXER_URL}/trades`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return parseJson<{
    ok: boolean;
    holding: DirectHolding;
    activity: ActivityRecord;
  }>(res);
}

export async function fetchHoldings(wallet: string) {
  const res = await fetch(`${INDEXER_URL}/holdings/${wallet}`);
  return parseJson<{ wallet: string; holdings: DirectHolding[] }>(res);
}

// ─── Portfolio / activity / vault ───────────────────────

export async function fetchPortfolio(wallet: string) {
  const res = await fetch(`${INDEXER_URL}/portfolio/${wallet}`);
  return parseJson<PortfolioResponse>(res);
}

export interface ActivityRecord {
  id: string;
  type: string;
  timestamp: string;
  txHash: string;
  valueUsd: number;
  stockbackUsd: number;
  status: string;
  vaultId?: string;
  assets?: string[];
  receiptTokens?: string;
}

export interface PortfolioResponse {
  wallet: string;
  currentValueUsd: number;
  netPerformanceUsd: number;
  totalStockbackUsd: number;
  receiptBalance: string;
  strategy: string | null;
  depositAsset: string | null;
  vaultId?: string | null;
  allocation: Array<{ ticker: string; weight: number; usd: number }>;
  directHoldings?: DirectHolding[];
  sharePrice?: number;
  openingNetUsd?: number;
  empty?: boolean;
}

export async function fetchActivity(wallet: string) {
  const res = await fetch(`${INDEXER_URL}/activity/${wallet}`);
  return parseJson<{ records: ActivityRecord[] }>(res);
}

export interface VaultResponse {
  id: string;
  strategy: string;
  depositAsset: string;
  tvlUsd: number;
  sharePrice: number;
  receiptSupply: string;
  holdings: Array<{ ticker: string; weight: number; usd: number }>;
  paused: boolean;
  contractAddress: string;
}

export async function fetchVault(id: string) {
  const res = await fetch(`${INDEXER_URL}/vault/${id}`);
  return parseJson<VaultResponse>(res);
}

// ─── Launchpad ──────────────────────────────────────────

export interface LaunchpadPair {
  pairAddress: string;
  receiptAddress: string;
  receiptSymbol: string;
  creatorWallet: string;
  tickerA: string;
  tickerB: string;
  categoryA: string;
  categoryB: string;
  weightABps: number;
  creatorFeeBps: number;
  tvlUsd: number;
  totalDepositsUsd: number;
  totalDepositors: number;
  creatorEarningsUsd: number;
  displayName?: string;
  description?: string;
  imageUrl?: string;
  logoUrl?: string;
  websiteUrl?: string;
  numeraireTicker?: string;
  status: string;
  createdAt: string;
}

export interface LaunchpadPairDetail extends LaunchpadPair {
  tokenA: string;
  tokenB: string;
  /** Source-verification state of the vault and its share token (published automatically after launch). */
  verification?: { vault: ContractVerification; receipt: ContractVerification };
}

/** Where a launched contract's source has been published (see indexer /launchpad/verification/:address). */
export interface ContractVerification {
  address: string;
  kind: "PairVault" | "PairShareToken" | "CreatorToken" | null;
  /** True when the source is published on at least one backend. */
  verified: boolean;
  sourcify: boolean;
  blockscout: boolean;
  /** Public source page on Sourcify, when verified there. */
  sourcifyUrl: string | null;
  updatedAt: string | null;
}

export interface LaunchpadStats {
  totalPairs: number;
  totalTvlUsd: number;
  totalCreatorEarningsUsd: number;
  totalCreators: number;
}

export interface LaunchpadActivity {
  deposits: Array<{
    wallet: string;
    valueUsd: number;
    amountA: string;
    amountB: string;
    sharesMinted: string;
    creatorFeeUsd: number;
    txHash: string;
    timestamp: string;
  }>;
  redeems: Array<{
    wallet: string;
    valueUsd: number;
    amountA: string;
    amountB: string;
    sharesBurned: string;
    txHash: string;
    timestamp: string;
  }>;
}

export async function fetchLaunchpadPairs(
  sort: "tvl" | "new" | "depositors" = "tvl",
): Promise<{ pairs: LaunchpadPair[] }> {
  const res = await fetch(
    `${INDEXER_URL}/launchpad/pairs?sort=${encodeURIComponent(sort)}`,
  );
  return parseJson(res);
}

export async function fetchLaunchpadPair(
  address: string,
): Promise<{ pair: LaunchpadPairDetail; activity: LaunchpadActivity }> {
  const res = await fetch(`${INDEXER_URL}/launchpad/pair/${address}`);
  return parseJson(res);
}

export type PairHistoryRange = "1h" | "24h" | "7d" | "30d" | "all";

export interface PairHistoryPoint {
  timestamp: string;
  navUsd: number;
  sharePrice: number;
  totalShares: string;
}

export interface PairHistoryResponse {
  range: PairHistoryRange;
  points: PairHistoryPoint[];
  source?: "snapshots" | "reconstructed";
}

export async function fetchPairHistory(
  address: string,
  range: PairHistoryRange = "24h",
): Promise<PairHistoryResponse> {
  const res = await fetch(
    `${INDEXER_URL}/launchpad/pair/${address}/history?range=${range}`,
    { cache: "no-store" },
  );
  return parseJson(res);
}

export type PairCandleInterval = "1m" | "5m" | "15m" | "1h";
export type PairCandleMetric = "navUsd" | "sharePrice";

export interface PairCandle {
  /** Bucket start (ISO) */
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface PairCandlesResponse {
  interval: PairCandleInterval;
  metric: PairCandleMetric;
  candles: PairCandle[];
}

export async function fetchPairCandles(
  address: string,
  interval: PairCandleInterval,
  metric: PairCandleMetric,
): Promise<PairCandlesResponse> {
  const res = await fetch(
    `${INDEXER_URL}/launchpad/pair/${address}/candles?interval=${interval}&metric=${metric}`,
    { cache: "no-store" },
  );
  return parseJson(res);
}

/** Pushed by the indexer the moment a pair trades or its price moves. */
export interface PairLiveSnapshot {
  pairAddress: string;
  navUsd: number;
  sharePrice: number;
  totalShares: string;
  timestamp: string;
  reason: "trade" | "tick";
}

export function pairStreamUrl(address: string): string {
  return `${INDEXER_URL}/launchpad/pair/${address.toLowerCase()}/stream`;
}

/** Creator fee shares already cashed out (18-decimal string). */
export async function fetchCreatorClaims(address: string): Promise<{ claimedShares: string }> {
  const res = await fetch(`${INDEXER_URL}/launchpad/pair/${address.toLowerCase()}/creator-claims`, {
    cache: "no-store",
  });
  return parseJson(res);
}

// ─── Bonding-curve creator tokens ───────────────────────

export interface CurveToken {
  tokenAddress: string;
  pairAddress: string;
  shareAddress: string;
  creatorWallet: string;
  name: string;
  symbol: string;
  graduated: boolean;
  priceUsd: number;
  marketCapUsd: number;
  startMarketCapUsd: number;
  graduationMarketCapUsd: number;
  sharePriceUsd: number;
  progressBps: number;
  tradesCount: number;
  txHash: string;
  createdAt: string;
  tickerA?: string;
  tickerB?: string;
  pairName?: string;
  pairDescription?: string;
  /** Pair banner (wide cover) — the token shares the pair's identity. */
  imageUrl?: string;
  /** Pair logo (square avatar). */
  logoUrl?: string;
  volume24hUsd?: number;
  /** Distinct wallets holding the token (indexer estimate). */
  holders?: number;
  /** Source-verification state of the token contract (detail endpoint only). */
  verification?: ContractVerification;
}

export type CurveTokenSort = "new" | "mcap" | "volume";

export interface CurveTrade {
  trader: string;
  isBuy: boolean;
  shares: string;
  tokens: string;
  priceUsd: number;
  marketCapUsd: number;
  valueUsd: number;
  txHash: string;
  logIndex: number;
  timestamp: string;
}

/** One point of a token's market-cap line: the launch, every trade, and "now". */
export interface TokenHistoryPoint {
  timestamp: string;
  marketCapUsd: number;
  priceUsd: number;
  isBuy?: boolean;
  txHash?: string;
  trader?: string;
}

export interface TokenHistoryResponse {
  range: PairHistoryRange;
  points: TokenHistoryPoint[];
}

/** Pushed by the indexer for every trade of a creator token. */
export interface TokenLiveTrade extends CurveTrade {
  tokenAddress: string;
}

export async function fetchCurveTokens(sort: CurveTokenSort = "mcap"): Promise<{ tokens: CurveToken[] }> {
  const res = await fetch(`${INDEXER_URL}/launchpad/tokens?sort=${sort}`, { cache: "no-store" });
  return parseJson(res);
}

export interface CurveTokenStats {
  tokens: number;
  totalMarketCapUsd: number;
  volume24hUsd: number;
}

export async function fetchCurveTokenStats(): Promise<CurveTokenStats> {
  const res = await fetch(`${INDEXER_URL}/launchpad/tokens/stats`, { cache: "no-store" });
  return parseJson(res);
}

export async function fetchCurveToken(address: string): Promise<{ token: CurveToken; trades: CurveTrade[] }> {
  const res = await fetch(`${INDEXER_URL}/launchpad/token/${address.toLowerCase()}`, { cache: "no-store" });
  return parseJson(res);
}

export async function fetchTokenCandles(
  address: string,
  interval: PairCandleInterval,
): Promise<{ interval: PairCandleInterval; candles: PairCandle[] }> {
  const res = await fetch(
    `${INDEXER_URL}/launchpad/token/${address.toLowerCase()}/candles?interval=${interval}`,
    { cache: "no-store" },
  );
  return parseJson(res);
}

export async function fetchTokenHistory(
  address: string,
  range: PairHistoryRange = "24h",
): Promise<TokenHistoryResponse> {
  const res = await fetch(
    `${INDEXER_URL}/launchpad/token/${address.toLowerCase()}/history?range=${range}`,
    { cache: "no-store" },
  );
  return parseJson(res);
}

export function tokenStreamUrl(address: string): string {
  return `${INDEXER_URL}/launchpad/token/${address.toLowerCase()}/stream`;
}

/** Record a confirmed claim transaction; the indexer verifies it on-chain. */
export async function recordCreatorClaim(
  address: string,
  txHash: string,
): Promise<{ ok: true; claimedShares: string; recordedShares: string }> {
  const res = await fetch(`${INDEXER_URL}/launchpad/pair/${address.toLowerCase()}/creator-claims`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ txHash }),
  });
  return parseJson(res);
}

export async function fetchLaunchpadByCreator(
  wallet: string,
): Promise<{ pairs: LaunchpadPair[] }> {
  const res = await fetch(`${INDEXER_URL}/launchpad/creator/${wallet}`);
  return parseJson(res);
}

export async function fetchLaunchpadStats(): Promise<LaunchpadStats> {
  const res = await fetch(`${INDEXER_URL}/launchpad/stats`);
  return parseJson(res);
}

export async function uploadLaunchpadImage(
  file: File,
): Promise<{ ok: true; id: string; imageUrl: string }> {
  const form = new FormData();
  form.append("file", file);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const res = await fetch(`${INDEXER_URL}/launchpad/upload-image`, {
      method: "POST",
      body: form,
      signal: controller.signal,
    });
    return parseJson(res);
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      throw new Error("Upload timed out — Redis is slow. Try a smaller image or paste a URL.");
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export interface LaunchpadMetadataBody {
  pairAddress: string;
  displayName?: string;
  description?: string;
  imageUrl?: string;
  logoUrl?: string;
  websiteUrl?: string;
  numeraireTicker?: string;
  /** ISO timestamp included in the signed message */
  issuedAt: string;
  /** Creator signature over `pairMetadataMessage` */
  signature: `0x${string}`;
}

/**
 * Save a launched pair's profile. The indexer verifies the signature belongs to
 * the pair's on-chain creator. Deposits and redeems are indexed from chain events.
 */
export async function saveLaunchpadMetadata(body: LaunchpadMetadataBody) {
  const res = await fetch(`${INDEXER_URL}/launchpad/launch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return parseJson<{ ok: boolean }>(res);
}

export interface BackendHealth {
  allocator: boolean;
  quote: boolean;
  indexer: boolean;
}

export async function checkBackendHealth(): Promise<BackendHealth> {
  const probe = (url: string) =>
    fetch(`${url}/health`, { signal: AbortSignal.timeout(2500) });
  const [a, q, i] = await Promise.allSettled([
    probe(ALLOCATOR_URL),
    probe(QUOTE_URL),
    probe(INDEXER_URL),
  ]);
  return {
    allocator: a.status === "fulfilled" && a.value.ok,
    quote: q.status === "fulfilled" && q.value.ok,
    indexer: i.status === "fulfilled" && i.value.ok,
  };
}
