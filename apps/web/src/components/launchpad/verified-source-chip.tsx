"use client";

import { ArrowSquareOut, CircleNotch, SealCheck } from "@phosphor-icons/react";
import type { ContractVerification } from "@/lib/api";
import { cn, explorerUrl } from "@/lib/utils";

/**
 * "Source verified" pill for a launched contract. The indexer publishes every
 * launched contract's source to Sourcify and the explorer right after launch,
 * so the pill reads "pending" until that job has finished.
 */
export function VerifiedSourceChip({
  verification,
  address,
  label = "Source",
  className,
}: {
  verification?: ContractVerification | null;
  /** Contract address, used for the explorer link when only Blockscout has the source. */
  address?: string;
  label?: string;
  className?: string;
}) {
  if (!verification) return null;
  const base =
    "inline-flex items-center gap-1 rounded-full px-2 py-1 font-mono text-[11px] transition-colors";
  if (!verification.verified) {
    return (
      <span className={cn(base, "bg-surface-muted text-muted-foreground", className)} title="Publishing the contract source">
        <CircleNotch size={12} weight="bold" className="animate-spin" />
        {label} verification pending
      </span>
    );
  }
  const href =
    verification.sourcifyUrl ??
    (address ? `${explorerUrl("address", address)}?tab=contract` : null);
  const body = (
    <>
      <SealCheck size={12} weight="fill" />
      {label} verified
      {href && <ArrowSquareOut size={12} weight="bold" />}
    </>
  );
  const cls = cn(base, "bg-accent-subtle text-accent-strong hover:bg-accent-subtle/80", className);
  return href ? (
    <a href={href} target="_blank" rel="noopener noreferrer" className={cls} title="Open the published source">
      {body}
    </a>
  ) : (
    <span className={cls}>{body}</span>
  );
}
