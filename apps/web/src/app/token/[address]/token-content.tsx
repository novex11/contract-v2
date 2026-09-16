"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { formatUnits, isAddress, type Address } from "viem";
import { useReadContract } from "wagmi";
import { ArrowSquareOut, CaretLeft, GraduationCap, RocketLaunch, SealCheck } from "@phosphor-icons/react";
import { getTokenByAddress, isTestnetMode } from "@compose/config";
import type { CurveTrade, PairHistoryPoint, PairHistoryRange } from "@/lib/api";
import { receiptTokenAbi } from "@/lib/contracts";
import { useWallet } from "@/hooks/use-wallet";
import { useOraclePrices, usePairOnchain } from "@/hooks/use-pair-launchpad";
import { useCurveOnchain, useCurveTokenDetail, useTokenHistory, useTokenLive } from "@/hooks/use-curve-token";
import { ponsTokenUrl, usePonsOnchain } from "@/hooks/use-pons-token";
import { PairAreaChart, type PairAreaMetric } from "@/components/pair/pair-area-chart";
import { TokenTradePanel } from "@/components/token/token-trade-panel";
import { PonsTradePanel } from "@/components/token/pons-trade-panel";
import { PonsCreatorFees } from "@/components/token/pons-creator-fees";
import { CurveCreatorFees } from "@/components/token/curve-creator-fees";
import { AddressChip } from "@/components/launchpad/address-chip";
import { DualLogoStack } from "@/components/launchpad/dual-logo-stack";
import { Badge } from "@/components/ui/badge";
import { cn, explorerUrl, formatUsd } from "@/lib/utils";

const SUPPLY = 1_000_000_000;

function compactTokens(raw: string | bigint): string {
  const n = Number(formatUnits(typeof raw === "string" ? BigInt(raw) : raw, 18));
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(2)}K`;
  return n.toFixed(2);
}

function formatPrice(usd: number): string {
  if (usd === 0) return "$0";
  if (usd >= 0.01) return formatUsd(usd);
  const exp = Math.floor(Math.log10(usd));
  return `$${usd.toFixed(Math.min(12, -exp + 3))}`;
}

function timeAgo(iso: string): string {
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86_400)}d`;
}

function shortHash(h: string): string {
  return `${h.slice(0, 6)}…${h.slice(-4)}`;
}

const tradeKey = (t: CurveTrade) => `${t.txHash}-${t.logIndex ?? ""}`;

export default function TokenDetailContent({ address }: { address: string }) {
  const token = isAddress(address) ? (address as Address) : undefined;
  const wallet = useWallet();
  const [range, setRange] = useState<PairHistoryRange>("24h");
  const [metric, setMetric] = useState<PairAreaMetric>("navUsd");

  const detail = useCurveTokenDetail(token);
  const onchain = useCurveOnchain(token);
  const curve = onchain.data;
  // A token launched on Pons v2 has no ComposeCurve entry; its market is read through PonsRouter.
  const ponsChain = usePonsOnchain(token);
  const pons = ponsChain.data ?? undefined;
  const market = pons
    ? { pair: pons.pair, creator: pons.creator, launchTime: pons.launchTime }
    : curve
      ? { pair: curve.pair, creator: curve.creator, launchTime: curve.launchTime }
      : undefined;
  const pairChain = usePairOnchain(market?.pair);
  const chain = pairChain.data;
  const history = useTokenHistory(token, range);
  const live = useTokenLive(token, () => {
    void onchain.refetch();
    void ponsChain.refetch();
    void pairChain.refetch();
  });

  const nameRead = useReadContract({ address: token, abi: receiptTokenAbi, functionName: "name", query: { enabled: !!token } });
  const symbolRead = useReadContract({ address: token, abi: receiptTokenAbi, functionName: "symbol", query: { enabled: !!token } });

  const meta = detail.data?.token;
  const name = meta?.name ?? (nameRead.data as string | undefined) ?? "Creator token";
  const symbol = meta?.symbol ?? (symbolRead.data as string | undefined) ?? "TOKEN";

  // Indexed trades plus anything pushed live since the last fetch, newest first.
  const trades = useMemo(() => {
    const list = detail.data?.trades ?? [];
    if (!live.last) return list;
    const seen = new Set(list.map(tradeKey));
    return seen.has(tradeKey(live.last)) ? list : [live.last, ...list];
  }, [detail.data?.trades, live.last]);

  // Every trade is a point on the line (the indexer emits the launch, each trade, and "now").
  const points = useMemo<PairHistoryPoint[]>(
    () =>
      (history.data?.points ?? []).map((p) => ({
        timestamp: p.timestamp,
        navUsd: p.marketCapUsd,
        sharePrice: p.priceUsd,
        totalShares: "0",
      })),
    [history.data],
  );

  const tokenAMeta = chain ? getTokenByAddress(chain.tokenA) : undefined;
  const tokenBMeta = chain ? getTokenByAddress(chain.tokenB) : undefined;
  const tickerA = tokenAMeta?.ticker ?? meta?.tickerA ?? "Token A";
  const tickerB = tokenBMeta?.ticker ?? meta?.tickerB ?? "Token B";
  const { prices } = useOraclePrices(chain ? [chain.tokenA, chain.tokenB] : []);
  const priceA8 = chain ? prices.get(chain.tokenA.toLowerCase()) : undefined;
  const priceB8 = chain ? prices.get(chain.tokenB.toLowerCase()) : undefined;

  const marketCapUsd = pons
    ? Number(pons.marketCapUsd8) / 1e8
    : curve
      ? Number(curve.marketCapUsd8) / 1e8
      : (meta?.marketCapUsd ?? 0);
  const priceUsd = marketCapUsd / SUPPLY;
  const progressBps = pons?.progressBps ?? curve?.progressBps ?? meta?.progressBps ?? 0;
  const graduated = pons?.graduated ?? curve?.graduated ?? meta?.graduated ?? false;
  const graduationMcap = meta?.graduationMarketCapUsd;
  const toGraduation = graduationMcap ? Math.max(0, graduationMcap - marketCapUsd) : undefined;
  // The Pons price seen through the two-stock lens: pair shares and quote stock per token.
  const quoteSym = pons?.quoteSymbol || meta?.quoteSymbol || "quote";
  const priceShares = pons ? Number(formatUnits(pons.priceInShares, 18)) : meta?.priceShares;
  const priceQuote = pons ? Number(formatUnits(pons.priceInQuote, pons.quoteDecimals)) : undefined;
  const ponsUrl = meta?.ponsUrl ?? (token ? ponsTokenUrl(token) : "");

  if (!token) {
    return <div className="container-page py-12 text-sm text-muted-foreground">That is not a valid token address.</div>;
  }
  if (onchain.isLoading || ponsChain.isLoading) {
    return <div className="container-page py-12 text-sm text-muted-foreground">Loading token…</div>;
  }
  if (!market) {
    return (
      <div className="container-page py-12 text-sm text-muted-foreground">
        This address is not a Compose creator token on this network.
      </div>
    );
  }

  return (
    <div className="container-page min-h-[100dvh] py-8 md:py-10">
      <Link
        href="/launchpad"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <CaretLeft size={14} />
        Launchpad
      </Link>

      {/* Banner — the token shares its pair's identity */}
      {meta?.imageUrl && (
        <div className="relative mt-5 h-40 overflow-hidden rounded-[1.75rem] border border-border md:h-52">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={meta.imageUrl} alt="" className="h-full w-full object-cover" />
        </div>
      )}

      {/* Header */}
      <div className="mt-5 flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-start gap-4">
          {meta?.logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={meta.logoUrl} alt="" className="h-14 w-14 shrink-0 rounded-2xl border border-border object-cover" />
          ) : (
            <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-accent-subtle font-mono text-lg font-bold text-accent-strong">
              {symbol.slice(0, 2)}
            </div>
          )}
          <div>
            <p className="label-caps flex items-center gap-2">
              <RocketLaunch size={12} weight="fill" />
              {pons ? `Creator token · Pons v2 curve · quoted in ${quoteSym}` : "Creator token · bonding curve"}
            </p>
            <h1 className="mt-1 text-3xl font-semibold tracking-tight md:text-4xl">{name}</h1>
            <p className="mt-1 font-mono text-sm text-muted-foreground">${symbol}</p>
            {meta?.pairDescription && (
              <p className="mt-2 max-w-xl text-sm leading-relaxed text-muted-foreground">{meta.pairDescription}</p>
            )}
            <p className="mt-2 flex items-center gap-2 text-sm text-muted-foreground">
              Backed by
              <span className="flex items-center gap-1.5 font-medium text-foreground">
                <DualLogoStack tickerA={tickerA} tickerB={tickerB} size="sm" />
                {tickerA} + {tickerB}
              </span>
            </p>
            {pons && (
              <p className="mt-1 font-mono text-xs text-muted-foreground">
                1 {symbol} = {priceShares !== undefined ? formatSmall(priceShares) : "—"} {tickerA}+{tickerB} shares ={" "}
                {priceQuote !== undefined ? formatSmall(priceQuote) : "—"} {quoteSym} · one market, shown two ways
              </p>
            )}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {pons && (
            <a href={ponsUrl} target="_blank" rel="noopener noreferrer" title="This token's page on Pons">
              <Badge variant="outline">
                Live on Pons
                <ArrowSquareOut size={12} />
              </Badge>
            </a>
          )}
          {graduated ? (
            <Badge variant="success">
              <GraduationCap size={12} weight="fill" />
              Graduated
            </Badge>
          ) : (
            <Badge variant="accent">
              <SealCheck size={12} weight="fill" />
              On bonding curve
            </Badge>
          )}
        </div>
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-2 rounded-2xl border border-border bg-surface-muted p-3 text-xs">
        <span className="rounded-full bg-accent-subtle px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wide text-accent-strong">
          {isTestnetMode() ? "Robinhood Chain Testnet" : "Robinhood Chain"}
        </span>
        <AddressChip address={token} label="Token" />
        <AddressChip address={market.pair} label="Pair" />
        <AddressChip address={market.creator} label="Creator" />
        {pons && <AddressChip address={pons.curve} label="Pons curve" />}
      </div>

      {/* Bonding progress */}
      <section className="mt-6 rounded-[1.5rem] border border-border bg-surface p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <p className="text-sm font-semibold">Bonding curve progress</p>
          <p className="font-mono text-sm tabular-nums">
            {graduated ? "100% · graduated" : `${(progressBps / 100).toFixed(2)}%`}
          </p>
        </div>
        <div className="mt-3 h-3 w-full overflow-hidden rounded-full bg-surface-muted">
          <div
            className={cn("h-full rounded-full transition-all duration-700", graduated ? "bg-success" : "bg-accent")}
            style={{ width: `${Math.min(100, progressBps / 100)}%` }}
          />
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          {pons
            ? graduated
              ? "This token graduated on Pons: its liquidity moved into a locked Uniswap pool. Trade it on Pons."
              : toGraduation !== undefined
                ? `${formatUsd(toGraduation)} more market cap to graduate at ≈ ${formatUsd(graduationMcap!)}. Every buy adds ${quoteSym} to the Pons curve.`
                : `Every buy adds ${quoteSym} to the Pons curve; once it sells out, liquidity moves into a locked Uniswap pool on Pons.`
            : graduated
              ? "This token reached its graduation target. Trading continues on the curve."
              : toGraduation !== undefined
                ? `${formatUsd(toGraduation)} more market cap to graduate at ≈ ${formatUsd(graduationMcap!)}. Every buy adds ${tickerA} + ${tickerB} to the pair vault.`
                : "Every buy adds stock-backed pair shares to the curve reserve."}
        </p>
      </section>

      {/* Backing: what the vault behind this token holds */}
      <section className="mt-4 rounded-[1.5rem] border border-border bg-surface p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <p className="text-sm font-semibold">Backing</p>
          <Link
            href={`/pair/${market.pair}`}
            className="font-mono text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          >
            Creator vault ↗
          </Link>
        </div>
        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          <BackingStat
            label={`${tickerA} in vault`}
            value={chain ? `${formatReserve(chain.reserveA, tokenAMeta?.decimals ?? 18)} ${tickerA}` : "—"}
            sub={chain && priceA8 ? formatUsd(Number(formatUnits(chain.reserveA, tokenAMeta?.decimals ?? 18)) * (Number(priceA8) / 1e8)) : undefined}
          />
          <BackingStat
            label={`${tickerB} in vault`}
            value={chain ? `${formatReserve(chain.reserveB, tokenBMeta?.decimals ?? 18)} ${tickerB}` : "—"}
            sub={chain && priceB8 ? formatUsd(Number(formatUnits(chain.reserveB, tokenBMeta?.decimals ?? 18)) * (Number(priceB8) / 1e8)) : undefined}
          />
          <BackingStat label="Vault TVL" value={chain ? formatUsd(Number(chain.navUsd8) / 1e8) : "—"} sub="real stocks, redeemable" />
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          {pons
            ? `The token's curve reserve is ${quoteSym} on Pons. This vault backs the ${tickerA}+${tickerB} shares you can pay with or receive; buying with shares redeems them into the quote, selling for shares deposits it back.`
            : `Every buy adds ${tickerA} + ${tickerB} to this vault and every sell takes them back out. Only the creator can deposit into it directly.`}
        </p>
      </section>

      <div className="mt-8 grid gap-8 lg:grid-cols-12">
        <div className="lg:col-span-7">
          <PairAreaChart
            points={points}
            metric={metric}
            onMetricChange={setMetric}
            metricLabels={{ navUsd: "MCap", sharePrice: "Price" }}
            range={range}
            onRangeChange={setRange}
            stats={[
              { label: "Market cap", value: formatUsd(marketCapUsd) },
              { label: "Price", value: formatPrice(priceUsd) },
              { label: "24h volume", value: meta?.volume24hUsd != null ? formatUsd(meta.volume24hUsd) : "—" },
              { label: "Trades", value: meta ? meta.tradesCount.toLocaleString() : "—" },
            ]}
            live={
              live.last
                ? { timestamp: live.last.timestamp, value: metric === "navUsd" ? live.last.marketCapUsd : live.last.priceUsd }
                : undefined
            }
            connected={live.connected}
            loading={history.isLoading}
            height={320}
            emptyHint="The line starts at launch and adds a point for every trade."
          />

          <section className="mt-6 rounded-[1.75rem] border border-border bg-surface p-6">
            <h2 className="text-base font-semibold">Trades</h2>
            {detail.isError && (
              <p className="mt-3 text-sm text-muted-foreground">Trades are unavailable while the indexer is offline.</p>
            )}
            {!detail.isError && trades.length === 0 && (
              <p className="mt-3 text-sm text-muted-foreground">No trades yet. Be the first to buy.</p>
            )}
            {trades.length > 0 && (
              <div className="mt-4 overflow-x-auto">
                <table className="w-full min-w-[640px] font-mono text-xs">
                  <thead>
                    <tr className="text-left text-muted-foreground">
                      <th className="pb-2 font-normal">Age</th>
                      <th className="pb-2 font-normal">Type</th>
                      <th className="pb-2 text-right font-normal">USD</th>
                      <th className="pb-2 text-right font-normal">{symbol}</th>
                      <th className="pb-2 text-right font-normal">MCap</th>
                      <th className="pb-2 text-right font-normal">Trader</th>
                      <th className="pb-2 text-right font-normal">Tx</th>
                    </tr>
                  </thead>
                  <tbody>
                    {trades.map((t) => (
                      <tr key={tradeKey(t)} className="border-t border-border-subtle">
                        <td className="py-2 text-muted-foreground">{timeAgo(t.timestamp)}</td>
                        <td className={cn("py-2 font-semibold", t.isBuy ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400")}>
                          {t.isBuy ? "Buy" : "Sell"}
                        </td>
                        <td className="py-2 text-right tabular-nums">{formatUsd(t.valueUsd)}</td>
                        <td className="py-2 text-right tabular-nums">{compactTokens(t.tokens)}</td>
                        <td className="py-2 text-right tabular-nums">{formatUsd(t.marketCapUsd)}</td>
                        <td className="py-2 text-right">
                          <a
                            href={explorerUrl("address", t.trader)}
                            target="_blank"
                            rel="noopener noreferrer"
                            title="Trader on Blockscout"
                            className="underline-offset-2 hover:underline"
                          >
                            {shortHash(t.trader)}
                          </a>
                        </td>
                        <td className="py-2 text-right">
                          <a
                            href={explorerUrl("tx", t.txHash)}
                            target="_blank"
                            rel="noopener noreferrer"
                            title="Transaction on Blockscout"
                            className="inline-flex items-center gap-1 text-accent-strong underline-offset-2 hover:underline"
                          >
                            {shortHash(t.txHash)}
                            <ArrowSquareOut size={12} />
                          </a>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>

        <aside className="lg:col-span-5">
          <div className="lg:sticky lg:top-24">
            {wallet.address && wallet.address.toLowerCase() === market.creator.toLowerCase() && (
              pons ? (
                <PonsCreatorFees className="mb-4" pons={pons} symbol={symbol} ponsUrl={ponsUrl} />
              ) : curve ? (
                <CurveCreatorFees
                  className="mb-4"
                  token={token}
                  pair={curve.pair}
                  symbol={symbol}
                  owedShares={curve.creatorFees}
                  sharePriceUsd={chain ? Number(chain.sharePriceUsd8) / 1e8 : meta?.sharePriceUsd}
                  onClaimed={() => void onchain.refetch()}
                />
              ) : null
            )}
            {chain && pons ? (
              <PonsTradePanel
                token={token}
                pair={pons.pair}
                symbol={symbol}
                chain={chain}
                pons={pons}
                tickerA={tickerA}
                tickerB={tickerB}
                decA={tokenAMeta?.decimals ?? 18}
                decB={tokenBMeta?.decimals ?? 18}
                priceA8={priceA8}
                priceB8={priceB8}
                account={wallet.address}
                authenticated={wallet.authenticated}
                walletReady={wallet.ready}
                onLogin={wallet.login}
                onDone={() => {
                  void ponsChain.refetch();
                  void pairChain.refetch();
                  void detail.refetch();
                  void history.refetch();
                }}
              />
            ) : chain && curve ? (
              <TokenTradePanel
                token={token}
                pair={curve.pair}
                symbol={symbol}
                chain={chain}
                tickerA={tickerA}
                tickerB={tickerB}
                decA={tokenAMeta?.decimals ?? 18}
                decB={tokenBMeta?.decimals ?? 18}
                priceA8={priceA8}
                priceB8={priceB8}
                launchTime={curve.launchTime}
                account={wallet.address}
                authenticated={wallet.authenticated}
                walletReady={wallet.ready}
                onLogin={wallet.login}
                onDone={() => {
                  void onchain.refetch();
                  void pairChain.refetch();
                  void detail.refetch();
                  void history.refetch();
                }}
              />
            ) : (
              <div className="rounded-[1.75rem] border border-border bg-surface p-6 text-sm text-muted-foreground">
                Loading pair…
              </div>
            )}
            <p className="mt-3 px-1 text-[11px] leading-relaxed text-muted-foreground">
              {pons ? (
                <>
                  1B fixed supply on a Pons v2 constant-product curve quoted in {quoteSym}. The same curve is listed on
                  ponsfamily.com; Compose routes every trade onto it and re-quotes the price in {tickerA}+{tickerB} pair
                  shares. 1% curve fee, with the creator&apos;s share paid by Pons directly.
                </>
              ) : (
                <>
                  1B fixed supply, all of it on the curve at launch. Price follows a constant-product bonding curve quoted in{" "}
                  {tickerA}+{tickerB} pair shares, so the reserve is real stocks. 1% trade fee: 70% creator, 30% protocol.
                </>
              )}
            </p>
          </div>
        </aside>
      </div>
    </div>
  );
}

/** Small unit prices (shares or stock per token) without scientific notation. */
function formatSmall(n: number): string {
  if (n === 0) return "0";
  if (n >= 0.01) return n.toLocaleString(undefined, { maximumFractionDigits: 4 });
  const exp = Math.floor(Math.log10(n));
  return n.toFixed(Math.min(12, -exp + 3));
}

function formatReserve(amount: bigint, decimals: number): string {
  const n = Number(formatUnits(amount, decimals));
  return n.toLocaleString(undefined, { maximumFractionDigits: n !== 0 && n < 1 ? 6 : 4 });
}

function BackingStat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-2xl border border-border-subtle bg-surface-muted/50 p-3">
      <p className="text-[11px] text-muted-foreground">{label}</p>
      <p className="mt-1 font-mono text-sm font-semibold tabular-nums">{value}</p>
      {sub && <p className="mt-0.5 font-mono text-[11px] text-muted-foreground">{sub}</p>}
    </div>
  );
}
