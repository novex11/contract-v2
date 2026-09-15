/**
 * Publishes the source of every contract our factories launched — PairVault +
 * PairShareToken per pair, CreatorToken per bonding-curve token — to Sourcify
 * and the Blockscout explorer. The indexer does this automatically for new
 * launches; this script backfills or re-checks. Safe to re-run: contracts that
 * are already verified are skipped.
 *
 * Usage: pnpm verify:launched [--mainnet] [pairAddress | tokenAddress]
 */
import { createPublicClient, http, parseAbi, type Address, type PublicClient } from "viem";
import { join } from "node:path";
import { loadRootEnv } from "./lib/load-env";
import testnet from "../packages/config/src/testnet-deployments.json";
import mainnet from "../packages/config/src/mainnet-deployments.json";
import { robinhoodChain, robinhoodTestnet } from "../packages/config/src/chain";
import {
  verifyCreatorToken,
  verifyPairContracts,
  type VerificationRecord,
  type VerifierOptions,
} from "../services/indexer/src/contract-verifier";

loadRootEnv();

const mainnetMode = process.argv.includes("--mainnet");
const target = process.argv.slice(2).find((a) => a.startsWith("0x")) as Address | undefined;
const chain = mainnetMode ? robinhoodChain : robinhoodTestnet;
const deployment = mainnetMode ? mainnet : testnet;
const rpcUrl =
  (mainnetMode ? process.env.ROBINHOOD_RPC_URL : process.env.ROBINHOOD_TESTNET_RPC_URL) || deployment.rpcUrl;
const explorerApiUrl = (process.env.EXPLORER_API_URL || `${chain.blockExplorers.default.url}/api`).replace(/\/$/, "");
const factory = deployment.contracts.pairFactory as Address;
const curve = deployment.contracts.composeCurve as Address;
const ZERO = "0x0000000000000000000000000000000000000000";

const factoryAbi = parseAbi([
  "function pairCount() view returns (uint256)",
  "function pairs(uint256) view returns (address pair, address receiptToken, address tokenA, address tokenB, uint16 weightABps, uint16 creatorFeeBps, address creator)",
  "function isPair(address) view returns (bool)",
]);
const curveAbi = parseAbi(["function tokenOfPair(address pair) view returns (address)"]);

function describe(r: VerificationRecord): string {
  const tail = r.error ? `  (${r.error})` : "";
  return `${r.kind.padEnd(15)} ${r.address}  sourcify=${r.sourcify}  blockscout=${r.blockscout}${tail}`;
}

async function main() {
  const client = createPublicClient({ chain, transport: http(rpcUrl) }) as PublicClient;
  const opts: VerifierOptions = {
    chainId: chain.id,
    explorerApiUrl,
    sourcifyUrl: process.env.SOURCIFY_URL,
    inputsDir: join(__dirname, "../services/indexer/verification"),
    log: (m) => console.log(`  · ${m}`),
  };

  let pairs: Address[] = [];
  let tokens: Address[] = [];
  if (target) {
    const isPair = await client.readContract({ address: factory, abi: factoryAbi, functionName: "isPair", args: [target] });
    if (isPair) pairs = [target];
    else tokens = [target];
  } else {
    const count = await client.readContract({ address: factory, abi: factoryAbi, functionName: "pairCount" });
    for (let i = 0n; i < count; i++) {
      const info = await client.readContract({ address: factory, abi: factoryAbi, functionName: "pairs", args: [i] });
      pairs.push(info[0]);
    }
  }
  for (const pair of pairs) {
    const token = await client.readContract({ address: curve, abi: curveAbi, functionName: "tokenOfPair", args: [pair] });
    if (token && token.toLowerCase() !== ZERO) tokens.push(token);
  }

  console.log(
    `Publishing source for ${pairs.length} pair(s) and ${tokens.length} token(s) on ${chain.name} (${chain.id})\n` +
      `  sourcify: ${opts.sourcifyUrl ?? "https://sourcify.dev/server"}\n  explorer: ${explorerApiUrl}\n`,
  );

  const records: VerificationRecord[] = [];
  for (const pair of pairs) {
    console.log(`Pair ${pair}`);
    const { vault, receipt } = await verifyPairContracts(client, opts, pair);
    records.push(vault, receipt);
    console.log(`  ${describe(vault)}\n  ${describe(receipt)}`);
  }
  for (const token of tokens) {
    console.log(`Token ${token}`);
    const r = await verifyCreatorToken(client, opts, token, curve);
    records.push(r);
    console.log(`  ${describe(r)}`);
  }

  const failedSourcify = records.filter((r) => r.sourcify === "failed" || r.sourcify === "skipped");
  const failedExplorer = records.filter((r) => r.blockscout === "failed");
  console.log(
    `\nDone: ${records.length} contract(s); ${records.length - failedSourcify.length} on Sourcify` +
      `, ${records.length - failedExplorer.length - records.filter((r) => r.blockscout === "skipped").length} on the explorer.`,
  );
  if (failedExplorer.length > 0 && mainnetMode) {
    console.log(
      "The mainnet explorer rejects non-browser clients (Cloudflare); Sourcify is the source of truth until it allow-lists the indexer.",
    );
  }
  if (failedSourcify.length > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
