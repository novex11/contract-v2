"use client";

import { formatUnits } from "viem";
import { ArrowSquareOut, CheckCircle, CircleNotch, Coins, WarningCircle } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { cn, explorerUrl, formatUsd } from "@/lib/utils";
import { usePonsCreatorFeeActions, usePonsCreatorFees, type PonsOnchainState } from "@/hooks/use-pons-token";

export interface PonsCreatorFeesProps {
  pons: PonsOnchainState;
  symbol: string;
  ponsUrl: string;
  className?: string;
}

function fmt(amount: bigint, decimals: number): string {
  return Number(formatUnits(amount, decimals)).toLocaleString(undefined, { maximumFractionDigits: 6 });
}

/**
 * Creator fees on a Pons-launched token. Pons never pays them out by itself:
 * the creator tax and the creator's share of the 1% curve fee accrue on the
 * token's curve until the creator sweeps them into Pons's fee escrow, and sit
 * there until the creator claims them. Both transactions must come from the
 * creator wallet (Pons's creator fee recipient), so they are exposed here.
 */
export function PonsCreatorFees({ pons, symbol, ponsUrl, className }: PonsCreatorFeesProps) {
  const fees = usePonsCreatorFees({ curve: pons.curve, quoteToken: pons.quoteToken, creator: pons.creator });
  const actions = usePonsCreatorFeeActions();
  const busy = actions.stage === "submit";
  const data = fees.data;
  const dec = pons.quoteDecimals;
  const quoteSym = pons.quoteSymbol || "quote";

  // USD per quote unit, read off the two router prices (USD and quote per token).
  const quoteUsd =
    pons.priceInQuote > 0n
      ? Number(pons.priceUsd8) / 1e8 / Number(formatUnits(pons.priceInQuote, dec))
      : undefined;
  const usd = (amount: bigint) => (quoteUsd != null ? Number(formatUnits(amount, dec)) * quoteUsd : undefined);

  const sweepable = data?.sweepable ?? 0n;
  const claimable = data?.claimable ?? 0n;
  const totalUsd = usd(sweepable + claimable);
  const creatorFeeSharePct = data ? (100 - data.protocolShareBps / 100).toFixed(0) : "70";

  async function sweep() {
    actions.reset();
    try {
      await actions.sweep(pons.curve);
      await fees.refetch();
    } catch {
      /* shown below */
    }
  }

  async function claim() {
    actions.reset();
    try {
      if (!data) return;
      await actions.claim(data.escrow, pons.quoteToken);
      await fees.refetch();
    } catch {
      /* shown below */
    }
  }

  return (
    <section className={cn("rounded-[1.75rem] border border-accent/60 bg-accent-subtle/50 p-5 shadow-float", className)}>
      <div className="flex items-center gap-2 text-sm font-semibold text-accent-strong">
        <Coins size={16} weight="fill" />
        Creator trading fees
      </div>
      <p className="mt-3 text-xs text-muted-foreground">Earned from ${symbol} trades on Pons, paid in {quoteSym}</p>
      <p className="mt-1 font-mono text-3xl font-semibold tabular-nums">{totalUsd != null ? formatUsd(totalUsd) : "—"}</p>
      <p className="mt-0.5 font-mono text-xs text-muted-foreground">
        {fmt(sweepable + claimable, dec)} {quoteSym} · {creatorFeeSharePct}% of the 1% curve fee
        {data && data.creatorTax > 0n ? " + creator tax" : ""}
      </p>

      <dl className="mt-4 grid grid-cols-2 gap-3 text-xs">
        <div className="rounded-2xl border border-border bg-surface p-3">
          <dt className="text-muted-foreground">On the curve</dt>
          <dd className="mt-1 font-mono tabular-nums">
            {fmt(sweepable, dec)} {quoteSym}
          </dd>
          <dd className="text-muted-foreground">{usd(sweepable) != null ? formatUsd(usd(sweepable)!) : ""}</dd>
        </div>
        <div className="rounded-2xl border border-border bg-surface p-3">
          <dt className="text-muted-foreground">In Pons escrow</dt>
          <dd className="mt-1 font-mono tabular-nums">
            {fmt(claimable, dec)} {quoteSym}
          </dd>
          <dd className="text-muted-foreground">{usd(claimable) != null ? formatUsd(usd(claimable)!) : ""}</dd>
        </div>
      </dl>

      <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
        Fees wait on the curve until you sweep them into Pons&apos;s escrow, then wait there until you claim. Only your
        wallet can do either, and neither happens on its own.
      </p>

      {actions.error && (
        <p className="mt-3 flex items-start gap-1.5 text-xs text-destructive">
          <WarningCircle size={14} weight="fill" className="mt-0.5 shrink-0" />
          {actions.error}
        </p>
      )}
      {actions.stage === "done" && actions.hash && (
        <p className="mt-3 flex items-start gap-1.5 text-xs text-success">
          <CheckCircle size={14} weight="fill" className="mt-0.5 shrink-0" />
          <span>
            Done.{" "}
            <a href={explorerUrl("tx", actions.hash)} target="_blank" rel="noopener noreferrer" className="underline">
              View transaction ↗
            </a>
          </span>
        </p>
      )}

      <div className="mt-4 grid grid-cols-2 gap-2">
        <Button size="lg" variant="outline" disabled={sweepable === 0n || busy} onClick={sweep}>
          {busy ? <CircleNotch size={16} className="animate-spin" /> : null}
          Sweep to escrow
        </Button>
        <Button size="lg" disabled={claimable === 0n || busy} onClick={claim}>
          {busy ? <CircleNotch size={16} className="animate-spin" /> : null}
          {claimable > 0n && usd(claimable) != null ? `Claim ${formatUsd(usd(claimable)!)}` : "Claim"}
        </Button>
      </div>

      <a
        href={ponsUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="mt-3 inline-flex items-center gap-1 text-xs text-accent-strong underline-offset-2 hover:underline"
      >
        Token on Pons
        <ArrowSquareOut size={12} />
      </a>
    </section>
  );
}
