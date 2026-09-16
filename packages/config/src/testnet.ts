import testnetDeployments from "./testnet-deployments.json" with { type: "json" };

/** True when the app / service is configured for Robinhood Chain testnet. */
export function isTestnetMode(): boolean {
  return process.env.NEXT_PUBLIC_USE_TESTNET === "true";
}

/** Active chain id (46630 testnet, 4663 mainnet). */
export function activeChainId(): number {
  return isTestnetMode() ? 46630 : 4663;
}

/** Shape of `testnet-deployments.json`, written by `pnpm sync:testnet`. */
export interface TestnetDeployment {
  chainId: number;
  rpcUrl: string;
  /** Block the launchpad was deployed at — indexer backfills from here. */
  startBlock: number;
  /** Real faucet Stock Tokens + WETH, keyed by ticker. */
  tokens: Record<string, string>;
  /** PushPriceFeed per ticker. */
  feeds: Record<string, string>;
  contracts: {
    pairFactory: string;
    oracle: string;
    emergency: string;
    priceFeedUpdater: string;
    /** USDG/ETH buy & sell router (DeployTestnetRouter). */
    pairRouter?: string;
    /** Oracle-priced Uniswap stand-in (testnet has no Uniswap). */
    swapRouter?: string;
    /** 6-decimal TestUSDG with a public faucet. */
    usdg?: string;
    usdgFeed?: string;
    /** Bonding-curve creator tokens (DeployTestnetCurve). */
    composeCurve?: string;
    /** Buy/sell creator tokens with ETH or USDG. */
    curveRouter?: string;
    /** Pons v2 launch factory (external; one-stock quote curves). */
    ponsFactory?: string;
    /** Launches a pair's token on Pons v2 (PonsLauncher). */
    ponsLauncher?: string;
    /** Trades Pons-launched tokens in pair shares, stocks, USDG or ETH (PonsRouter). */
    ponsRouter?: string;
    /** Managed baskets (DeployTestnetBaskets) — swap through the oracle-priced router. */
    allocationController?: string;
    cashbackReserve?: string;
    executionRouter?: string;
    swapAdapter?: string;
    vaultFactory?: string;
  };
  /** Balanced StrategyVault + receipt token per stock ticker (DeployTestnetBaskets). */
  vaults?: Record<string, { vault: string; receipt: string }>;
  syncedAt?: string;
}

/** Whether the testnet basket stack has been deployed and synced. */
export function testnetBasketsReady(): boolean {
  return isTestnetMode() && isHexAddress(testnetDeployment().contracts.vaultFactory);
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

export function isHexAddress(value: string | undefined | null): value is `0x${string}` {
  return typeof value === "string" && ADDRESS_RE.test(value);
}

export function testnetDeployment(): TestnetDeployment {
  return testnetDeployments as TestnetDeployment;
}

/** Whether the testnet launchpad has been deployed and synced. */
export function testnetContractsReady(): boolean {
  return isTestnetMode() && isHexAddress(testnetDeployment().contracts.pairFactory);
}

export { testnetDeployments };
