"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { motion } from "motion/react";
import {
  ArrowRight,
  ChartLineUp,
  GraduationCap,
  Rocket,
  Sparkle,
  TrendUp,
  Users,
} from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { fetchCurveTokenStats, type CurveToken, type CurveTokenSort } from "@/lib/api";
import { useCurveTokens } from "@/hooks/use-curve-token";
import { useWallet } from "@/hooks/use-wallet";
import { cn, formatUsd } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DualLogoStack } from "@/components/launchpad/dual-logo-stack";

const spring = { type: "spring", stiffness: 100, damping: 20 } as const;

type Filter = "all" | "graduating" | "graduated" | "mine";

const FILTERS: Array<{ id: Filter; label: string }> = [
  { id: "all", label: "All" },
  { id: "graduating", label: "Graduating soon" },
  { id: "graduated", label: "Graduated" },
  { id: "mine", label: "My launches" },
];

const SORTS: Array<{ id: CurveTokenSort; label: string }> = [
  { id: "mcap", label: "Market cap" },
  { id: "new", label: "New" },
  { id: "volume", label: "Volume" },
];

/** Tokens at or past this progress count as "graduating soon". */
const GRADUATING_BPS = 5_000;

function timeAgo(iso: string): string {
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86_400)}d ago`;
}

function compactUsd(v: number): string {
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(v >= 10_000_000 ? 0 : 1)}M`;
  if (v >= 10_000) return `$${(v / 1_000).toFixed(0)}k`;
  return formatUsd(v);
}

export default function LaunchpadPage() {
  const wallet = useWallet();
  const [filter, setFilter] = useState<Filter>("all");
  const [sort, setSort] = useState<CurveTokenSort>("mcap");

  const tokens = useCurveTokens(sort);
  const stats = useQuery({ queryKey: ["curve-token-stats"], queryFn: fetchCurveTokenStats, refetchInterval: 30_000, retry: 1 });
  const all = useMemo(() => tokens.data?.tokens ?? [], [tokens.data]);

  const filtered = useMemo(() => {
    return all.filter((t) => {
      if (filter === "mine") {
        return !!wallet.address && t.creatorWallet.toLowerCase() === wallet.address.toLowerCase();
      }
      if (filter === "graduated") return t.graduated;
      if (filter === "graduating") return !t.graduated && t.progressBps >= GRADUATING_BPS;
      return true;
    });
  }, [all, filter, wallet.address]);

  // Indexer totals when available; fall back to summing the list.
  const totals = useMemo(
    () => ({
      count: stats.data?.tokens ?? all.length,
      marketCap: stats.data?.totalMarketCapUsd ?? all.reduce((sum, t) => sum + (t.marketCapUsd || 0), 0),
      volume24h: stats.data?.volume24hUsd ?? all.reduce((sum, t) => sum + (t.volume24hUsd ?? 0), 0),
      creators: new Set(all.map((t) => t.creatorWallet.toLowerCase())).size,
    }),
    [all, stats.data],
  );

  const emptyLabel =
    filter === "mine"
      ? "You haven't launched a token yet."
      : filter === "graduated"
        ? "No token has graduated yet."
        : filter === "graduating"
          ? "No token is close to graduating right now."
          : "No tokens have launched yet.";

  return (
    <div className="container-page min-h-[100dvh] py-8 md:py-10">
      <div className="grid gap-6 md:grid-cols-12 md:items-end">
        <div className="md:col-span-8">
          <p className="label-caps flex items-center gap-2">
            <Sparkle size={12} weight="fill" /> Launchpad
          </p>
          <h1 className="mt-3 text-3xl font-semibold tracking-tight md:text-4xl">Stock-backed tokens</h1>
          <p className="mt-3 max-w-xl text-muted-foreground">
            Every token here trades on a bonding curve backed by real tokenized stocks. Buy with ETH or USDG,
            sell any time, and watch it graduate.
          </p>
        </div>
        <div className="md:col-span-4 md:text-right">
          <Button asChild variant="outline" size="lg">
            <Link href="/launch">
              Launch a pair
              <Rocket size={16} weight="bold" />
            </Link>
          </Button>
          <p className="mt-2 text-[11px] text-muted-foreground md:text-right">
            Creators seed a stock pair, then launch its token.
          </p>
        </div>
      </div>

      {/* Stats strip */}
      <div className="mt-8 grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard label="Tokens" value={totals.count} icon={Rocket} />
        <StatCard label="Total market cap" value={compactUsd(totals.marketCap)} icon={TrendUp} />
        <StatCard label="24h volume" value={compactUsd(totals.volume24h)} icon={ChartLineUp} />
        <StatCard label="Creators" value={totals.creators} icon={Users} />
      </div>

      {/* Filters */}
      <div className="mt-8 flex flex-wrap items-center gap-3">
        <div className="flex flex-wrap gap-1 rounded-full border border-border bg-surface p-1">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => setFilter(f.id)}
              className={cn(
                "rounded-full px-3 py-1.5 text-xs font-medium transition-all active:scale-[0.98]",
                filter === f.id ? "bg-accent-subtle text-accent-strong" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {f.label}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap gap-1 rounded-full border border-border bg-surface p-1">
          {SORTS.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => setSort(s.id)}
              className={cn(
                "rounded-full px-3 py-1.5 text-xs font-medium transition-all active:scale-[0.98]",
                sort === s.id ? "bg-accent-subtle text-accent-strong" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>

      {/* Token list */}
      <div className="mt-8">
        {tokens.isLoading ? (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="h-56 animate-pulse rounded-3xl border border-border bg-surface-muted/40" />
            ))}
          </div>
        ) : tokens.isError ? (
          <div className="rounded-3xl border border-dashed border-border bg-surface p-12 text-center">
            <p className="font-mono text-sm text-muted-foreground">Tokens are unavailable while the indexer is offline.</p>
          </div>
        ) : filtered.length === 0 ? (
          <div className="rounded-3xl border border-dashed border-border bg-surface p-12 text-center">
            <p className="font-mono text-sm text-muted-foreground">{emptyLabel}</p>
            {filter !== "graduated" && filter !== "graduating" && (
              <Button asChild className="mt-4">
                <Link href="/launch">
                  Launch the first one
                  <ArrowRight size={14} weight="bold" />
                </Link>
              </Button>
            )}
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {filtered.map((token, i) => (
              <TokenCard key={token.tokenAddress} token={token} delay={i * 0.03} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function StatCard({
  label,
  value,
  icon: Icon,
}: {
  label: string;
  value: string | number;
  icon: React.ComponentType<{ size?: number; weight?: "regular" | "fill" | "bold" }>;
}) {
  return (
    <div className="rounded-2xl border border-border bg-surface p-4">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Icon size={14} weight="fill" />
        <span>{label}</span>
      </div>
      <p className="mt-2 font-mono text-2xl font-semibold tabular-nums">
        {typeof value === "number" ? value.toLocaleString() : value}
      </p>
    </div>
  );
}

function TokenCard({ token, delay }: { token: CurveToken; delay: number }) {
  const tickerA = token.tickerA ?? "A";
  const tickerB = token.tickerB ?? "B";
  const progress = token.graduated ? 100 : Math.min(100, token.progressBps / 100);

  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ ...spring, delay }}>
      <Link
        href={`/token/${token.tokenAddress}`}
        className="group block h-full overflow-hidden rounded-3xl border border-border bg-surface transition-all hover:border-accent hover:shadow-card active:scale-[0.99]"
      >
        {token.imageUrl ? (
          <div className="relative h-24 w-full overflow-hidden">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={token.imageUrl}
              alt=""
              className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.02]"
            />
          </div>
        ) : (
          <div className="h-3 w-full bg-gradient-to-r from-accent/60 to-accent/10" />
        )}

        <div className="p-5">
          <div className="flex items-start justify-between gap-3">
            <div className="flex min-w-0 items-center gap-3">
              {token.logoUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={token.logoUrl}
                  alt=""
                  className="h-11 w-11 shrink-0 rounded-xl border border-border bg-surface object-cover"
                />
              ) : (
                <DualLogoStack tickerA={tickerA} tickerB={tickerB} size="md" />
              )}
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold">{token.name}</p>
                <p className="font-mono text-[11px] text-muted-foreground">
                  ${token.symbol} · backed by {tickerA} + {tickerB}
                </p>
              </div>
            </div>
            <div className="flex shrink-0 flex-col items-end gap-1">
              {token.graduated ? (
                <Badge variant="success">
                  <GraduationCap size={11} weight="fill" />
                  Graduated
                </Badge>
              ) : (
                <Badge variant="accent">{progress.toFixed(0)}%</Badge>
              )}
              {token.venue === "pons" && (
                <Badge variant="outline" title={token.quoteSymbol ? `Quoted in ${token.quoteSymbol} on Pons` : "Live on Pons"}>
                  Pons{token.quoteSymbol ? ` · ${token.quoteSymbol}` : ""}
                </Badge>
              )}
            </div>
          </div>

          <div className="mt-4 flex items-baseline justify-between">
            <div>
              <p className="text-[11px] text-muted-foreground">Market cap</p>
              <p className="font-mono text-xl font-semibold tabular-nums">{formatUsd(token.marketCapUsd)}</p>
            </div>
            <div className="text-right">
              <p className="text-[11px] text-muted-foreground">24h volume</p>
              <p className="font-mono text-sm tabular-nums">
                {token.volume24hUsd != null ? formatUsd(token.volume24hUsd) : "—"}
              </p>
            </div>
          </div>

          <div className="mt-3">
            <div className="flex items-center justify-between text-[11px] text-muted-foreground">
              <span>Bonding curve</span>
              <span className="font-mono tabular-nums">
                {token.graduated ? "graduated" : `${formatUsd(token.marketCapUsd)} / ${compactUsd(token.graduationMarketCapUsd)}`}
              </span>
            </div>
            <div className="mt-1.5 h-2 w-full overflow-hidden rounded-full bg-surface-muted">
              <div
                className={cn("h-full rounded-full transition-all duration-700", token.graduated ? "bg-success" : "bg-accent")}
                style={{ width: `${progress}%` }}
              />
            </div>
          </div>

          <dl className="mt-4 grid grid-cols-3 gap-2 font-mono text-[11px]">
            <div>
              <dt className="text-muted-foreground">Holders</dt>
              <dd className="mt-0.5 text-sm font-semibold tabular-nums">
                {token.holders != null ? token.holders.toLocaleString() : "—"}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Trades</dt>
              <dd className="mt-0.5 text-sm font-semibold tabular-nums">{token.tradesCount.toLocaleString()}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Launched</dt>
              <dd className="mt-0.5 text-sm font-semibold tabular-nums">{timeAgo(token.createdAt)}</dd>
            </div>
          </dl>

          <div className="mt-4 flex items-center justify-between text-[11px] text-muted-foreground">
            <span className="font-mono">
              by {token.creatorWallet.slice(0, 6)}…{token.creatorWallet.slice(-4)}
            </span>
            <span className="inline-flex items-center gap-1 text-accent-strong opacity-0 transition-opacity group-hover:opacity-100">
              Trade
              <ArrowRight size={12} weight="bold" />
            </span>
          </div>
        </div>
      </Link>
    </motion.div>
  );
}
