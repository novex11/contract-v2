"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { motion, AnimatePresence } from "motion/react";
import { formatUnits, isAddress, type Address } from "viem";
import { useReadContract } from "wagmi";
import {
  ArrowRight,
  CaretLeft,
  Coin,
  Drop,
  Info,
  LockKey,
  SealCheck,
  Sparkle,
  Wallet,
  WarningCircle,
} from "@phosphor-icons/react";
import {
  LAUNCHPAD_CONFIG,
  LAUNCHPAD_SLIPPAGE_BPS,
  PAIR_CATEGORY_ACCENT,
  PAIR_CATEGORY_LABEL,
  TESTNET_FAUCET_URL,
  classifyPair,
  depositAmountError,
  getTokenByAddress,
  isTestnetMode,
  isUSMarketHours,
} from "@compose/config";
import { fetchLaunchpadPair, type PairHistoryRange } from "@/lib/api";
import {
  PAIR_FACTORY_ADDRESS,
  isWeth,
  pairFactoryAbi,
  pairFactoryReady,
  pairRouterReady,
  pairVaultAbi,
  receiptTokenAbi,
} from "@/lib/contracts";
import {
  useOraclePrices,
  usePairDeposit,
  usePairOnchain,
  usePairPool,
  usePairRedeem,
  useTokenBalances,
  type TxStage,
} from "@/hooks/use-pair-launchpad";
import { useWallet } from "@/hooks/use-wallet";
import { useQuotes } from "@/hooks/use-quotes";
import { usePairHistory } from "@/hooks/use-pair-history";
import { usePairLive } from "@/hooks/use-pair-live";
import { PairAreaChart } from "@/components/pair/pair-area-chart";
import { cn, explorerUrl, formatUsd } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { NumberTicker } from "@/components/ui/number-ticker";
import { StockLogo } from "@/components/ui/stock-logo";
import { Sparkline } from "@/components/ui/sparkline";
import { HatchPattern } from "@/components/motion/hatch-pattern";
import { OnChainVerifiedBadge } from "@/components/receipt/on-chain-verified-badge";
import { DualLogoStack } from "@/components/launchpad/dual-logo-stack";
import { AddressChip } from "@/components/launchpad/address-chip";
import { VerifiedSourceChip } from "@/components/launchpad/verified-source-chip";
import { StageProgressList, type ProgressStep } from "@/components/launchpad/stage-progress";
import { DepositAmountField } from "@/components/launchpad/deposit-amount-field";
import type { PairChartMetric } from "@/components/pair/pair-chart";
import { CreatorRewards } from "@/components/pair/creator-rewards";
import { PairTokenCard } from "@/components/token/pair-token-card";
import { usePairCurveToken } from "@/hooks/use-curve-token";

const spring = { type: "spring", stiffness: 100, damping: 20 } as const;
const LEG_B_ACCENT = "#3D8BFF";
const GAS_RESERVE_WEI = 500_000_000_000_000n;
const REDEEM_PRESETS = [25, 50, 75, 100];
type Tab = "deposit" | "redeem";

function formatToken(amount: bigint, decimals = 18): string {
  const n = Number(formatUnits(amount, decimals));
  return n.toLocaleString(undefined, { maximumFractionDigits: n !== 0 && n < 1 ? 6 : 4 });
}

function usdValue(amount: bigint, price8: bigint | undefined, decimals = 18): number {
  if (!price8) return 0;
  return Number(formatUnits(amount * price8, decimals + 8));
}

const isBusy = (s: TxStage) => s === "approve-a" || s === "approve-b" || s === "submit";

export default function PairDetailContent({ address }: { address: string }) {
  const pairAddress = isAddress(address) ? (address as Address) : undefined;
  const wallet = useWallet();
  const qc = useQueryClient();

  const [tab, setTab] = useState<Tab>("deposit");
  const [usdAmount, setUsdAmount] = useState<number>(LAUNCHPAD_CONFIG.defaultSeedUsd);
  const [payWithEth, setPayWithEth] = useState<boolean | null>(null);
  const [redeemPct, setRedeemPct] = useState(100);
  const [activeFlow, setActiveFlow] = useState<Tab | null>(null);
  const [lastStage, setLastStage] = useState<TxStage | null>(null);
  const [chartRange, setChartRange] = useState<PairHistoryRange>("24h");
  const [chartMetric, setChartMetric] = useState<PairChartMetric>("navUsd");
  // PairRouter only serves pairs from the current factory (creator reward claims need it).
  const routerPairCheck = useReadContract({
    address: PAIR_FACTORY_ADDRESS,
    abi: pairFactoryAbi,
    functionName: "isPair",
    args: pairAddress ? [pairAddress] : undefined,
    query: { enabled: !!pairAddress && pairRouterReady && pairFactoryReady },
  });
  const routerSupported = routerPairCheck.data as boolean | undefined;
  // The pair's single public token (strictly one per pair).
  const pairToken = usePairCurveToken(pairAddress);

  // Off-chain profile + activity (optional — the page works from chain data alone)
  const detail = useQuery({
    queryKey: ["pair-detail", pairAddress?.toLowerCase()],
    queryFn: () => fetchLaunchpadPair(pairAddress!),
    enabled: !!pairAddress,
    refetchInterval: 10_000,
    retry: 1,
  });
  const meta = detail.data?.pair;
  const activity = detail.data?.activity;

  const onchain = usePairOnchain(pairAddress);
  const poolAddress = usePairPool(pairAddress);
  const chain = onchain.data;
  const historyQuery = usePairHistory(pairAddress, chartRange);
  // Live snapshots: a buy/sell or price move shows up within seconds.
  const live = usePairLive(pairAddress, () => {
    void onchain.refetch();
  });
  const historyPoints = historyQuery.data?.points ?? [];

  const tokenAMeta = chain ? getTokenByAddress(chain.tokenA) : undefined;
  const tokenBMeta = chain ? getTokenByAddress(chain.tokenB) : undefined;
  const tickerA = tokenAMeta?.ticker ?? meta?.tickerA ?? "Token A";
  const tickerB = tokenBMeta?.ticker ?? meta?.tickerB ?? "Token B";
  const decA = tokenAMeta?.decimals ?? 18;
  const decB = tokenBMeta?.decimals ?? 18;
  const category = classifyPair(
    tokenAMeta?.category ?? meta?.categoryA ?? "",
    tokenBMeta?.category ?? meta?.categoryB ?? "",
  );
  const categoryLabel = PAIR_CATEGORY_LABEL[category];
  const categoryAccent = PAIR_CATEGORY_ACCENT[category];

  const receiptSymbolRead = useReadContract({
    address: chain?.receiptToken,
    abi: receiptTokenAbi,
    functionName: "symbol",
    query: { enabled: !!chain },
  });
  const receiptNameRead = useReadContract({
    address: chain?.receiptToken,
    abi: receiptTokenAbi,
    functionName: "name",
    query: { enabled: !!chain },
  });
  const receiptBalance = useReadContract({
    address: chain?.receiptToken,
    abi: receiptTokenAbi,
    functionName: "balanceOf",
    args: wallet.address ? [wallet.address] : undefined,
    query: { enabled: !!chain && !!wallet.address, refetchInterval: 15_000 },
  });
  const userShares = (receiptBalance.data as bigint | undefined) ?? 0n;
  const symbol = (receiptSymbolRead.data as string | undefined) ?? meta?.receiptSymbol ?? "PAIR";
  const displayName =
    meta?.displayName || (receiptNameRead.data as string | undefined) || symbol;

  const isCreator =
    !!wallet.address && !!chain && wallet.address.toLowerCase() === chain.creator.toLowerCase();

  const { byTicker } = useQuotes([tickerA, tickerB]);
  const quoteA = byTicker.get(tickerA);
  const quoteB = byTicker.get(tickerB);

  const legTokens = chain ? [chain.tokenA, chain.tokenB] : [];
  const { prices } = useOraclePrices(legTokens);
  const priceA8 = chain ? prices.get(chain.tokenA.toLowerCase()) : undefined;
  const priceB8 = chain ? prices.get(chain.tokenB.toLowerCase()) : undefined;
  const priceA = priceA8 ? Number(priceA8) / 1e8 : quoteA?.price;
  const priceB = priceB8 ? Number(priceB8) / 1e8 : quoteB?.price;

  const navUsd = chain ? Number(chain.navUsd8) / 1e8 : (meta?.tvlUsd ?? 0);
  const sharePriceUsd = chain ? Number(chain.sharePriceUsd8) / 1e8 : undefined;
  const feeBps = chain?.creatorFeeBps ?? meta?.creatorFeeBps ?? 0;

  // ─── Deposit quote ───────────────────────────────────
  const usd8 = BigInt(Math.round((usdAmount || 0) * 1e8));
  const depositQuote = useReadContract({
    address: pairAddress,
    abi: pairVaultAbi,
    functionName: "quoteDeposit",
    args: [usd8],
    query: { enabled: !!pairAddress && !!chain && usd8 > 0n, refetchInterval: 15_000 },
  });
  const quoted = depositQuote.data as readonly [bigint, bigint, bigint] | undefined;
  const needA = quoted?.[0] ?? 0n;
  const needB = quoted?.[1] ?? 0n;
  const grossShares = quoted?.[2] ?? 0n;

  const { balances, native, refetch: refetchBalances } = useTokenBalances(wallet.address, legTokens);
  const balA = chain ? (balances.get(chain.tokenA.toLowerCase()) ?? 0n) : 0n;
  const balB = chain ? (balances.get(chain.tokenB.toLowerCase()) ?? 0n) : 0n;

  const wethLeg: Address | null = chain
    ? isWeth(chain.tokenA)
      ? chain.tokenA
      : isWeth(chain.tokenB)
        ? chain.tokenB
        : null
    : null;
  const wethIsA = !!chain && wethLeg === chain.tokenA;
  const wethIsB = !!chain && wethLeg === chain.tokenB;
  const wethNeeded = wethIsA ? needA : wethIsB ? needB : 0n;
  const wethBalance = wethIsA ? balA : wethIsB ? balB : 0n;
  const useEth = wethLeg !== null && (payWithEth ?? wethBalance < wethNeeded);
  const nativeLeg = useEth ? wethLeg : null;
  const ethSpendable = native != null && native > GAS_RESERVE_WEI ? native - GAS_RESERVE_WEI : 0n;
  const haveA = useEth && wethIsA ? ethSpendable : balA;
  const haveB = useEth && wethIsB ? ethSpendable : balB;
  const unitA = useEth && wethIsA ? "ETH" : tickerA;
  const unitB = useEth && wethIsB ? "ETH" : tickerB;
  const shortA = needA > haveA;
  const shortB = needB > haveB;

  // Headroom so reserve changes between quote and inclusion don't under-fund the deposit.
  const withHeadroom = (x: bigint) => (x * BigInt(10_000 + LAUNCHPAD_SLIPPAGE_BPS)) / 10_000n;
  const maxA = withHeadroom(needA) < haveA ? withHeadroom(needA) : haveA;
  const maxB = withHeadroom(needB) < haveB ? withHeadroom(needB) : haveB;
  const feeShares = isCreator ? 0n : (grossShares * BigInt(feeBps)) / 10_000n;
  const netShares = grossShares - feeShares;
  const minShares = (netShares * BigInt(10_000 - LAUNCHPAD_SLIPPAGE_BPS)) / 10_000n;
  const feeUsd = isCreator ? 0 : ((usdAmount || 0) * feeBps) / 10_000;

  const reserveValueA = chain ? usdValue(chain.reserveA, priceA8, decA) : 0;
  const reserveValueB = chain ? usdValue(chain.reserveB, priceB8, decB) : 0;
  const reserveTotal = reserveValueA + reserveValueB;
  const maxUsd =
    reserveTotal > 0 && reserveValueA > 0 && reserveValueB > 0
      ? Math.min(
          usdValue(haveA, priceA8, decA) / (reserveValueA / reserveTotal),
          usdValue(haveB, priceB8, decB) / (reserveValueB / reserveTotal),
        )
      : undefined;

  // ─── Redeem quote ────────────────────────────────────
  const redeemShares = (userShares * BigInt(redeemPct)) / 100n;
  const redeemQuote = useReadContract({
    address: pairAddress,
    abi: pairVaultAbi,
    functionName: "quoteRedeem",
    args: [redeemShares],
    query: { enabled: !!pairAddress && redeemShares > 0n, refetchInterval: 15_000 },
  });
  const outs = redeemQuote.data as readonly [bigint, bigint, bigint] | undefined;
  const outA = outs?.[0] ?? 0n;
  const outB = outs?.[1] ?? 0n;
  const outValueUsd = outs ? Number(outs[2]) / 1e8 : 0;

  // ─── Transactions ────────────────────────────────────
  const depositTx = usePairDeposit(pairAddress);
  const redeemTx = usePairRedeem(pairAddress);
  const flow = activeFlow === "redeem" ? redeemTx : depositTx;
  const stage: TxStage = activeFlow ? flow.stage : "idle";
  const overlayVisible = activeFlow !== null && (isBusy(stage) || stage === "error");

  useEffect(() => {
    if (isBusy(stage)) setLastStage(stage);
    if (stage === "done") {
      void onchain.refetch();
      void receiptBalance.refetch();
      refetchBalances();
      qc.invalidateQueries({ queryKey: ["pair-detail", pairAddress?.toLowerCase()] });
      qc.invalidateQueries({ queryKey: ["pair-history"] });
      qc.invalidateQueries({ queryKey: ["launchpad-pairs"] });
      qc.invalidateQueries({ queryKey: ["launchpad-stats"] });
      flow.reset();
      setActiveFlow(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage]);

  const depositBlocker = !chain
    ? "Loading pair…"
    : (depositAmountError(usdAmount) ??
      (!quoted
        ? "Loading quote…"
        : shortA
          ? `Not enough ${unitA}: need ${formatToken(needA, decA)}, wallet has ${formatToken(haveA, decA)}.`
          : shortB
            ? `Not enough ${unitB}: need ${formatToken(needB, decB)}, wallet has ${formatToken(haveB, decB)}.`
            : null));

  async function handleDeposit() {
    if (!chain || depositBlocker) return;
    setActiveFlow("deposit");
    setLastStage(null);
    depositTx.reset();
    try {
      await depositTx.execute({
        tokenA: chain.tokenA,
        tokenB: chain.tokenB,
        maxA,
        maxB,
        minShares,
        nativeLeg,
      });
    } catch {
      /* shown in the progress overlay */
    }
  }

  async function handleRedeem() {
    if (redeemShares <= 0n || !outs) return;
    setActiveFlow("redeem");
    setLastStage(null);
    redeemTx.reset();
    try {
      await redeemTx.execute({
        shares: redeemShares,
        minA: (outA * BigInt(10_000 - LAUNCHPAD_SLIPPAGE_BPS)) / 10_000n,
        minB: (outB * BigInt(10_000 - LAUNCHPAD_SLIPPAGE_BPS)) / 10_000n,
      });
    } catch {
      /* shown in the progress overlay */
    }
  }

  function refreshAfterTrade() {
    void onchain.refetch();
    void receiptBalance.refetch();
    refetchBalances();
    qc.invalidateQueries({ queryKey: ["pair-detail", pairAddress?.toLowerCase()] });
    qc.invalidateQueries({ queryKey: ["pair-history"] });
    qc.invalidateQueries({ queryKey: ["launchpad-pairs"] });
    qc.invalidateQueries({ queryKey: ["launchpad-stats"] });
  }

  if (!pairAddress) {
    return <NotFound message="That is not a valid pair address." />;
  }
  if (onchain.isLoading) {
    return (
      <div className="container-page py-12 text-sm text-muted-foreground">Loading pair…</div>
    );
  }
  if (!chain) {
    return <NotFound message="This address is not a Compose pair on this network." />;
  }

  const progressSteps: ProgressStep[] =
    activeFlow === "redeem"
      ? [{ id: "submit", label: "Redeeming shares", hint: `You receive ${tickerA} and ${tickerB}` }]
      : [
          ...(useEth && wethIsA
            ? []
            : [{ id: "approve-a" as const, label: `Approve ${tickerA}`, hint: "Skipped if already approved" }]),
          ...(useEth && wethIsB
            ? []
            : [{ id: "approve-b" as const, label: `Approve ${tickerB}`, hint: "Skipped if already approved" }]),
          { id: "submit", label: "Depositing", hint: `Adds ${tickerA} + ${tickerB} and mints ${symbol}` },
        ];

  const allActivity = [
    ...(activity?.deposits ?? []).map((d) => ({ ...d, kind: "deposit" as const })),
    ...(activity?.redeems ?? []).map((r) => ({ ...r, kind: "redeem" as const })),
  ]
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
    .slice(0, 12);

  const creatorFeeUsd = Number(formatUnits(chain.creatorFeeShares, 18)) * (sharePriceUsd ?? 1);

  return (
    <div className="relative container-page min-h-[100dvh] py-8 md:py-10">

      <Link
        href="/launchpad"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <CaretLeft size={14} />
        Launchpad
      </Link>

      {meta?.imageUrl && (
        <div className="relative mt-5 h-40 overflow-hidden rounded-[1.75rem] border border-border md:h-52">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={meta.imageUrl} alt="" className="h-full w-full object-cover" />
        </div>
      )}

      {/* Hero header */}
      <div className="mt-5 flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-start gap-4">
          {meta?.logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={meta.logoUrl}
              alt=""
              className="h-14 w-14 rounded-2xl border border-border object-cover"
            />
          ) : (
            <DualLogoStack tickerA={tickerA} tickerB={tickerB} size="lg" />
          )}
          <div>
            <p className="label-caps flex items-center gap-2">
              <Sparkle size={12} weight="fill" />
              Launched pair · {categoryLabel}
              {meta?.numeraireTicker && (
                <span className="normal-case text-muted-foreground">
                  · quote {meta.numeraireTicker}
                </span>
              )}
            </p>
            <h1 className="mt-2 bg-gradient-to-br from-foreground via-foreground to-accent-strong bg-clip-text text-3xl font-semibold tracking-tight text-transparent md:text-4xl">
              {displayName}
            </h1>
            <p className="mt-1 font-mono text-sm text-muted-foreground">{symbol}</p>
            <p className="mt-0.5 text-sm text-muted-foreground">
              {tokenAMeta?.name ?? tickerA} × {tokenBMeta?.name ?? tickerB}
            </p>
            {meta?.description && (
              <p className="mt-3 max-w-xl text-sm leading-relaxed text-muted-foreground">
                {meta.description}
              </p>
            )}
            {meta?.websiteUrl && (
              <a
                href={meta.websiteUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-2 inline-block text-sm text-accent-strong underline-offset-2 hover:underline"
              >
                {meta.websiteUrl.replace(/^https?:\/\//, "")}
              </a>
            )}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <OnChainVerifiedBadge />
          {feeBps > 0 ? (
            <Badge variant="accent">
              <SealCheck size={12} weight="fill" />
              {(feeBps / 100).toFixed(1)}% creator fee
            </Badge>
          ) : (
            <Badge variant="secondary">
              <LockKey size={12} weight="fill" />
              Creator-managed vault
            </Badge>
          )}
        </div>
      </div>

      {!isCreator && (
        <div className="mt-5 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-accent/50 bg-accent-subtle/50 px-4 py-3 text-sm">
          <span className="flex items-center gap-2">
            <LockKey size={16} weight="fill" className="shrink-0 text-accent-strong" />
            This vault is managed by its creator. Trade the pair&apos;s token instead.
          </span>
          {pairToken.token ? (
            <Button asChild size="sm">
              <Link href={`/token/${pairToken.token}`}>
                Trade ${symbol}
                <ArrowRight size={14} weight="bold" />
              </Link>
            </Button>
          ) : (
            <span className="font-mono text-xs text-muted-foreground">Token not launched yet</span>
          )}
        </div>
      )}

      {/* Deployment strip */}
      <div className="mt-5 flex flex-wrap items-center gap-2 rounded-2xl border border-border bg-surface-muted p-3 text-xs">
        <span className="rounded-full bg-accent-subtle px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wide text-accent-strong">
          {isTestnetMode() ? "Robinhood Chain Testnet" : "Robinhood Chain"}
        </span>
        <AddressChip address={pairAddress} label="Pair" />
        {poolAddress && (
          <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface px-2.5 py-1 font-mono text-[11px]" title={poolAddress}>
            <span className="label-caps">Uniswap v4 pool</span>
            {poolAddress.slice(0, 10)}…{poolAddress.slice(-6)}
          </span>
        )}
        <AddressChip address={chain.receiptToken} label="Receipt" />
        <AddressChip address={chain.creator} label="Creator" />
        <VerifiedSourceChip verification={meta?.verification?.vault} address={pairAddress} label="Vault" />
        <VerifiedSourceChip verification={meta?.verification?.receipt} address={chain.receiptToken} label="Receipt" />
      </div>

      {/* Stats */}
      <div className="mt-8 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="On-chain TVL" value={formatUsd(navUsd)} />
        <Stat label="Share price" value={sharePriceUsd != null ? formatUsd(sharePriceUsd) : "—"} />
        <Stat label="Depositors" value={meta ? meta.totalDepositors.toString() : "—"} />
        <Stat label="Creator fees earned" value={formatUsd(creatorFeeUsd)} accent />
      </div>

      <div className="mt-10 grid gap-8 lg:grid-cols-12">
        {/* Left: chart + legs + creator + activity */}
        <div className="lg:col-span-7">
          <PairAreaChart
            className="mb-6"
            points={historyPoints}
            metric={chartMetric}
            onMetricChange={setChartMetric}
            range={chartRange}
            onRangeChange={setChartRange}
            loading={historyQuery.isLoading}
            connected={live.connected}
            live={
              live.last
                ? {
                    timestamp: live.last.timestamp,
                    value: chartMetric === "navUsd" ? live.last.navUsd : live.last.sharePrice,
                  }
                : undefined
            }
            stats={[
              { label: "Price", value: sharePriceUsd !== undefined ? `$${sharePriceUsd.toFixed(4)}` : "—" },
              { label: "Market cap", value: formatUsd(navUsd) },
              { label: "Backing", value: `${tickerA} + ${tickerB}` },
              { label: "Market", value: poolAddress ? "Uniswap v4" : "Compose vault" },
            ]}
            height={340}
          />

          <section className="grid gap-3 sm:grid-cols-2">
            <LegCard
              ticker={tickerA}
              name={tokenAMeta?.name}
              category={tokenAMeta?.category}
              weightBps={chain.weightABps}
              priceUsd={priceA}
              change24h={quoteA?.changePercent}
              sparkline={quoteA?.sparkline}
              address={chain.tokenA}
              reserve={`${formatToken(chain.reserveA, decA)} ${tickerA}`}
              accent={categoryAccent}
            />
            <LegCard
              ticker={tickerB}
              name={tokenBMeta?.name}
              category={tokenBMeta?.category}
              weightBps={10_000 - chain.weightABps}
              priceUsd={priceB}
              change24h={quoteB?.changePercent}
              sparkline={quoteB?.sparkline}
              address={chain.tokenB}
              reserve={`${formatToken(chain.reserveB, decB)} ${tickerB}`}
              accent={LEG_B_ACCENT}
            />
          </section>

          {isCreator && (
            <section className="mt-6 rounded-[1.75rem] border border-accent bg-accent-subtle/60 p-6">
              <div className="flex items-center gap-2 text-sm font-semibold text-accent-strong">
                <Coin size={16} weight="fill" />
                Creator dashboard
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                Only you can add {tickerA} + {tickerB} to this vault. The public trades its token on the
                bonding curve, and you earn 70% of the 1% curve fee on every trade.
                {feeBps > 0 &&
                  ` Deposit fees from older activity were minted to you as ${symbol} shares and can be redeemed at any time.`}
              </p>
              <div className="mt-4 flex flex-wrap gap-6">
                <div>
                  <p className="text-xs text-muted-foreground">Fee shares earned</p>
                  <p className="mt-1 font-mono text-2xl font-semibold tabular-nums text-accent-strong">
                    {formatToken(chain.creatorFeeShares)}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Current value</p>
                  <p className="mt-1 font-mono text-2xl font-semibold tabular-nums">
                    {formatUsd(creatorFeeUsd)}
                  </p>
                </div>
              </div>
            </section>
          )}

          <section className="mt-6 rounded-[1.75rem] border border-border bg-surface p-6">
            <h2 className="text-base font-semibold">Recent activity</h2>
            {detail.isError && (
              <p className="mt-3 text-sm text-muted-foreground">
                Activity is unavailable while the indexer is offline.
              </p>
            )}
            {!detail.isError && allActivity.length === 0 && (
              <p className="mt-3 text-sm text-muted-foreground">No activity yet.</p>
            )}
            {allActivity.length > 0 && (
              <ul className="mt-4 space-y-2">
                {allActivity.map((row) => (
                  <li
                    key={`${row.kind}-${row.txHash}`}
                    className="flex items-center justify-between gap-3 rounded-2xl border border-border-subtle bg-surface-muted/40 px-4 py-3"
                  >
                    <div className="flex items-center gap-3">
                      <Badge variant={row.kind === "deposit" ? "success" : "secondary"}>{row.kind}</Badge>
                      <a
                        href={explorerUrl("tx", row.txHash)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="font-mono text-xs underline-offset-2 hover:underline"
                      >
                        {row.wallet.slice(0, 6)}…{row.wallet.slice(-4)}
                      </a>
                    </div>
                    <div className="text-right font-mono text-xs">
                      <div className="tabular-nums">{formatUsd(row.valueUsd)}</div>
                      <div className="text-[10px] text-muted-foreground">
                        {new Date(row.timestamp).toLocaleString(undefined, {
                          hour: "2-digit",
                          minute: "2-digit",
                          month: "short",
                          day: "numeric",
                        })}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        {/* Right: creator vault controls (deposit / redeem) or the public token pointer */}
        <aside className="lg:col-span-5">
          <div className="lg:sticky lg:top-24">
            <PairTokenCard
              className="mb-4"
              pair={pairAddress}
              share={chain.receiptToken}
              isCreator={isCreator}
              userShares={userShares}
              sharePriceUsd={sharePriceUsd}
              sharePriceUsd8={chain.sharePriceUsd8}
              logoUrl={meta?.logoUrl}
              imageUrl={meta?.imageUrl}
              displayName={displayName}
              symbol={symbol}
            />
            {isCreator && (
              <CreatorRewards
                className="mb-4"
                pair={pairAddress}
                chain={chain}
                symbol={symbol}
                tickerA={tickerA}
                tickerB={tickerB}
                decA={decA}
                decB={decB}
                userShares={userShares}
                sharePriceUsd={sharePriceUsd}
                routerSupported={routerSupported}
                onDone={refreshAfterTrade}
              />
            )}
            {isCreator ? (
            <div className="overflow-hidden rounded-[1.75rem] border border-border bg-surface shadow-float">
              <div className="flex border-b border-border-subtle">
                {(["deposit", "redeem"] as const).map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setTab(t)}
                    className={cn(
                      "flex-1 py-3 text-sm font-semibold capitalize transition-colors",
                      tab === t ? "bg-accent-subtle text-accent-strong" : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {t === "deposit" ? "Add stocks" : "Redeem"}
                  </button>
                ))}
              </div>

              {tab === "deposit" ? (
                <div className="p-5">
                  <DepositAmountField
                    id="pair-usd"
                    label="USD value to deposit"
                    value={usdAmount}
                    onChange={setUsdAmount}
                    maxUsd={wallet.address ? maxUsd : undefined}
                    hint={`Split across ${tickerA} + ${tickerB} at the pair's current ratio`}
                    inputClassName="!h-14 !text-xl !rounded-xl !pl-9"
                  />

                  <div className="mt-4 grid grid-cols-2 gap-2">
                    <NeedRow unit={unitA} ticker={tickerA} need={needA} have={haveA} decimals={decA} connected={!!wallet.address} />
                    <NeedRow unit={unitB} ticker={tickerB} need={needB} have={haveB} decimals={decB} connected={!!wallet.address} />
                  </div>

                  {wethLeg && (
                    <label className="mt-3 flex cursor-pointer items-center justify-between gap-3 rounded-2xl border border-border bg-surface px-4 py-3 text-xs">
                      <span>
                        <span className="block font-semibold text-foreground">Pay the WETH leg with ETH</span>
                        <span className="text-muted-foreground">Wrapped inside the deposit transaction.</span>
                      </span>
                      <input
                        type="checkbox"
                        checked={useEth}
                        onChange={(e) => setPayWithEth(e.target.checked)}
                        className="h-4 w-4 shrink-0 accent-[var(--accent)]"
                      />
                    </label>
                  )}

                  <div className="relative mt-4 rounded-2xl border border-border bg-accent-subtle/60 p-4">
                    <HatchPattern className="opacity-40" />
                    <dl className="relative space-y-1.5 font-mono text-xs">
                      <div className="flex justify-between">
                        <dt className="text-muted-foreground">Shares minted</dt>
                        <dd className="tabular-nums">≈ {formatToken(netShares)} {symbol}</dd>
                      </div>
                      <div className="flex justify-between">
                        <dt className="text-muted-foreground">Deposit fee</dt>
                        <dd className="tabular-nums">none (your vault)</dd>
                      </div>
                      <div className="flex justify-between border-t border-border pt-1.5 text-sm">
                        <dt className="font-medium">Your position</dt>
                        <dd className="font-medium tabular-nums">{formatUsd((usdAmount || 0) - feeUsd)}</dd>
                      </div>
                    </dl>
                  </div>

                  {wallet.authenticated && depositBlocker && (
                    <p className="mt-3 flex items-start gap-1.5 text-xs text-muted-foreground">
                      <Info size={14} className="mt-0.5 shrink-0" />
                      {depositBlocker}
                    </p>
                  )}
                  {isTestnetMode() && wallet.address && balA === 0n && balB === 0n && (
                    <p className="mt-3 flex items-start gap-1.5 text-xs text-muted-foreground">
                      <Drop size={14} className="mt-0.5 shrink-0 text-accent-strong" />
                      <span>
                        Get free testnet {tickerA} and {tickerB} from the{" "}
                        <a href={TESTNET_FAUCET_URL} target="_blank" rel="noopener noreferrer" className="text-accent-strong underline">
                          Robinhood faucet ↗
                        </a>
                      </span>
                    </p>
                  )}
                  {!isUSMarketHours() && (
                    <p className="mt-3 flex items-start gap-1.5 text-xs text-amber-600 dark:text-amber-400">
                      <WarningCircle size={14} weight="fill" className="mt-0.5 shrink-0" />
                      US markets are closed; values use the latest available prices.
                    </p>
                  )}

                  {wallet.authenticated ? (
                    <Button
                      className="mt-4 w-full"
                      size="lg"
                      disabled={depositBlocker !== null || isBusy(depositTx.stage)}
                      onClick={handleDeposit}
                    >
                      {isBusy(depositTx.stage) ? "Processing…" : `Add ${formatUsd(usdAmount || 0)} of stocks`}
                      {!isBusy(depositTx.stage) && <ArrowRight size={16} weight="bold" />}
                    </Button>
                  ) : (
                    <Button className="mt-4 w-full" size="lg" onClick={wallet.login} disabled={!wallet.ready}>
                      <Wallet size={16} />
                      Connect wallet
                    </Button>
                  )}
                </div>
              ) : (
                <div className="p-5">
                  <p className="text-sm">
                    Your <span className="font-mono">{symbol}</span> balance
                  </p>
                  <p className="mt-2 font-mono text-3xl font-semibold tabular-nums">
                    {formatToken(userShares)}
                  </p>
                  {sharePriceUsd != null && userShares > 0n && (
                    <p className="mt-1 text-xs text-muted-foreground">
                      ≈ {formatUsd(Number(formatUnits(userShares, 18)) * sharePriceUsd)} at{" "}
                      {formatUsd(sharePriceUsd)} per share
                    </p>
                  )}

                  <div className="mt-4 flex gap-2">
                    {REDEEM_PRESETS.map((p) => (
                      <button
                        key={p}
                        type="button"
                        onClick={() => setRedeemPct(p)}
                        className={cn(
                          "flex-1 rounded-full border px-3 py-1.5 font-mono text-xs transition-all",
                          redeemPct === p
                            ? "border-accent bg-accent-subtle text-accent-strong"
                            : "border-border text-muted-foreground hover:border-accent/40",
                        )}
                      >
                        {p}%
                      </button>
                    ))}
                  </div>

                  <dl className="mt-4 space-y-1.5 rounded-2xl border border-border bg-surface-muted p-4 font-mono text-xs">
                    <div className="flex justify-between">
                      <dt className="text-muted-foreground">You receive {tickerA}</dt>
                      <dd className="tabular-nums">{formatToken(outA, decA)}</dd>
                    </div>
                    <div className="flex justify-between">
                      <dt className="text-muted-foreground">You receive {tickerB}</dt>
                      <dd className="tabular-nums">{formatToken(outB, decB)}</dd>
                    </div>
                    <div className="flex justify-between border-t border-border pt-1.5 text-sm">
                      <dt className="font-medium">Value</dt>
                      <dd className="font-medium tabular-nums">{formatUsd(outValueUsd)}</dd>
                    </div>
                  </dl>

                  {wallet.authenticated ? (
                    <Button
                      className="mt-4 w-full"
                      size="lg"
                      variant="inverse"
                      disabled={redeemShares <= 0n || !outs || isBusy(redeemTx.stage)}
                      onClick={handleRedeem}
                    >
                      {isBusy(redeemTx.stage)
                        ? "Redeeming…"
                        : userShares > 0n
                          ? `Redeem ${redeemPct}%`
                          : "Nothing to redeem"}
                    </Button>
                  ) : (
                    <Button className="mt-4 w-full" size="lg" onClick={wallet.login} disabled={!wallet.ready}>
                      <Wallet size={16} />
                      Connect wallet
                    </Button>
                  )}
                  <p className="mt-3 text-center text-[11px] text-muted-foreground">
                    Redemptions return both tokens and are never paused.
                  </p>
                </div>
              )}
            </div>
            ) : userShares > 0n ? (
              <div className="overflow-hidden rounded-[1.75rem] border border-border bg-surface shadow-float">
                <div className="border-b border-border-subtle px-5 py-3 text-sm font-semibold">Redeem your shares</div>
                <div className="p-5">
                  <p className="text-sm">
                    Your <span className="font-mono">{symbol}</span> balance
                  </p>
                  <p className="mt-2 font-mono text-3xl font-semibold tabular-nums">
                    {formatToken(userShares)}
                  </p>
                  {sharePriceUsd != null && userShares > 0n && (
                    <p className="mt-1 text-xs text-muted-foreground">
                      ≈ {formatUsd(Number(formatUnits(userShares, 18)) * sharePriceUsd)} at{" "}
                      {formatUsd(sharePriceUsd)} per share
                    </p>
                  )}

                  <div className="mt-4 flex gap-2">
                    {REDEEM_PRESETS.map((p) => (
                      <button
                        key={p}
                        type="button"
                        onClick={() => setRedeemPct(p)}
                        className={cn(
                          "flex-1 rounded-full border px-3 py-1.5 font-mono text-xs transition-all",
                          redeemPct === p
                            ? "border-accent bg-accent-subtle text-accent-strong"
                            : "border-border text-muted-foreground hover:border-accent/40",
                        )}
                      >
                        {p}%
                      </button>
                    ))}
                  </div>

                  <dl className="mt-4 space-y-1.5 rounded-2xl border border-border bg-surface-muted p-4 font-mono text-xs">
                    <div className="flex justify-between">
                      <dt className="text-muted-foreground">You receive {tickerA}</dt>
                      <dd className="tabular-nums">{formatToken(outA, decA)}</dd>
                    </div>
                    <div className="flex justify-between">
                      <dt className="text-muted-foreground">You receive {tickerB}</dt>
                      <dd className="tabular-nums">{formatToken(outB, decB)}</dd>
                    </div>
                    <div className="flex justify-between border-t border-border pt-1.5 text-sm">
                      <dt className="font-medium">Value</dt>
                      <dd className="font-medium tabular-nums">{formatUsd(outValueUsd)}</dd>
                    </div>
                  </dl>

                  {wallet.authenticated ? (
                    <Button
                      className="mt-4 w-full"
                      size="lg"
                      variant="inverse"
                      disabled={redeemShares <= 0n || !outs || isBusy(redeemTx.stage)}
                      onClick={handleRedeem}
                    >
                      {isBusy(redeemTx.stage)
                        ? "Redeeming…"
                        : userShares > 0n
                          ? `Redeem ${redeemPct}%`
                          : "Nothing to redeem"}
                    </Button>
                  ) : (
                    <Button className="mt-4 w-full" size="lg" onClick={wallet.login} disabled={!wallet.ready}>
                      <Wallet size={16} />
                      Connect wallet
                    </Button>
                  )}
                  <p className="mt-3 text-center text-[11px] text-muted-foreground">
                    Redemptions return both tokens and are never paused.
                  </p>
                </div>
              </div>
            ) : (
              <div className="rounded-[1.75rem] border border-border bg-surface p-5 text-sm text-muted-foreground shadow-float">
                <p className="flex items-center gap-2 font-semibold text-foreground">
                  <LockKey size={16} weight="fill" className="text-accent-strong" />
                  Creator-managed vault
                </p>
                <p className="mt-2 text-xs leading-relaxed">
                  Only the creator can add {tickerA} + {tickerB} here. Everyone else trades this pair through its
                  token, which is backed 1:1 by this vault and can be sold back at any time.
                </p>
              </div>
            )}
          </div>
        </aside>
      </div>

      <AnimatePresence>
        {overlayVisible && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4 backdrop-blur-sm"
          >
            <motion.div
              initial={{ y: 24, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              transition={spring}
              className="relative w-full max-w-md overflow-hidden rounded-[2rem] border border-border bg-surface p-6 shadow-float"
            >
              <div className="flex items-center gap-3">
                <DualLogoStack tickerA={tickerA} tickerB={tickerB} size="md" />
                <div>
                  <p className="text-sm text-muted-foreground">
                    {activeFlow === "redeem" ? "Redeeming" : "Depositing"}
                  </p>
                  <p className="font-mono text-lg font-semibold">{symbol}</p>
                </div>
              </div>
              <StageProgressList
                className="mt-6"
                steps={progressSteps}
                current={stage}
                lastActive={lastStage}
                errorMessage={flow.error}
                pendingHash={flow.pendingHash}
                errorTitle={activeFlow === "redeem" ? "Redeem failed" : "Deposit failed"}
              />
              {stage === "error" && (
                <Button
                  variant="outline"
                  className="mt-4 w-full"
                  onClick={() => {
                    flow.reset();
                    setActiveFlow(null);
                  }}
                >
                  Close
                </Button>
              )}
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function NotFound({ message }: { message: string }) {
  return (
    <div className="container-page py-12">
      <Link
        href="/launchpad"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <CaretLeft size={14} />
        Launchpad
      </Link>
      <div className="mt-8 rounded-3xl border border-dashed border-border bg-surface p-12 text-center">
        <p className="font-mono text-sm text-muted-foreground">{message}</p>
        <Button asChild className="mt-4" variant="outline">
          <Link href="/launchpad">Back to launchpad</Link>
        </Button>
      </div>
    </div>
  );
}

function NeedRow({
  unit,
  ticker,
  need,
  have,
  decimals,
  connected,
}: {
  unit: string;
  ticker: string;
  need: bigint;
  have: bigint;
  decimals: number;
  connected: boolean;
}) {
  const short = connected && need > have;
  return (
    <div
      className={cn(
        "rounded-2xl border p-3",
        short ? "border-destructive/40 bg-destructive/5" : "border-border bg-surface-muted/60",
      )}
    >
      <div className="flex items-center gap-2">
        <StockLogo ticker={ticker} size="xs" />
        <span className="text-xs font-semibold">{unit}</span>
      </div>
      <p className="mt-2 font-mono text-sm font-semibold tabular-nums">{formatToken(need, decimals)}</p>
      {connected && (
        <p className={cn("font-mono text-[10px]", short ? "text-destructive" : "text-muted-foreground")}>
          wallet {formatToken(have, decimals)}
        </p>
      )}
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="rounded-2xl border border-border bg-surface p-4">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={cn("mt-2 font-mono text-2xl font-semibold tabular-nums", accent && "text-accent-strong")}>
        {value}
      </p>
    </div>
  );
}

function LegCard({
  ticker,
  name,
  category,
  weightBps,
  priceUsd,
  change24h,
  sparkline,
  address,
  reserve,
  accent,
}: {
  ticker: string;
  name?: string;
  category?: string;
  weightBps: number;
  priceUsd?: number;
  change24h?: number;
  sparkline?: number[];
  address: string;
  reserve: string;
  accent: string;
}) {
  const up = change24h != null ? change24h >= 0 : true;
  return (
    <div className="group relative overflow-hidden rounded-[1.5rem] border border-border bg-surface p-5 transition-transform hover:-translate-y-0.5">
      <div className="relative flex items-start gap-3">
        <StockLogo ticker={ticker} size="md" />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="text-lg font-semibold">{ticker}</span>
            <span className="font-mono text-xs tabular-nums text-muted-foreground">
              target {(weightBps / 100).toFixed(0)}%
            </span>
          </div>
          <p className="truncate text-xs text-muted-foreground">{name ?? "—"}</p>
          {category && (
            <p className="mt-0.5 inline-block rounded-full bg-surface-muted px-2 py-0.5 font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
              {category.replace("-", " ")}
            </p>
          )}
        </div>
      </div>

      {sparkline && sparkline.length > 2 && (
        <div className="relative mt-3">
          <Sparkline data={sparkline} width={260} height={48} positive={up} strokeWidth={1.8} className="w-full" />
        </div>
      )}

      <div className="relative mt-3 flex items-baseline justify-between">
        <span className="font-mono text-2xl font-semibold tabular-nums">
          {priceUsd != null ? (
            <NumberTicker value={priceUsd} prefix="$" decimals={priceUsd < 10 ? 4 : 2} startOnView={false} />
          ) : (
            "—"
          )}
        </span>
        {change24h != null && (
          <span
            className={cn(
              "rounded-full px-2 py-0.5 font-mono text-xs tabular-nums",
              up ? "bg-emerald-500/10 text-emerald-600" : "bg-rose-500/10 text-rose-600",
            )}
          >
            {change24h >= 0 ? "+" : ""}
            {change24h.toFixed(2)}%
          </span>
        )}
      </div>
      <p className="relative mt-2 font-mono text-[11px] text-muted-foreground">Reserve: {reserve}</p>
      <div className="relative mt-3 text-[11px]">
        <AddressChip address={address} kind="address" label="Contract" />
      </div>
    </div>
  );
}
