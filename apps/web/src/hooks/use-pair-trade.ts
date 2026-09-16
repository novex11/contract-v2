"use client";

import { useCallback, useMemo, useState } from "react";
import { encodePacked, erc20Abi, maxUint256, type Abi, type Address, type Hash } from "viem";
import { useReadContract, useReadContracts } from "wagmi";
import { isTestnetMode } from "@compose/config";
import {
  pairRouterAbi,
  pairRouterReady,
  pairVaultAbi,
  testUsdgAbi,
  PAIR_ROUTER_ADDRESS,
  SWAP_QUOTER_ADDRESS,
  swapQuoterAbi,
  USDG_ADDRESS,
  WETH_ADDRESS,
  swapQuotesReady,
  usdgReady,
} from "@/lib/contracts";
import { useContractTx } from "@/lib/tx";

const REFRESH_MS = 15_000;

/** Pool fee tier used for every leg (0.3%). */
export const TRADE_POOL_FEE = 3000;
export const DEFAULT_SLIPPAGE_BPS = 100;
/** Quote validity sent to PairRouter. */
const DEADLINE_SECONDS = 20 * 60;

export type QuoteAsset = "ETH" | "USDG";
export type TradeStage = "idle" | "approve" | "approve-a" | "approve-b" | "operator" | "submit" | "done" | "error";

export function quoteTokenAddress(asset: QuoteAsset): Address {
  return asset === "ETH" ? WETH_ADDRESS : USDG_ADDRESS;
}

export function quoteAssetDecimals(asset: QuoteAsset): number {
  return asset === "ETH" ? 18 : 6;
}

const same = (a: string | undefined, b: string | undefined) =>
  !!a && !!b && a.toLowerCase() === b.toLowerCase();

/** Single-hop Uniswap v3 path at the default tier; empty when no swap is needed. Fallback only. */
export function swapPath(from: Address, to: Address): `0x${string}` {
  if (same(from, to)) return "0x";
  return encodePacked(["address", "uint24", "address"], [from, TRADE_POOL_FEE, to]);
}

/** A concrete Uniswap route for one leg: the exact packed bytes the router executes. */
export interface SwapRoute {
  path: `0x${string}`;
  /** Token addresses along the route, from → … → to. */
  hops: Address[];
  /** Pool fee tier of each hop, in Uniswap units (500 = 0.05%). */
  tiers: number[];
  /** Total pool fees along the route, in basis points (e.g. 35 for 0.05% + 0.3%). */
  feeBps: number;
  amountOut: bigint;
}

/** Fee tiers tried for a direct pool. */
const DIRECT_TIERS = [500, 3000, 10_000] as const;
/** Fee tiers tried per hop when routing through USDG. */
const HOP_TIERS = [500, 3000] as const;

function packPath(hops: Address[], tiers: number[]): `0x${string}` {
  const types: ("address" | "uint24")[] = ["address"];
  const values: (Address | number)[] = [hops[0]!];
  for (let i = 0; i < tiers.length; i++) {
    types.push("uint24", "address");
    values.push(tiers[i]!, hops[i + 1]!);
  }
  return encodePacked(types, values);
}

/**
 * Candidate routes for `from → to`. Mainnet pools sit on different tiers per
 * stock and some stocks only pool against USDG, so we try every direct tier
 * plus a two-hop route through USDG and let the quoter decide. The testnet mock
 * router only knows the single 0.3% direct path.
 */
export function candidateRoutes(from: Address, to: Address): Array<Omit<SwapRoute, "amountOut">> {
  if (same(from, to)) return [];
  if (isTestnetMode()) {
    return [{ path: swapPath(from, to), hops: [from, to], tiers: [TRADE_POOL_FEE], feeBps: TRADE_POOL_FEE / 100 }];
  }
  const out: Array<Omit<SwapRoute, "amountOut">> = [];
  for (const t of DIRECT_TIERS) out.push({ path: packPath([from, to], [t]), hops: [from, to], tiers: [t], feeBps: t / 100 });
  if (!same(from, USDG_ADDRESS) && !same(to, USDG_ADDRESS)) {
    for (const t1 of HOP_TIERS) {
      for (const t2 of HOP_TIERS) {
        out.push({
          path: packPath([from, USDG_ADDRESS, to], [t1, t2]),
          hops: [from, USDG_ADDRESS, to],
          tiers: [t1, t2],
          feeBps: (t1 + t2) / 100,
        });
      }
    }
  }
  return out;
}

/** Human label for a route, e.g. "ETH → USDG → AAPL · 0.05% + 0.3%" or "0.3% Uniswap swap". */
export function describeRoute(route: SwapRoute | undefined, fromSymbol: string, toSymbol: string): string {
  if (!route) return "—";
  const fees = route.tiers.map((t) => `${(t / 10_000).toLocaleString(undefined, { maximumFractionDigits: 2 })}%`).join(" + ");
  if (route.hops.length <= 2) return `${fees} Uniswap swap`;
  return `${fromSymbol} → USDG → ${toSymbol} · ${fees}`;
}

const deadline = () => BigInt(Math.floor(Date.now() / 1000) + DEADLINE_SECONDS);

interface QuoteCall {
  address: Address;
  abi: Abi;
  functionName: "quoteExactInput";
  args: readonly [`0x${string}`, bigint];
}

function quoteCall(path: `0x${string}`, amount: bigint): QuoteCall {
  return { address: SWAP_QUOTER_ADDRESS, abi: swapQuoterAbi, functionName: "quoteExactInput", args: [path, amount] };
}

export interface LegQuote {
  /** Amount of `to` received; equals the input when no swap is needed. */
  amountOut: bigint;
  /** Chosen route; undefined when the leg needs no swap. */
  route?: SwapRoute;
}

/**
 * Quote two legs by trying every candidate route in one multicall and keeping
 * the best output per leg. A reverting candidate means that pool does not
 * exist and is ignored. A leg that needs no swap passes its amount through.
 */
export function useLegQuotes(legs: Array<{ from: Address; to: Address; amount: bigint }> | null) {
  const plan = useMemo(() => {
    if (!legs) return null;
    return legs.map((leg) =>
      !same(leg.from, leg.to) && leg.amount > 0n ? candidateRoutes(leg.from, leg.to) : [],
    );
  }, [legs]);
  const calls = useMemo(() => {
    if (!plan || !legs) return [];
    const out: QuoteCall[] = [];
    plan.forEach((routes, i) => routes.forEach((r) => out.push(quoteCall(r.path, legs[i]!.amount))));
    return out;
  }, [plan, legs]);
  const query = useReadContracts({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    contracts: calls as any,
    query: { enabled: swapQuotesReady && calls.length > 0, refetchInterval: REFRESH_MS },
  });

  let k = 0;
  let anyNoRoute = false;
  const quotes: Array<LegQuote | undefined> | undefined = legs?.map((leg, i) => {
    const routes = plan?.[i] ?? [];
    if (routes.length === 0) return { amountOut: leg.amount };
    if (!query.data) {
      k += routes.length;
      return undefined;
    }
    let best: SwapRoute | undefined;
    for (const r of routes) {
      const item = query.data[k++];
      if (item?.status !== "success") continue;
      // QuoterV2 returns (amountOut, ...); the testnet router returns amountOut alone.
      const res = item.result as bigint | readonly [bigint, ...unknown[]];
      const amountOut = Array.isArray(res) ? (res[0] as bigint) : (res as bigint);
      if (!best || amountOut > best.amountOut) best = { ...r, amountOut };
    }
    if (!best) {
      anyNoRoute = true;
      return undefined;
    }
    return { amountOut: best.amountOut, route: best };
  });

  return {
    outs: quotes?.map((q) => q?.amountOut),
    routes: quotes?.map((q) => q?.route),
    loading: query.isLoading,
    error: query.error?.message ?? (query.data && anyNoRoute ? "No Uniswap pool found for this route." : undefined),
  };
}

// ─── Quotes ─────────────────────────────────────────────

export interface BuyQuoteInput {
  pair?: Address;
  tokenA?: Address;
  tokenB?: Address;
  reserveA: bigint;
  reserveB: bigint;
  priceA8?: bigint;
  priceB8?: bigint;
  decA: number;
  decB: number;
  asset: QuoteAsset;
  amountIn: bigint;
  feeBps: number;
  isCreator: boolean;
  /** Recipient is fee-exempt on the pair (e.g. the CurveRouter): no creator deposit fee. */
  feeExempt?: boolean;
}

/** Mirrors PairRouter.buy: split by reserve value, swap each leg, previewDeposit. */
export function useBuyQuote(i: BuyQuoteInput) {
  const payToken = quoteTokenAddress(i.asset);
  const ready =
    !!i.pair && !!i.tokenA && !!i.tokenB && !!i.priceA8 && !!i.priceB8 &&
    i.reserveA > 0n && i.reserveB > 0n && i.amountIn > 0n;

  let inForA = 0n;
  if (ready) {
    const valueA = (i.reserveA * i.priceA8!) / 10n ** BigInt(i.decA);
    const valueB = (i.reserveB * i.priceB8!) / 10n ** BigInt(i.decB);
    inForA = valueA + valueB > 0n ? (i.amountIn * valueA) / (valueA + valueB) : 0n;
  }
  const inForB = ready ? i.amountIn - inForA : 0n;

  const legs = useLegQuotes(
    ready
      ? [
          { from: payToken, to: i.tokenA!, amount: inForA },
          { from: payToken, to: i.tokenB!, amount: inForB },
        ]
      : null,
  );
  const outA = legs.outs?.[0];
  const outB = legs.outs?.[1];
  const routeA = legs.routes?.[0];
  const routeB = legs.routes?.[1];
  const haveOuts = outA !== undefined && outB !== undefined;

  const preview = useReadContract({
    address: i.pair,
    abi: pairVaultAbi,
    functionName: "previewDeposit",
    args: haveOuts ? [outA, outB] : undefined,
    query: { enabled: ready && haveOuts, refetchInterval: REFRESH_MS },
  });
  const pv = preview.data as readonly [bigint, bigint, bigint] | undefined;
  const gross = pv?.[0];
  const feeShares = gross !== undefined && !i.isCreator && !i.feeExempt ? (gross * BigInt(i.feeBps)) / 10_000n : 0n;

  return {
    shares: gross !== undefined ? gross - feeShares : undefined,
    feeShares,
    outA,
    outB,
    routeA,
    routeB,
    /** Exact swap bytes to send to the router so execution matches the quote. */
    pathA: routeA?.path ?? (i.tokenA ? swapPath(payToken, i.tokenA) : "0x"),
    pathB: routeB?.path ?? (i.tokenB ? swapPath(payToken, i.tokenB) : "0x"),
    dustA: pv && outA !== undefined ? outA - pv[1] : 0n,
    dustB: pv && outB !== undefined ? outB - pv[2] : 0n,
    loading: ready && (legs.loading || preview.isLoading),
    error: legs.error ?? preview.error?.message,
  };
}

export interface SellQuoteInput {
  pair?: Address;
  tokenA?: Address;
  tokenB?: Address;
  shares: bigint;
  asset: QuoteAsset;
}

/** Mirrors PairRouter.sell: quoteRedeem, then swap both legs to the payout asset. */
export function useSellQuote(i: SellQuoteInput) {
  const receiveToken = quoteTokenAddress(i.asset);
  const ready = !!i.pair && !!i.tokenA && !!i.tokenB && i.shares > 0n;

  const redeem = useReadContract({
    address: i.pair,
    abi: pairVaultAbi,
    functionName: "quoteRedeem",
    args: [i.shares],
    query: { enabled: ready, refetchInterval: REFRESH_MS },
  });
  const r = redeem.data as readonly [bigint, bigint, bigint] | undefined;

  const legs = useLegQuotes(
    ready && r
      ? [
          { from: i.tokenA!, to: receiveToken, amount: r[0] },
          { from: i.tokenB!, to: receiveToken, amount: r[1] },
        ]
      : null,
  );
  const outA = legs.outs?.[0];
  const outB = legs.outs?.[1];
  const routeA = legs.routes?.[0];
  const routeB = legs.routes?.[1];

  return {
    amountOut: outA !== undefined && outB !== undefined ? outA + outB : undefined,
    amountA: r?.[0],
    amountB: r?.[1],
    valueUsd8: r?.[2],
    routeA,
    routeB,
    pathA: routeA?.path ?? (i.tokenA ? swapPath(i.tokenA, receiveToken) : "0x"),
    pathB: routeB?.path ?? (i.tokenB ? swapPath(i.tokenB, receiveToken) : "0x"),
    loading: ready && (redeem.isLoading || legs.loading),
    error: legs.error ?? redeem.error?.message,
  };
}

// ─── Transactions ───────────────────────────────────────

export interface BuyInput {
  asset: QuoteAsset;
  tokenA: Address;
  tokenB: Address;
  amountIn: bigint;
  minShares: bigint;
  slippageBps: number;
  /** Quoted swap routes (from useBuyQuote); defaults to the single 0.3% path. */
  pathA?: `0x${string}`;
  pathB?: `0x${string}`;
}

export interface SellInput {
  asset: QuoteAsset;
  tokenA: Address;
  tokenB: Address;
  shares: bigint;
  minAmountOut: bigint;
  slippageBps: number;
  /** Quoted swap routes (from useSellQuote); defaults to the single 0.3% path. */
  pathA?: `0x${string}`;
  pathB?: `0x${string}`;
}

export function usePairTrade(pair: Address | undefined) {
  const { send, approveIfNeeded, ensureReady, getClient } = useContractTx();
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

  const buy = useCallback(
    async (input: BuyInput): Promise<Hash> => {
      setError(null);
      setHash(undefined);
      try {
        if (!pair || !pairRouterReady) throw new Error("Buying with ETH or USDG is not available on this network yet.");
        const payToken = quoteTokenAddress(input.asset);
        if (input.asset === "USDG") {
          setStage("approve");
          await approveIfNeeded(USDG_ADDRESS, PAIR_ROUTER_ADDRESS, input.amountIn, { onSubmitted: setHash });
        }
        setStage("submit");
        const { hash: txHash } = await send(
          {
            address: PAIR_ROUTER_ADDRESS,
            abi: pairRouterAbi,
            functionName: "buy",
            args: [
              {
                pair,
                payToken,
                amountIn: input.amountIn,
                pathA: input.pathA ?? swapPath(payToken, input.tokenA),
                pathB: input.pathB ?? swapPath(payToken, input.tokenB),
                minShares: input.minShares,
                maxSlippageBps: input.slippageBps,
                deadline: deadline(),
              },
            ],
            value: input.asset === "ETH" ? input.amountIn : undefined,
          },
          { onSubmitted: setHash },
        );
        setStage("done");
        return txHash;
      } catch (e) {
        return fail(e);
      }
    },
    [pair, approveIfNeeded, send, fail],
  );

  const sell = useCallback(
    async (input: SellInput): Promise<Hash> => {
      setError(null);
      setHash(undefined);
      try {
        if (!pair || !pairRouterReady) throw new Error("Selling for ETH or USDG is not available on this network yet.");
        const account = await ensureReady();
        // The pair vault is its own ERC-20 share token; PairRouter redeems
        // through a standard allowance, granted once per pair.
        const allowance = await getClient().readContract({
          address: pair,
          abi: erc20Abi,
          functionName: "allowance",
          args: [account, PAIR_ROUTER_ADDRESS],
        });
        if (allowance < input.shares) {
          setStage("operator");
          await send(
            { address: pair, abi: erc20Abi, functionName: "approve", args: [PAIR_ROUTER_ADDRESS, maxUint256] },
            { onSubmitted: setHash },
          );
        }

        const receiveToken = quoteTokenAddress(input.asset);
        setStage("submit");
        const { hash: txHash } = await send(
          {
            address: PAIR_ROUTER_ADDRESS,
            abi: pairRouterAbi,
            functionName: "sell",
            args: [
              {
                pair,
                receiveToken,
                shares: input.shares,
                pathA: input.pathA ?? swapPath(input.tokenA, receiveToken),
                pathB: input.pathB ?? swapPath(input.tokenB, receiveToken),
                minAmountOut: input.minAmountOut,
                maxSlippageBps: input.slippageBps,
                unwrapEth: input.asset === "ETH",
                deadline: deadline(),
              },
            ],
          },
          { onSubmitted: setHash },
        );
        setStage("done");
        return txHash;
      } catch (e) {
        return fail(e);
      }
    },
    [pair, ensureReady, getClient, send, fail],
  );

  return { buy, sell, stage, error, hash, reset };
}

/** TestUSDG faucet (testnet only): 1,000 USDG per hour per wallet. */
export function useUsdgFaucet() {
  const { send } = useContractTx();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const claim = useCallback(async () => {
    setPending(true);
    setError(null);
    try {
      await send({ address: USDG_ADDRESS, abi: testUsdgAbi, functionName: "faucet" });
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setPending(false);
    }
  }, [send]);

  return { claim, pending, error, available: swapQuotesReady && usdgReady };
}
