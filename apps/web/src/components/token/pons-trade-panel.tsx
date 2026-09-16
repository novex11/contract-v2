"use client";

import { useEffect, useMemo, useState } from "react";
import { formatUnits, parseUnits, type Address } from "viem";
import { useBalance, useReadContract } from "wagmi";
import { ArrowRight, CheckCircle, CircleNotch, Info, ShieldCheck, Wallet, WarningCircle } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { EthLogo, UsdgLogo } from "@/components/ui/asset-logo";
import { StockLogo } from "@/components/ui/stock-logo";
import { DualLogoStack } from "@/components/launchpad/dual-logo-stack";
import { AssetSelect, type AssetOption } from "@/components/token/asset-select";
import { cn, explorerUrl, formatUsd } from "@/lib/utils";
import { USDG_ADDRESS, WETH_ADDRESS, erc20Abi, pairVaultAbi, usdgReady } from "@/lib/contracts";
import { useOraclePrices, useTokenBalances, type PairOnchainState } from "@/hooks/use-pair-launchpad";
import { DEFAULT_SLIPPAGE_BPS, describeRoute, swapPath, useLegQuotes, type TradeStage } from "@/hooks/use-pair-trade";
import {
  PONS_SNIPE_WINDOW_SECONDS,
  usePonsQuoteBuy,
  usePonsQuoteSell,
  usePonsTrade,
  type PonsOnchainState,
  type PonsPayMethod,
} from "@/hooks/use-pons-token";

const SLIPPAGE_OPTIONS = [100, 200, 300];
const SELL_PRESETS = [25, 50, 75, 100];
const ETH_GAS_RESERVE = 500_000_000_000_000n;

const same = (a: string | undefined, b: string | undefined) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

function compactTokens(amount: bigint): string {
  const n = Number(formatUnits(amount, 18));
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(2)}K`;
  return n.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

function formatAmount(amount: bigint, decimals: number): string {
  const n = Number(formatUnits(amount, decimals));
  return n.toLocaleString(undefined, { maximumFractionDigits: n !== 0 && n < 1 ? 6 : 4 });
}

export interface PonsTradePanelProps {
  token: Address;
  pair: Address;
  symbol: string;
  chain: PairOnchainState;
  pons: PonsOnchainState;
  tickerA: string;
  tickerB: string;
  decA: number;
  decB: number;
  priceA8?: bigint;
  priceB8?: bigint;
  account?: Address;
  authenticated: boolean;
  walletReady: boolean;
  onLogin: () => void;
  onDone: () => void;
}

/**
 * Buy/Sell panel for a token whose market is a Pons v2 curve quoted in one of
 * the pair's stocks. Pay or receive ETH, USDG, the quote stock itself, or the
 * pair's shares; every route ends on the same Pons curve.
 */
export function PonsTradePanel(props: PonsTradePanelProps) {
  const { token, pair, symbol, chain, pons, tickerA, tickerB, decA, decB, priceA8, priceB8, account, authenticated, walletReady, onLogin, onDone } =
    props;
  const quote = pons.quoteToken;
  const quoteDec = pons.quoteDecimals;
  const quoteSym = pons.quoteSymbol || "quote";
  const quoteIsA = same(quote, chain.tokenA);
  const quoteIsB = same(quote, chain.tokenB);
  const quoteIsUsdg = same(quote, USDG_ADDRESS);

  const [mode, setMode] = useState<"buy" | "sell">("buy");
  const [method, setMethod] = useState<PonsPayMethod>("ETH");
  const [amount, setAmount] = useState("");
  const [sellPct, setSellPct] = useState(100);
  const [slippageBps, setSlippageBps] = useState(DEFAULT_SLIPPAGE_BPS);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => setAmount(""), [method, mode]);
  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1_000);
    return () => clearInterval(id);
  }, []);

  const payDecimals = method === "ETH" ? 18 : method === "USDG" ? 6 : method === "QUOTE" ? quoteDec : 18;
  const payToken: Address = method === "ETH" ? WETH_ADDRESS : method === "USDG" ? USDG_ADDRESS : method === "QUOTE" ? quote : pair;

  // ─── Balances and prices ──────────────────────────────
  const native = useBalance({ address: account, query: { enabled: !!account, refetchInterval: 15_000 } });
  const balances = useTokenBalances(account, [USDG_ADDRESS, quote, pair]);
  const usdgBalance = balances.balances.get(USDG_ADDRESS.toLowerCase()) ?? 0n;
  const quoteBalance = balances.balances.get(quote.toLowerCase()) ?? 0n;
  const shareBalance = balances.balances.get(pair.toLowerCase()) ?? 0n;
  const tokenBalanceRead = useReadContract({
    address: token,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: account ? [account] : undefined,
    query: { enabled: !!account, refetchInterval: 10_000 },
  });
  const tokenBalance = (tokenBalanceRead.data as bigint | undefined) ?? 0n;
  const balance =
    method === "ETH" ? (native.data?.value ?? 0n) : method === "USDG" ? usdgBalance : method === "QUOTE" ? quoteBalance : shareBalance;
  const spendable = method === "ETH" ? (balance > ETH_GAS_RESERVE ? balance - ETH_GAS_RESERVE : 0n) : balance;

  const { prices } = useOraclePrices([WETH_ADDRESS, quote]);
  const ethUsd = Number(prices.get(WETH_ADDRESS.toLowerCase()) ?? 0n) / 1e8;
  const quoteUsd = quoteIsUsdg ? 1 : Number(prices.get(quote.toLowerCase()) ?? 0n) / 1e8;
  const sharePriceUsd = Number(chain.sharePriceUsd8) / 1e8;
  const payUsd = method === "ETH" ? ethUsd : method === "USDG" ? 1 : method === "QUOTE" ? quoteUsd : sharePriceUsd;

  const amountIn = useMemo(() => {
    try {
      return amount ? parseUnits(amount, payDecimals) : 0n;
    } catch {
      return 0n;
    }
  }, [amount, payDecimals]);
  const amountUsd = Number(formatUnits(amountIn, payDecimals)) * payUsd;
  const sellTokens = (tokenBalance * BigInt(sellPct)) / 100n;

  // ─── Buy quotes: pay asset → quote stock → Pons curve ──
  const buying = mode === "buy" && amountIn > 0n;
  const redeem = useReadContract({
    address: pair,
    abi: pairVaultAbi,
    functionName: "quoteRedeem",
    args: [amountIn],
    query: { enabled: buying && method === "SHARES", refetchInterval: 15_000 },
  });
  const rq = redeem.data as readonly [bigint, bigint, bigint] | undefined;
  const buyLegs = useLegQuotes(
    !buying
      ? null
      : method === "SHARES"
        ? rq
          ? [
              { from: chain.tokenA, to: quote, amount: rq[0] },
              { from: chain.tokenB, to: quote, amount: rq[1] },
            ]
          : null
        : method === "QUOTE"
          ? [{ from: quote, to: quote, amount: amountIn }]
          : [{ from: payToken, to: quote, amount: amountIn }],
  );
  const quoteIn =
    method === "SHARES"
      ? buyLegs.outs?.[0] !== undefined && buyLegs.outs?.[1] !== undefined
        ? buyLegs.outs[0] + buyLegs.outs[1]
        : undefined
      : buyLegs.outs?.[0];
  const buyQuote = usePonsQuoteBuy(token, buying ? quoteIn : undefined);
  const tokensOut = buyQuote.tokensOut;
  const minTokensOut = tokensOut !== undefined ? (tokensOut * BigInt(10_000 - slippageBps)) / 10_000n : 0n;

  // ─── Sell quotes: Pons curve → quote stock → receive asset ──
  const selling = mode === "sell" && sellTokens > 0n;
  const sellCurve = usePonsQuoteSell(token, selling ? sellTokens : 0n);
  const quoteOut = sellCurve.quoteOut;
  let forA = 0n;
  if (quoteOut !== undefined && priceA8 && priceB8 && chain.reserveA > 0n && chain.reserveB > 0n) {
    const valueA = (chain.reserveA * priceA8) / 10n ** BigInt(decA);
    const valueB = (chain.reserveB * priceB8) / 10n ** BigInt(decB);
    forA = valueA + valueB > 0n ? (quoteOut * valueA) / (valueA + valueB) : 0n;
  }
  const sellLegs = useLegQuotes(
    !selling || quoteOut === undefined
      ? null
      : method === "SHARES"
        ? [
            { from: quote, to: chain.tokenA, amount: forA },
            { from: quote, to: chain.tokenB, amount: quoteOut - forA },
          ]
        : method === "QUOTE"
          ? [{ from: quote, to: quote, amount: quoteOut }]
          : [{ from: quote, to: payToken, amount: quoteOut }],
  );
  const outA = method === "SHARES" ? sellLegs.outs?.[0] : undefined;
  const outB = method === "SHARES" ? sellLegs.outs?.[1] : undefined;
  const depositPreview = useReadContract({
    address: pair,
    abi: pairVaultAbi,
    functionName: "previewDeposit",
    args: [outA ?? 0n, outB ?? 0n],
    query: { enabled: selling && method === "SHARES" && outA !== undefined && outB !== undefined, refetchInterval: 15_000 },
  });
  const pv = depositPreview.data as readonly [bigint, bigint, bigint] | undefined;
  const amountOut = method === "SHARES" ? pv?.[0] : sellLegs.outs?.[0];
  const minAmountOut = amountOut !== undefined ? (amountOut * BigInt(10_000 - slippageBps)) / 10_000n : 0n;
  const receiveDecimals = payDecimals;
  const receiveUsd = amountOut !== undefined ? Number(formatUnits(amountOut, receiveDecimals)) * payUsd : undefined;

  const trade = usePonsTrade();
  const busy = trade.stage === "approve" || trade.stage === "submit";
  const snipeUntil = pons.launchTime + PONS_SNIPE_WINDOW_SECONDS;
  const launchProtected = pons.launchTime > 0 && now < snipeUntil;

  let blocker: string | null = null;
  if (pons.graduated) blocker = "This token graduated to its Uniswap pool on Pons. Trade it there.";
  else if (mode === "buy") {
    if (amountIn === 0n) blocker = `Enter an amount of ${methodLabel(method, quoteSym)}`;
    else if (account && amountIn > spendable)
      blocker = method === "ETH" ? "Not enough ETH (0.0005 ETH is kept for gas)." : `Not enough ${methodLabel(method, quoteSym)} in your wallet.`;
    else if (redeem.error || buyLegs.error || buyQuote.error) blocker = "Quote unavailable. Prices may be stale; try again shortly.";
    else if (quoteIn === undefined || tokensOut === undefined) blocker = "Fetching quote…";
    else if (tokensOut === 0n) blocker = "Amount too small.";
  } else {
    if (tokenBalance === 0n) blocker = `You have no ${symbol} to sell.`;
    else if (sellCurve.error || sellLegs.error || depositPreview.error) blocker = "Quote unavailable. Prices may be stale; try again shortly.";
    else if (sellCurve.loading || amountOut === undefined) blocker = "Fetching quote…";
  }

  async function submit() {
    trade.reset();
    try {
      if (mode === "buy" && method === "SHARES") {
        await trade.buyWithShares({
          token,
          pair,
          quoteToken: quote,
          tokenA: chain.tokenA,
          tokenB: chain.tokenB,
          sharesIn: amountIn,
          minTokensOut,
          slippageBps,
          pathA: buyLegs.routes?.[0]?.path,
          pathB: buyLegs.routes?.[1]?.path,
        });
        setAmount("");
      } else if (mode === "buy") {
        await trade.buy({
          token,
          quoteToken: quote,
          method: method as Exclude<PonsPayMethod, "SHARES">,
          amountIn,
          minTokensOut,
          slippageBps,
          path: buyLegs.routes?.[0]?.path ?? swapPath(payToken, quote),
        });
        setAmount("");
      } else if (method === "SHARES") {
        await trade.sellForShares({
          token,
          quoteToken: quote,
          tokenA: chain.tokenA,
          tokenB: chain.tokenB,
          tokensIn: sellTokens,
          minShares: minAmountOut,
          slippageBps,
          pathA: sellLegs.routes?.[0]?.path,
          pathB: sellLegs.routes?.[1]?.path,
        });
      } else {
        await trade.sell({
          token,
          quoteToken: quote,
          method: method as Exclude<PonsPayMethod, "SHARES">,
          tokensIn: sellTokens,
          minAmountOut,
          slippageBps,
          path: sellLegs.routes?.[0]?.path ?? swapPath(quote, payToken),
        });
      }
      void native.refetch();
      void tokenBalanceRead.refetch();
      balances.refetch();
      onDone();
    } catch {
      /* shown in the status list */
    }
  }

  const label = methodLabel(method, quoteSym);
  const steps: Array<{ id: TradeStage; label: string }> =
    mode === "buy"
      ? [
          ...(method !== "ETH" ? [{ id: "approve" as const, label: `Approve ${label}` }] : []),
          { id: "submit", label: `Buy ${symbol} with ${label}` },
        ]
      : [
          { id: "approve", label: `Approve ${symbol}` },
          { id: "submit", label: `Sell ${symbol} for ${label}` },
        ];
  const order: TradeStage[] = ["approve", "submit", "done"];

  const route = (() => {
    if (method === "QUOTE") return mode === "buy" ? `${quoteSym} → ${symbol}` : `${symbol} → ${quoteSym}`;
    if (method === "SHARES") {
      const legs = quoteIsA ? tickerB : quoteIsB ? tickerA : `${tickerA} + ${tickerB}`;
      return mode === "buy"
        ? `${tickerA}+${tickerB} shares → ${legs} → ${quoteSym} → ${symbol}`
        : `${symbol} → ${quoteSym} → ${legs} → ${tickerA}+${tickerB} shares`;
    }
    return mode === "buy" ? `${method} → ${quoteSym} → ${symbol}` : `${symbol} → ${quoteSym} → ${method}`;
  })();
  const swapLabel = (() => {
    const legs = mode === "buy" ? buyLegs.routes : sellLegs.routes;
    const parts = (legs ?? []).map((r, k) => {
      if (!r) return null;
      const from = mode === "buy" ? (method === "SHARES" ? (k === 0 ? tickerA : tickerB) : method) : quoteSym;
      const to = mode === "buy" ? quoteSym : method === "SHARES" ? (k === 0 ? tickerA : tickerB) : method;
      return describeRoute(r, from, to);
    });
    const list = parts.filter((x): x is string => !!x);
    if (list.length === 0) return "no swap";
    return list.join(" · ");
  })();
  const prefix = mode === "buy" ? "" : "Receive ";
  const shareOption: AssetOption<PonsPayMethod> = {
    id: "SHARES",
    label: `${prefix}${tickerA}+${tickerB} shares`,
    subtitle: mode === "buy" ? "Redeemed into stocks, swapped into the quote" : "Quote swapped into both stocks, deposited for you",
    logo: <DualLogoStack tickerA={tickerA} tickerB={tickerB} size="sm" />,
    balance: account ? `${formatAmount(shareBalance, 18)} shares` : undefined,
  };
  const methodOptions: AssetOption<PonsPayMethod>[] = [
    {
      id: "ETH",
      label: `${prefix}ETH`,
      subtitle: mode === "buy" ? `Swapped into ${quoteSym} on Uniswap` : `${quoteSym} swapped to ETH`,
      logo: <EthLogo />,
      balance: account ? `${formatAmount(native.data?.value ?? 0n, 18)} ETH` : undefined,
    },
    ...(usdgReady && !quoteIsUsdg
      ? [
          {
            id: "USDG" as const,
            label: `${prefix}USDG`,
            subtitle: mode === "buy" ? `Swapped into ${quoteSym} on Uniswap` : `${quoteSym} swapped to USDG`,
            logo: <UsdgLogo />,
            balance: account ? `${formatAmount(usdgBalance, 6)} USDG` : undefined,
          },
        ]
      : []),
    {
      id: "QUOTE" as const,
      label: `${prefix}${quoteSym}`,
      subtitle: mode === "buy" ? "The curve's quote asset, no swap" : "Straight from the curve, no swap",
      logo: quoteIsUsdg ? <UsdgLogo /> : <StockLogo ticker={quoteSym} size="sm" />,
      balance: account ? `${formatAmount(quoteBalance, quoteDec)} ${quoteSym}` : undefined,
    },
    shareOption,
  ];

  return (
    <div className="overflow-hidden rounded-[1.75rem] border border-border bg-surface shadow-float">
      <div className="flex border-b border-border-subtle">
        {(["buy", "sell"] as const).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => setMode(m)}
            className={cn(
              "flex-1 py-3 text-sm font-semibold capitalize transition-colors",
              mode === m
                ? m === "buy"
                  ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                  : "bg-rose-500/10 text-rose-600 dark:text-rose-400"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {m}
          </button>
        ))}
      </div>

      <div className="p-5">
        <AssetSelect className="mb-4" label={mode === "buy" ? "Pay with" : "Receive"} value={method} onChange={setMethod} options={methodOptions} />

        {mode === "buy" ? (
          <div>
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <label htmlFor="pons-trade-amount">You pay</label>
              {account && (
                <button type="button" onClick={() => setAmount(formatUnits(spendable, payDecimals))} className="font-mono transition-colors hover:text-foreground">
                  Balance {formatAmount(balance, payDecimals)} {label}
                </button>
              )}
            </div>
            <div className="mt-2 flex items-center gap-2 rounded-2xl border border-border bg-surface px-4 transition-colors focus-within:border-accent">
              <input
                id="pons-trade-amount"
                inputMode="decimal"
                autoComplete="off"
                placeholder="0.0"
                value={amount}
                onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))}
                className="h-14 w-full min-w-0 bg-transparent font-mono text-xl outline-none"
              />
              <span className="font-mono text-sm font-semibold">{label}</span>
            </div>
            {amountUsd > 0 && <p className="mt-1 text-xs text-muted-foreground">≈ {formatUsd(amountUsd)}</p>}
          </div>
        ) : (
          <div>
            <p className="text-xs text-muted-foreground">Your {symbol}</p>
            <p className="mt-1 font-mono text-2xl font-semibold tabular-nums">{compactTokens(tokenBalance)}</p>
            <div className="mt-3 flex gap-2">
              {SELL_PRESETS.map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => setSellPct(p)}
                  className={cn(
                    "flex-1 rounded-full border px-3 py-1.5 font-mono text-xs transition-all",
                    sellPct === p ? "border-accent bg-accent-subtle text-accent-strong" : "border-border text-muted-foreground hover:border-accent/40",
                  )}
                >
                  {p}%
                </button>
              ))}
            </div>
          </div>
        )}

        <dl className="mt-4 space-y-1.5 rounded-2xl border border-border bg-surface-muted p-4 font-mono text-xs">
          {mode === "buy" ? (
            <>
              <Row strong label="You receive" value={tokensOut !== undefined ? `≈ ${compactTokens(tokensOut)} ${symbol}` : "—"} />
              {quoteIn !== undefined && method !== "QUOTE" && (
                <Row label={`${quoteSym} to the curve`} value={`${formatAmount(quoteIn, quoteDec)} ${quoteSym}`} />
              )}
              <Row label="Minimum received" value={tokensOut !== undefined ? `${compactTokens(minTokensOut)} ${symbol}` : "—"} />
            </>
          ) : (
            <>
              <Row strong label="You receive" value={amountOut !== undefined ? `≈ ${formatAmount(amountOut, receiveDecimals)} ${label}` : "—"} />
              {receiveUsd !== undefined && receiveUsd > 0 && <Row label="Value" value={formatUsd(receiveUsd)} />}
              <Row label="Minimum received" value={amountOut !== undefined ? `${formatAmount(minAmountOut, receiveDecimals)} ${label}` : "—"} />
            </>
          )}
          <Row label="Route" value={route} />
          <Row label="Fees" value={`1% Pons curve · ${swapLabel}${method === "SHARES" ? " · no pair deposit fee" : ""}`} />
          <div className="flex items-center justify-between gap-3 pt-1">
            <dt className="text-muted-foreground">Max slippage</dt>
            <dd className="flex gap-1">
              {SLIPPAGE_OPTIONS.map((bps) => (
                <button
                  key={bps}
                  type="button"
                  onClick={() => setSlippageBps(bps)}
                  className={cn("rounded-full px-2 py-0.5 transition-colors", slippageBps === bps ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground")}
                >
                  {bps / 100}%
                </button>
              ))}
            </dd>
          </div>
        </dl>

        {launchProtected && (
          <p className="mt-3 flex items-start gap-1.5 text-xs text-amber-600 dark:text-amber-400">
            <ShieldCheck size={14} weight="fill" className="mt-0.5 shrink-0" />
            Pons launch protection for {snipeUntil - now}s: buys pay a snipe tax that starts at 99% and decays to zero.
          </p>
        )}
        {authenticated && blocker && !busy && trade.stage !== "done" && (
          <p className="mt-3 flex items-start gap-1.5 text-xs text-muted-foreground">
            <Info size={14} className="mt-0.5 shrink-0" />
            {blocker}
          </p>
        )}

        {trade.stage !== "idle" && (
          <ol className="mt-4 space-y-2 rounded-2xl border border-border bg-surface p-4 text-xs">
            {steps.map((step) => {
              const current = trade.stage === step.id;
              const passed = trade.stage === "done" || (trade.stage !== "error" && order.indexOf(trade.stage) > order.indexOf(step.id));
              return (
                <li key={step.id} className="flex items-center gap-2">
                  {passed ? (
                    <CheckCircle size={16} weight="fill" className="text-success" />
                  ) : current ? (
                    <CircleNotch size={16} className="animate-spin text-accent-strong" />
                  ) : (
                    <span className="h-4 w-4 rounded-full border border-border" />
                  )}
                  <span className={cn(current ? "font-semibold text-foreground" : "text-muted-foreground")}>{step.label}</span>
                </li>
              );
            })}
            {trade.stage === "done" && (
              <li className="pt-1 font-semibold text-success">
                {mode === "buy" ? "Bought" : "Sold"} successfully.{" "}
                {trade.hash && (
                  <a href={explorerUrl("tx", trade.hash)} target="_blank" rel="noopener noreferrer" className="underline">
                    View transaction ↗
                  </a>
                )}
              </li>
            )}
            {trade.stage === "error" && trade.error && (
              <li className="flex items-start gap-1.5 pt-1 text-destructive">
                <WarningCircle size={14} weight="fill" className="mt-0.5 shrink-0" />
                {trade.error}
              </li>
            )}
          </ol>
        )}

        {authenticated ? (
          <Button
            className={cn("mt-4 w-full", mode === "buy" ? "bg-emerald-600 hover:bg-emerald-600/90" : "")}
            size="lg"
            variant={mode === "sell" ? "inverse" : undefined}
            disabled={blocker !== null || busy}
            onClick={submit}
          >
            {busy ? "Processing…" : mode === "buy" ? `Buy ${symbol}` : `Sell ${sellPct}% for ${label}`}
            {!busy && <ArrowRight size={16} weight="bold" />}
          </Button>
        ) : (
          <Button className="mt-4 w-full" size="lg" onClick={onLogin} disabled={!walletReady}>
            <Wallet size={16} />
            Connect wallet
          </Button>
        )}
      </div>
    </div>
  );
}

function methodLabel(method: PonsPayMethod, quoteSym: string): string {
  if (method === "QUOTE") return quoteSym;
  if (method === "SHARES") return "shares";
  return method;
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className={cn("flex justify-between gap-3", strong && "text-sm")}>
      <dt className={strong ? "font-medium" : "text-muted-foreground"}>{label}</dt>
      <dd className={cn("text-right tabular-nums", strong && "font-medium")}>{value}</dd>
    </div>
  );
}
