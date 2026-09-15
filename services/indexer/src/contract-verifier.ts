import { readFileSync } from "node:fs";
import { join } from "node:path";
import { encodeAbiParameters, parseAbi, type Address, type Hex, type PublicClient } from "viem";

/*
 * Source verification for every contract our factories deploy at launch time:
 *
 *   PairFactory  → PairVault + PairShareToken (through PairDeployer)
 *   ComposeCurve → CreatorToken
 *
 * Each contract is published to two places:
 *
 *   - Sourcify (https://sourcify.dev): accepts submissions from any client for
 *     Robinhood Chain mainnet (4663) and testnet (46630), no rate limit. This
 *     is the backend that must succeed.
 *   - Blockscout (Etherscan-compatible API): best effort. The mainnet explorer
 *     sits behind a Cloudflare challenge that rejects non-browser clients, so
 *     submissions from a server fail fast there until the explorer allow-lists
 *     the indexer; the testnet explorer accepts them.
 *
 * Only viem + fetch are used so the indexer and CLI scripts share this file.
 */

export type ContractKind = "PairVault" | "PairShareToken" | "CreatorToken";

export interface VerifierOptions {
  /** Chain the contracts live on (4663 mainnet, 46630 testnet). */
  chainId: number;
  /** Blockscout API base, e.g. https://explorer.testnet.chain.robinhood.com/api */
  explorerApiUrl: string;
  /** Sourcify server base (default: the public instance). */
  sourcifyUrl?: string;
  /** Directory with compiler.json and <Contract>.input.json (standard JSON inputs). */
  inputsDir: string;
  log?: (message: string) => void;
  /** Called with the outcome of every contract so it can be persisted. */
  onResult?: (record: VerificationRecord) => void | Promise<void>;
}

export type VerifyOutcome = "verified" | "already-verified" | "failed" | "skipped";

export interface VerificationRecord {
  address: Address;
  kind: ContractKind;
  sourcify: VerifyOutcome;
  blockscout: VerifyOutcome;
  /** Last error message from either backend, if any. */
  error?: string;
}

export interface VerifyRequest {
  address: Address;
  kind: ContractKind;
  /** Fully qualified name, e.g. src/PairVault.sol:PairVault */
  contractName: string;
  /** Standard JSON compiler input (string). */
  input: string;
  /** ABI-encoded constructor arguments. */
  constructorArgs: Hex;
  /** Hash of the transaction that created the contract (helps Sourcify match creation bytecode). */
  creationTxHash?: Hex;
}

export const DEFAULT_SOURCIFY_URL = "https://sourcify.dev/server";

/** Public source page for a verified contract on Sourcify. */
export function sourcifyRepoUrl(chainId: number, address: string): string {
  return `https://repo.sourcify.dev/${chainId}/${address}`;
}

const vaultAbi = parseAbi([
  "function creator() view returns (address)",
  "function tokenA() view returns (address)",
  "function tokenB() view returns (address)",
  "function weightABps() view returns (uint16)",
  "function creatorFeeBps() view returns (uint16)",
  "function receiptToken() view returns (address)",
  "function oracle() view returns (address)",
  "function emergency() view returns (address)",
  "function weth() view returns (address)",
]);
const erc20Abi = parseAbi([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function owner() view returns (address)",
  "function totalSupply() view returns (uint256)",
]);

const POLL_MS = 5_000;
const MAX_POLLS = 48;
const ATTEMPTS = 3;
const SOURCIFY_POLL_MS = 3_000;
const SOURCIFY_MAX_POLLS = 40;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const CONTRACT_FILES: Record<ContractKind, { file: string; name: string }> = {
  PairVault: { file: "PairVault.input.json", name: "src/PairVault.sol:PairVault" },
  PairShareToken: { file: "PairShareToken.input.json", name: "src/PairShareToken.sol:PairShareToken" },
  CreatorToken: { file: "CreatorToken.input.json", name: "src/CreatorToken.sol:CreatorToken" },
};

interface Inputs {
  compilerVersion: string;
  inputs: Record<ContractKind, string>;
}

const inputsCache = new Map<string, Inputs | null>();

function loadInputs(dir: string): Inputs | null {
  if (inputsCache.has(dir)) return inputsCache.get(dir)!;
  let loaded: Inputs | null = null;
  try {
    const { compilerVersion } = JSON.parse(readFileSync(join(dir, "compiler.json"), "utf8")) as {
      compilerVersion: string;
    };
    const inputs = {} as Record<ContractKind, string>;
    for (const kind of Object.keys(CONTRACT_FILES) as ContractKind[]) {
      inputs[kind] = readFileSync(join(dir, CONTRACT_FILES[kind].file), "utf8");
    }
    loaded = { compilerVersion, inputs };
  } catch {
    loaded = null;
  }
  inputsCache.set(dir, loaded);
  return loaded;
}

// ─── Sourcify ───────────────────────────────────────────

class SourcifyRejected extends Error {}

/** "exact_match" / "match" when Sourcify has the contract, null otherwise. */
export async function sourcifyMatch(base: string, chainId: number, address: Address): Promise<string | null> {
  try {
    const res = await fetch(`${base}/v2/contract/${chainId}/${address}`, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) return null;
    const json = (await res.json()) as { match?: string | null };
    return json.match ?? null;
  } catch {
    return null;
  }
}

async function sourcifySubmit(base: string, chainId: number, req: VerifyRequest, compilerVersion: string): Promise<string> {
  const body = {
    stdJsonInput: JSON.parse(req.input) as unknown,
    compilerVersion: compilerVersion.replace(/^v/, ""),
    contractIdentifier: req.contractName,
    ...(req.creationTxHash ? { creationTransactionHash: req.creationTxHash } : {}),
  };
  const res = await fetch(`${base}/v2/verify/${chainId}/${req.address}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  const json = (await res.json().catch(() => ({}))) as {
    verificationId?: string;
    customCode?: string;
    message?: string;
  };
  if (res.status === 409 || json.customCode === "already_verified") throw new SourcifyRejected("already_verified");
  if (!res.ok || !json.verificationId) {
    throw new Error(`sourcify submit ${res.status}: ${json.customCode ?? ""} ${json.message ?? ""}`.trim());
  }
  return json.verificationId;
}

async function sourcifyWait(base: string, id: string): Promise<string> {
  for (let i = 0; i < SOURCIFY_MAX_POLLS; i++) {
    await sleep(SOURCIFY_POLL_MS);
    try {
      const res = await fetch(`${base}/v2/verify/${id}`, { signal: AbortSignal.timeout(20_000) });
      const json = (await res.json().catch(() => ({}))) as {
        isJobCompleted?: boolean;
        contract?: { match?: string | null };
        error?: { customCode?: string; message?: string };
      };
      if (!json.isJobCompleted) continue;
      if (json.error) return `error: ${json.error.customCode ?? ""} ${json.error.message ?? ""}`.trim();
      return json.contract?.match ?? "no match";
    } catch {
      continue;
    }
  }
  return "timed out waiting for sourcify";
}

/** Verify one contract on Sourcify; idempotent. */
export async function verifyOnSourcify(
  opts: VerifierOptions,
  req: VerifyRequest,
  compilerVersion: string,
): Promise<{ outcome: VerifyOutcome; error?: string }> {
  const base = (opts.sourcifyUrl ?? DEFAULT_SOURCIFY_URL).replace(/\/$/, "");
  if (await sourcifyMatch(base, opts.chainId, req.address)) return { outcome: "already-verified" };
  let lastError = "";
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      const id = await sourcifySubmit(base, opts.chainId, req, compilerVersion);
      const result = await sourcifyWait(base, id);
      if (/match/.test(result) && !/^error|no match/.test(result)) return { outcome: "verified" };
      lastError = result;
    } catch (e) {
      if (e instanceof SourcifyRejected) return { outcome: "already-verified" };
      lastError = e instanceof Error ? e.message : String(e);
    }
    opts.log?.(`${req.contractName} ${req.address}: sourcify attempt ${attempt} → ${lastError}`);
    // A brand-new contract may not be visible to Sourcify's RPC yet.
    await sleep(attempt * 10_000);
    if (await sourcifyMatch(base, opts.chainId, req.address)) return { outcome: "verified" };
  }
  return { outcome: "failed", error: `sourcify: ${lastError}` };
}

// ─── Blockscout ─────────────────────────────────────────

/** The explorer answered with something other than its JSON API (Cloudflare challenge, HTML error page). */
class ExplorerBlocked extends Error {}

async function isVerifiedOnExplorer(apiUrl: string, address: Address): Promise<boolean> {
  try {
    const res = await fetch(`${apiUrl}/v2/addresses/${address}`, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) return false;
    const json = (await res.json()) as { is_verified?: boolean };
    return json.is_verified === true;
  } catch {
    return false;
  }
}

async function explorerSubmit(apiUrl: string, fields: Record<string, string>): Promise<string> {
  const body = new URLSearchParams({
    module: "contract",
    action: "verifysourcecode",
    codeformat: "solidity-standard-json-input",
    ...fields,
  });
  const res = await fetch(apiUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  let json: { status?: string; result?: unknown; message?: string };
  try {
    json = JSON.parse(text) as typeof json;
  } catch {
    throw new ExplorerBlocked(`explorer returned ${res.status} with a non-JSON body (blocked for non-browser clients?)`);
  }
  if (json.status !== "1" || typeof json.result !== "string") {
    throw new Error(`submit rejected: ${String(json.result ?? json.message ?? res.status)}`);
  }
  return json.result;
}

async function explorerWait(apiUrl: string, guid: string, address: Address): Promise<string> {
  for (let i = 0; i < MAX_POLLS; i++) {
    await sleep(POLL_MS);
    // Blockscout often answers "Unknown UID" while a job is still processing,
    // so the address's verified flag is the source of truth.
    if (await isVerifiedOnExplorer(apiUrl, address)) return "Pass - Verified";
    try {
      const res = await fetch(
        `${apiUrl}?module=contract&action=checkverifystatus&guid=${encodeURIComponent(guid)}`,
        { signal: AbortSignal.timeout(20_000) },
      );
      const json = (await res.json().catch(() => ({}))) as { result?: unknown };
      const result = String(json.result ?? "");
      if (/pending|queue|in progress|unknown uid/i.test(result)) continue;
      return result;
    } catch {
      continue;
    }
  }
  return "timed out waiting for explorer";
}

/** Verify one contract on Blockscout; idempotent, gives up at once when the explorer blocks the client. */
export async function verifyOnBlockscout(
  opts: VerifierOptions,
  req: VerifyRequest,
  compilerVersion: string,
): Promise<{ outcome: VerifyOutcome; error?: string }> {
  if (!opts.explorerApiUrl) return { outcome: "skipped" };
  if (await isVerifiedOnExplorer(opts.explorerApiUrl, req.address)) return { outcome: "already-verified" };

  const args = req.constructorArgs.replace(/^0x/, "");
  let lastError = "";
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      const guid = await explorerSubmit(opts.explorerApiUrl, {
        contractaddress: req.address,
        contractname: req.contractName,
        compilerversion: compilerVersion,
        sourceCode: req.input,
        constructorArguements: args,
        constructorArguments: args,
      });
      const result = await explorerWait(opts.explorerApiUrl, guid, req.address);
      if (/pass|already verified/i.test(result)) return { outcome: "verified" };
      lastError = result;
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      if (e instanceof ExplorerBlocked) {
        opts.log?.(`${req.contractName} ${req.address}: blockscout → ${lastError}`);
        return { outcome: "failed", error: `blockscout: ${lastError}` };
      }
    }
    opts.log?.(`${req.contractName} ${req.address}: blockscout attempt ${attempt} → ${lastError}`);
    // A fresh contract may not be indexed by the explorer yet; a queued job may finish late.
    await sleep(attempt * 20_000);
    if (await isVerifiedOnExplorer(opts.explorerApiUrl, req.address)) return { outcome: "verified" };
  }
  return { outcome: "failed", error: `blockscout: ${lastError}` };
}

// ─── One contract, both backends ────────────────────────

/** Publish one contract's source to Sourcify and Blockscout and report the outcome. */
export async function verifyContract(opts: VerifierOptions, req: VerifyRequest, compilerVersion: string): Promise<VerificationRecord> {
  const sourcify = await verifyOnSourcify(opts, req, compilerVersion);
  const blockscout = await verifyOnBlockscout(opts, req, compilerVersion);
  const record: VerificationRecord = {
    address: req.address,
    kind: req.kind,
    sourcify: sourcify.outcome,
    blockscout: blockscout.outcome,
    ...(sourcify.error || blockscout.error
      ? { error: [sourcify.error, blockscout.error].filter(Boolean).join("; ") }
      : {}),
  };
  await opts.onResult?.(record);
  return record;
}

function skipped(address: Address, kind: ContractKind, reason: string): VerificationRecord {
  return { address, kind, sourcify: "skipped", blockscout: "skipped", error: reason };
}

// ─── Launchpad pair: PairVault + PairShareToken ─────────

/** Verify a launched pair's PairVault and PairShareToken using constructor values read from chain. */
export async function verifyPairContracts(
  client: PublicClient,
  opts: VerifierOptions,
  pair: Address,
  extra: { creationTxHash?: Hex } = {},
): Promise<{ vault: VerificationRecord; receipt: VerificationRecord }> {
  const inputs = loadInputs(opts.inputsDir);
  const read = <T>(functionName: (typeof vaultAbi)[number]["name"]) =>
    client.readContract({ address: pair, abi: vaultAbi, functionName }) as Promise<T>;
  const [creator, tokenA, tokenB, weightABps, creatorFeeBps, receiptToken, oracle, emergency, weth] =
    await Promise.all([
      read<Address>("creator"),
      read<Address>("tokenA"),
      read<Address>("tokenB"),
      read<number>("weightABps"),
      read<number>("creatorFeeBps"),
      read<Address>("receiptToken"),
      read<Address>("oracle"),
      read<Address>("emergency"),
      read<Address>("weth"),
    ]);
  if (!inputs) {
    const reason = `verification inputs missing in ${opts.inputsDir} (run scripts/export-verification-inputs.sh)`;
    opts.log?.(reason);
    return { vault: skipped(pair, "PairVault", reason), receipt: skipped(receiptToken, "PairShareToken", reason) };
  }

  const vaultArgs = encodeAbiParameters(
    [
      {
        type: "tuple",
        components: [
          { name: "creator", type: "address" },
          { name: "tokenA", type: "address" },
          { name: "tokenB", type: "address" },
          { name: "weightABps", type: "uint16" },
          { name: "creatorFeeBps", type: "uint16" },
          { name: "receiptToken", type: "address" },
          { name: "oracle", type: "address" },
          { name: "emergency", type: "address" },
          { name: "weth", type: "address" },
        ],
      },
    ],
    [{ creator, tokenA, tokenB, weightABps, creatorFeeBps, receiptToken, oracle, emergency, weth }],
  );

  // PairShareToken(name, symbol, owner): the owner is the PairFactory that ran the deployer.
  const [name, symbol, owner] = await Promise.all([
    client.readContract({ address: receiptToken, abi: erc20Abi, functionName: "name" }),
    client.readContract({ address: receiptToken, abi: erc20Abi, functionName: "symbol" }),
    client.readContract({ address: receiptToken, abi: erc20Abi, functionName: "owner" }),
  ]);
  const receiptArgs = encodeAbiParameters(
    [{ type: "string" }, { type: "string" }, { type: "address" }],
    [name, symbol, owner],
  );

  const vault = await verifyContract(
    opts,
    {
      address: pair,
      kind: "PairVault",
      contractName: CONTRACT_FILES.PairVault.name,
      input: inputs.inputs.PairVault,
      constructorArgs: vaultArgs,
      creationTxHash: extra.creationTxHash,
    },
    inputs.compilerVersion,
  );
  const receipt = await verifyContract(
    opts,
    {
      address: receiptToken,
      kind: "PairShareToken",
      contractName: CONTRACT_FILES.PairShareToken.name,
      input: inputs.inputs.PairShareToken,
      constructorArgs: receiptArgs,
      creationTxHash: extra.creationTxHash,
    },
    inputs.compilerVersion,
  );
  return { vault, receipt };
}

// ─── Bonding-curve token: CreatorToken ──────────────────

/**
 * Verify a CreatorToken launched by ComposeCurve. The curve mints the whole
 * fixed supply to itself, so the constructor is (name, symbol, totalSupply, curve).
 */
export async function verifyCreatorToken(
  client: PublicClient,
  opts: VerifierOptions,
  token: Address,
  curve: Address,
  extra: { creationTxHash?: Hex } = {},
): Promise<VerificationRecord> {
  const inputs = loadInputs(opts.inputsDir);
  if (!inputs) {
    const reason = `verification inputs missing in ${opts.inputsDir} (run scripts/export-verification-inputs.sh)`;
    opts.log?.(reason);
    return skipped(token, "CreatorToken", reason);
  }
  const [name, symbol, supply] = await Promise.all([
    client.readContract({ address: token, abi: erc20Abi, functionName: "name" }),
    client.readContract({ address: token, abi: erc20Abi, functionName: "symbol" }),
    client.readContract({ address: token, abi: erc20Abi, functionName: "totalSupply" }),
  ]);
  const args = encodeAbiParameters(
    [{ type: "string" }, { type: "string" }, { type: "uint256" }, { type: "address" }],
    [name, symbol, supply, curve],
  );
  return verifyContract(
    opts,
    {
      address: token,
      kind: "CreatorToken",
      contractName: CONTRACT_FILES.CreatorToken.name,
      input: inputs.inputs.CreatorToken,
      constructorArgs: args,
      creationTxHash: extra.creationTxHash,
    },
    inputs.compilerVersion,
  );
}

/** Runs verification jobs one at a time and never twice for the same key in a process. */
export function createVerificationQueue<T extends string>(run: (key: T, ...rest: unknown[]) => Promise<void>) {
  const seen = new Set<string>();
  let tail: Promise<void> = Promise.resolve();
  return (key: T, ...rest: unknown[]) => {
    const k = key.toLowerCase();
    if (seen.has(k)) return;
    seen.add(k);
    tail = tail.then(() => run(key, ...rest)).catch(() => undefined);
  };
}
