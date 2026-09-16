import mainnetManifestJson from "./mainnet-manifest.json" with { type: "json" };
import mainnetDeploymentsJson from "./mainnet-deployments.json" with { type: "json" };
import { isHexAddress } from "./testnet.js";
import type { StockToken } from "./tokens.js";

/** One tokenized stock from the RHJ registry (see scripts/build-mainnet-manifest.ts). */
export interface ManifestToken {
  ticker: string;
  name: string;
  address: `0x${string}`;
  decimals: number;
  category: StockToken["category"];
  logoUrl?: string;
  isin?: string;
  tradingHours?: { market: boolean; extended: boolean; overnight: boolean };
}

export interface MainnetManifest {
  chainId: number;
  source: string;
  generatedAt: string;
  tokens: ManifestToken[];
}

/** Shape of `mainnet-deployments.json`, written by `pnpm sync:mainnet`. */
export interface MainnetDeployment {
  chainId: number;
  rpcUrl: string;
  /** Block the launchpad was deployed at — indexer backfills from here. */
  startBlock: number;
  /** PushPriceFeed per ticker (USDG and WETH included). */
  feeds: Record<string, string>;
  contracts: {
    pairFactory: string;
    oracle: string;
    emergency: string;
    priceFeedUpdater: string;
    pairRouter: string;
    /** Uniswap V3 SwapRouter02 (canonical). */
    swapRouter: string;
    usdg: string;
    usdgFeed: string;
    composeCurve: string;
    curveRouter: string;
    /** Pons v2 launch factory (external; one-stock quote curves). */
    ponsFactory: string;
    /** Launches a pair's token on Pons v2 (PonsLauncher). */
    ponsLauncher: string;
    /** Trades Pons-launched tokens in pair shares, stocks, USDG or ETH (PonsRouter). */
    ponsRouter: string;
    allocationController: string;
    cashbackReserve: string;
    executionRouter: string;
    /** ISwapRouter adapter the ExecutionRouter trades through. */
    swapAdapter: string;
    vaultFactory: string;
  };
  /** Balanced StrategyVault + receipt token per stock ticker (CreateMainnetVaults). */
  vaults?: Record<string, { vault: string; receipt: string }>;
  syncedAt?: string;
}

export function mainnetManifest(): MainnetManifest {
  return mainnetManifestJson as MainnetManifest;
}

export function mainnetDeployment(): MainnetDeployment {
  return mainnetDeploymentsJson as MainnetDeployment;
}

/** Whether the mainnet launchpad has been deployed and synced. */
export function mainnetContractsReady(): boolean {
  return isHexAddress(mainnetDeployment().contracts.pairFactory);
}

/** Whether the mainnet basket stack has been deployed and synced. */
export function mainnetBasketsReady(): boolean {
  return isHexAddress(mainnetDeployment().contracts.vaultFactory);
}
