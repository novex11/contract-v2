"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { motion, AnimatePresence } from "motion/react";
import { formatUnits, type Address } from "viem";
import { useReadContracts, useSignMessage } from "wagmi";
import {
  ArrowRight,
  CaretLeft,
  Check,
  CheckCircle,
  CircleNotch,
  Coins,
  Drop,
  Info,
  Rocket,
  Scales,
  SealCheck,
  Sparkle,
  TextAa,
  Wallet,
  WarningCircle,
} from "@phosphor-icons/react";
import {
  LAUNCHPAD_CONFIG,
  LAUNCHPAD_SLIPPAGE_BPS,
  LAUNCH_METADATA_LIMITS,
  PAIR_CATEGORY_ACCENT,
  PAIR_CATEGORY_LABEL,
  TESTNET_FAUCET_URL,
  classifyPair,
  depositAmountError,
  isTestnetMode,
  isValidHttpUrl,
  launchpadEligibleTokens,
  pairMetadataMessage,
  sanitizeDisplayName,
  sanitizeReceiptSymbol,
  testnetContractsReady,
  USDG_DECIMALS,
  type StockToken,
} from "@compose/config";
import { saveLaunchpadMetadata } from "@/lib/api";
import { rpcDisplayLabel } from "@/lib/chain-config";
import { useChainConfig } from "@/components/chain-config-context";
import {
  ORACLE_ADDRESS,
  USDG_ADDRESS,
  isWeth,
  oracleAdapterAbi,
  oracleReady,
  pairFactoryReady,
} from "@/lib/contracts";
import { friendlyTxError } from "@/lib/tx";
import {
  useExistingPair,
  useLaunchPair,
  useOraclePrices,
  usePoolConfig,
  usePairUniquenessPending,
  useTokenBalances,
  type TxStage,
  useListedTokens,
} from "@/hooks/use-pair-launchpad";
import { useWallet } from "@/hooks/use-wallet";
import { useQuotes } from "@/hooks/use-quotes";
import { cn, explorerUrl, formatUsd } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { NumberTicker } from "@/components/ui/number-ticker";
import { Sparkline } from "@/components/ui/sparkline";
import { StockLogo } from "@/components/ui/stock-logo";
import { HatchPattern } from "@/components/motion/hatch-pattern";
import { DualLogoStack } from "@/components/launchpad/dual-logo-stack";
import { AddressChip } from "@/components/launchpad/address-chip";
import { StageProgressList, type ProgressStep } from "@/components/launchpad/stage-progress";
import { PairPreviewCard } from "@/components/launchpad/pair-preview-card";
import { PoolSeedOption } from "@/components/launchpad/pool-seed-option";
import { ImageUploader } from "@/components/launchpad/image-uploader";
import { DepositAmountField } from "@/components/launchpad/deposit-amount-field";

const spring = { type: "spring", stiffness: 100, damping: 20 } as const;
const LEG_B_ACCENT = "#3D8BFF";
const WEIGHT_PRESETS = [3000, 5000, 7000];
/** Native ETH kept aside for gas when a WETH leg is paid with ETH. */
const GAS_RESERVE_WEI = 500_000_000_000_000n;

/** Token amount worth `weightBps` of `usd8` at `price8` (all USD values 8-decimal). */
function tokenAmountForUsd(
  usd8: bigint,
  weightBps: number,
  price8: bigint | undefined,
  decimals: number,
): bigint {
  if (!price8) return 0n;
  return (usd8 * BigInt(weightBps) * 10n ** BigInt(decimals)) / 10_000n / price8;
}

function formatToken(amount: bigint, decimals = 18): string {
  const n = Number(formatUnits(amount, decimals));
  return n.toLocaleString(undefined, { maximumFractionDigits: n !== 0 && n < 1 ? 6 : 4 });
}

function usdValue(amount: bigint, price8: bigint | undefined, decimals = 18): number {
  if (!price8) return 0;
  return Number(formatUnits(amount * price8, decimals + 8));
}


function Section({
  n,
  title,
  hint,
  done,
  last,
  icon: Icon,
  children,
}: {
  n: string;
  title: string;
  hint?: string;
  /** Step is complete — shows a check + accent ring */
  done?: boolean;
  /** Hide the vertical connector below this step */
  last?: boolean;
  icon?: React.ComponentType<{ size?: number; weight?: "regular" | "fill" | "bold" }>;
  children: React.ReactNode;
}) {
  return (
    <section className="relative grid gap-4 py-7 first:pt-0 md:grid-cols-[3.25rem_1fr] md:gap-6">
      {/* Step rail */}
      <div className="relative flex flex-row items-center gap-3 md:flex-col md:items-start">
        <motion.span
          layout
          className={cn(
            "relative z-10 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full border font-mono text-xs font-semibold transition-colors",
            done
              ? "border-accent bg-accent text-accent-foreground shadow-[0_0_0_4px_var(--accent-subtle)]"
              : "border-border bg-surface text-muted-foreground",
          )}
        >
          <AnimatePresence mode="wait" initial={false}>
            {done ? (
              <motion.span
                key="check"
                initial={{ scale: 0.4, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                exit={{ scale: 0.4, opacity: 0 }}
                transition={{ type: "spring", stiffness: 300, damping: 18 }}
              >
                <Check size={14} weight="bold" />
              </motion.span>
            ) : (
              <motion.span
                key="num"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
              >
                {n}
              </motion.span>
            )}
          </AnimatePresence>
        </motion.span>
        {!last && (
          <span
            aria-hidden
            className={cn(
              "absolute left-[1.125rem] top-9 hidden h-[calc(100%+1.75rem)] w-px md:block",
              done ? "bg-accent/60" : "bg-border-subtle",
            )}
          />
        )}
        <div className="md:hidden">
          <h2 className="text-base font-semibold">{title}</h2>
        </div>
      </div>

      <div>
        <div className="mb-4 hidden items-start justify-between gap-3 md:flex">
          <div>
            <h2 className="flex items-center gap-2 text-base font-semibold">
              {Icon && (
                <span className="inline-flex h-6 w-6 items-center justify-center rounded-md bg-accent-subtle text-accent-strong">
                  <Icon size={13} weight="fill" />
                </span>
              )}
              {title}
            </h2>
            {hint && (
              <p className="mt-1 text-xs text-muted-foreground">{hint}</p>
            )}
          </div>
          {done && (
            <span className="shrink-0 rounded-full bg-emerald-500/10 px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wide text-emerald-600 dark:text-emerald-400">
              Done
            </span>
          )}
        </div>
        {hint && (
          <p className="mb-3 text-xs text-muted-foreground md:hidden">{hint}</p>
        )}
        {children}
      </div>
    </section>
  );
}

/** Small labelled input wrapper shared by the identity step. */
function Field({
  label,
  required,
  optional,
  helper,
  trailing,
  children,
}: {
  label: string;
  required?: boolean;
  optional?: boolean;
  helper?: string;
  trailing?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="block">
      <span className="flex items-baseline justify-between">
        <span className="text-xs font-semibold text-foreground">
          {label}
          {required && <span className="ml-0.5 text-destructive">*</span>}
          {optional && (
            <span className="ml-1 font-normal text-muted-foreground">
              (optional)
            </span>
          )}
        </span>
        {trailing}
      </span>
      <div className="mt-1.5">{children}</div>
      {helper && (
        <span className="mt-1 block font-mono text-[10px] text-muted-foreground">
          {helper}
        </span>
      )}
    </div>
  );
}

const inputClass =
  "h-11 w-full rounded-xl border border-border bg-surface-muted px-3 text-sm outline-none transition-all placeholder:text-muted-foreground/50 focus:border-accent focus:bg-surface focus:shadow-[0_0_0_3px_var(--accent-subtle)]";

export default function LaunchContent() {
  const wallet = useWallet();
  const { rpcUrl } = useChainConfig();
  const router = useRouter();
  const { signMessageAsync } = useSignMessage();
  const listing = useListedTokens();
  const eligibleTokens = useMemo<StockToken[]>(() => {
    const all = launchpadEligibleTokens();
    // Until the factory reports its list, show everything; afterwards only
    // tokens with a registered feed can be a leg (launch reverts otherwise).
    if (!listing.loaded || listing.listed.size === 0) return all;
    return all.filter((t) => listing.listed.has(t.address.toLowerCase()));
  }, [listing.loaded, listing.listed]);

  const [tickerA, setTickerA] = useState<string>(() => eligibleTokens[0]?.ticker ?? "TSLA");
  const [tickerB, setTickerB] = useState<string>(() => eligibleTokens[1]?.ticker ?? "AMZN");
  const [weightABps, setWeightABps] = useState<number>(5000);
  // Pair deposits are creator-only, so the public never pays a deposit fee.
  const feeBps = 0;
  const [usdTarget, setUsdTarget] = useState<number>(LAUNCHPAD_CONFIG.defaultSeedUsd);
  const [payWithEth, setPayWithEth] = useState<boolean | null>(null);
  const [poolOn, setPoolOn] = useState(false);
  const [poolShareBps, setPoolShareBps] = useState<number>(LAUNCHPAD_CONFIG.pool.defaultShareBps);
  const [displayNameInput, setDisplayNameInput] = useState("");
  const [symbolInput, setSymbolInput] = useState("");
  const [description, setDescription] = useState("");
  const [bannerUrl, setBannerUrl] = useState("");
  const [logoUrl, setLogoUrl] = useState("");
  const [websiteUrl, setWebsiteUrl] = useState("");
  const [numeraireTicker, setNumeraireTicker] = useState<string>("");
  const [lastStage, setLastStage] = useState<TxStage | null>(null);
  const [savingProfile, setSavingProfile] = useState(false);
  const [success, setSuccess] = useState<{
    pair: Address;
    hash: `0x${string}`;
    pool?: `0x${string}`;
    symbol: string;
    shares: number;
    profileError?: string;
  } | null>(null);

  const tokenA = eligibleTokens.find((t) => t.ticker === tickerA);
  const tokenB = eligibleTokens.find((t) => t.ticker === tickerB);
  const canPair = !!tokenA && !!tokenB && tickerA !== tickerB;
  const addrA = tokenA?.address as Address | undefined;
  const addrB = tokenB?.address as Address | undefined;

  const { data: existingPair } = useExistingPair(addrA, addrB);
  const pairUniquenessPending = usePairUniquenessPending(addrA, addrB);
  const existingPairAddr =
    typeof existingPair === "string" ? (existingPair as Address) : undefined;
  const alreadyExists = Boolean(
    existingPairAddr && existingPairAddr !== "0x0000000000000000000000000000000000000000",
  );

  const receiptSymbol = sanitizeReceiptSymbol(symbolInput);
  const receiptName = sanitizeDisplayName(displayNameInput);
  const category = canPair ? classifyPair(tokenA!.category, tokenB!.category) : "mixed";
  const categoryLabel = PAIR_CATEGORY_LABEL[category];
  const categoryAccent = PAIR_CATEGORY_ACCENT[category];

  const { byTicker } = useQuotes([tickerA, tickerB]);
  const priceTokens = useMemo(() => (addrA && addrB ? [addrA, addrB] : []), [addrA, addrB]);
  const { prices } = useOraclePrices(priceTokens);
  const priceA8 = addrA ? prices.get(addrA.toLowerCase()) : undefined;
  const priceB8 = addrB ? prices.get(addrB.toLowerCase()) : undefined;
  const priceA = priceA8 ? Number(priceA8) / 1e8 : byTicker.get(tickerA)?.price;
  const priceB = priceB8 ? Number(priceB8) / 1e8 : byTicker.get(tickerB)?.price;

  // getPrice() reverts when a feed is older than the on-chain staleness limit.
  const freshness = useReadContracts({
    contracts: priceTokens.map((token) => ({
      address: ORACLE_ADDRESS,
      abi: oracleAdapterAbi,
      functionName: "getPrice",
      args: [token],
    })),
    query: { enabled: oracleReady && priceTokens.length === 2, refetchInterval: 15_000 },
  });
  const pricesStale = freshness.data?.some((r) => r.status === "failure") ?? false;

  const {
    balances,
    native,
    refetch: refetchBalances,
  } = useTokenBalances(wallet.address, priceTokens);
  const balA = addrA ? (balances.get(addrA.toLowerCase()) ?? 0n) : 0n;
  const balB = addrB ? (balances.get(addrB.toLowerCase()) ?? 0n) : 0n;

  // Optional DEX pool at launch (share token vs the factory's quote token, USDG).
  const poolConfig = usePoolConfig();
  const quoteToken = poolConfig.data?.enabled ? poolConfig.data.quoteToken : undefined;
  const poolAvailable = Boolean(quoteToken);
  const quoteSymbol = quoteToken && quoteToken.toLowerCase() === USDG_ADDRESS.toLowerCase() ? "USDG" : "quote token";
  const quoteDecimals = USDG_DECIMALS;
  const { balances: quoteBalances } = useTokenBalances(wallet.address, quoteToken ? [quoteToken] : []);
  const quoteBalanceRaw = quoteToken ? (quoteBalances.get(quoteToken.toLowerCase()) ?? 0n) : 0n;
  const quoteBalance = wallet.address ? Number(quoteBalanceRaw) / 10 ** quoteDecimals : undefined;
  const poolActive = poolOn && poolAvailable && !!quoteToken;
  const poolUsd = poolActive ? (usdTarget * poolShareBps) / 10_000 : 0;
  const poolQuoteNeeded = poolUsd * (1 + LAUNCHPAD_CONFIG.pool.quoteBufferBps / 10_000);
  const poolQuoteMaxRaw = BigInt(Math.ceil(poolQuoteNeeded * 10 ** quoteDecimals));
  const poolBlocker =
    poolActive && quoteBalance !== undefined && quoteBalance < poolQuoteNeeded
      ? `Need ${formatUsd(poolQuoteNeeded)} ${quoteSymbol} for the pool`
      : null;

  useEffect(() => {
    if (eligibleTokens.length === 0) return;
    const allowed = new Set(eligibleTokens.map((t) => t.ticker));
    const aOk = allowed.has(tickerA);
    const bOk = allowed.has(tickerB);
    if (aOk && bOk && tickerA !== tickerB) return;
    const nextA = aOk ? tickerA : eligibleTokens[0]!.ticker;
    const nextB =
      bOk && tickerB !== nextA
        ? tickerB
        : (eligibleTokens.find((t) => t.ticker !== nextA)?.ticker ?? nextA);
    setTickerA(nextA);
    setTickerB(nextB);
  }, [eligibleTokens, tickerA, tickerB]);

  const weightBBps = 10_000 - weightABps;

  const usd8 = BigInt(Math.round((usdTarget || 0) * 1e8));
  const amountA = tokenA ? tokenAmountForUsd(usd8, weightABps, priceA8, tokenA.decimals) : 0n;
  const amountB = tokenB ? tokenAmountForUsd(usd8, weightBBps, priceB8, tokenB.decimals) : 0n;

  const wethLeg: Address | null =
    addrA && isWeth(addrA) ? addrA : addrB && isWeth(addrB) ? addrB : null;
  const wethNeeded = wethLeg === addrA ? amountA : wethLeg === addrB ? amountB : 0n;
  const wethBalance = wethLeg === addrA ? balA : wethLeg === addrB ? balB : 0n;
  const useEth = wethLeg !== null && (payWithEth ?? wethBalance < wethNeeded);
  const nativeLeg = useEth ? wethLeg : null;
  const ethSpendable = native != null && native > GAS_RESERVE_WEI ? native - GAS_RESERVE_WEI : 0n;
  const haveA = nativeLeg !== null && nativeLeg === addrA ? ethSpendable : balA;
  const haveB = nativeLeg !== null && nativeLeg === addrB ? ethSpendable : balB;
  const shortA = amountA > haveA;
  const shortB = amountB > haveB;
  const unitA = nativeLeg !== null && nativeLeg === addrA ? "ETH" : tickerA;
  const unitB = nativeLeg !== null && nativeLeg === addrB ? "ETH" : tickerB;

  const maxUsd =
    tokenA && tokenB && priceA8 && priceB8
      ? Math.min(
          usdValue(haveA, priceA8, tokenA.decimals) / (weightABps / 10_000),
          usdValue(haveB, priceB8, tokenB.decimals) / (weightBBps / 10_000),
        )
      : undefined;

  // The seed mints 1e18 shares per $1 at on-chain prices; allow 1% drift.
  const minShares =
    (usd8 * 10_000_000_000n * BigInt(10_000 - LAUNCHPAD_SLIPPAGE_BPS)) / 10_000n;

  const metadataComplete =
    receiptName.length >= 3 &&
    receiptSymbol.length >= 3 &&
    description.trim().length >= 1 &&
    bannerUrl.trim().length > 0 &&
    logoUrl.trim().length > 0 &&
    isValidHttpUrl(bannerUrl, true) &&
    isValidHttpUrl(logoUrl, true) &&
    isValidHttpUrl(websiteUrl) &&
    (numeraireTicker === tickerA || numeraireTicker === tickerB);

  const metadataError =
    receiptName.length < 3
      ? "Enter a display name (min 3 characters)"
      : receiptSymbol.length < 3
        ? "Enter a ticker / symbol (min 3 characters)"
        : !description.trim()
          ? "Enter a description for your pair"
          : !bannerUrl.trim()
            ? "Upload a banner image or paste a URL"
            : !logoUrl.trim()
              ? "Upload a logo image or paste a URL"
              : !isValidHttpUrl(bannerUrl, true)
                ? "Banner must be uploaded or a valid http(s) URL"
                : !isValidHttpUrl(logoUrl, true)
                  ? "Logo must be uploaded or a valid http(s) URL"
                  : !isValidHttpUrl(websiteUrl)
                    ? "Website URL must start with http:// or https://"
                    : numeraireTicker !== tickerA && numeraireTicker !== tickerB
                      ? "Pick a quote leg (numeraire)"
                      : null;

  const launchPair = useLaunchPair();
  const stage = launchPair.stage;
  useEffect(() => {
    if (stage === "approve-a" || stage === "approve-b" || stage === "submit") setLastStage(stage);
  }, [stage]);
  const txBusy = stage === "approve-a" || stage === "approve-b" || stage === "submit";
  const busy = txBusy || savingProfile;
  const overlayVisible = busy || stage === "error";

  const depositError = depositAmountError(usdTarget);
  const pricesReady = !!priceA8 && !!priceB8;
  const noPairTokens = !!wallet.address && balA === 0n && balB === 0n;

  const seedBlocker =
    depositError ??
    (!pricesReady
      ? "Loading on-chain prices…"
      : pricesStale
        ? "On-chain prices are refreshing. Try again in a minute."
        : shortA
          ? `Not enough ${unitA}: need ${formatToken(amountA)}, wallet has ${formatToken(haveA)}.`
          : shortB
            ? `Not enough ${unitB}: need ${formatToken(amountB)}, wallet has ${formatToken(haveB)}.`
            : poolBlocker);

  const stepsDone = [
    canPair && !alreadyExists,
    metadataComplete,
    true, // weights are always in range via the slider
    wallet.authenticated && seedBlocker === null,
  ];
  const stepsCompleted = stepsDone.filter(Boolean).length;
  const progressPct = Math.round((stepsCompleted / stepsDone.length) * 100);

  const blocker = !pairFactoryReady
    ? isTestnetMode()
      ? "Launchpad contracts are not deployed on testnet yet (pnpm deploy:testnet)."
      : "The launchpad is not deployed on this network yet."
    : !canPair
      ? "Pick two different tokens."
      : pairUniquenessPending
        ? "Checking whether this pair already exists…"
        : alreadyExists
          ? `${tickerA}/${tickerB} is already launched.`
          : (metadataError ?? seedBlocker);
  const canLaunch = wallet.authenticated && blocker === null && !busy;

  async function saveProfile(pair: Address): Promise<string | undefined> {
    const issuedAt = new Date().toISOString();
    const meta = {
      pairAddress: pair,
      displayName: receiptName,
      description: description.trim(),
      imageUrl: bannerUrl.trim(),
      logoUrl: logoUrl.trim(),
      websiteUrl: websiteUrl.trim(),
      numeraireTicker,
    };
    let signature: `0x${string}`;
    try {
      signature = await signMessageAsync({ message: pairMetadataMessage({ ...meta, issuedAt }) });
    } catch (e) {
      return friendlyTxError(e);
    }
    let lastError = "Could not reach the indexer.";
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await saveLaunchpadMetadata({ ...meta, issuedAt, signature });
        return undefined;
      } catch (e) {
        lastError = e instanceof Error ? e.message : String(e);
        await new Promise((r) => setTimeout(r, 1500));
      }
    }
    return lastError;
  }

  async function launch() {
    if (!canLaunch || !tokenA || !tokenB) return;
    launchPair.reset();
    setLastStage(null);
    let result: Awaited<ReturnType<typeof launchPair.execute>>;
    try {
      result = await launchPair.execute({
        tokenA: tokenA.address,
        tokenB: tokenB.address,
        weightABps,
        creatorFeeBps: feeBps,
        receiptName,
        receiptSymbol,
        amountA,
        amountB,
        minShares,
        nativeLeg,
        pool: poolActive && quoteToken ? { shareBps: poolShareBps, quoteToken, maxQuoteAmount: poolQuoteMaxRaw } : undefined,
      });
    } catch {
      return; // stage=error, message shown in the progress overlay
    }
    refetchBalances();
    setSavingProfile(true);
    const profileError = await saveProfile(result.pair);
    setSavingProfile(false);
    setSuccess({
      pair: result.pair,
      hash: result.hash,
      pool: result.pool,
      symbol: receiptSymbol,
      shares: usdTarget,
      profileError,
    });
  }

  async function retryProfile() {
    if (!success) return;
    setSavingProfile(true);
    const profileError = await saveProfile(success.pair);
    setSavingProfile(false);
    setSuccess({ ...success, profileError });
  }

  const progressSteps: ProgressStep[] = [
    ...(nativeLeg !== null && nativeLeg === addrA
      ? []
      : [{ id: "approve-a" as const, label: `Approve ${tickerA}`, hint: "Token approval for the launchpad (skipped if already approved)" }]),
    ...(nativeLeg !== null && nativeLeg === addrB
      ? []
      : [{ id: "approve-b" as const, label: `Approve ${tickerB}`, hint: "Token approval for the launchpad (skipped if already approved)" }]),
    {
      id: "submit",
      label: "Launch & seed pair",
      hint: "One transaction deploys your pair vault and deposits your seed",
    },
  ];

  // ─── Success screen ──────────────────────────────────
  if (success) {
    return (
      <SuccessScreen
        colorA={categoryAccent}
        colorB={LEG_B_ACCENT}
        tickerA={tickerA}
        tickerB={tickerB}
        receiptSymbol={success.symbol}
        sharesMinted={success.shares}
        seedTx={success.hash}
        poolAddr={success.pool}
        pairAddr={success.pair}
        notice={
          success.profileError
            ? `Your pair is live on-chain, but its profile (name, images, description) was not saved: ${success.profileError}`
            : undefined
        }
        onRetryProfile={success.profileError ? retryProfile : undefined}
        retrying={savingProfile}
        onAnother={() => {
          launchPair.reset();
          setSuccess(null);
        }}
        onBrowse={() => router.push(`/pair/${success.pair}`)}
      />
    );
  }

  return (
    <div className="relative container-page min-h-[100dvh] py-8 md:py-10">
      <Link
        href="/launchpad"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <CaretLeft size={14} />
        Launchpad
      </Link>

      {isTestnetMode() && (
        <div className="mt-4 rounded-2xl border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-sm text-amber-700 dark:text-amber-400">
          <span className="font-semibold">Testnet mode</span>
          {" · "}
          Robinhood Chain Testnet (46630) · RPC{" "}
          <span className="font-mono text-xs">{rpcDisplayLabel(rpcUrl)}</span>
          {!testnetContractsReady() && (
            <>
              {" · "}
              Run{" "}
              <code className="rounded bg-surface-muted px-1.5 py-0.5 font-mono text-xs">
                pnpm deploy:testnet
              </code>{" "}
              to enable launches.
            </>
          )}
        </div>
      )}

      {/* Hero */}
      <div className="mt-5 grid gap-6 md:grid-cols-12 md:items-end">
        <div className="md:col-span-7">
          <p className="label-caps flex items-center gap-2">
            <Sparkle size={12} weight="fill" /> Pair Launchpad
          </p>
          <h1 className="mt-3 bg-gradient-to-br from-foreground via-foreground to-accent-strong bg-clip-text text-3xl font-semibold tracking-tight text-transparent md:text-5xl">
            Launch a unique pair
          </h1>
          <p className="mt-3 max-w-xl text-muted-foreground">
            Pair any two listed tokens on Robinhood Chain, seed the vault with
            the tokens themselves, then launch its token. Only you can add
            stocks to the vault; the public trades the token.
          </p>
        </div>

        {/* Progress summary */}
        <div className="md:col-span-5">
          <div className="relative overflow-hidden rounded-2xl border border-border bg-surface/80 p-4 backdrop-blur">
            <HatchPattern className="opacity-30" />
            <div className="relative">
              <div className="flex items-baseline justify-between">
                <span className="label-caps">Launch readiness</span>
                <span className="font-mono text-xs tabular-nums text-muted-foreground">
                  {stepsCompleted}/{stepsDone.length} steps
                </span>
              </div>
              <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-surface-muted">
                <motion.div
                  className="h-full rounded-full"
                  animate={{ width: `${progressPct}%` }}
                  transition={{ type: "spring", stiffness: 120, damping: 20 }}
                  style={{
                    background: `linear-gradient(90deg, ${categoryAccent}, ${LEG_B_ACCENT})`,
                  }}
                />
              </div>
              <div className="mt-3 flex flex-wrap gap-1.5">
                {[
                  ["Pair", stepsDone[0]],
                  ["Identity", stepsDone[1]],
                  ["Weights", stepsDone[2]],
                  ["Seed", stepsDone[3]],
                ].map(([label, ok]) => (
                  <span
                    key={label as string}
                    className={cn(
                      "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-[10px] font-semibold transition-colors",
                      ok
                        ? "border-accent/40 bg-accent-subtle text-accent-strong"
                        : "border-border text-muted-foreground",
                    )}
                  >
                    {ok ? <Check size={9} weight="bold" /> : null}
                    {label as string}
                  </span>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Highlights strip */}
      <div className="mt-8 grid gap-3 sm:grid-cols-3">
        {[
          {
            icon: <Rocket size={16} weight="fill" />,
            title: "Instant & permissionless",
            body: "Any wallet, any two listed tokens. One launch transaction.",
          },
          {
            icon: <Coins size={16} weight="fill" />,
            title: "Earn on every token trade",
            body: "70% of the 1% curve fee on every buy and sell of your pair's token, paid in pair shares.",
          },
          {
            icon: <SealCheck size={16} weight="fill" />,
            title: "Fully backed, always redeemable",
            body: "Your vault holds the real tokens. Token holders can always sell back into them.",
          },
        ].map((h, i) => (
          <motion.div
            key={h.title}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ ...spring, delay: 0.05 * i }}
            className="flex items-start gap-3 rounded-2xl border border-border bg-surface px-4 py-3"
          >
            <span className="mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-accent-subtle text-accent-strong">
              {h.icon}
            </span>
            <div>
              <p className="text-sm font-semibold">{h.title}</p>
              <p className="text-xs text-muted-foreground">{h.body}</p>
            </div>
          </motion.div>
        ))}
      </div>

      <div className="mt-10 grid gap-10 lg:grid-cols-12">
        {/* Left: form */}
        <div className="lg:col-span-7">
          <Section
            n="01"
            title="Choose your pair"
            hint="Pick any two listed tokens. Your seed is valued at on-chain oracle prices."
            done={stepsDone[0]}
            icon={Scales}
          >
            {isTestnetMode() && (
              <p className="mb-4 flex items-start gap-2 rounded-xl border border-accent/25 bg-accent-subtle/40 px-3 py-2.5 text-xs leading-relaxed text-foreground">
                <Info size={16} className="mt-0.5 shrink-0 text-accent-strong" />
                <span>
                  <strong>Robinhood Chain Testnet:</strong>{" "}
                  {eligibleTokens.map((t) => t.ticker).join(", ")}: the real faucet
                  Stock Tokens plus WETH. Claim free test tokens and ETH from the{" "}
                  <a
                    href={TESTNET_FAUCET_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-medium text-accent-strong underline-offset-2 hover:underline"
                  >
                    Robinhood faucet ↗
                  </a>
                </span>
              </p>
            )}
            <div className="grid gap-4 md:grid-cols-2">
              <div className="rounded-2xl border border-border bg-surface p-3">
                <div className="mb-2 flex items-center justify-between px-1">
                  <span className="flex items-center gap-2 text-xs font-semibold">
                    <span
                      className="inline-block h-2.5 w-2.5 rounded-full"
                      style={{ background: categoryAccent }}
                    />
                    Token A
                  </span>
                  <span className="flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
                    <StockLogo ticker={tickerA} size="xs" />
                    {tickerA}
                  </span>
                </div>
                <TokenGrid
                  compact
                  tokens={eligibleTokens}
                  selected={tickerA}
                  excluded={tickerB}
                  onPick={(t) => {
                    setTickerA(t);
                    setPayWithEth(null);
                  }}
                  byTicker={byTicker}
                />
              </div>
              <div className="rounded-2xl border border-border bg-surface p-3">
                <div className="mb-2 flex items-center justify-between px-1">
                  <span className="flex items-center gap-2 text-xs font-semibold">
                    <span
                      className="inline-block h-2.5 w-2.5 rounded-full"
                      style={{ background: LEG_B_ACCENT }}
                    />
                    Token B
                  </span>
                  <span className="flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
                    <StockLogo ticker={tickerB} size="xs" />
                    {tickerB}
                  </span>
                </div>
                <TokenGrid
                  compact
                  tokens={eligibleTokens}
                  selected={tickerB}
                  excluded={tickerA}
                  onPick={(t) => {
                    setTickerB(t);
                    setPayWithEth(null);
                  }}
                  byTicker={byTicker}
                />
              </div>
            </div>

            {/* Pair summary strip */}
            <motion.div
              layout
              className="mt-4 flex items-center justify-between gap-3 rounded-2xl border border-border bg-surface-muted/60 px-4 py-3"
            >
              <div className="flex items-center gap-3">
                <DualLogoStack tickerA={tickerA} tickerB={tickerB} size="sm" />
                <div>
                  <p className="text-sm font-semibold">
                    {tickerA} <span className="text-muted-foreground">/</span> {tickerB}
                  </p>
                  <p className="text-[11px] text-muted-foreground">
                    {tokenA?.name} · {tokenB?.name}
                  </p>
                </div>
              </div>
              <div className="text-right">
                <span
                  className="inline-flex items-center rounded-full px-2.5 py-1 font-mono text-[10px] font-semibold uppercase tracking-wide text-white"
                  style={{ background: categoryAccent }}
                >
                  {categoryLabel}
                </span>
                {pairUniquenessPending && (
                  <p className="mt-1 text-[11px] text-muted-foreground">Checking chain…</p>
                )}
                {alreadyExists && (
                  <p className="mt-1 text-[11px] text-destructive">Already launched</p>
                )}
              </div>
            </motion.div>
            {alreadyExists && existingPairAddr && (
              <p className="mt-3 flex items-start gap-2 rounded-xl border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-xs leading-relaxed text-foreground">
                <WarningCircle size={16} className="mt-0.5 shrink-0 text-destructive" />
                <span>
                  <strong>
                    {tickerA}/{tickerB} is already launched.
                  </strong>{" "}
                  Each token combination can exist once.{" "}
                  <Link
                    href={`/pair/${existingPairAddr}`}
                    className="font-medium text-accent-strong underline-offset-2 hover:underline"
                  >
                    Open the existing pair
                  </Link>{" "}
                  to deposit, or pick a different combination.
                </span>
              </p>
            )}
          </Section>


          <Section
            n="02"
            title="Pair identity"
            hint="You choose everything — name, ticker, image, and description. Nothing is auto-filled."
            done={stepsDone[1]}
            icon={TextAa}
          >
            <div className="overflow-hidden rounded-2xl border border-border bg-surface">
              {/* Banner + logo — prominent visual assets */}
              <div className="relative border-b border-border-subtle bg-gradient-to-br from-accent-subtle/50 via-surface to-surface p-5 md:p-6">
                <div className="mb-4 flex items-start gap-3">
                  <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-accent text-accent-foreground">
                    <Sparkle size={18} weight="fill" />
                  </span>
                  <div>
                    <h3 className="text-sm font-semibold">Banner & logo</h3>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      Upload from your device or paste a URL. Both show on your
                      pair page and launchpad listing.
                    </p>
                  </div>
                </div>
                <div className="grid gap-5 md:grid-cols-[1fr_11rem]">
                  <Field
                    label="Banner"
                    required
                    helper="Wide cover image at the top of your pair page"
                  >
                    <ImageUploader
                      variant="banner"
                      value={bannerUrl}
                      onChange={setBannerUrl}
                    />
                  </Field>
                  <Field
                    label="Logo"
                    required
                    helper="Square avatar over the banner"
                  >
                    <ImageUploader
                      variant="logo"
                      value={logoUrl}
                      onChange={setLogoUrl}
                    />
                  </Field>
                </div>
              </div>

              <div className="space-y-4 p-5">
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field
                    label="Display name"
                    required
                    helper={`On-chain ERC-20 name · max ${LAUNCH_METADATA_LIMITS.displayNameMax} chars`}
                    trailing={
                      <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
                        {displayNameInput.length}/{LAUNCH_METADATA_LIMITS.displayNameMax}
                      </span>
                    }
                  >
                    <input
                      type="text"
                      value={displayNameInput}
                      maxLength={LAUNCH_METADATA_LIMITS.displayNameMax}
                      onChange={(e) => setDisplayNameInput(e.target.value)}
                      placeholder="Your pair name"
                      required
                      className={inputClass}
                    />
                  </Field>
                  <Field
                    label="Ticker / symbol"
                    required
                    helper="Receipt token symbol · letters, numbers, hyphen"
                    trailing={
                      <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
                        {symbolInput.length}/{LAUNCH_METADATA_LIMITS.symbolMax}
                      </span>
                    }
                  >
                    <div className="relative">
                      <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 font-mono text-sm text-muted-foreground">
                        $
                      </span>
                      <input
                        type="text"
                        value={symbolInput}
                        maxLength={LAUNCH_METADATA_LIMITS.symbolMax}
                        onChange={(e) =>
                          setSymbolInput(e.target.value.toUpperCase())
                        }
                        placeholder="YOUR-TICKER"
                        required
                        className={cn(
                          inputClass,
                          "pl-7 font-mono font-semibold uppercase tracking-wide",
                        )}
                      />
                    </div>
                  </Field>
                </div>

                <Field
                  label="Description"
                  required
                  trailing={
                    <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
                      {description.length}/{LAUNCH_METADATA_LIMITS.descriptionMax}
                    </span>
                  }
                >
                  <textarea
                    value={description}
                    maxLength={LAUNCH_METADATA_LIMITS.descriptionMax}
                    onChange={(e) => setDescription(e.target.value)}
                    rows={4}
                    placeholder="What's the thesis behind this pair? Who is it for?"
                    required
                    className={cn(
                      inputClass,
                      "h-auto resize-none py-2.5 leading-relaxed",
                    )}
                  />
                </Field>

                <Field
                  label="Website / link"
                  optional
                  helper="Docs, X profile, or a landing page for your pair"
                >
                  <input
                    type="url"
                    value={websiteUrl}
                    maxLength={LAUNCH_METADATA_LIMITS.websiteUrlMax}
                    onChange={(e) => setWebsiteUrl(e.target.value)}
                    placeholder="https://…"
                    className={inputClass}
                  />
                </Field>

                <div>
                  <span className="text-xs font-semibold">
                    Quote leg (numeraire){" "}
                    <span className="text-destructive">*</span>
                  </span>
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    Which stock anchors the pair&apos;s value narrative.
                  </p>
                  <div className="mt-2 grid grid-cols-2 gap-2">
                    {[tickerA, tickerB].map((t, idx) => {
                      const on = numeraireTicker === t;
                      const tok = idx === 0 ? tokenA : tokenB;
                      return (
                        <button
                          key={t}
                          type="button"
                          onClick={() => setNumeraireTicker(t)}
                          className={cn(
                            "relative flex items-center gap-3 rounded-xl border p-3 text-left transition-all active:scale-[0.99]",
                            on
                              ? "border-accent bg-accent-subtle shadow-card"
                              : "border-border bg-surface hover:border-accent/40",
                          )}
                        >
                          <StockLogo ticker={t} size="sm" />
                          <span className="min-w-0">
                            <span className="block text-sm font-semibold">
                              {t}
                            </span>
                            <span className="block truncate text-[11px] text-muted-foreground">
                              {tok?.name}
                            </span>
                          </span>
                          {on && (
                            <span className="absolute right-3 top-3 text-accent-strong">
                              <CheckCircle size={16} weight="fill" />
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                </div>

                <AnimatePresence initial={false}>
                  {metadataError ? (
                    <motion.p
                      key={metadataError}
                      initial={{ opacity: 0, y: -4 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0 }}
                      className="flex items-center gap-1.5 rounded-xl border border-destructive/20 bg-destructive/5 px-3 py-2 text-xs text-destructive"
                    >
                      <WarningCircle size={14} />
                      {metadataError}
                    </motion.p>
                  ) : (
                    <motion.p
                      key="ok"
                      initial={{ opacity: 0, y: -4 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0 }}
                      className="flex items-center gap-1.5 rounded-xl border border-emerald-500/20 bg-emerald-500/5 px-3 py-2 text-xs text-emerald-600 dark:text-emerald-400"
                    >
                      <CheckCircle size={14} weight="fill" />
                      Identity looks great — see the live preview on the right.
                    </motion.p>
                  )}
                </AnimatePresence>
              </div>
            </div>
          </Section>

          <Section
            n="03"
            title="Weight split"
            hint={`Between ${LAUNCHPAD_CONFIG.minWeightBps / 100}% and ${LAUNCHPAD_CONFIG.maxWeightBps / 100}% per leg.`}
            done={stepsDone[2]}
            icon={Scales}
          >
            <div className="rounded-2xl border border-border bg-surface p-5">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <StockLogo ticker={tickerA} size="md" />
                  <div>
                    <p className="text-sm font-semibold">{tickerA}</p>
                    <p
                      className="font-mono text-2xl font-semibold tabular-nums"
                      style={{ color: categoryAccent }}
                    >
                      {(weightABps / 100).toFixed(0)}%
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-3 text-right">
                  <div>
                    <p className="text-sm font-semibold">{tickerB}</p>
                    <p
                      className="font-mono text-2xl font-semibold tabular-nums"
                      style={{ color: LEG_B_ACCENT }}
                    >
                      {(weightBBps / 100).toFixed(0)}%
                    </p>
                  </div>
                  <StockLogo ticker={tickerB} size="md" />
                </div>
              </div>

              <input
                type="range"
                min={LAUNCHPAD_CONFIG.minWeightBps}
                max={LAUNCHPAD_CONFIG.maxWeightBps}
                step={500}
                value={weightABps}
                onChange={(e) => setWeightABps(Number(e.target.value))}
                className="range-slider mt-5 w-full"
                style={{
                  background: `linear-gradient(90deg, ${categoryAccent} 0%, ${categoryAccent} ${weightABps / 100}%, ${LEG_B_ACCENT} ${weightABps / 100}%, ${LEG_B_ACCENT} 100%)`,
                }}
                aria-label="Token A weight"
              />

              <div className="mt-4 flex flex-wrap gap-2">
                {WEIGHT_PRESETS.map((w) => (
                  <button
                    key={w}
                    type="button"
                    onClick={() => setWeightABps(w)}
                    className={cn(
                      "rounded-full border px-3 py-1 font-mono text-xs transition-all active:scale-[0.98]",
                      weightABps === w
                        ? "border-accent bg-accent-subtle text-accent-strong"
                        : "border-border text-muted-foreground hover:border-accent/40",
                    )}
                  >
                    {w / 100}/{(10_000 - w) / 100}
                  </button>
                ))}
              </div>

              {priceA && priceB && (
                <p className="mt-4 rounded-xl bg-surface-muted/70 px-3 py-2 font-mono text-[11px] text-muted-foreground">
                  A $1,000 deposit buys ≈{" "}
                  <span className="text-foreground">
                    {((1000 * weightABps) / 10_000 / priceA).toFixed(3)} {tickerA}
                  </span>{" "}
                  +{" "}
                  <span className="text-foreground">
                    {((1000 * weightBBps) / 10_000 / priceB).toFixed(3)} {tickerB}
                  </span>{" "}
                  at current prices.
                </p>
              )}
            </div>
          </Section>

          {/* Step 04 — seed amount */}
          <Section
            n="04"
            title="Seed deposit"
            hint={`You launch by depositing your own ${tickerA} and ${tickerB} (USDG and ETH can't be used to launch). The value is split by your weights at on-chain prices, and you receive pair shares at $1.00 each.`}
            done={stepsDone[3]}
            last
            icon={Wallet}
          >
            <div className="space-y-4">
              <DepositAmountField
                id="usd-amount"
                label={`Seed value (paid in ${tickerA} + ${tickerB})`}
                value={usdTarget}
                onChange={setUsdTarget}
                maxUsd={wallet.address ? maxUsd : undefined}
                hint={`${formatUsd((usdTarget * weightABps) / 10_000)} of ${tickerA} + ${formatUsd((usdTarget * weightBBps) / 10_000)} of ${tickerB}`}
              />

              <div className="grid gap-2 sm:grid-cols-2">
                <SeedLegRow
                  ticker={tickerA}
                  name={tokenA?.name}
                  unit={unitA}
                  amount={amountA}
                  have={haveA}
                  decimals={tokenA?.decimals ?? 18}
                  priceUsd={priceA}
                  connected={!!wallet.address}
                />
                <SeedLegRow
                  ticker={tickerB}
                  name={tokenB?.name}
                  unit={unitB}
                  amount={amountB}
                  have={haveB}
                  decimals={tokenB?.decimals ?? 18}
                  priceUsd={priceB}
                  connected={!!wallet.address}
                />
              </div>

              <PoolSeedOption
                available={poolAvailable}
                enabled={poolOn}
                onToggle={setPoolOn}
                shareBps={poolShareBps}
                onShareChange={setPoolShareBps}
                seedUsd={usdTarget}
                quoteSymbol={quoteSymbol}
                quoteBalance={quoteBalance}
              />

              {wethLeg && (
                <label className="flex cursor-pointer items-center justify-between gap-3 rounded-2xl border border-border bg-surface px-4 py-3 text-xs">
                  <span>
                    <span className="block font-semibold text-foreground">
                      Pay the WETH leg with ETH
                    </span>
                    <span className="text-muted-foreground">
                      Wrapped inside the launch transaction, so there&apos;s no separate wrap step.
                    </span>
                  </span>
                  <input
                    type="checkbox"
                    checked={useEth}
                    onChange={(e) => setPayWithEth(e.target.checked)}
                    className="h-4 w-4 shrink-0 accent-[var(--accent)]"
                  />
                </label>
              )}

              {isTestnetMode() && noPairTokens && (
                <p className="flex items-start gap-2 rounded-xl border border-border bg-surface-muted px-3 py-2.5 text-xs leading-relaxed text-muted-foreground">
                  <Drop size={16} className="mt-0.5 shrink-0 text-accent-strong" />
                  <span>
                    This wallet holds no {tickerA} or {tickerB}. Claim free testnet
                    Stock Tokens and ETH from the{" "}
                    <a
                      href={TESTNET_FAUCET_URL}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-medium text-accent-strong underline-offset-2 hover:underline"
                    >
                      Robinhood faucet ↗
                    </a>
                    . Balances refresh automatically.
                  </span>
                </p>
              )}

              {pricesStale && (
                <p className="flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/5 px-3 py-2.5 text-xs text-amber-700 dark:text-amber-400">
                  <WarningCircle size={16} className="mt-0.5 shrink-0" />
                  On-chain prices are older than one hour. The price keeper refreshes
                  them every few minutes; launching resumes automatically.
                </p>
              )}
            </div>
          </Section>
        </div>

        {/* Right: preview + confirm */}
        <aside className="lg:col-span-5">
          <div className="space-y-4 lg:sticky lg:top-24">
            <div className="flex items-center justify-between px-1">
              <p className="label-caps flex items-center gap-2">
                <Sparkle size={11} weight="fill" /> Live preview
              </p>
              <Badge variant={alreadyExists ? "destructive" : canLaunch ? "accent" : "secondary"}>
                {alreadyExists
                  ? "Already exists"
                  : canLaunch
                    ? "Ready to launch"
                    : `${stepsCompleted}/${stepsDone.length} complete`}
              </Badge>
            </div>

            <PairPreviewCard
              tickerA={tickerA}
              tickerB={tickerB}
              weightABps={weightABps}
              name={receiptName}
              symbol={receiptSymbol}
              description={description.trim()}
              bannerUrl={bannerUrl}
              logoUrl={logoUrl}
              websiteUrl={isValidHttpUrl(websiteUrl) ? websiteUrl : ""}
              categoryLabel={categoryLabel}
              accentA={categoryAccent}
              accentB={LEG_B_ACCENT}
              creatorFeeBps={feeBps}
              priceA={priceA}
              priceB={priceB}
            />

            <div className="overflow-hidden rounded-[1.75rem] border border-border bg-surface shadow-float">
              {(() => {
                const sA = byTicker.get(tickerA)?.sparkline ?? [];
                const sB = byTicker.get(tickerB)?.sparkline ?? [];
                if (sA.length < 2 && sB.length < 2) return null;
                const len = Math.max(sA.length, sB.length);
                const wA = weightABps / 10_000;
                const blended: number[] = [];
                for (let i = 0; i < len; i++) {
                  const va = sA[Math.min(i, sA.length - 1)] ?? 0;
                  const vb = sB[Math.min(i, sB.length - 1)] ?? 0;
                  blended.push(va * wA + vb * (1 - wA));
                }
                const first = blended[0]!;
                const lastV = blended[blended.length - 1]!;
                const up = lastV >= first;
                const chg = first > 0 ? ((lastV - first) / first) * 100 : 0;
                return (
                  <div className="border-b border-border-subtle px-5 pb-3 pt-4">
                    <div className="flex items-baseline justify-between">
                      <p className="label-caps">Blended trend · 24h</p>
                      <span
                        className={cn(
                          "font-mono text-xs font-semibold tabular-nums",
                          up ? "text-emerald-600" : "text-rose-600",
                        )}
                      >
                        {up ? "+" : ""}
                        {chg.toFixed(2)}%
                      </span>
                    </div>
                    <div className="mt-2">
                      <Sparkline data={blended} width={260} height={44} positive={up} strokeWidth={1.5} className="w-full" />
                    </div>
                  </div>
                );
              })()}

              <div className="relative bg-accent-subtle/70 px-5 py-4">
                <HatchPattern className="opacity-40" />
                <div className="relative">
                  <p className="label-caps">Seed value · paid in stocks</p>
                  <p className="mt-1 font-mono text-3xl font-semibold tabular-nums text-accent-strong">
                    <NumberTicker value={usdTarget} prefix="$" decimals={0} startOnView={false} />
                  </p>
                  <p className="mt-1 font-mono text-xs text-muted-foreground">
                    {formatToken(amountA, tokenA?.decimals)} {unitA} + {formatToken(amountB, tokenB?.decimals)} {unitB}
                  </p>
                  <dl className="mt-3 space-y-1 font-mono text-xs">
                    <div className="flex justify-between">
                      <dt className="text-muted-foreground">Receipt shares</dt>
                      <dd className="tabular-nums">
                        {(usdTarget || 0).toFixed(2)} {receiptSymbol || "shares"}
                      </dd>
                    </div>
                    <div className="flex justify-between">
                      <dt className="text-muted-foreground">Share price at launch</dt>
                      <dd className="tabular-nums">$1.00</dd>
                    </div>
                    <div className="flex justify-between">
                      <dt className="text-muted-foreground">Curve fee to you</dt>
                      <dd className="tabular-nums">70% of the 1% trade fee</dd>
                    </div>
                  </dl>
                </div>
              </div>

              <dl className="space-y-1.5 border-t border-border-subtle px-5 py-4 font-mono text-xs">
                <div className="flex justify-between">
                  <dt className="text-muted-foreground">Deposit {unitA}</dt>
                  <dd className="tabular-nums">{formatToken(amountA, tokenA?.decimals)}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-muted-foreground">Deposit {unitB}</dt>
                  <dd className="tabular-nums">{formatToken(amountB, tokenB?.decimals)}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-muted-foreground">{tickerA} oracle price</dt>
                  <dd className="tabular-nums">{priceA8 ? formatUsd(Number(priceA8) / 1e8) : "—"}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-muted-foreground">{tickerB} oracle price</dt>
                  <dd className="tabular-nums">{priceB8 ? formatUsd(Number(priceB8) / 1e8) : "—"}</dd>
                </div>
                <div className="flex justify-between border-t border-border pt-2 text-sm">
                  <dt className="font-medium">Receipt token</dt>
                  <dd className="font-medium tabular-nums">{receiptSymbol || "—"}</dd>
                </div>
              </dl>

              <div className="border-t border-border-subtle p-5">
                {wallet.authenticated && blocker && (
                  <p className="mb-3 flex items-start gap-1.5 text-xs text-muted-foreground">
                    {pairUniquenessPending ? (
                      <CircleNotch size={14} className="mt-0.5 shrink-0 animate-spin" />
                    ) : (
                      <Info size={14} className="mt-0.5 shrink-0" />
                    )}
                    <span>
                      {blocker}
                      {alreadyExists && existingPairAddr && (
                        <>
                          {" "}
                          <Link href={`/pair/${existingPairAddr}`} className="underline">
                            Open it
                          </Link>
                        </>
                      )}
                    </span>
                  </p>
                )}
                {wallet.authenticated ? (
                  <Button
                    className={cn(
                      "w-full transition-all",
                      canLaunch &&
                        "hover:bg-accent-strong",
                    )}
                    size="lg"
                    disabled={!canLaunch}
                    onClick={launch}
                  >
                    {busy ? (
                      "Launching…"
                    ) : (
                      <>
                        Launch & seed with {unitA} + {unitB}
                        <Rocket size={16} weight="bold" />
                      </>
                    )}
                  </Button>
                ) : (
                  <Button className="w-full" size="lg" onClick={wallet.login} disabled={!wallet.ready}>
                    <Wallet size={16} />
                    Connect wallet to launch
                  </Button>
                )}
                <p className="mt-3 text-center text-[11px] leading-relaxed text-muted-foreground">
                  Up to 3 wallet confirmations: two token approvals (once per token) and
                  the launch. {LAUNCHPAD_CONFIG.maxPairsPerCreator} pairs max per creator.
                </p>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div className="rounded-2xl border border-border bg-surface-muted/60 p-3">
                <p className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
                  Listed tokens
                </p>
                <p className="mt-0.5 font-mono text-lg font-semibold tabular-nums">
                  {eligibleTokens.length}
                </p>
              </div>
              <div className="rounded-2xl border border-border bg-surface-muted/60 p-3">
                <p className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
                  Uniqueness
                </p>
                <p className="mt-0.5 flex items-center gap-1 text-sm font-semibold">
                  <CheckCircle size={14} weight="fill" className="text-accent-strong" />
                  On-chain
                </p>
              </div>
            </div>
          </div>
        </aside>
      </div>

      {/* Progress overlay */}
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
                  <p className="text-sm text-muted-foreground">Launching</p>
                  <p className="font-mono text-lg font-semibold">{receiptSymbol}</p>
                </div>
              </div>
              <StageProgressList
                className="mt-6"
                steps={progressSteps}
                current={stage}
                lastActive={lastStage}
                errorMessage={launchPair.error}
                pendingHash={launchPair.pendingHash}
                errorTitle="Launch failed"
              />
              {savingProfile && (
                <p className="mt-3 flex items-start gap-2 rounded-2xl border border-accent bg-accent-subtle p-3 text-xs">
                  <CircleNotch size={16} className="mt-0.5 shrink-0 animate-spin text-accent-strong" />
                  Saving your pair profile. Approve the signature request in your
                  wallet (free, no gas).
                </p>
              )}
              {stage === "error" && (
                <Button variant="outline" className="mt-4 w-full" onClick={launchPair.reset}>
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

function SeedLegRow({
  ticker,
  name,
  unit,
  amount,
  have,
  decimals,
  priceUsd,
  connected,
}: {
  ticker: string;
  name?: string;
  unit: string;
  amount: bigint;
  have: bigint;
  decimals: number;
  priceUsd?: number;
  connected: boolean;
}) {
  const short = connected && amount > have;
  const payingEth = unit === "ETH" && ticker !== "ETH";
  return (
    <div
      className={cn(
        "rounded-2xl border p-4",
        short ? "border-destructive/40 bg-destructive/5" : "border-border bg-surface",
      )}
    >
      <div className="flex items-center gap-2">
        <StockLogo ticker={ticker} size="sm" />
        <div className="min-w-0">
          <p className="text-sm font-semibold">{unit}</p>
          <p className="truncate text-[11px] text-muted-foreground">
            {payingEth ? "Wrapped to WETH in the launch tx" : name}
          </p>
        </div>
      </div>
      <p className="mt-3 font-mono text-lg font-semibold tabular-nums">
        {formatToken(amount, decimals)}
      </p>
      <p className="font-mono text-[11px] text-muted-foreground">
        {priceUsd ? `≈ ${formatUsd(Number(formatUnits(amount, decimals)) * priceUsd)}` : "—"}
      </p>
      {connected && (
        <p className={cn("mt-2 font-mono text-[11px]", short ? "text-destructive" : "text-muted-foreground")}>
          Wallet: {formatToken(have, decimals)} {unit}
          {short ? " · not enough" : ""}
        </p>
      )}
    </div>
  );
}


function SuccessScreen({
  tickerA,
  tickerB,
  receiptSymbol,
  sharesMinted,
  seedTx,
  launchTx,
  pairAddr,
  poolAddr,
  colorA,
  colorB,
  onAnother,
  onBrowse,
  notice,
  onRetryProfile,
  retrying,
}: {
  tickerA: string;
  tickerB: string;
  receiptSymbol: string;
  sharesMinted: number;
  seedTx: `0x${string}`;
  launchTx?: `0x${string}`;
  pairAddr: `0x${string}`;
  poolAddr?: `0x${string}`;
  colorA: string;
  colorB: string;
  onAnother: () => void;
  onBrowse: () => void;
  notice?: string;
  onRetryProfile?: () => void;
  retrying?: boolean;
}) {
  return (
    <div className="relative container-page flex min-h-[80dvh] items-center py-16">
      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ type: "spring", stiffness: 100, damping: 20 }}
        className="relative mx-auto w-full max-w-lg overflow-hidden rounded-[2rem] border border-border bg-surface p-8 shadow-float"
      >
        <motion.div
          initial={{ scale: 0, rotate: -30 }}
          animate={{ scale: 1, rotate: 0 }}
          transition={{ type: "spring", stiffness: 220, damping: 14, delay: 0.05 }}
          className="inline-flex h-14 w-14 items-center justify-center rounded-2xl bg-accent-subtle text-accent-strong"
        >
          <Rocket size={30} weight="fill" />
        </motion.div>
        <h1 className="mt-5 text-3xl font-semibold tracking-tight">
          Pair is live
        </h1>
        <p className="mt-2 text-muted-foreground">
          Your <span className="font-mono">{receiptSymbol}</span> pair is now
          seeded on Robinhood Chain. Your seed minted receipts at $1.00 per
          share.
        </p>
        <p className="mt-2 text-xs text-muted-foreground">
          Next, launch the pair&apos;s token from the pair page: on the Compose curve, or on Pons v2 quoted in one of
          its stocks.
        </p>
        {notice && (
          <div className="mt-3 rounded-xl border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
            <p>{notice}</p>
            {onRetryProfile && (
              <Button size="sm" variant="outline" className="mt-2" disabled={retrying} onClick={onRetryProfile}>
                {retrying ? "Saving…" : "Retry saving profile"}
              </Button>
            )}
          </div>
        )}

        <div className="mt-6 flex items-baseline gap-3 rounded-2xl border border-border bg-accent-subtle p-4">
          <DualLogoStack tickerA={tickerA} tickerB={tickerB} size="md" />
          <div className="min-w-0">
            <p className="label-caps">You just minted</p>
            <p className="font-mono text-2xl font-semibold tabular-nums text-accent-strong">
              <NumberTicker value={sharesMinted} decimals={2} startOnView={false} />
              <span className="ml-2 text-base font-medium">{receiptSymbol}</span>
            </p>
          </div>
        </div>

        <div className="mt-5 space-y-2 text-xs">
          <div className="flex flex-wrap items-center gap-2">
            <span className="label-caps">Pair</span>
            <AddressChip address={pairAddr} kind="address" />
          </div>
          {launchTx && (
            <div className="flex flex-wrap items-center gap-2">
              <span className="label-caps">Launch tx</span>
              <AddressChip address={launchTx} kind="tx" />
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <span className="label-caps">Seed tx</span>
            <AddressChip address={seedTx} kind="tx" />
          </div>
          {poolAddr && (
            <div className="flex flex-wrap items-center gap-2">
              <span className="label-caps">DEX pool</span>
              <span className="font-mono text-[11px]" title={poolAddr}>{poolAddr.slice(0, 10)}…{poolAddr.slice(-6)}</span>
              <span className="text-[11px] text-muted-foreground">Uniswap v4 · shares vs USDG · indexed by terminals</span>
            </div>
          )}
        </div>

        <div className="mt-6 flex flex-wrap gap-2">
          <Button onClick={onBrowse}>
            View pair
            <ArrowRight size={14} weight="bold" />
          </Button>
          <Button variant="outline" onClick={onAnother}>
            Launch another
          </Button>
          <a
            href={explorerUrl("tx", seedTx)}
            target="_blank"
            rel="noopener noreferrer"
            className="ml-auto self-center text-xs text-muted-foreground underline"
          >
            View on explorer ↗
          </a>
        </div>
      </motion.div>
    </div>
  );
}

function TokenGrid({
  tokens,
  selected,
  excluded,
  onPick,
  byTicker,
  compact,
}: {
  tokens: StockToken[];
  selected: string;
  excluded: string;
  onPick: (t: string) => void;
  byTicker: ReturnType<typeof useQuotes>["byTicker"];
  /** Row list for side-by-side leg pickers */
  compact?: boolean;
}) {
  if (compact) {
    return (
      <div className="no-scrollbar max-h-[21rem] space-y-1.5 overflow-y-auto pr-0.5">
        {tokens.map((t: StockToken) => {
          const isExcluded = t.ticker === excluded;
          const on = selected === t.ticker;
          const q = byTicker.get(t.ticker);
          const up = q ? q.changePercent >= 0 : true;
          return (
            <button
              key={t.ticker}
              type="button"
              disabled={isExcluded}
              onClick={() => onPick(t.ticker)}
              className={cn(
                "relative flex w-full items-center gap-2.5 rounded-xl border px-2.5 py-2 text-left transition-all active:scale-[0.99]",
                isExcluded
                  ? "cursor-not-allowed border-border/50 bg-surface-muted/50 opacity-40"
                  : on
                    ? "border-accent bg-accent-subtle shadow-card"
                    : "border-transparent bg-transparent hover:border-border hover:bg-surface-muted/60",
              )}
            >
              <StockLogo ticker={t.ticker} size="sm" />
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline gap-1.5">
                  <span className="text-sm font-semibold">{t.ticker}</span>
                  <span className="truncate text-[10px] text-muted-foreground">
                    {t.name}
                  </span>
                </span>
                {q && (
                  <span className="flex items-baseline gap-1.5 font-mono text-[11px] tabular-nums">
                    <span className="font-semibold">{formatUsd(q.price)}</span>
                    <span className={up ? "text-emerald-600" : "text-rose-600"}>
                      {up ? "+" : ""}
                      {q.changePercent.toFixed(2)}%
                    </span>
                  </span>
                )}
              </span>
              {q && q.sparkline.length > 2 && (
                <Sparkline
                  data={q.sparkline}
                  width={56}
                  height={20}
                  positive={up}
                  strokeWidth={1.2}
                  className="shrink-0"
                />
              )}
              {on && (
                <span className="shrink-0 text-accent-strong">
                  <CheckCircle size={16} weight="fill" />
                </span>
              )}
            </button>
          );
        })}
      </div>
    );
  }

  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
      {tokens.map((t: StockToken) => {
        const isExcluded = t.ticker === excluded;
        const on = selected === t.ticker;
        const q = byTicker.get(t.ticker);
        const up = q ? q.changePercent >= 0 : true;
        return (
          <button
            key={t.ticker}
            type="button"
            disabled={isExcluded}
            onClick={() => onPick(t.ticker)}
            className={cn(
              "group/tok relative flex flex-col gap-1.5 overflow-hidden rounded-2xl border p-3 text-left transition-all active:scale-[0.98]",
              isExcluded
                ? "cursor-not-allowed border-border/50 bg-surface-muted/50 opacity-40"
                : on
                  ? "border-accent bg-accent-subtle shadow-card"
                  : "border-border bg-surface hover:border-accent/40",
            )}
          >
            {/* Top row: logo + ticker + name */}
            <div className="flex items-center gap-2">
              <StockLogo ticker={t.ticker} size="sm" />
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline gap-1.5">
                  <span className="text-sm font-semibold">{t.ticker}</span>
                  <span className="truncate font-mono text-[10px] text-muted-foreground">
                    {t.name}
                  </span>
                </span>
                {t.category && (
                  <span className="block truncate text-[10px] capitalize text-muted-foreground/60">
                    {t.category.replace("-", " ")}
                  </span>
                )}
              </span>
            </div>

            {/* Mini sparkline */}
            {q && q.sparkline.length > 2 && (
              <Sparkline
                data={q.sparkline}
                width={120}
                height={24}
                positive={up}
                strokeWidth={1.2}
                className="w-full"
              />
            )}

            {/* Price + change */}
            {q && (
              <div className="flex items-baseline justify-between gap-1">
                <span className="font-mono text-xs font-semibold tabular-nums">
                  {formatUsd(q.price)}
                </span>
                <span
                  className={cn(
                    "font-mono text-[10px] tabular-nums",
                    up ? "text-emerald-600" : "text-rose-600",
                  )}
                >
                  {up ? "+" : ""}{q.changePercent.toFixed(2)}%
                </span>
              </div>
            )}
          </button>
        );
      })}
    </div>
  );
}
