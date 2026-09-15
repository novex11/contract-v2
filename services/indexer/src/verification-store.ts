import { eq, inArray } from "drizzle-orm";
import type { Db } from "./db.js";
import { contractVerifications } from "./schema.js";
import type { ContractKind, VerificationRecord, VerifyOutcome } from "./contract-verifier.js";

/*
 * Persisted outcome of source verification for launched contracts, so the API
 * can show "source verified" and restarts only retry what is still missing.
 */

export interface VerificationStatus {
  address: string;
  chainId: number;
  kind: ContractKind;
  sourcify: VerifyOutcome;
  blockscout: VerifyOutcome;
  error: string | null;
  updatedAt: string;
}

const VERIFIED: ReadonlySet<VerifyOutcome> = new Set(["verified", "already-verified"]);

export function isVerified(outcome: VerifyOutcome | null | undefined): boolean {
  return outcome != null && VERIFIED.has(outcome);
}

/** Public JSON shape: booleans per backend plus links to the published source. */
export function toVerificationJson(row: VerificationStatus | null, chainId: number, address: string) {
  const sourcifyOk = isVerified(row?.sourcify);
  const blockscoutOk = isVerified(row?.blockscout);
  return {
    address: address.toLowerCase(),
    kind: row?.kind ?? null,
    /** True when the source is published on at least one backend. */
    verified: sourcifyOk || blockscoutOk,
    sourcify: sourcifyOk,
    blockscout: blockscoutOk,
    sourcifyUrl: sourcifyOk ? `https://repo.sourcify.dev/${chainId}/${address.toLowerCase()}` : null,
    updatedAt: row?.updatedAt ?? null,
  };
}

export async function upsertVerification(db: Db, chainId: number, record: VerificationRecord): Promise<void> {
  const row = {
    address: record.address.toLowerCase(),
    chainId: String(chainId),
    kind: record.kind,
    sourcify: record.sourcify,
    blockscout: record.blockscout,
    error: record.error ?? null,
    updatedAt: new Date(),
  };
  await db
    .insert(contractVerifications)
    .values(row)
    .onConflictDoUpdate({ target: contractVerifications.address, set: row });
}

function fromRow(r: typeof contractVerifications.$inferSelect): VerificationStatus {
  return {
    address: r.address,
    chainId: Number(r.chainId),
    kind: r.kind as ContractKind,
    sourcify: r.sourcify as VerifyOutcome,
    blockscout: r.blockscout as VerifyOutcome,
    error: r.error,
    updatedAt: r.updatedAt.toISOString(),
  };
}

export async function getVerification(db: Db, address: string): Promise<VerificationStatus | null> {
  const rows = await db
    .select()
    .from(contractVerifications)
    .where(eq(contractVerifications.address, address.toLowerCase()))
    .limit(1);
  return rows[0] ? fromRow(rows[0]) : null;
}

export async function getVerifications(db: Db, addresses: string[]): Promise<Map<string, VerificationStatus>> {
  const out = new Map<string, VerificationStatus>();
  const keys = Array.from(new Set(addresses.map((a) => a.toLowerCase())));
  if (keys.length === 0) return out;
  const rows = await db.select().from(contractVerifications).where(inArray(contractVerifications.address, keys));
  for (const r of rows) out.set(r.address, fromRow(r));
  return out;
}

/** True when both backends already have the source, so a restart need not retry. */
export async function isFullyVerified(db: Db, address: string): Promise<boolean> {
  const row = await getVerification(db, address);
  return row != null && isVerified(row.sourcify) && isVerified(row.blockscout);
}
