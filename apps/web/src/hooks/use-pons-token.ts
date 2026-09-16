"use client";

import { useCallback, useMemo, useState } from "react";
import { decodeEventLog, parseAbiItem, type Address, type Hash, type Hex } from "viem";
import { useReadContract, useReadContracts } from "wagmi";
import {
  PONS_FACTORY_ADDRESS,
  PONS_LAUNCHER_ADDRESS,
  PONS_ROUTER_ADDRESS,
  USDG_ADDRESS,
  WETH_ADDRESS,
  erc20Abi,
  ponsLauncherAbi,
  ponsLauncherReady,
  ponsRouterAbi,
  ponsRouterReady,
  ponsV2BondingCurveAbi,
  ponsV2FeeEscrowAbi,
  ponsV2LaunchFactoryAbi,
} from "@/lib/contracts";
import { useContractTx } from "@/lib/tx";
import { swapPath, type QuoteAsset, type TradeStage } from "@/hooks/use-pair-trade";

const REFRESH_MS = 10_000;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const ZERO_BYTES32 = `0x${"0".repeat(64)}` as Hex;
const DEADLINE_SECONDS = 20 * 60;
const deadline = () => BigInt(Math.floor(Date.now() / 1000) + DEADLINE_SECONDS);

/** Pons launch config every Compose launch uses (1B supply, 1% curve fee). */
export const PONS_LAUNCH_CONFIG_ID = 0n;
/** Pons taxes non-exempt buys for this long after launch (99% decaying to 0). */
export const PONS_SNIPE_WINDOW_SECONDS = 3;

const same = (a: string | undefined, b: string | undefined) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

export function ponsTokenUrl(token: string): string {
  return `https://www.ponsfamily.com/token/${token}`;
}

// ─── Launch ─────────────────────────────────────────────

export interface PonsQuoteOption {
  address: Address;
  symbol: string;
  decimals: number;
  kind: "stock" | "usdg";
}

/**
 * Whether the pair can launch its token on Pons, which of its legs (or USDG)
 * Pons accepts as the quote asset, the launch fee, and the pinned economics
 * for the selected quote. `launchedToken` is the pair's Pons token if any.
 */
export function usePonsLaunchInfo(i: {
  pair?: Address;
  tokenA?: Address;
  tokenB?: Address;
  tickerA?: string;
  tickerB?: string;
  decA?: number;
  decB?: number;
  selectedQuote?: Address;
}) {
  const candidates = useMemo<PonsQuoteOption[]>(() => {
    const out: PonsQuoteOption[] = [];
    if (i.tokenA) out.push({ address: i.tokenA, symbol: i.tickerA ?? "Token A", decimals: i.decA ?? 18, kind: "stock" });
    if (i.tokenB) out.push({ address: i.tokenB, symbol: i.tickerB ?? "Token B", decimals: i.decB ?? 18, kind: "stock" });
    if (USDG_ADDRESS !== ZERO_ADDRESS) out.push({ address: USDG_ADDRESS, symbol: "USDG", decimals: 6, kind: "usdg" });
    return out;
  }, [i.tokenA, i.tokenB, i.tickerA, i.tickerB, i.decA, i.decB]);

  const contracts = useMemo(
    () => [
      { address: PONS_FACTORY_ADDRESS, abi: ponsV2LaunchFactoryAbi, functionName: "launchFee" },
      { address: PONS_FACTORY_ADDRESS, abi: ponsV2LaunchFactoryAbi, functionName: "canLaunch", args: [PONS_LAUNCHER_ADDRESS] },
      ...(i.pair ? [{ address: PONS_LAUNCHER_ADDRESS, abi: ponsLauncherAbi, functionName: "tokenOfPair", args: [i.pair] }] : []),
      ...candidates.map((c) => ({
        address: PONS_FACTORY_ADDRESS,
        abi: ponsV2LaunchFactoryAbi,
        functionName: "approvedPairTokens",
        args: [c.address],
      })),
    ],
    [i.pair, candidates],
  );
  const reads = useReadContracts({
    // Mixed ABIs in one multicall; results are narrowed by position below.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    contracts: contracts as any,
    query: { enabled: ponsLauncherReady, refetchInterval: 30_000 },
  });
  const r = reads.data;
  const offset = i.pair ? 3 : 2;
  const launchFee = r?.[0]?.status === "success" ? (r[0].result as bigint) : undefined;
  const gateOpen = r?.[1]?.status === "success" ? (r[1].result as boolean) : undefined;
  const launched = i.pair && r?.[2]?.status === "success" ? (r[2].result as Address) : undefined;
  const approvedQuotes = candidates.filter((_, k) => r?.[offset + k]?.status === "success" && (r[offset + k]!.result as boolean));

  const economics = useReadContract({
    address: PONS_LAUNCHER_ADDRESS,
    abi: ponsLauncherAbi,
    functionName: "previewEconomics",
    args: i.selectedQuote ? [PONS_LAUNCH_CONFIG_ID, i.selectedQuote] : undefined,
    query: { enabled: ponsLauncherReady && !!i.selectedQuote, refetchInterval: 30_000 },
  });

  const refetch = useCallback(() => Promise.all([reads.refetch(), economics.refetch()]), [reads, economics]);
  const result: PonsLaunchInfo = {
    ready: ponsLauncherReady && gateOpen === true,
    gateOpen,
    launchFee,
    approvedQuotes,
    launchedToken: launched === undefined ? undefined : launched === ZERO_ADDRESS ? null : launched,
    expectedEconomics: (economics.data as Hex | undefined) ?? ZERO_BYTES32,
    isLoading: reads.isLoading,
    refetch,
  };
  return result;
}

export interface PonsLaunchInfo {
  /** Contracts configured on this network and Pons currently accepting launches. */
  ready: boolean;
  gateOpen: boolean | undefined;
  launchFee: bigint | undefined;
  approvedQuotes: PonsQuoteOption[];
  /** The pair's Pons token: undefined while loading, null if none. */
  launchedToken: Address | null | undefined;
  expectedEconomics: Hex;
  isLoading: boolean;
  refetch: () => Promise<unknown>;
}

const TokenLaunchedEvent = parseAbiItem(
  "event TokenLaunched(address indexed token, address indexed pair, address indexed creator, address curve, address quoteToken, string name, string symbol, uint256 launchConfigId)",
);

function useStage() {
  const [stage, setStage] = useState<TradeStage>("idle");
  const [error, setError] = useState<string | null>(null);
  const [hash, setHash] = useState<Hash | undefined>();
  const reset = useCallback(() => {
    setStage("idle");
    setError(null);
    setHash(undefined);
  }, []);
  const fail = useCallback((e: unknown): never => {
    const message = e instanceof Error ? e.message : String(e);
    setError(message);
    setStage("error");
    throw new Error(message);
  }, []);
  return { stage, setStage, error, setError, hash, setHash, reset, fail };
}

export interface PonsLaunchInput {
  pair: Address;
  quoteToken: Address;
  launchFee: bigint;
  expectedEconomics: Hex;
  /** Opening buy in quote units (0 for none); the creator is exempt from the snipe tax. */
  devBuyQuote: bigint;
  minDevTokens: bigint;
  logo?: string;
  description?: string;
  website?: string;
  creatorTaxBps?: number;
  /** Extra wallets exempt from the 3 s snipe tax (max 32); the creator already is. */
  exemptions?: Address[];
}

/**
 * Pair creator launches the pair's token on Pons v2 through PonsLauncher. The
 * token takes the pair's name and symbol; the quote is one of its stocks or USDG.
 */
export function usePonsLaunch() {
  const { send, approveIfNeeded } = useContractTx();
  const s = useStage();
  const { setStage, setError, setHash, fail } = s;

  const launch = useCallback(
    async (i: PonsLaunchInput): Promise<{ token: Address; curve: Address; hash: Hash }> => {
      setError(null);
      setHash(undefined);
      try {
        if (!ponsLauncherReady) throw new Error("Pons launches are not available on this network yet.");
        if (i.devBuyQuote > 0n) {
          setStage("approve");
          await approveIfNeeded(i.quoteToken, PONS_LAUNCHER_ADDRESS, i.devBuyQuote, { onSubmitted: setHash });
        }
        const salt = new Uint8Array(32);
        crypto.getRandomValues(salt);
        setStage("submit");
        const { hash, receipt } = await send(
          {
            address: PONS_LAUNCHER_ADDRESS,
            abi: ponsLauncherAbi,
            functionName: "launch",
            args: [
              {
                pair: i.pair,
                quoteToken: i.quoteToken,
                launchConfigId: PONS_LAUNCH_CONFIG_ID,
                logo: i.logo ?? "",
                description: i.description ?? "",
                socials: { twitter: "", telegram: "", discord: "", website: i.website ?? "", farcaster: "" },
                creatorTaxBps: i.creatorTaxBps ?? 0,
                buybackEnabled: false,
                expectedEconomics: i.expectedEconomics,
                salt: `0x${Array.from(salt, (b) => b.toString(16).padStart(2, "0")).join("")}` as Hex,
                exemptions: i.exemptions ?? [],
                devBuyQuote: i.devBuyQuote,
                minDevTokens: i.minDevTokens,
              },
            ],
            value: i.launchFee,
          },
          { onSubmitted: setHash },
        );
        for (const log of receipt.logs) {
          if (!same(log.address, PONS_LAUNCHER_ADDRESS)) continue;
          try {
            const decoded = decodeEventLog({ abi: [TokenLaunchedEvent], data: log.data, topics: log.topics });
            setStage("done");
            return { token: decoded.args.token, curve: decoded.args.curve, hash };
          } catch {
            continue;
          }
        }
        throw new Error("Token launched on Pons, but its address was not found in the receipt.");
      } catch (e) {
        return fail(e);
      }
    },
    [approveIfNeeded, send, setStage, setError, setHash, fail],
  );

  return { launch, stage: s.stage, error: s.error, hash: s.hash, reset: s.reset };
}

// ─── On-chain state ─────────────────────────────────────

export interface PonsOnchainState {
  pair: Address;
  curve: Address;
  quoteToken: Address;
  creator: Address;
  launchTime: number;
  /** Quote units per 1e18 tokens, in the quote token's decimals. */
  priceInQuote: bigint;
  /** USD (8 decimals) per 1e18 tokens. */
  priceUsd8: bigint;
  /** Pair shares (1e18) per 1e18 tokens. */
  priceInShares: bigint;
  marketCapUsd8: bigint;
  progressBps: number;
  graduated: boolean;
  quoteSymbol: string;
  quoteDecimals: number;
}

/** A token's Pons market as seen through PonsRouter; undefined while loading, null if not a Pons token. */
export function usePonsOnchain(token: Address | undefined): {
  data: PonsOnchainState | null | undefined;
  isLoading: boolean;
  refetch: () => Promise<unknown>;
} {
  const launch = useReadContract({
    address: PONS_LAUNCHER_ADDRESS,
    abi: ponsLauncherAbi,
    functionName: "launches",
    args: token ? [token] : undefined,
    query: { enabled: !!token && ponsLauncherReady, refetchInterval: 60_000 },
  });
  const l = launch.data as readonly [Address, Address, Address, Address, bigint] | undefined;
  const curve = l && l[1] !== ZERO_ADDRESS ? l[1] : undefined;
  const quote = l && l[1] !== ZERO_ADDRESS ? l[2] : undefined;

  const viewCalls = useMemo(
    () =>
      token && curve && quote
        ? [
            { address: PONS_ROUTER_ADDRESS, abi: ponsRouterAbi, functionName: "priceInQuote", args: [token] },
            { address: PONS_ROUTER_ADDRESS, abi: ponsRouterAbi, functionName: "priceUsd8", args: [token] },
            { address: PONS_ROUTER_ADDRESS, abi: ponsRouterAbi, functionName: "priceInShares", args: [token] },
            { address: PONS_ROUTER_ADDRESS, abi: ponsRouterAbi, functionName: "marketCapUsd8", args: [token] },
            { address: PONS_ROUTER_ADDRESS, abi: ponsRouterAbi, functionName: "progressBps", args: [token] },
            { address: curve, abi: ponsV2BondingCurveAbi, functionName: "graduated" },
            { address: quote, abi: erc20Abi, functionName: "symbol" },
            { address: quote, abi: erc20Abi, functionName: "decimals" },
          ]
        : [],
    [token, curve, quote],
  );
  const views = useReadContracts({
    // Mixed ABIs in one multicall; results are narrowed by position below.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    contracts: viewCalls as any,
    query: { enabled: !!token && !!curve && ponsRouterReady, refetchInterval: REFRESH_MS },
  });
  const r = views.data;
  const big = (k: number) => (r?.[k]?.status === "success" ? (r[k]!.result as bigint) : 0n);

  let data: PonsOnchainState | null | undefined;
  if (!ponsLauncherReady) data = null;
  else if (l === undefined) data = launch.isError ? null : undefined;
  else if (!curve || !quote) data = null;
  else {
    data = {
      pair: l![0],
      curve,
      quoteToken: quote,
      creator: l![3],
      launchTime: Number(l![4]),
      priceInQuote: big(0),
      priceUsd8: big(1),
      priceInShares: big(2),
      marketCapUsd8: big(3),
      progressBps: Number(big(4)),
      graduated: r?.[5]?.status === "success" ? (r[5].result as boolean) : false,
      quoteSymbol: r?.[6]?.status === "success" ? (r[6].result as string) : "",
      quoteDecimals: r?.[7]?.status === "success" ? Number(r[7].result as number | bigint) : 18,
    };
  }
  const refetch = useCallback(() => Promise.all([launch.refetch(), views.refetch()]), [launch, views]);
  return { data, isLoading: data === undefined && (launch.isLoading || views.isLoading), refetch };
}

export function usePonsQuoteBuy(token: Address | undefined, quoteIn: bigint | undefined) {
  const query = useReadContract({
    address: PONS_ROUTER_ADDRESS,
    abi: ponsRouterAbi,
    functionName: "quoteBuy",
    args: token && quoteIn ? [token, quoteIn] : undefined,
    query: { enabled: !!token && !!quoteIn && quoteIn > 0n && ponsRouterReady, refetchInterval: REFRESH_MS },
  });
  const r = query.data as readonly [bigint, bigint] | undefined;
  return { tokensOut: r?.[0], fee: r?.[1], loading: query.isLoading, error: query.error?.message };
}

export function usePonsQuoteSell(token: Address | undefined, tokens: bigint) {
  const query = useReadContract({
    address: PONS_ROUTER_ADDRESS,
    abi: ponsRouterAbi,
    functionName: "quoteSell",
    args: token && tokens > 0n ? [token, tokens] : undefined,
    query: { enabled: !!token && tokens > 0n && ponsRouterReady, refetchInterval: REFRESH_MS },
  });
  const r = query.data as readonly [bigint, bigint] | undefined;
  return { quoteOut: r?.[0], fee: r?.[1], loading: query.isLoading, error: query.error?.message };
}

// ─── Trading ────────────────────────────────────────────

/** How a Pons trade is paid or settled: ETH/USDG (swapped), the curve's quote stock, or pair shares. */
export type PonsPayMethod = QuoteAsset | "QUOTE" | "SHARES";

export interface PonsBuyInput {
  token: Address;
  quoteToken: Address;
  method: Exclude<PonsPayMethod, "SHARES">;
  amountIn: bigint;
  minTokensOut: bigint;
  slippageBps: number;
  /** Quoted route payToken → quote (from useLegQuotes); defaults to the single 0.3% path. */
  path?: `0x${string}`;
}

export interface PonsBuyWithSharesInput {
  token: Address;
  /** The pair vault (it is the share ERC-20). */
  pair: Address;
  quoteToken: Address;
  tokenA: Address;
  tokenB: Address;
  sharesIn: bigint;
  minTokensOut: bigint;
  slippageBps: number;
  pathA?: `0x${string}`;
  pathB?: `0x${string}`;
}

export interface PonsSellInput {
  token: Address;
  quoteToken: Address;
  method: Exclude<PonsPayMethod, "SHARES">;
  tokensIn: bigint;
  minAmountOut: bigint;
  slippageBps: number;
  /** Quoted route quote → receiveToken. */
  path?: `0x${string}`;
}

export interface PonsSellForSharesInput {
  token: Address;
  quoteToken: Address;
  tokenA: Address;
  tokenB: Address;
  tokensIn: bigint;
  minShares: bigint;
  slippageBps: number;
  pathA?: `0x${string}`;
  pathB?: `0x${string}`;
}

function payTokenFor(method: Exclude<PonsPayMethod, "SHARES">, quote: Address): Address {
  if (method === "QUOTE") return quote;
  return method === "ETH" ? WETH_ADDRESS : USDG_ADDRESS;
}

/** Buy/sell Pons-launched tokens through PonsRouter; every trade settles on the Pons curve. */
export function usePonsTrade() {
  const { send, approveIfNeeded } = useContractTx();
  const s = useStage();
  const { setStage, setError, setHash, fail } = s;
  const notReady = () => new Error("Pons tokens are not tradable on this network yet.");

  const buy = useCallback(
    async (i: PonsBuyInput): Promise<Hash> => {
      setError(null);
      setHash(undefined);
      try {
        if (!ponsRouterReady) throw notReady();
        const payToken = payTokenFor(i.method, i.quoteToken);
        if (i.method !== "ETH") {
          setStage("approve");
          await approveIfNeeded(payToken, PONS_ROUTER_ADDRESS, i.amountIn, { onSubmitted: setHash });
        }
        setStage("submit");
        const { hash } = await send(
          {
            address: PONS_ROUTER_ADDRESS,
            abi: ponsRouterAbi,
            functionName: "buy",
            args: [
              {
                token: i.token,
                payToken,
                amountIn: i.amountIn,
                path: i.method === "QUOTE" ? "0x" : (i.path ?? swapPath(payToken, i.quoteToken)),
                minTokensOut: i.minTokensOut,
                maxSlippageBps: i.slippageBps,
                deadline: deadline(),
              },
            ],
            value: i.method === "ETH" ? i.amountIn : undefined,
          },
          { onSubmitted: setHash },
        );
        setStage("done");
        return hash;
      } catch (e) {
        return fail(e);
      }
    },
    [approveIfNeeded, send, setStage, setError, setHash, fail],
  );

  const buyWithShares = useCallback(
    async (i: PonsBuyWithSharesInput): Promise<Hash> => {
      setError(null);
      setHash(undefined);
      try {
        if (!ponsRouterReady) throw notReady();
        setStage("approve");
        await approveIfNeeded(i.pair, PONS_ROUTER_ADDRESS, i.sharesIn, { onSubmitted: setHash });
        setStage("submit");
        const { hash } = await send(
          {
            address: PONS_ROUTER_ADDRESS,
            abi: ponsRouterAbi,
            functionName: "buyWithShares",
            args: [
              {
                token: i.token,
                sharesIn: i.sharesIn,
                pathA: same(i.tokenA, i.quoteToken) ? "0x" : (i.pathA ?? swapPath(i.tokenA, i.quoteToken)),
                pathB: same(i.tokenB, i.quoteToken) ? "0x" : (i.pathB ?? swapPath(i.tokenB, i.quoteToken)),
                minTokensOut: i.minTokensOut,
                maxSlippageBps: i.slippageBps,
                deadline: deadline(),
              },
            ],
          },
          { onSubmitted: setHash },
        );
        setStage("done");
        return hash;
      } catch (e) {
        return fail(e);
      }
    },
    [approveIfNeeded, send, setStage, setError, setHash, fail],
  );

  const sell = useCallback(
    async (i: PonsSellInput): Promise<Hash> => {
      setError(null);
      setHash(undefined);
      try {
        if (!ponsRouterReady) throw notReady();
        const receiveToken = payTokenFor(i.method, i.quoteToken);
        setStage("approve");
        await approveIfNeeded(i.token, PONS_ROUTER_ADDRESS, i.tokensIn, { onSubmitted: setHash });
        setStage("submit");
        const { hash } = await send(
          {
            address: PONS_ROUTER_ADDRESS,
            abi: ponsRouterAbi,
            functionName: "sell",
            args: [
              {
                token: i.token,
                tokensIn: i.tokensIn,
                receiveToken,
                path: i.method === "QUOTE" ? "0x" : (i.path ?? swapPath(i.quoteToken, receiveToken)),
                minAmountOut: i.minAmountOut,
                maxSlippageBps: i.slippageBps,
                unwrapEth: i.method === "ETH",
                deadline: deadline(),
              },
            ],
          },
          { onSubmitted: setHash },
        );
        setStage("done");
        return hash;
      } catch (e) {
        return fail(e);
      }
    },
    [approveIfNeeded, send, setStage, setError, setHash, fail],
  );

  const sellForShares = useCallback(
    async (i: PonsSellForSharesInput): Promise<Hash> => {
      setError(null);
      setHash(undefined);
      try {
        if (!ponsRouterReady) throw notReady();
        setStage("approve");
        await approveIfNeeded(i.token, PONS_ROUTER_ADDRESS, i.tokensIn, { onSubmitted: setHash });
        setStage("submit");
        const { hash } = await send(
          {
            address: PONS_ROUTER_ADDRESS,
            abi: ponsRouterAbi,
            functionName: "sellForShares",
            args: [
              {
                token: i.token,
                tokensIn: i.tokensIn,
                pathA: same(i.tokenA, i.quoteToken) ? "0x" : (i.pathA ?? swapPath(i.quoteToken, i.tokenA)),
                pathB: same(i.tokenB, i.quoteToken) ? "0x" : (i.pathB ?? swapPath(i.quoteToken, i.tokenB)),
                minShares: i.minShares,
                maxSlippageBps: i.slippageBps,
                deadline: deadline(),
              },
            ],
          },
          { onSubmitted: setHash },
        );
        setStage("done");
        return hash;
      } catch (e) {
        return fail(e);
      }
    },
    [approveIfNeeded, send, setStage, setError, setHash, fail],
  );

  return { buy, buyWithShares, sell, sellForShares, stage: s.stage, error: s.error, hash: s.hash, reset: s.reset };
}

// ─── Creator fees ───────────────────────────────────────
// Pons never pushes fees to the creator. The 1% curve fee and the creator tax
// accrue on the token's curve; the creator fee recipient (the pair creator, as
// set by PonsLauncher) sweeps them into Pons's shared fee escrow and then claims
// from the escrow. Only the recipient may sweep (the curve reverts with
// NotFeeSweepOperator for anyone else), so no keeper can do it for them.

export interface PonsCreatorFeeState {
  escrow: Address;
  /** Curve fee waiting on the curve, not yet swept (quote units). */
  curveFee: bigint;
  /** Creator tax waiting on the curve, not yet swept (quote units). */
  creatorTax: bigint;
  /** Pons keeps this share of the curve fee; the rest of it goes to the creator. */
  protocolShareBps: number;
  buybackEnabled: boolean;
  /** What a sweep would credit to the creator right now (quote units). */
  sweepable: bigint;
  /** Already swept and waiting in the escrow for the creator to claim (quote units). */
  claimable: bigint;
}

/** Fee balances a Pons token's creator can sweep from the curve and claim from the escrow. */
export function usePonsCreatorFees(i: { curve?: Address; quoteToken?: Address; creator?: Address }): {
  data: PonsCreatorFeeState | undefined;
  isLoading: boolean;
  refetch: () => Promise<unknown>;
} {
  const escrow = useReadContract({
    address: PONS_FACTORY_ADDRESS,
    abi: ponsV2LaunchFactoryAbi,
    functionName: "feeEscrow",
    query: { enabled: ponsLauncherReady, staleTime: Infinity },
  });
  const escrowAddress = escrow.data as Address | undefined;
  const calls = useMemo(
    () =>
      i.curve && i.quoteToken && i.creator && escrowAddress
        ? [
            { address: i.curve, abi: ponsV2BondingCurveAbi, functionName: "quoteFeeBalance" },
            { address: i.curve, abi: ponsV2BondingCurveAbi, functionName: "creatorTaxBalance" },
            { address: i.curve, abi: ponsV2BondingCurveAbi, functionName: "protocolFeeShareBps" },
            { address: i.curve, abi: ponsV2BondingCurveAbi, functionName: "buybackEnabled" },
            { address: escrowAddress, abi: ponsV2FeeEscrowAbi, functionName: "balanceOfToken", args: [i.creator, i.quoteToken] },
          ]
        : [],
    [i.curve, i.quoteToken, i.creator, escrowAddress],
  );
  const reads = useReadContracts({
    // Mixed ABIs in one multicall; results are narrowed by position below.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    contracts: calls as any,
    query: { enabled: calls.length > 0, refetchInterval: REFRESH_MS },
  });
  const r = reads.data;
  const big = (k: number) => (r?.[k]?.status === "success" ? (r[k]!.result as bigint) : 0n);

  let data: PonsCreatorFeeState | undefined;
  if (escrowAddress && r && r.length === 5) {
    const curveFee = big(0);
    const creatorTax = big(1);
    const protocolShareBps = Number(big(2));
    const creatorFeeShare = curveFee - (curveFee * BigInt(protocolShareBps)) / 10_000n;
    data = {
      escrow: escrowAddress,
      curveFee,
      creatorTax,
      protocolShareBps,
      buybackEnabled: r[3]?.status === "success" ? (r[3].result as boolean) : false,
      sweepable: creatorFeeShare + creatorTax,
      claimable: big(4),
    };
  }
  const refetch = useCallback(() => Promise.all([escrow.refetch(), reads.refetch()]), [escrow, reads]);
  return { data, isLoading: !data && (escrow.isLoading || reads.isLoading), refetch };
}

/** Sweep a Pons curve's fees into the escrow and claim them; both must be sent by the creator fee recipient. */
export function usePonsCreatorFeeActions() {
  const { send } = useContractTx();
  const s = useStage();
  const { setStage, setError, setHash, fail } = s;

  const sweep = useCallback(
    async (curve: Address): Promise<Hash> => {
      setError(null);
      setHash(undefined);
      try {
        setStage("submit");
        // No buyback leg on Compose launches, so no minimum buyback output to protect.
        const { hash } = await send(
          { address: curve, abi: ponsV2BondingCurveAbi, functionName: "sweepFees", args: [0n] },
          { onSubmitted: setHash },
        );
        setStage("done");
        return hash;
      } catch (e) {
        return fail(e);
      }
    },
    [send, setStage, setError, setHash, fail],
  );

  const claim = useCallback(
    async (escrow: Address, quoteToken: Address): Promise<Hash> => {
      setError(null);
      setHash(undefined);
      try {
        setStage("submit");
        const { hash } = await send(
          { address: escrow, abi: ponsV2FeeEscrowAbi, functionName: "claimToken", args: [quoteToken] },
          { onSubmitted: setHash },
        );
        setStage("done");
        return hash;
      } catch (e) {
        return fail(e);
      }
    },
    [send, setStage, setError, setHash, fail],
  );

  return { sweep, claim, stage: s.stage, error: s.error, hash: s.hash, reset: s.reset };
}
