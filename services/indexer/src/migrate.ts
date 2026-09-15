import postgres from "postgres";
import { getConnectionString, postgresSslOption } from "./db-config.js";

const RETRIES = 15;
const RETRY_MS = 2000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function ensureSchema(): Promise<void> {
  const connectionString = getConnectionString();
  if (!connectionString) return;

  let lastError: unknown;
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    const sql = postgres(connectionString, {
      max: 1,
      ssl: postgresSslOption(connectionString),
    });
    try {
      await sql`
        CREATE TABLE IF NOT EXISTS positions (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          wallet text NOT NULL,
          vault_id text NOT NULL,
          deposit_ticker text NOT NULL,
          deposit_usd numeric(18, 4) NOT NULL,
          current_value_usd numeric(18, 4) NOT NULL,
          receipt_balance text NOT NULL DEFAULT '0',
          strategy text NOT NULL,
          allocation jsonb DEFAULT '[]'::jsonb,
          created_at timestamp NOT NULL DEFAULT now(),
          updated_at timestamp NOT NULL DEFAULT now()
        )
      `;
      await sql`CREATE UNIQUE INDEX IF NOT EXISTS positions_wallet_idx ON positions (wallet)`;

      await sql`
        CREATE TABLE IF NOT EXISTS activity (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          wallet text NOT NULL,
          type text NOT NULL,
          tx_hash text NOT NULL,
          value_usd numeric(18, 4) NOT NULL,
          stockback_usd numeric(18, 4) NOT NULL DEFAULT '0',
          status text NOT NULL DEFAULT 'confirmed',
          vault_id text,
          created_at timestamp NOT NULL DEFAULT now()
        )
      `;

      await sql`
        CREATE TABLE IF NOT EXISTS vaults (
          id text PRIMARY KEY,
          strategy text NOT NULL,
          deposit_asset text NOT NULL,
          tvl_usd numeric(18, 4) NOT NULL DEFAULT '0',
          share_price numeric(18, 8) NOT NULL DEFAULT '1',
          receipt_supply text NOT NULL DEFAULT '0',
          holdings jsonb DEFAULT '[]'::jsonb,
          paused boolean NOT NULL DEFAULT false,
          contract_address text NOT NULL DEFAULT '0x',
          created_at timestamp NOT NULL DEFAULT now()
        )
      `;

      await sql`
        CREATE TABLE IF NOT EXISTS holdings (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          wallet text NOT NULL,
          ticker text NOT NULL,
          qty numeric(24, 8) NOT NULL DEFAULT '0',
          avg_price_usd numeric(18, 4) NOT NULL DEFAULT '0',
          cost_usd numeric(18, 4) NOT NULL DEFAULT '0',
          updated_at timestamp NOT NULL DEFAULT now()
        )
      `;
      await sql`CREATE UNIQUE INDEX IF NOT EXISTS holdings_wallet_ticker_idx ON holdings (wallet, ticker)`;

      await sql`
        CREATE TABLE IF NOT EXISTS wallet_stockback (
          wallet text PRIMARY KEY,
          total_usd numeric(18, 4) NOT NULL DEFAULT '0',
          updated_at timestamp NOT NULL DEFAULT now()
        )
      `;

      // ─── Analytics tables ─────────────────────────────
      await sql`
        CREATE TABLE IF NOT EXISTS swap_events (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          tx_hash text NOT NULL,
          block_number numeric NOT NULL,
          log_index numeric NOT NULL DEFAULT '0',
          vault_address text NOT NULL,
          token_in text NOT NULL,
          token_out text NOT NULL,
          amount_in text NOT NULL,
          amount_out text NOT NULL,
          value_usd numeric(18, 4) NOT NULL DEFAULT '0',
          created_at timestamp NOT NULL DEFAULT now()
        )
      `;
      await sql`CREATE UNIQUE INDEX IF NOT EXISTS swap_events_tx_log_idx ON swap_events (tx_hash, log_index)`;

      await sql`
        CREATE TABLE IF NOT EXISTS deposit_events (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          tx_hash text NOT NULL,
          block_number numeric NOT NULL,
          user_address text NOT NULL,
          amount_in text NOT NULL,
          shares_minted text NOT NULL,
          value_usd numeric(18, 4) NOT NULL DEFAULT '0',
          created_at timestamp NOT NULL DEFAULT now()
        )
      `;
      await sql`CREATE UNIQUE INDEX IF NOT EXISTS deposit_events_tx_idx ON deposit_events (tx_hash)`;

      await sql`
        CREATE TABLE IF NOT EXISTS redeem_events (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          tx_hash text NOT NULL,
          block_number numeric NOT NULL,
          user_address text NOT NULL,
          shares_burned text NOT NULL,
          redeem_mode numeric NOT NULL DEFAULT '0',
          value_usd numeric(18, 4) NOT NULL DEFAULT '0',
          created_at timestamp NOT NULL DEFAULT now()
        )
      `;
      await sql`CREATE UNIQUE INDEX IF NOT EXISTS redeem_events_tx_idx ON redeem_events (tx_hash)`;

      await sql`
        CREATE TABLE IF NOT EXISTS daily_volume (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          date text NOT NULL,
          vault_id text NOT NULL DEFAULT 'tNVDA-B',
          volume_usd numeric(18, 4) NOT NULL DEFAULT '0',
          deposit_volume_usd numeric(18, 4) NOT NULL DEFAULT '0',
          redeem_volume_usd numeric(18, 4) NOT NULL DEFAULT '0',
          swap_count numeric NOT NULL DEFAULT '0',
          deposit_count numeric NOT NULL DEFAULT '0',
          redeem_count numeric NOT NULL DEFAULT '0',
          unique_wallets numeric NOT NULL DEFAULT '0'
        )
      `;
      await sql`CREATE UNIQUE INDEX IF NOT EXISTS daily_volume_date_vault_idx ON daily_volume (date, vault_id)`;

      await sql`
        CREATE TABLE IF NOT EXISTS tvl_snapshots (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          vault_id text NOT NULL DEFAULT 'tNVDA-B',
          vault_address text NOT NULL,
          nav_usd numeric(18, 4) NOT NULL,
          share_price numeric(18, 8) NOT NULL,
          total_shares text NOT NULL DEFAULT '0',
          created_at timestamp NOT NULL DEFAULT now()
        )
      `;

      // ─── Launchpad tables ─────────────────────────────
      await sql`
        CREATE TABLE IF NOT EXISTS launched_pairs (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          pair_key text NOT NULL,
          pair_address text NOT NULL,
          receipt_address text NOT NULL,
          receipt_symbol text NOT NULL,
          creator_wallet text NOT NULL,
          token_a text NOT NULL,
          token_b text NOT NULL,
          ticker_a text NOT NULL,
          ticker_b text NOT NULL,
          category_a text NOT NULL,
          category_b text NOT NULL,
          weight_a_bps numeric NOT NULL,
          creator_fee_bps numeric NOT NULL,
          tvl_usd numeric(18, 4) NOT NULL DEFAULT '0',
          total_deposits_usd numeric(18, 4) NOT NULL DEFAULT '0',
          total_depositors numeric NOT NULL DEFAULT '0',
          creator_earnings_usd numeric(18, 4) NOT NULL DEFAULT '0',
          status text NOT NULL DEFAULT 'active',
          tx_hash text NOT NULL DEFAULT '',
          created_at timestamp NOT NULL DEFAULT now(),
          updated_at timestamp NOT NULL DEFAULT now()
        )
      `;
      // pair_key is unique per factory (created below once factory_address exists).
      await sql`DROP INDEX IF EXISTS launched_pairs_key_idx`;
      await sql`CREATE UNIQUE INDEX IF NOT EXISTS launched_pairs_address_idx ON launched_pairs (pair_address)`;

      // Metadata columns (safe to re-run on existing Neon DBs)
      await sql`ALTER TABLE launched_pairs ADD COLUMN IF NOT EXISTS display_name text NOT NULL DEFAULT ''`;
      await sql`ALTER TABLE launched_pairs ADD COLUMN IF NOT EXISTS description text NOT NULL DEFAULT ''`;
      await sql`ALTER TABLE launched_pairs ADD COLUMN IF NOT EXISTS image_url text NOT NULL DEFAULT ''`;
      await sql`ALTER TABLE launched_pairs ADD COLUMN IF NOT EXISTS logo_url text NOT NULL DEFAULT ''`;
      await sql`ALTER TABLE launched_pairs ADD COLUMN IF NOT EXISTS website_url text NOT NULL DEFAULT ''`;
      await sql`ALTER TABLE launched_pairs ADD COLUMN IF NOT EXISTS numeraire_ticker text NOT NULL DEFAULT ''`;
      await sql`ALTER TABLE launched_pairs ADD COLUMN IF NOT EXISTS volume_24h_usd numeric(18, 4) NOT NULL DEFAULT '0'`;
      await sql`ALTER TABLE launched_pairs ADD COLUMN IF NOT EXISTS pool_address text NOT NULL DEFAULT ''`;

      await sql`
        CREATE TABLE IF NOT EXISTS launchpad_images (
          id uuid PRIMARY KEY,
          content_type text NOT NULL,
          data text NOT NULL,
          created_at timestamp NOT NULL DEFAULT now()
        )
      `;

      await sql`
        CREATE TABLE IF NOT EXISTS pair_deposits (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          pair_address text NOT NULL,
          wallet text NOT NULL,
          usdg_amount numeric(18, 4) NOT NULL,
          shares_minted text NOT NULL,
          creator_fee_usd numeric(18, 4) NOT NULL DEFAULT '0',
          tx_hash text NOT NULL,
          created_at timestamp NOT NULL DEFAULT now()
        )
      `;

      await sql`
        CREATE TABLE IF NOT EXISTS pair_redeems (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          pair_address text NOT NULL,
          wallet text NOT NULL,
          shares_burned text NOT NULL,
          usdg_out numeric(18, 4) NOT NULL,
          tx_hash text NOT NULL,
          created_at timestamp NOT NULL DEFAULT now()
        )
      `;

      await sql`
        CREATE TABLE IF NOT EXISTS pair_snapshots (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          pair_address text NOT NULL,
          nav_usd numeric(18, 4) NOT NULL,
          share_price numeric(18, 8) NOT NULL DEFAULT '1',
          total_shares text NOT NULL DEFAULT '0',
          created_at timestamp NOT NULL DEFAULT now()
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS pair_snapshots_addr_ts_idx ON pair_snapshots (pair_address, created_at)`;

      // ─── In-kind launchpad (v2) ───────────────────────
      await sql`ALTER TABLE launched_pairs ADD COLUMN IF NOT EXISTS factory_address text NOT NULL DEFAULT ''`;
      await sql`CREATE UNIQUE INDEX IF NOT EXISTS launched_pairs_factory_key_idx ON launched_pairs (factory_address, pair_key)`;
      await sql`ALTER TABLE pair_deposits ADD COLUMN IF NOT EXISTS log_index numeric NOT NULL DEFAULT '0'`;
      await sql`ALTER TABLE pair_deposits ADD COLUMN IF NOT EXISTS amount_a text NOT NULL DEFAULT '0'`;
      await sql`ALTER TABLE pair_deposits ADD COLUMN IF NOT EXISTS amount_b text NOT NULL DEFAULT '0'`;
      await sql`ALTER TABLE pair_redeems ADD COLUMN IF NOT EXISTS log_index numeric NOT NULL DEFAULT '0'`;
      await sql`ALTER TABLE pair_redeems ADD COLUMN IF NOT EXISTS amount_a text NOT NULL DEFAULT '0'`;
      await sql`ALTER TABLE pair_redeems ADD COLUMN IF NOT EXISTS amount_b text NOT NULL DEFAULT '0'`;
      // Older rows were written by both the browser and the listener; keep one per event.
      await sql`DELETE FROM pair_deposits a USING pair_deposits b WHERE a.id < b.id AND a.tx_hash = b.tx_hash AND a.log_index = b.log_index`;
      await sql`DELETE FROM pair_redeems a USING pair_redeems b WHERE a.id < b.id AND a.tx_hash = b.tx_hash AND a.log_index = b.log_index`;
      await sql`CREATE UNIQUE INDEX IF NOT EXISTS pair_deposits_tx_log_idx ON pair_deposits (tx_hash, log_index)`;
      await sql`CREATE UNIQUE INDEX IF NOT EXISTS pair_redeems_tx_log_idx ON pair_redeems (tx_hash, log_index)`;

      // ─── Creator fee claims (fee shares the creator has cashed out) ───
      await sql`
        CREATE TABLE IF NOT EXISTS creator_fee_claims (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          pair_address text NOT NULL,
          creator_wallet text NOT NULL,
          shares text NOT NULL,
          tx_hash text NOT NULL,
          created_at timestamp NOT NULL DEFAULT now()
        )
      `;
      await sql`CREATE UNIQUE INDEX IF NOT EXISTS creator_fee_claims_tx_idx ON creator_fee_claims (tx_hash)`;
      await sql`CREATE INDEX IF NOT EXISTS creator_fee_claims_pair_idx ON creator_fee_claims (pair_address)`;

      // ─── Bonding-curve creator tokens ─────────────────
      await sql`
        CREATE TABLE IF NOT EXISTS curve_tokens (
          token_address text PRIMARY KEY,
          pair_address text NOT NULL,
          share_address text NOT NULL,
          creator_wallet text NOT NULL,
          name text NOT NULL,
          symbol text NOT NULL,
          start_quote text NOT NULL,
          virtual_quote text NOT NULL,
          token_reserve text NOT NULL,
          graduation_quote text NOT NULL,
          graduated boolean NOT NULL DEFAULT false,
          price_usd numeric(38, 18) NOT NULL DEFAULT '0',
          market_cap_usd numeric(24, 4) NOT NULL DEFAULT '0',
          start_market_cap_usd numeric(24, 4) NOT NULL DEFAULT '0',
          share_price_usd numeric(18, 8) NOT NULL DEFAULT '1',
          trades_count numeric NOT NULL DEFAULT '0',
          tx_hash text NOT NULL DEFAULT '',
          created_at timestamp NOT NULL DEFAULT now(),
          updated_at timestamp NOT NULL DEFAULT now()
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS curve_tokens_pair_idx ON curve_tokens (pair_address)`;
      // Tokens are scoped to the ComposeCurve that issued them; rows from older
      // curve deployments keep '' and drop out of every read.
      await sql`ALTER TABLE curve_tokens ADD COLUMN IF NOT EXISTS curve_address text NOT NULL DEFAULT ''`;
      await sql`CREATE INDEX IF NOT EXISTS curve_tokens_curve_idx ON curve_tokens (curve_address)`;
      await sql`
        CREATE TABLE IF NOT EXISTS curve_trades (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          token_address text NOT NULL,
          trader text NOT NULL,
          is_buy boolean NOT NULL,
          shares text NOT NULL,
          tokens text NOT NULL,
          fee text NOT NULL,
          price_usd numeric(38, 18) NOT NULL,
          market_cap_usd numeric(24, 4) NOT NULL,
          value_usd numeric(18, 4) NOT NULL,
          tx_hash text NOT NULL,
          log_index numeric NOT NULL DEFAULT '0',
          created_at timestamp NOT NULL DEFAULT now()
        )
      `;
      await sql`CREATE UNIQUE INDEX IF NOT EXISTS curve_trades_tx_log_idx ON curve_trades (tx_hash, log_index)`;
      await sql`CREATE INDEX IF NOT EXISTS curve_trades_token_ts_idx ON curve_trades (token_address, created_at)`;
      await sql`
        CREATE TABLE IF NOT EXISTS indexer_cursor (
          id text PRIMARY KEY,
          block numeric NOT NULL,
          updated_at timestamp NOT NULL DEFAULT now()
        )
      `;

      await sql`
        CREATE TABLE IF NOT EXISTS contract_verifications (
          address text PRIMARY KEY,
          chain_id numeric NOT NULL,
          kind text NOT NULL,
          sourcify text NOT NULL,
          blockscout text NOT NULL,
          error text,
          updated_at timestamp NOT NULL DEFAULT now()
        )
      `;

      console.log("[indexer] PostgreSQL schema ready");
      return;
    } catch (err) {
      lastError = err;
      console.warn(
        `[indexer] schema bootstrap attempt ${attempt}/${RETRIES} failed:`,
        err instanceof Error ? err.message : err,
      );
      await sleep(RETRY_MS);
    } finally {
      await sql.end({ timeout: 5 }).catch(() => undefined);
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("Failed to bootstrap PostgreSQL schema");
}
