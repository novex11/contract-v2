"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { formatUnits, isAddress, parseUnits, type Address } from "viem";
import { useReadContract } from "wagmi";
import { ArrowRight, ArrowSquareOut, CheckCircle, CircleNotch, RocketLaunch, WarningCircle } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { StockLogo } from "@/components/ui/stock-logo";
import { UsdgLogo } from "@/components/ui/asset-logo";
import { cn, formatUsd } from "@/lib/utils";
import { PONS_FACTORY_ADDRESS, composeCurveReady, ponsLauncherReady, ponsV2LaunchFactoryAbi, receiptTokenAbi } from "@/lib/contracts";
import { useWallet } from "@/hooks/use-wallet";
import { useOraclePrices, useTokenBalances } from "@/hooks/use-pair-launchpad";
import {
  useCreateCurveToken,
  useCurveOnchain,
  useCurveStartMarketCap,
  usePairCurveToken,
} from "@/hooks/use-curve-token";
import {
  PONS_LAUNCH_CONFIG_ID,
  ponsTokenUrl,
  usePonsLaunch,
  usePonsLaunchInfo,
  usePonsOnchain,
  type PonsQuoteOption,
} from "@/hooks/use-pons-token";

const SUPPLY = 10n ** 27n; // 1B × 1e18
const MAX_DEV_BUY_BPS = 500n; // 5% of supply, enforced on-chain
const CURVE_FEE_BPS = 100n; // 1% of every buy, in shares
const DEV_BUY_PRESETS = [0, 1, 2, 3, 5];
const PONS_MAX_EXEMPTIONS = 32; // Pons caps the snipe-tax exemption list per launch

type Venue = "compose" | "pons";

export interface PairTokenCardProps {
  pair: Address;
  share: Address;
  isCreator: boolean;
  userShares: bigint;
  sharePriceUsd?: number;
  /** USD (8 decimals) per 1e18 shares, straight from the vault. */
  sharePriceUsd8?: bigint;
  /** The pair's identity — its token launches with exactly this. */
  logoUrl?: string;
  imageUrl?: string;
  displayName: string;
  symbol: string;
  /** The pair's legs, so a Pons launch can offer them as the quote asset. */
  tokenA?: Address;
  tokenB?: Address;
  tickerA?: string;
  tickerB?: string;
  decA?: number;
  decB?: number;
  description?: string;
  websiteUrl?: string;
  className?: string;
}

/**
 * On a pair page: the pair's single creator token (one per pair, launched by the
 * pair creator with the pair's own name, ticker, logo and banner) on either the
 * Compose curve or a Pons v2 curve, and the launch card for the creator.
 */
export function PairTokenCard(props: PairTokenCardProps) {
  const { pair, isCreator, className } = props;
  const compose = usePairCurveToken(pair);
  const ponsInfo = usePonsLaunchInfo({
    pair,
    tokenA: props.tokenA,
    tokenB: props.tokenB,
    tickerA: props.tickerA,
    tickerB: props.tickerB,
    decA: props.decA,
    decB: props.decB,
  });
  const wallet = useWallet();
  if (!composeCurveReady && !ponsLauncherReady) return null;

  const ponsToken = ponsLauncherReady ? ponsInfo.launchedToken : null;
  const loading = (composeCurveReady && compose.isLoading) || (ponsLauncherReady && ponsToken === undefined);
  const refetchAll = () => {
    void compose.refetch();
    void ponsInfo.refetch();
  };

  return (
    <div className={cn("space-y-4", className)}>
      {compose.token ? (
        <section className="rounded-[1.75rem] border border-accent/50 bg-accent-subtle/40 p-4">
          <p className="flex items-center gap-1.5 px-1 text-xs font-semibold text-accent-strong">
            <RocketLaunch size={14} weight="fill" />
            Pair token
          </p>
          <div className="mt-3">
            <TokenLinkRow token={compose.token} logoUrl={props.logoUrl} />
          </div>
          <p className="mt-2 px-1 text-[11px] text-muted-foreground">
            One token per pair. It trades on a bonding curve backed by this pair&apos;s stocks.
          </p>
        </section>
      ) : ponsToken ? (
        <section className="rounded-[1.75rem] border border-accent/50 bg-accent-subtle/40 p-4">
          <p className="flex items-center gap-1.5 px-1 text-xs font-semibold text-accent-strong">
            <RocketLaunch size={14} weight="fill" />
            Pair token · live on Pons
          </p>
          <div className="mt-3">
            <PonsTokenLinkRow token={ponsToken} logoUrl={props.logoUrl} />
          </div>
          <p className="mt-2 px-1 text-[11px] text-muted-foreground">
            One token per pair. Its market is a Pons v2 curve quoted in one of this pair&apos;s stocks; Compose trades it
            in pair shares on that same curve.
          </p>
        </section>
      ) : loading ? (
        <div className="h-24 animate-pulse rounded-[1.75rem] bg-surface-muted" />
      ) : isCreator && wallet.address ? (
        <CreateTokenCard
          {...props}
          ponsReady={ponsInfo.ready}
          ponsQuotes={ponsInfo.approvedQuotes}
          ponsLaunchFee={ponsInfo.launchFee}
          onCreated={refetchAll}
        />
      ) : (
        <p className="rounded-[1.5rem] border border-dashed border-border p-4 text-center text-xs text-muted-foreground">
          The pair creator hasn&apos;t launched this pair&apos;s token yet.
        </p>
      )}
    </div>
  );
}

function TokenLinkRow({ token, logoUrl }: { token: Address; logoUrl?: string }) {
  const { data } = useCurveOnchain(token);
  const symbol = useReadContract({ address: token, abi: receiptTokenAbi, functionName: "symbol" });
  const mcap = data ? Number(data.marketCapUsd8) / 1e8 : undefined;
  const sym = (symbol.data as string | undefined) ?? "…";
  return (
    <LinkRow
      href={`/token/${token}`}
      logoUrl={logoUrl}
      sym={sym}
      line={
        mcap !== undefined
          ? `${formatUsd(mcap)} mcap${data ? (data.graduated ? " · graduated" : ` · ${(data.progressBps / 100).toFixed(1)}% to graduation`) : ""}`
          : "Loading…"
      }
    />
  );
}

function PonsTokenLinkRow({ token, logoUrl }: { token: Address; logoUrl?: string }) {
  const { data } = usePonsOnchain(token);
  const symbol = useReadContract({ address: token, abi: receiptTokenAbi, functionName: "symbol" });
  const mcap = data ? Number(data.marketCapUsd8) / 1e8 : undefined;
  const sym = (symbol.data as string | undefined) ?? "…";
  return (
    <LinkRow
      href={`/token/${token}`}
      logoUrl={logoUrl}
      sym={sym}
      line={
        data
          ? `${formatUsd(mcap ?? 0)} mcap · quoted in ${data.quoteSymbol || "stock"}${data.graduated ? " · graduated" : ` · ${(data.progressBps / 100).toFixed(1)}% to graduation`}`
          : "Loading…"
      }
    />
  );
}

function LinkRow({ href, logoUrl, sym, line }: { href: string; logoUrl?: string; sym: string; line: string }) {
  return (
    <Link
      href={href}
      className="group flex items-center justify-between gap-3 rounded-2xl border border-border bg-surface px-3 py-2.5 transition-colors hover:border-accent"
    >
      <div className="flex min-w-0 items-center gap-3">
        {logoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={logoUrl} alt="" className="h-9 w-9 shrink-0 rounded-xl border border-border object-cover" />
        ) : (
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-accent-subtle font-mono text-xs font-bold text-accent-strong">
            {sym.slice(0, 2)}
          </div>
        )}
        <div className="min-w-0">
          <p className="truncate font-mono text-sm font-semibold">${sym}</p>
          <p className="font-mono text-[11px] text-muted-foreground">{line}</p>
        </div>
      </div>
      <ArrowRight size={14} className="shrink-0 text-accent-strong transition-transform group-hover:translate-x-0.5" />
    </Link>
  );
}

function ceilDiv(a: bigint, b: bigint): bigint {
  return (a + b - 1n) / b;
}

/**
 * Mirrors ComposeCurve: the whole 1B supply sits on the curve against a virtual
 * quote reserve q0 = startMcap / sharePrice. A dev buy of `sharesIn` shares
 * (1% fee) takes tokensOut = S − ceil(q0·S / (q0 + sharesIn − fee)).
 */
function devBuyMath(q0: bigint, targetBps: bigint) {
  if (q0 <= 0n || targetBps <= 0n) return { sharesIn: 0n, tokensOut: 0n };
  const net = (q0 * targetBps) / (10_000n - targetBps);
  const sharesIn = ceilDiv(net * 10_000n, 10_000n - CURVE_FEE_BPS);
  const fee = (sharesIn * CURVE_FEE_BPS) / 10_000n;
  const newReserve = ceilDiv(q0 * SUPPLY, q0 + sharesIn - fee);
  return { sharesIn, tokensOut: SUPPLY - newReserve };
}

function compactTokens(amount: bigint): string {
  const n = Number(formatUnits(amount, 18));
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(2)}K`;
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function fmt(amount: bigint, decimals: number, max = 4): string {
  return Number(formatUnits(amount, decimals)).toLocaleString(undefined, { maximumFractionDigits: max });
}

function CreateTokenCard(
  props: PairTokenCardProps & {
    ponsReady: boolean;
    ponsQuotes: PonsQuoteOption[];
    ponsLaunchFee?: bigint;
    onCreated: () => void;
  },
) {
  const { imageUrl, logoUrl, displayName, symbol, ponsReady, ponsQuotes } = props;
  const ponsAvailable = ponsReady && ponsQuotes.length > 0;
  const [venue, setVenue] = useState<Venue>(composeCurveReady ? "compose" : "pons");
  const [created, setCreated] = useState<Address | null>(null);
  const active: Venue = venue === "compose" && !composeCurveReady ? "pons" : venue === "pons" && !ponsAvailable ? "compose" : venue;

  return (
    <section className="overflow-hidden rounded-[1.75rem] border border-accent/60 bg-accent-subtle/40 shadow-float">
      {imageUrl && (
        <div className="h-20 w-full overflow-hidden border-b border-border">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={imageUrl} alt="" className="h-full w-full object-cover" />
        </div>
      )}
      <div className="p-5">
        <div className="flex items-center gap-2 text-sm font-semibold text-accent-strong">
          <RocketLaunch size={16} weight="fill" />
          Launch this pair&apos;s token
        </div>

        {/* Identity preview — nothing to type, the token is the pair */}
        <div className="mt-3 flex items-center gap-3 rounded-2xl border border-border bg-surface p-3">
          {logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={logoUrl} alt="" className="h-11 w-11 shrink-0 rounded-xl border border-border object-cover" />
          ) : (
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-accent-subtle font-mono text-sm font-bold text-accent-strong">
              {symbol.slice(0, 2)}
            </div>
          )}
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold">{displayName}</p>
            <p className="font-mono text-xs text-muted-foreground">${symbol}</p>
          </div>
        </div>
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
          Your token launches as <span className="font-mono font-semibold text-foreground">${symbol}</span> ·{" "}
          <span className="font-semibold text-foreground">{displayName}</span> with this logo and banner. One token per
          pair, only you can launch it.
        </p>

        {composeCurveReady && ponsAvailable && (
          <div className="mt-4">
            <p className="text-xs text-muted-foreground">Where it trades</p>
            <div className="mt-2 grid grid-cols-2 gap-2">
              <VenueButton on={active === "compose"} onClick={() => setVenue("compose")} title="Compose curve" sub="Quoted in the pair's shares" />
              <VenueButton on={active === "pons"} onClick={() => setVenue("pons")} title="Pons v2" sub="One-stock quote · listed on ponsfamily.com" />
            </div>
          </div>
        )}

        {created && (
          <Link
            href={`/token/${created}`}
            className="mt-3 flex items-center gap-1.5 rounded-xl bg-surface px-3 py-2 text-xs text-success hover:underline"
          >
            <CheckCircle size={14} weight="fill" />
            Token launched. Open its page
            <ArrowRight size={12} />
          </Link>
        )}

        {active === "pons" ? (
          <PonsLaunchForm {...props} created={created} onCreated={(t) => { setCreated(t); props.onCreated(); }} />
        ) : (
          <ComposeLaunchForm {...props} created={created} onCreated={(t) => { setCreated(t); props.onCreated(); }} />
        )}
      </div>
    </section>
  );
}

function VenueButton({ on, onClick, title, sub }: { on: boolean; onClick: () => void; title: string; sub: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-2xl border px-3 py-2.5 text-left transition-all",
        on ? "border-accent bg-surface shadow-card" : "border-border bg-surface/60 hover:border-accent/40",
      )}
    >
      <p className="text-sm font-semibold">{title}</p>
      <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">{sub}</p>
    </button>
  );
}

function ComposeLaunchForm({
  pair,
  share,
  userShares,
  sharePriceUsd,
  sharePriceUsd8,
  symbol,
  created,
  onCreated,
}: PairTokenCardProps & { created: Address | null; onCreated: (token: Address) => void }) {
  const [devPct, setDevPct] = useState("0");
  const creator = useCreateCurveToken();
  const startMcap8 = useCurveStartMarketCap();
  const busy = creator.stage === "approve" || creator.stage === "submit";

  const pctNumber = Number(devPct);
  const pctValid = devPct === "" || (Number.isFinite(pctNumber) && pctNumber >= 0);
  const targetBps = pctValid ? BigInt(Math.round(Math.max(0, pctNumber) * 100)) : -1n;

  const sharePrice8 = sharePriceUsd8 ?? (sharePriceUsd ? BigInt(Math.round(sharePriceUsd * 1e8)) : undefined);
  const q0 = startMcap8 && sharePrice8 && sharePrice8 > 0n ? (startMcap8 * 10n ** 18n) / sharePrice8 : undefined;
  const math = useMemo(
    () => (q0 !== undefined && targetBps > 0n ? devBuyMath(q0, targetBps) : { sharesIn: 0n, tokensOut: 0n }),
    [q0, targetBps],
  );
  const sharesUsd = sharePriceUsd ? Number(formatUnits(math.sharesIn, 18)) * sharePriceUsd : undefined;
  const startMcapUsd = startMcap8 ? Number(startMcap8) / 1e8 : undefined;

  const blocker =
    targetBps < 0n
      ? "Dev buy must be a number"
      : targetBps > MAX_DEV_BUY_BPS
        ? "Dev buy is capped at 5% of supply"
        : targetBps > 0n && q0 === undefined
          ? "Waiting for the curve's starting price…"
          : math.sharesIn > userShares
            ? `Not enough pair shares — you hold ${fmt(userShares, 18)}`
            : null;

  async function create() {
    try {
      const result = await creator.create({
        pair,
        share,
        devBuyShares: math.sharesIn,
        minDevTokens: (math.tokensOut * 99n) / 100n,
      });
      onCreated(result.token);
    } catch {
      /* shown below */
    }
  }

  return (
    <>
      <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
        1B fixed supply, all of it on the curve — you receive nothing at launch except what your dev buy purchases.
        {startMcapUsd !== undefined && ` Starts at a ${formatUsd(startMcapUsd)} market cap and graduates around 16.8× higher.`}{" "}
        You earn 70% of the 1% trading fee.
      </p>

      <div className="mt-4">
        <p className="text-xs text-muted-foreground">Dev buy · % of the 1B supply (optional, max 5%)</p>
        <div className="mt-2 flex gap-1.5">
          {DEV_BUY_PRESETS.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => setDevPct(String(p))}
              className={cn(
                "flex-1 rounded-full border px-2 py-1.5 font-mono text-xs transition-all",
                Number(devPct) === p ? "border-accent bg-accent-subtle text-accent-strong" : "border-border text-muted-foreground hover:border-accent/40",
              )}
            >
              {p}%
            </button>
          ))}
        </div>
        <div className="mt-2 flex items-center gap-2 rounded-xl border border-border bg-surface px-3 focus-within:border-accent">
          <input
            value={devPct}
            inputMode="decimal"
            onChange={(e) => setDevPct(e.target.value.replace(/[^0-9.]/g, "").slice(0, 5))}
            placeholder="0"
            className="h-10 w-full min-w-0 bg-transparent font-mono text-sm outline-none"
          />
          <span className="font-mono text-xs text-muted-foreground">% of supply</span>
        </div>
        <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
          {targetBps > 0n && math.sharesIn > 0n ? (
            <>
              ≈ <span className="font-mono text-foreground">{compactTokens(math.tokensOut)}</span> tokens (
              {(Number(targetBps) / 100).toFixed(2)}% of supply) for{" "}
              <span className="font-mono text-foreground">{fmt(math.sharesIn, 18)}</span> pair shares
              {sharesUsd !== undefined && ` ≈ ${formatUsd(sharesUsd)}`} · you hold {fmt(userShares, 18)}
            </>
          ) : (
            <>No dev buy — the whole supply starts on the curve. You hold {fmt(userShares, 18)} pair shares.</>
          )}
        </p>
      </div>

      {blocker && !busy && <p className="mt-3 text-xs text-muted-foreground">{blocker}</p>}
      {creator.error && (
        <p className="mt-3 flex items-start gap-1.5 text-xs text-destructive">
          <WarningCircle size={14} weight="fill" className="mt-0.5 shrink-0" />
          {creator.error}
        </p>
      )}

      <Button className="mt-4 w-full" size="lg" disabled={blocker !== null || busy || !!created} onClick={create}>
        {busy ? (
          <>
            <CircleNotch size={16} className="animate-spin" />
            {creator.stage === "approve" ? "Approve pair shares…" : "Launching…"}
          </>
        ) : (
          <>
            <RocketLaunch size={16} weight="bold" />
            Launch ${symbol}
          </>
        )}
      </Button>
    </>
  );
}

function PonsLaunchForm({
  pair,
  symbol,
  tokenA,
  tokenB,
  tickerA,
  tickerB,
  decA,
  decB,
  description,
  websiteUrl,
  logoUrl,
  ponsQuotes,
  ponsLaunchFee,
  created,
  onCreated,
}: PairTokenCardProps & {
  ponsQuotes: PonsQuoteOption[];
  ponsLaunchFee?: bigint;
  created: Address | null;
  onCreated: (token: Address) => void;
}) {
  const wallet = useWallet();
  const [quoteAddr, setQuoteAddr] = useState<Address | undefined>(ponsQuotes[0]?.address);
  const quote = ponsQuotes.find((q) => q.address === quoteAddr) ?? ponsQuotes[0];
  const [devText, setDevText] = useState("");
  const [exemptText, setExemptText] = useState("");
  const launcher = usePonsLaunch();

  // Wallets that may buy untaxed inside Pons's 3 s launch window (team, treasury, market maker).
  const exemptions = useMemo(() => {
    const raw = exemptText
      .split(/[\s,;]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    const valid = Array.from(new Set(raw.filter((a) => isAddress(a)).map((a) => a.toLowerCase()))) as Address[];
    return { list: valid, invalid: raw.filter((a) => !isAddress(a)) };
  }, [exemptText]);
  const busy = launcher.stage === "approve" || launcher.stage === "submit";

  const info = usePonsLaunchInfo({ pair, tokenA, tokenB, tickerA, tickerB, decA, decB, selectedQuote: quote?.address });
  const econ = useReadContract({
    address: PONS_FACTORY_ADDRESS,
    abi: ponsV2LaunchFactoryAbi,
    functionName: "pairTokenEconomics",
    args: quote ? [quote.address] : undefined,
    query: { enabled: !!quote, staleTime: 60_000 },
  });
  const e = econ.data as readonly [bigint, bigint, number] | undefined;
  const phantom = e?.[0];
  const balances = useTokenBalances(wallet.address, quote ? [quote.address] : []);
  const quoteBalance = quote ? (balances.balances.get(quote.address.toLowerCase()) ?? 0n) : 0n;
  const { prices } = useOraclePrices(quote && quote.kind === "stock" ? [quote.address] : []);
  const quoteUsd = quote ? (quote.kind === "usdg" ? 1 : Number(prices.get(quote.address.toLowerCase()) ?? 0n) / 1e8) : 0;

  const devBuy = useMemo(() => {
    try {
      return devText && quote ? parseUnits(devText, quote.decimals) : 0n;
    } catch {
      return -1n;
    }
  }, [devText, quote]);
  const devTokens = useMemo(() => {
    if (devBuy <= 0n || phantom === undefined || phantom === 0n) return 0n;
    const net = devBuy - (devBuy * CURVE_FEE_BPS) / 10_000n;
    return (net * SUPPLY) / (phantom + net);
  }, [devBuy, phantom]);
  const startMcapUsd = phantom !== undefined && quote ? Number(formatUnits(phantom, quote.decimals)) * quoteUsd : undefined;
  const fee = ponsLaunchFee ?? info.launchFee;

  const blocker = !quote
    ? "Pons has not approved either of this pair's stocks as a quote asset yet."
    : devBuy < 0n
      ? "Dev buy must be a number"
      : devBuy > quoteBalance
        ? `Not enough ${quote.symbol} — you hold ${fmt(quoteBalance, quote.decimals)}`
        : fee === undefined
          ? "Waiting for Pons's launch fee…"
          : exemptions.invalid.length > 0
            ? `Not a wallet address: ${exemptions.invalid[0]}`
            : exemptions.list.length > PONS_MAX_EXEMPTIONS
              ? `Pons allows at most ${PONS_MAX_EXEMPTIONS} exempt wallets`
              : null;

  async function launch() {
    if (!quote || fee === undefined) return;
    try {
      const result = await launcher.launch({
        pair,
        quoteToken: quote.address,
        launchFee: fee,
        expectedEconomics: info.expectedEconomics,
        devBuyQuote: devBuy,
        minDevTokens: (devTokens * 95n) / 100n,
        logo: logoUrl,
        description,
        website: websiteUrl,
        exemptions: exemptions.list,
      });
      onCreated(result.token);
    } catch {
      /* shown below */
    }
  }

  return (
    <>
      <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
        One shared market: on Pons the token is quoted in the stock you pick, on Compose it is quoted in this pair&apos;s
        shares. Price and volume match on both. 1B supply on a Pons v2 curve, 1% trade fee; your share of it accrues
        on the curve and you sweep and claim it from this token&apos;s page.
        {startMcapUsd !== undefined && startMcapUsd > 0 && ` Starts at ≈ ${formatUsd(startMcapUsd)} market cap.`}
      </p>

      <div className="mt-4">
        <p className="text-xs text-muted-foreground">Quote asset on Pons</p>
        <div className="mt-2 grid gap-2" style={{ gridTemplateColumns: `repeat(${Math.max(1, ponsQuotes.length)}, minmax(0, 1fr))` }}>
          {ponsQuotes.map((q) => (
            <button
              key={q.address}
              type="button"
              onClick={() => setQuoteAddr(q.address)}
              className={cn(
                "flex items-center gap-2 rounded-2xl border px-3 py-2 text-left transition-all",
                quote?.address === q.address ? "border-accent bg-surface shadow-card" : "border-border bg-surface/60 hover:border-accent/40",
              )}
            >
              {q.kind === "usdg" ? <UsdgLogo /> : <StockLogo ticker={q.symbol} size="sm" />}
              <span className="font-mono text-sm font-semibold">{q.symbol}</span>
            </button>
          ))}
        </div>
      </div>

      {quote && (
        <div className="mt-4">
          <p className="text-xs text-muted-foreground">Dev buy · {quote.symbol} (optional, untaxed, fills in the launch transaction)</p>
          <div className="mt-2 flex items-center gap-2 rounded-xl border border-border bg-surface px-3 focus-within:border-accent">
            <input
              value={devText}
              inputMode="decimal"
              onChange={(e) => setDevText(e.target.value.replace(/[^0-9.]/g, ""))}
              placeholder="0.0"
              className="h-10 w-full min-w-0 bg-transparent font-mono text-sm outline-none"
            />
            <span className="font-mono text-xs text-muted-foreground">{quote.symbol}</span>
          </div>
          <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
            {devBuy > 0n && devTokens > 0n ? (
              <>
                ≈ <span className="font-mono text-foreground">{compactTokens(devTokens)}</span> tokens (
                {((Number(devTokens) / Number(SUPPLY)) * 100).toFixed(2)}% of supply)
                {quoteUsd > 0 && ` for ≈ ${formatUsd(Number(formatUnits(devBuy, quote.decimals)) * quoteUsd)}`} · you hold{" "}
                {fmt(quoteBalance, quote.decimals)} {quote.symbol}
              </>
            ) : (
              <>No dev buy — the whole supply starts on the curve. You hold {fmt(quoteBalance, quote.decimals)} {quote.symbol}.</>
            )}
          </p>
        </div>
      )}

      <div className="mt-4">
        <p className="text-xs text-muted-foreground">
          Snipe-tax exempt wallets (optional, up to {PONS_MAX_EXEMPTIONS}) · team or treasury wallets that may buy in the
          first 3 s untaxed
        </p>
        <textarea
          value={exemptText}
          onChange={(e) => setExemptText(e.target.value)}
          placeholder="0x… one per line"
          rows={2}
          spellCheck={false}
          className="mt-2 w-full resize-y rounded-xl border border-border bg-surface px-3 py-2 font-mono text-xs outline-none focus:border-accent"
        />
        {exemptions.list.length > 0 && (
          <p className="mt-1 text-[11px] text-muted-foreground">
            {exemptions.list.length} wallet{exemptions.list.length === 1 ? "" : "s"} exempt besides you
          </p>
        )}
      </div>

      <dl className="mt-4 space-y-1 rounded-2xl border border-border bg-surface-muted p-3 font-mono text-[11px]">
        <div className="flex justify-between gap-3">
          <dt className="text-muted-foreground">Pons launch fee</dt>
          <dd>{fee !== undefined ? `${fmt(fee, 18, 6)} ETH` : "—"}</dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-muted-foreground">Launch config</dt>
          <dd>#{PONS_LAUNCH_CONFIG_ID.toString()} · 1B supply · 1% curve fee</dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-muted-foreground">Launch protection</dt>
          <dd>
            3s snipe tax · you{exemptions.list.length > 0 ? ` + ${exemptions.list.length}` : ""} exempt
          </dd>
        </div>
      </dl>

      {blocker && !busy && <p className="mt-3 text-xs text-muted-foreground">{blocker}</p>}
      {launcher.error && (
        <p className="mt-3 flex items-start gap-1.5 text-xs text-destructive">
          <WarningCircle size={14} weight="fill" className="mt-0.5 shrink-0" />
          {launcher.error}
        </p>
      )}

      <Button className="mt-4 w-full" size="lg" disabled={blocker !== null || busy || !!created} onClick={launch}>
        {busy ? (
          <>
            <CircleNotch size={16} className="animate-spin" />
            {launcher.stage === "approve" ? `Approve ${quote?.symbol ?? "quote"}…` : "Launching on Pons…"}
          </>
        ) : (
          <>
            <RocketLaunch size={16} weight="bold" />
            Launch ${symbol} on Pons
          </>
        )}
      </Button>
      {created && (
        <a
          href={ponsTokenUrl(created)}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-2 flex items-center justify-center gap-1 text-xs text-accent-strong underline"
        >
          View on Pons <ArrowSquareOut size={12} />
        </a>
      )}
    </>
  );
}
