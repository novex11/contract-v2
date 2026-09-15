import { readFileSync } from "node:fs";
import { join } from "node:path";
import { encodeAbiParameters, parseAbi, type Address, type PublicClient } from "viem";

/*
 * Source verification on Blockscout (Etherscan-compatible API) for the
 * contracts the launchpad deploys at launch time: PairVault + PairShareToken
 * (PairDeployer, on pair creation) and CreatorToken (ComposeCurve, on token
 * launch). Uses only viem + node so the indexer and CLI scripts can share it.
 *
 * Blockscout limits the verification endpoint to one submission per window
 * per IP and answers 429 with an `x-ratelimit-reset` header (ms); jobs run
 * one at a time and wait that window out before retrying.
 */

export interface VerifierOptions {
  /** e.g. https://explorer.testnet.chain.robinhood.com/api */
  explorerApiUrl: string;
  /** Directory with compiler.json, PairVault.input.json, PairShareToken.input.json, CreatorToken.input.json */
  inputsDir: string;
  log?: (message: string) => void;
}

export type VerifyOutcome = "verified" | "already-verified" | "failed" | "skipped";

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
const shareAbi = parseAbi([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function owner() view returns (address)",
]);
const creatorTokenAbi = parseAbi([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function totalSupply() view returns (uint256)",
]);

const POLL_MS = 5_000;
const MAX_POLLS = 48;
const ATTEMPTS = 3;
/** Longest we wait for a rate-limit window (Blockscout uses ~30 min). */
const MAX_RATE_LIMIT_WAIT_MS = 40 * 60_000;
/** Rate-limit waits do not count as attempts, but are bounded. */
const MAX_RATE_LIMIT_WAITS = 4;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Inputs {
  compilerVersion: string;
  pairVault: string;
  pairShareToken: string;
  creatorToken: string;
}

const inputsCache = new Map<string, Inputs | null>();

function loadInputs(dir: string): Inputs | null {
  if (inputsCache.has(dir)) return inputsCache.get(dir)!;
  let inputs: Inputs | null = null;
  try {
    const { compilerVersion } = JSON.parse(readFileSync(join(dir, "compiler.json"), "utf8")) as {
      compilerVersion: string;
    };
    inputs = {
      compilerVersion,
      pairVault: readFileSync(join(dir, "PairVault.input.json"), "utf8"),
      pairShareToken: readFileSync(join(dir, "PairShareToken.input.json"), "utf8"),
      creatorToken: readFileSync(join(dir, "CreatorToken.input.json"), "utf8"),
    };
  } catch {
    inputs = null;
  }
  inputsCache.set(dir, inputs);
  return inputs;
}

async function isVerified(apiUrl: string, address: Address): Promise<boolean> {
  try {
    const res = await fetch(`${apiUrl}/v2/addresses/${address}`, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) return false;
    const json = (await res.json()) as { is_verified?: boolean };
    return json.is_verified === true;
  } catch {
    return false;
  }
}

class RateLimited extends Error {
  constructor(readonly resetMs: number) {
    super(`rate limited by explorer; window resets in ${Math.round(resetMs / 1000)}s`);
  }
}

async function submit(apiUrl: string, fields: Record<string, string>): Promise<string> {
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
  if (res.status === 429) {
    const reset = Number(res.headers.get("x-ratelimit-reset") ?? res.headers.get("retry-after") ?? "");
    // Blockscout reports milliseconds; a plain Retry-After is seconds.
    const resetMs = res.headers.has("x-ratelimit-reset") ? reset : reset * 1000;
    throw new RateLimited(Number.isFinite(resetMs) && resetMs > 0 ? resetMs : 60_000);
  }
  if (res.status === 403) {
    throw new Error("submit rejected: 403 (explorer API refuses non-browser clients; verify manually)");
  }
  const json = (await res.json().catch(() => ({}))) as { status?: string; result?: unknown; message?: string };
  if (json.status !== "1" || typeof json.result !== "string") {
    throw new Error(`submit rejected: ${String(json.result ?? json.message ?? res.status)}`);
  }
  return json.result;
}

async function waitForResult(apiUrl: string, guid: string, address: Address): Promise<string> {
  for (let i = 0; i < MAX_POLLS; i++) {
    await sleep(POLL_MS);
    // Blockscout often answers "Unknown UID" while a job is still processing,
    // so the address's verified flag is the source of truth.
    if (await isVerified(apiUrl, address)) return "Pass - Verified";
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

/** Verify one contract; idempotent (skips contracts the explorer already shows as verified). */
export async function verifyContract(
  opts: VerifierOptions,
  request: { address: Address; contractName: string; input: string; constructorArgs: `0x${string}` },
  compilerVersion: string,
): Promise<VerifyOutcome> {
  const log = opts.log ?? (() => {});
  if (await isVerified(opts.explorerApiUrl, request.address)) return "already-verified";

  const args = request.constructorArgs.replace(/^0x/, "");
  let rateLimitWaits = 0;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      const guid = await submit(opts.explorerApiUrl, {
        contractaddress: request.address,
        contractname: request.contractName,
        compilerversion: compilerVersion,
        sourceCode: request.input,
        constructorArguements: args,
        constructorArguments: args,
      });
      const result = await waitForResult(opts.explorerApiUrl, guid, request.address);
      if (/pass|already verified/i.test(result)) return "verified";
      log(`${request.contractName} ${request.address}: attempt ${attempt} → ${result}`);
    } catch (e) {
      if (e instanceof RateLimited && rateLimitWaits < MAX_RATE_LIMIT_WAITS) {
        rateLimitWaits++;
        const wait = Math.min(e.resetMs, MAX_RATE_LIMIT_WAIT_MS) + 5_000;
        log(`${request.contractName} ${request.address}: ${e.message}; waiting ${Math.round(wait / 1000)}s`);
        await sleep(wait);
        attempt--; // the window, not the submission, failed
        continue;
      }
      log(`${request.contractName} ${request.address}: attempt ${attempt} → ${e instanceof Error ? e.message : e}`);
    }
    // A fresh contract may not be indexed by the explorer yet; a queued job may finish late.
    await sleep(attempt * 20_000);
    if (await isVerified(opts.explorerApiUrl, request.address)) return "verified";
  }
  return "failed";
}

/** Verify a launched pair's PairVault and PairShareToken using constructor values read from chain. */
export async function verifyPairContracts(
  client: PublicClient,
  opts: VerifierOptions,
  pair: Address,
): Promise<{ vault: VerifyOutcome; share: VerifyOutcome }> {
  const inputs = loadInputs(opts.inputsDir);
  if (!inputs) {
    opts.log?.(`verification inputs missing in ${opts.inputsDir} (run scripts/export-verification-inputs.sh)`);
    return { vault: "skipped", share: "skipped" };
  }

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

  // PairDeployer: new PairShareToken(name, symbol, msg.sender) — the factory owns it.
  const [name, symbol, owner] = await Promise.all([
    client.readContract({ address: receiptToken, abi: shareAbi, functionName: "name" }),
    client.readContract({ address: receiptToken, abi: shareAbi, functionName: "symbol" }),
    client.readContract({ address: receiptToken, abi: shareAbi, functionName: "owner" }),
  ]);
  const shareArgs = encodeAbiParameters(
    [{ type: "string" }, { type: "string" }, { type: "address" }],
    [name, symbol, owner],
  );

  const vault = await verifyContract(
    opts,
    { address: pair, contractName: "src/PairVault.sol:PairVault", input: inputs.pairVault, constructorArgs: vaultArgs },
    inputs.compilerVersion,
  );
  const share = await verifyContract(
    opts,
    {
      address: receiptToken,
      contractName: "src/PairShareToken.sol:PairShareToken",
      input: inputs.pairShareToken,
      constructorArgs: shareArgs,
    },
    inputs.compilerVersion,
  );
  return { vault, share };
}

/**
 * Verify a CreatorToken launched by ComposeCurve.
 * ComposeCurve: new CreatorToken(name, symbol, TOTAL_SUPPLY, address(this)) — the
 * token has no mint/burn, so totalSupply() is the constructor supply.
 */
export async function verifyCreatorToken(
  client: PublicClient,
  opts: VerifierOptions,
  token: Address,
  curve: Address,
): Promise<VerifyOutcome> {
  const inputs = loadInputs(opts.inputsDir);
  if (!inputs) {
    opts.log?.(`verification inputs missing in ${opts.inputsDir} (run scripts/export-verification-inputs.sh)`);
    return "skipped";
  }
  const [name, symbol, supply] = await Promise.all([
    client.readContract({ address: token, abi: creatorTokenAbi, functionName: "name" }),
    client.readContract({ address: token, abi: creatorTokenAbi, functionName: "symbol" }),
    client.readContract({ address: token, abi: creatorTokenAbi, functionName: "totalSupply" }),
  ]);
  const args = encodeAbiParameters(
    [{ type: "string" }, { type: "string" }, { type: "uint256" }, { type: "address" }],
    [name, symbol, supply, curve],
  );
  return verifyContract(
    opts,
    { address: token, contractName: "src/CreatorToken.sol:CreatorToken", input: inputs.creatorToken, constructorArgs: args },
    inputs.compilerVersion,
  );
}

/** Runs verification jobs one at a time and never twice for the same address. */
export function createVerificationQueue(run: (address: Address) => Promise<void>) {
  const seen = new Set<string>();
  let tail: Promise<void> = Promise.resolve();
  return (address: Address) => {
    const key = address.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    tail = tail.then(() => run(address)).catch(() => undefined);
  };
}
