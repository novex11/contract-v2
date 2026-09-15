import {
  pgTable,
  text,
  numeric,
  timestamp,
  uuid,
  boolean,
  jsonb,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { receiptTokenName } from "@compose/config";

const DEFAULT_VAULT_ID = receiptTokenName("NVDA", "balanced");

// ─── Positions ──────────────────────────────────────────

export const positions = pgTable(
  "positions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    wallet: text("wallet").notNull(),
    vaultId: text("vault_id").notNull(),
    depositTicker: text("deposit_ticker").notNull(),
    depositUsd: numeric("deposit_usd", { precision: 18, scale: 4 }).notNull(),
    currentValueUsd: numeric("current_value_usd", {
      precision: 18,
      scale: 4,
    }).notNull(),
    receiptBalance: text("receipt_balance").notNull().default("0"),
    strategy: text("strategy").notNull(),
    allocation: jsonb("allocation")
      .$type<Array<{ ticker: string; weight: number; usd: number }>>()
      .default([]),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [uniqueIndex("positions_wallet_idx").on(table.wallet)],
);

// ─── Activity ───────────────────────────────────────────

export const activity = pgTable("activity", {
  id: uuid("id").defaultRandom().primaryKey(),
  wallet: text("wallet").notNull(),
  type: text("type").notNull(), // deposit, redeem, rebalance
  txHash: text("tx_hash").notNull(),
  valueUsd: numeric("value_usd", { precision: 18, scale: 4 }).notNull(),
  stockbackUsd: numeric("stockback_usd", { precision: 18, scale: 4 })
    .notNull()
    .default("0"),
  status: text("status").notNull().default("confirmed"),
  vaultId: text("vault_id"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ─── Vaults ─────────────────────────────────────────────

export const vaults = pgTable("vaults", {
  id: text("id").primaryKey(),
  strategy: text("strategy").notNull(),
  depositAsset: text("deposit_asset").notNull(),
  tvlUsd: numeric("tvl_usd", { precision: 18, scale: 4 })
    .notNull()
    .default("0"),
  sharePrice: numeric("share_price", { precision: 18, scale: 8 })
    .notNull()
    .default("1"),
  receiptSupply: text("receipt_supply").notNull().default("0"),
  holdings: jsonb("holdings")
    .$type<Array<{ ticker: string; weight: number; usd: number }>>()
    .default([]),
  paused: boolean("paused").notNull().default(false),
  contractAddress: text("contract_address").notNull().default("0x"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ─── Direct stock holdings (buy/sell outside baskets) ───

export const holdings = pgTable(
  "holdings",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    wallet: text("wallet").notNull(),
    ticker: text("ticker").notNull(),
    qty: numeric("qty", { precision: 24, scale: 8 }).notNull().default("0"),
    avgPriceUsd: numeric("avg_price_usd", { precision: 18, scale: 4 })
      .notNull()
      .default("0"),
    costUsd: numeric("cost_usd", { precision: 18, scale: 4 })
      .notNull()
      .default("0"),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("holdings_wallet_ticker_idx").on(table.wallet, table.ticker),
  ],
);

// ─── Wallet Stockback Totals ────────────────────────────

export const walletStockback = pgTable(
  "wallet_stockback",
  {
    wallet: text("wallet").primaryKey(),
    totalUsd: numeric("total_usd", { precision: 18, scale: 4 })
      .notNull()
      .default("0"),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
);

// ─── Analytics: Swap Events ─────────────────────────────

export const swapEvents = pgTable(
  "swap_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    txHash: text("tx_hash").notNull(),
    blockNumber: numeric("block_number").notNull(),
    logIndex: numeric("log_index").notNull().default("0"),
    vaultAddress: text("vault_address").notNull(),
    tokenIn: text("token_in").notNull(),
    tokenOut: text("token_out").notNull(),
    amountIn: text("amount_in").notNull(),
    amountOut: text("amount_out").notNull(),
    valueUsd: numeric("value_usd", { precision: 18, scale: 4 })
      .notNull()
      .default("0"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("swap_events_tx_log_idx").on(table.txHash, table.logIndex),
  ],
);

// ─── Analytics: Deposit Events (raw on-chain) ───────────

export const depositEvents = pgTable(
  "deposit_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    txHash: text("tx_hash").notNull(),
    blockNumber: numeric("block_number").notNull(),
    userAddress: text("user_address").notNull(),
    amountIn: text("amount_in").notNull(),
    sharesMinted: text("shares_minted").notNull(),
    valueUsd: numeric("value_usd", { precision: 18, scale: 4 })
      .notNull()
      .default("0"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [uniqueIndex("deposit_events_tx_idx").on(table.txHash)],
);

// ─── Analytics: Redeem Events (raw on-chain) ────────────

export const redeemEvents = pgTable(
  "redeem_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    txHash: text("tx_hash").notNull(),
    blockNumber: numeric("block_number").notNull(),
    userAddress: text("user_address").notNull(),
    sharesBurned: text("shares_burned").notNull(),
    redeemMode: numeric("redeem_mode").notNull().default("0"),
    valueUsd: numeric("value_usd", { precision: 18, scale: 4 })
      .notNull()
      .default("0"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [uniqueIndex("redeem_events_tx_idx").on(table.txHash)],
);

// ─── Analytics: Daily Volume Aggregates ─────────────────

export const dailyVolume = pgTable("daily_volume", {
  id: uuid("id").defaultRandom().primaryKey(),
  date: text("date").notNull(),
  vaultId: text("vault_id").notNull().default(DEFAULT_VAULT_ID),
  volumeUsd: numeric("volume_usd", { precision: 18, scale: 4 })
    .notNull()
    .default("0"),
  depositVolumeUsd: numeric("deposit_volume_usd", { precision: 18, scale: 4 })
    .notNull()
    .default("0"),
  redeemVolumeUsd: numeric("redeem_volume_usd", { precision: 18, scale: 4 })
    .notNull()
    .default("0"),
  swapCount: numeric("swap_count").notNull().default("0"),
  depositCount: numeric("deposit_count").notNull().default("0"),
  redeemCount: numeric("redeem_count").notNull().default("0"),
  uniqueWallets: numeric("unique_wallets").notNull().default("0"),
});

// ─── Analytics: TVL Snapshots ───────────────────────────

export const tvlSnapshots = pgTable("tvl_snapshots", {
  id: uuid("id").defaultRandom().primaryKey(),
  vaultId: text("vault_id").notNull().default(DEFAULT_VAULT_ID),
  vaultAddress: text("vault_address").notNull(),
  navUsd: numeric("nav_usd", { precision: 18, scale: 4 }).notNull(),
  sharePrice: numeric("share_price", { precision: 18, scale: 8 }).notNull(),
  totalShares: text("total_shares").notNull().default("0"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ─── Launchpad: launched pairs ──────────────────────────

export const launchedPairs = pgTable(
  "launched_pairs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    pairKey: text("pair_key").notNull(),
    pairAddress: text("pair_address").notNull(),
    receiptAddress: text("receipt_address").notNull(),
    receiptSymbol: text("receipt_symbol").notNull(),
    creatorWallet: text("creator_wallet").notNull(),
    tokenA: text("token_a").notNull(),
    tokenB: text("token_b").notNull(),
    tickerA: text("ticker_a").notNull(),
    tickerB: text("ticker_b").notNull(),
    categoryA: text("category_a").notNull(),
    categoryB: text("category_b").notNull(),
    weightABps: numeric("weight_a_bps").notNull(),
    creatorFeeBps: numeric("creator_fee_bps").notNull(),
    tvlUsd: numeric("tvl_usd", { precision: 18, scale: 4 })
      .notNull()
      .default("0"),
    totalDepositsUsd: numeric("total_deposits_usd", { precision: 18, scale: 4 })
      .notNull()
      .default("0"),
    totalDepositors: numeric("total_depositors").notNull().default("0"),
    creatorEarningsUsd: numeric("creator_earnings_usd", {
      precision: 18,
      scale: 4,
    })
      .notNull()
      .default("0"),
    /** Rolling 24h deposit + redeem volume — refreshed on each activity */
    volume24hUsd: numeric("volume_24h_usd", { precision: 18, scale: 4 })
      .notNull()
      .default("0"),
    /** Human-readable pair name (mirrors on-chain receipt ERC-20 name) */
    displayName: text("display_name").notNull().default(""),
    /** Creator-supplied pair description (like Long.xyz tokenURI metadata) */
    description: text("description").notNull().default(""),
    /** Wide banner image for pair detail hero + cards */
    imageUrl: text("image_url").notNull().default(""),
    /** Square token logo (avatar) shown over the banner */
    logoUrl: text("logo_url").notNull().default(""),
    /** Optional project / social link */
    websiteUrl: text("website_url").notNull().default(""),
    /** Which token is the quote/numeraire leg (Long.xyz concept) */
    numeraireTicker: text("numeraire_ticker").notNull().default(""),
    /** Uniswap v3 pool seeded at launch (share token vs USDG); empty if none */
    poolAddress: text("pool_address").notNull().default(""),
    /** PairFactory that launched the pair (hides pairs from older deployments) */
    factoryAddress: text("factory_address").notNull().default(""),
    status: text("status").notNull().default("active"),
    txHash: text("tx_hash").notNull().default(""),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    // The same token pair can be launched again on a newer factory.
    uniqueIndex("launched_pairs_factory_key_idx").on(table.factoryAddress, table.pairKey),
    uniqueIndex("launched_pairs_address_idx").on(table.pairAddress),
  ],
);

// ─── Launchpad: pair deposits ───────────────────────────

// `usdg_amount` / `usdg_out` hold the USD value of the in-kind legs (column
// names kept for existing databases).
export const pairDeposits = pgTable(
  "pair_deposits",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    pairAddress: text("pair_address").notNull(),
    wallet: text("wallet").notNull(),
    usdgAmount: numeric("usdg_amount", { precision: 18, scale: 4 }).notNull(),
    amountA: text("amount_a").notNull().default("0"),
    amountB: text("amount_b").notNull().default("0"),
    sharesMinted: text("shares_minted").notNull(),
    creatorFeeUsd: numeric("creator_fee_usd", { precision: 18, scale: 4 })
      .notNull()
      .default("0"),
    txHash: text("tx_hash").notNull(),
    logIndex: numeric("log_index").notNull().default("0"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [uniqueIndex("pair_deposits_tx_log_idx").on(table.txHash, table.logIndex)],
);

// ─── Launchpad: pair redeems ────────────────────────────

export const pairRedeems = pgTable(
  "pair_redeems",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    pairAddress: text("pair_address").notNull(),
    wallet: text("wallet").notNull(),
    sharesBurned: text("shares_burned").notNull(),
    usdgOut: numeric("usdg_out", { precision: 18, scale: 4 }).notNull(),
    amountA: text("amount_a").notNull().default("0"),
    amountB: text("amount_b").notNull().default("0"),
    txHash: text("tx_hash").notNull(),
    logIndex: numeric("log_index").notNull().default("0"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [uniqueIndex("pair_redeems_tx_log_idx").on(table.txHash, table.logIndex)],
);

// ─── Launchpad: pair time-series snapshots ──────────────
// Every mark-to-market tick writes one row per active pair so the
// pair-detail chart can render a real NAV / share-price curve rather
// than a synthetic sparkline.

export const pairSnapshots = pgTable(
  "pair_snapshots",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    pairAddress: text("pair_address").notNull(),
    navUsd: numeric("nav_usd", { precision: 18, scale: 4 }).notNull(),
    sharePrice: numeric("share_price", { precision: 18, scale: 8 })
      .notNull()
      .default("1"),
    totalShares: text("total_shares").notNull().default("0"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [index("pair_snapshots_addr_ts_idx").on(table.pairAddress, table.createdAt)],
);

// ─── Indexer cursors ────────────────────────────────────
// Last processed block per log stream, so restarts resume without gaps.

export const indexerCursor = pgTable("indexer_cursor", {
  id: text("id").primaryKey(),
  block: numeric("block").notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// ─── Source verification of launched contracts ──────────

/** One row per launched contract (pair vault, share token, creator token) with the last outcome per backend. */
export const contractVerifications = pgTable("contract_verifications", {
  address: text("address").primaryKey(),
  chainId: numeric("chain_id").notNull(),
  kind: text("kind").notNull(),
  sourcify: text("sourcify").notNull(),
  blockscout: text("blockscout").notNull(),
  error: text("error"),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
