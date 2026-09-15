import { createPublicClient, http, type PublicClient } from "viem";
import {
  isHexAddress,
  isTestnetMode,
  mainnetDeployment,
  robinhoodChain,
  robinhoodTestnet,
  testnetDeployment,
} from "@compose/config";

export const USE_TESTNET = isTestnetMode();

export function chainRpcUrl(): string | undefined {
  return USE_TESTNET
    ? process.env.ROBINHOOD_TESTNET_RPC_URL || testnetDeployment().rpcUrl
    : process.env.ROBINHOOD_RPC_URL || mainnetDeployment().rpcUrl || undefined;
}

/** Env override first, then the synced mainnet deployment file. */
function mainnetAddress(...envs: Array<string | undefined>): string | undefined {
  for (const v of envs) if (isHexAddress(v)) return v;
  return undefined;
}

let client: PublicClient | null | undefined;

/** Shared read client for the active Robinhood Chain network. */
export function getPublicClient(): PublicClient | null {
  if (client !== undefined) return client;
  const url = chainRpcUrl();
  if (!url) {
    client = null;
    return null;
  }
  const chain = USE_TESTNET ? robinhoodTestnet : robinhoodChain;
  client = createPublicClient({
    chain: {
      id: chain.id,
      name: chain.name,
      nativeCurrency: chain.nativeCurrency,
      rpcUrls: { default: { http: [url] } },
    },
    transport: http(url),
  }) as PublicClient;
  return client;
}

/** On testnet the synced deployment file is authoritative; on mainnet env overrides the synced file. */
export function pairFactoryAddress(): `0x${string}` | undefined {
  const value = USE_TESTNET
    ? testnetDeployment().contracts.pairFactory
    : mainnetAddress(
        process.env.PAIR_FACTORY_ADDRESS,
        process.env.NEXT_PUBLIC_PAIR_FACTORY_ADDRESS,
        mainnetDeployment().contracts.pairFactory,
      );
  return isHexAddress(value) ? value : undefined;
}

export function oracleAddress(): `0x${string}` | undefined {
  const value = USE_TESTNET
    ? testnetDeployment().contracts.oracle
    : mainnetAddress(
        process.env.ORACLE_ADAPTER_ADDRESS,
        process.env.NEXT_PUBLIC_ORACLE_ADAPTER_ADDRESS,
        mainnetDeployment().contracts.oracle,
      );
  return isHexAddress(value) ? value : undefined;
}

/** ComposeCurve (creator tokens); the synced deployment file, env override on mainnet. */
export function composeCurveAddress(): `0x${string}` | undefined {
  const value = USE_TESTNET
    ? testnetDeployment().contracts.composeCurve
    : mainnetAddress(
        process.env.COMPOSE_CURVE_ADDRESS,
        process.env.NEXT_PUBLIC_COMPOSE_CURVE_ADDRESS,
        mainnetDeployment().contracts.composeCurve,
      );
  return isHexAddress(value) ? value : undefined;
}

/**
 * VaultFactory (managed baskets): the synced deployment file on testnet, env
 * override on mainnet.
 */
export function vaultFactoryAddress(): `0x${string}` | undefined {
  const value = USE_TESTNET
    ? testnetDeployment().contracts.vaultFactory
    : mainnetAddress(
        process.env.VAULT_FACTORY_ADDRESS,
        process.env.NEXT_PUBLIC_FACTORY_ADDRESS,
        mainnetDeployment().contracts.vaultFactory,
      );
  return isHexAddress(value) ? value : undefined;
}

/** Canonical Multicall3 deployment (same address on every EVM chain that has it). */
const CANONICAL_MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11" as const;

/** Multicall3 used to batch vault reads; env override, else the canonical address. */
export function multicall3Address(): `0x${string}` {
  const value = process.env.MULTICALL3_ADDRESS;
  return isHexAddress(value) ? value : CANONICAL_MULTICALL3;
}

/** Blockscout (Etherscan-compatible) API base for source verification. */
export function explorerApiUrl(): string {
  const base =
    process.env.EXPLORER_API_URL ||
    `${(USE_TESTNET ? robinhoodTestnet : robinhoodChain).blockExplorers.default.url}/api`;
  return base.replace(/\/$/, "");
}

/** Sourcify server used to publish launched contracts' source (default: the public instance). */
export function sourcifyUrl(): string {
  return (process.env.SOURCIFY_URL || "https://sourcify.dev/server").replace(/\/$/, "");
}

/** EVM chain id the indexer is following. */
export function chainId(): number {
  return (USE_TESTNET ? robinhoodTestnet : robinhoodChain).id;
}

/** Publish the source of every launched pair and token to Sourcify + the explorer (default on). */
export const AUTO_VERIFY_CONTRACTS = process.env.AUTO_VERIFY_CONTRACTS !== "false";

/** First block to index launchpad events from (the factory deployment block). */
export function launchpadStartBlock(): bigint {
  const raw =
    process.env.INDEXER_START_BLOCK ||
    String((USE_TESTNET ? testnetDeployment() : mainnetDeployment()).startBlock ?? 0);
  try {
    return BigInt(raw);
  } catch {
    return 0n;
  }
}
