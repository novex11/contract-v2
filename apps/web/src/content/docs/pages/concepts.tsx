import Link from "next/link";
import type { DocPage } from "../registry";
import { Callout, Code, C, Figure, Table, Pill } from "@/components/docs/docs-ui";
import { BasketFlowDiagram, LaunchFlowDiagram } from "@/components/docs/diagrams";

export const baskets: DocPage = {
  slug: "baskets",
  href: "/docs/baskets",
  title: "Managed baskets",
  description: "Deposit one tokenized stock and receive a diversified basket held in a strategy vault, represented by a receipt token that tracks NAV.",
  sections: [
    {
      id: "lifecycle",
      title: "Deposit lifecycle",
      keywords: ["deposit", "strategy vault", "receipt token", "nav", "redeem"],
      body: (
        <>
          <Figure caption="From a single stock to a basket, in one transaction.">
            <div className="p-4"><BasketFlowDiagram /></div>
          </Figure>
          <ol>
            <li><strong>Choose</strong> a deposit stock, an amount, a strategy and optional preferences on the <Link href="/create">Create</Link> page.</li>
            <li><strong>Preview</strong>: the allocator returns the exact lines, weights and Stockback. The button stays disabled until the allocator has answered and the allocation passes every rule.</li>
            <li><strong>Approve and deposit</strong>: one approval, then <C>StrategyVault.deposit</C> with the basket tokens and their weights in basis points.</li>
            <li><strong>On chain</strong>: the vault checks pauses and pending stock splits, asks the AllocationController to validate the weights, prices the deposit through the oracle, swaps each leg through the ExecutionRouter and mints receipt shares.</li>
            <li><strong>Stockback</strong> is paid from the CashbackReserve in the same transaction when the deposit qualifies.</li>
          </ol>
        </>
      ),
    },
    {
      id: "receipt-tokens",
      title: "Receipt tokens",
      keywords: ["tNVDA-B", "shares", "non-transferable", "share price"],
      body: (
        <>
          <p>
            Each vault mints a receipt token named after its deposit asset and strategy, for example <C>tNVDA-B</C> for
            NVDA on the Balanced strategy. Shares are <strong>non-transferable</strong>: they can only be minted on deposit and
            burned on redemption, which keeps the vault's accounting simple and auditable.
          </p>
          <p>
            Share price is <C>navUsd8 × 1e18 / totalShares</C>, where NAV is the oracle value of every token the vault holds.
            The first depositor mints one share per dollar.
          </p>
        </>
      ),
    },
    {
      id: "redemption",
      title: "Redemption modes",
      keywords: ["redeem", "original asset", "proportional", "usdg"],
      body: (
        <Table
          head={["Mode", "You receive", "Notes"]}
          rows={[
            ["Original asset", "The deposit stock", "Basket legs are swapped back into the deposit asset"],
            ["Proportional basket", "Every basket token pro rata", "No swaps; you take the lines as they are"],
            ["USD stable", "USDG", "Every leg is swapped to the vault's stable asset"],
          ]}
        />
      ),
    },
    {
      id: "guardrails",
      title: "Guardrails",
      keywords: ["tvl cap", "pause", "multiplier", "erc-8056", "slippage"],
      body: (
        <ul>
          <li><strong>Allocation rules</strong> are enforced on chain: only approved assets, weights summing to exactly 100%, and a per-strategy cap on any single stock.</li>
          <li><strong>Stock splits</strong>: Robinhood stock tokens implement ERC-8056 multipliers. Deposits are refused while a multiplier change is pending, so nobody deposits at a stale ratio.</li>
          <li><strong>TVL cap</strong> per vault and independent pause switches for deposits, swaps, rebalances and cashback.</li>
          <li><strong>Redemption never depends on oracle freshness</strong>, so a late price update can never lock funds.</li>
        </ul>
      ),
    },
  ],
};

export const strategies: DocPage = {
  slug: "strategies",
  href: "/docs/strategies",
  title: "Strategies",
  description: "Three published profiles decide how a deposit is spread across categories and how concentrated any single stock may be.",
  sections: [
    {
      id: "profiles",
      title: "The three profiles",
      keywords: ["defensive", "balanced", "aggressive", "bands", "max single stock"],
      body: (
        <>
          <Table
            head={["", "Defensive", "Balanced", "Aggressive"]}
            rows={[
              ["Large cap", "35–45%", "40–55%", "10–25%"],
              ["Growth", "0–15%", "15–25%", "50–70%"],
              ["Broad market (ETFs)", "20–30%", "10–20%", "0–10%"],
              ["Thematic", "0–5%", "0–5%", "10–25%"],
              ["Stable", "15–25%", "5–10%", "0–5%"],
              ["Forex", "5–15%", "5–15%", "0–10%"],
              [<strong key="m">Max single stock</strong>, <strong key="d">15%</strong>, <strong key="b">25%</strong>, <strong key="a">35%</strong>],
              ["Deposit retained", "15%", "20%", "25%"],
            ]}
          />
          <p>
            Bands come from <C>packages/config/src/strategies.ts</C>. The single-stock cap is also stored on chain in the
            AllocationController and enforced on every deposit.
          </p>
        </>
      ),
    },
    {
      id: "custom-basket",
      title: "Custom basket controls",
      keywords: ["prefer", "exclude", "basket size", "max tokens"],
      body: (
        <ul>
          <li><strong>Prefer</strong> stocks are always included and weighted higher.</li>
          <li><strong>Exclude</strong> removes a stock from consideration.</li>
          <li><strong>Basket size</strong> caps the number of stock lines. Only tokens deployed and approved on the current network are eligible.</li>
        </ul>
      ),
    },
    {
      id: "violations",
      title: "When a basket breaks a rule",
      keywords: ["violation", "cap exceeded", "disabled confirm"],
      body: (
        <Callout type="warning" title="Confirm is disabled until the basket is valid">
          If a preference pushes a stock above the strategy's cap, the preview shows the violation and the deposit button
          stays disabled. Remove a preferred stock or choose a larger basket size. The same rule is enforced on chain, so
          a violating basket could never be deposited anyway.
        </Callout>
      ),
    },
  ],
};

export const stockback: DocPage = {
  slug: "stockback",
  href: "/docs/stockback",
  title: "Stockback rewards",
  description: "A published, deterministic reward on qualifying basket deposits, paid in tokens from an on-chain reserve.",
  sections: [
    {
      id: "rules",
      title: "Published rules",
      keywords: ["deposit bonus", "floor", "lifetime cap", "rates"],
      body: (
        <Table
          head={["Parameter", "Value"]}
          rows={[
            ["Minimum qualifying deposit", "$100"],
            ["Maximum rewarded deposit", "$10,000"],
            ["Deposit bonus", "$2.00 flat"],
            ["Per-stock allocation reward", "0.3% – 1.0% of the amount bought, by ticker (default 0.5%)"],
            ["Per-wallet lifetime cap", "$50"],
            ["Duplicate guard", "24 hours"],
          ]}
        />
      ),
    },
    {
      id: "how-it-is-paid",
      title: "How it is paid",
      keywords: ["cashback reserve", "budget", "authorized vaults"],
      body: (
        <>
          <p>
            The vault calls <C>CashbackReserve.payDepositStockback</C> after minting shares. The reserve checks the floor, the
            budget, the wallet cap and the duplicate guard, then transfers reward tokens which the vault forwards to you.
            The call is wrapped so a reward failure never blocks a deposit.
          </p>
          <Callout type="note">
            The Create page shows exactly how much more you need to deposit to unlock the bonus, and the preview's Stockback
            figure is the amount that will post on confirm.
          </Callout>
        </>
      ),
    },
  ],
};

export const launchpad: DocPage = {
  slug: "launchpad",
  href: "/docs/launchpad",
  title: "Pair launchpad",
  description: "Turn any two listed stocks into a single tradable asset: a pair vault that holds both tokens in kind and issues a transferable share.",
  sections: [
    {
      id: "what-you-launch",
      title: "What you launch",
      keywords: ["pair vault", "stock x stock", "weight", "creator fee", "share token"],
      body: (
        <>
          <Figure src="/docs/launch.png" alt="Launch wizard" caption="The launch wizard: pick two tokens, a weight split, a creator fee, a seed and optionally a DEX pool." />
          <p>
            A launch deploys a <strong>PairVault</strong> and seeds it with your two tokens in one transaction. The vault
            holds both reserves directly; there is no bonding curve and no swap on deposit. The vault is its own ERC-20
            share token: shares are minted only against deposits, burned only by the holder who redeems them, and, unlike
            basket receipts, are freely transferable. No address can mint or burn them otherwise.
          </p>
          <Figure caption="Launch with pool seeding: vault (which is the share token) and a Uniswap v4 pool in one transaction.">
            <div className="p-4"><LaunchFlowDiagram /></div>
          </Figure>
        </>
      ),
    },
    {
      id: "parameters",
      title: "Parameters",
      keywords: ["limits", "bounds", "weight range", "fee range"],
      body: (
        <Table
          head={["Parameter", "Range", "Enforced"]}
          rows={[
            ["Weight of token A", "10% – 90%", "on chain"],
            ["Creator fee", "1% – 5% of gross shares on other people's deposits", "on chain"],
            ["Seed value split", "within 3% of the target weight at oracle prices", "on chain"],
            ["Minimum seed", "$1 on chain, $5 in the UI", "both"],
            ["Pairs per creator", "10", "on chain"],
            ["Pool share of seed", "10% – 50% of minted shares", "on chain"],
          ]}
        />
      ),
    },
    {
      id: "deposits-and-redemptions",
      title: "Deposits and redemptions",
      keywords: ["proportional", "in kind", "oracle independent"],
      body: (
        <ul>
          <li>The <strong>first deposit</strong> (the seed) must match the target weight at fresh oracle prices and mints one share per dollar.</li>
          <li><strong>Later deposits</strong> are proportional to current reserves. They never touch the oracle, so share math cannot be skewed by a stale feed.</li>
          <li><strong>Redemption</strong> burns shares for a proportional slice of both tokens. It is never paused by price staleness.</li>
          <li>The <strong>creator fee</strong> is minted as extra shares to the creator on deposits by others. The creator's own deposits, including the launch seed, are fee-free.</li>
          <li>Deposits pause automatically while either stock has a pending ERC-8056 multiplier change.</li>
        </ul>
      ),
    },
    {
      id: "buy-with-usdg-or-eth",
      title: "Buying with USDG or ETH",
      keywords: ["pair router", "swap", "slippage"],
      body: (
        <p>
          You do not need to hold both stocks. The <C>PairRouter</C> swaps USDG or ETH into the two legs through the
          configured swap router, deposits them for you and refunds any dust. Selling redeems your shares and swaps both
          legs back. Every swap is floored at the oracle price minus a slippage cap, so a thin pool cannot fill far from fair
          value.
        </p>
      ),
    },
  ],
};

export const dexPools: DocPage = {
  slug: "dex-pools",
  href: "/docs/dex-pools",
  title: "DEX pools & visibility",
  description: "Why a pair share is listed in a real Uniswap v4 pool at launch, how the pool is priced, and what trading terminals see.",
  sections: [
    {
      id: "why-a-pool",
      title: "Why a pool",
      keywords: ["axiom", "dexscreener", "terminals", "uniswap v4", "indexing"],
      body: (
        <>
          <p>
            Trading terminals such as Axiom and DexScreener discover tokens by watching DEX pools. A vault share that never
            trades on a DEX is invisible to them, however useful it is. So a launch can open a <strong>Uniswap v4 pool</strong>{" "}
            of the share token against USDG in the same transaction that creates the vault.
          </p>
          <Callout type="tip" title="Anchored to NAV">
            Because anyone can redeem shares in kind for the two underlying stocks, arbitrage keeps the pool price close to
            vault NAV. The pool is the visibility and convenience layer; the vault stays the source of truth.
          </Callout>
        </>
      ),
    },
    {
      id: "how-seeding-works",
      title: "How seeding works",
      keywords: ["pool key", "fee tier", "tick spacing", "permit2", "position manager", "full range"],
      body: (
        <>
          <ol>
            <li>The factory seeds the vault and receives all minted shares.</li>
            <li>It prices the chosen slice of shares (10–50%) at NAV and pulls the matching amount of USDG from the creator.</li>
            <li>It initialises a v4 pool with key <C>(share, USDG, fee 0.30%, tick spacing 60, no hook)</C> at exactly that price.</li>
            <li>It mints a full-range position through the v4 PositionManager, funded via Permit2, and sends the LP NFT to the creator.</li>
            <li>The remaining shares and any unused USDG go back to the creator.</li>
          </ol>
          <p>The pool id, key and position id are stored on the factory (<C>poolIdOf</C>, <C>poolKeyOf</C>, <C>poolPositionOf</C>) and emitted in <C>PoolSeeded</C>.</p>
        </>
      ),
    },
    {
      id: "networks-and-addresses",
      title: "Networks",
      keywords: ["testnet", "mainnet", "same addresses"],
      body: (
        <p>
          Uniswap v4 is deployed at the same addresses on Robinhood Chain testnet and mainnet, so the seeding path is
          identical on both. See <Link href="/docs/reference/addresses">Deployed addresses</Link>.
        </p>
      ),
    },
  ],
};

export const creatorTokens: DocPage = {
  slug: "creator-tokens",
  href: "/docs/creator-tokens",
  title: "Creator tokens",
  description: "Anyone can launch a community token on any launched pair. Tokens are priced in the pair's share, so demand for the token becomes demand for the two stocks.",
  sections: [
    {
      id: "overview",
      title: "Overview",
      keywords: ["bonding curve", "doppler", "airlock", "numeraire", "unlimited tokens"],
      body: (
        <>
          <p>
            A creator token is a new ERC-20 whose quote asset is a Compose pair share rather than ETH or a stablecoin. Any
            connected wallet can launch one on any launched pair, and a pair can host unlimited tokens. Pairs themselves
            remain unique per stock combination.
          </p>
          <Table
            head={["Network", "Mechanism", "Status"]}
            rows={[
              ["Testnet (46630) and mainnet (4663)", <>Compose bonding curve: 1 B supply on a constant-product curve quoted in the pair share, via <C>ComposeCurve</C> and <C>CurveRouter</C></>, <Pill key="1" tone="accent">live</Pill>],
              ["Mainnet (4663), Pons venue", <>Pons v2 bonding curve quoted in one of the pair&apos;s stocks (or USDG), launched through <C>PonsLauncher</C> and traded through <C>PonsRouter</C></>, <Pill key="3" tone="accent">live</Pill>],
              ["Mainnet (4663), terminal-visible path", "Doppler Airlock launch with the pair share as numeraire; price discovery in a v4 hook, then migration to a Uniswap v4 pool", <Pill key="2" tone="gold">planned</Pill>],
            ]}
          />
        </>
      ),
    },
    {
      id: "pons-venue",
      title: "The Pons venue",
      keywords: ["pons", "one-stock quote", "ponsfamily", "shared market"],
      body: (
        <>
          <p>
            A pair creator can launch the pair&apos;s token on Pons v2 instead of the Compose curve. The token keeps the
            pair&apos;s name and symbol, but its market is a Pons bonding curve quoted in one of the pair&apos;s two stocks
            (or USDG). It is listed on ponsfamily.com from the launch block. The creator&apos;s share of the 1% curve fee
            (70%, plus any creator tax) accrues on the curve; the creator sweeps it into Pons&apos;s fee escrow and claims
            it from the token page. Only the creator&apos;s wallet can do either.
          </p>
          <p>
            There is one market, not two. Every Compose trade on such a token is routed onto the same Pons curve by{" "}
            <C>PonsRouter</C>, whether it is paid in ETH, USDG, the quote stock or the pair&apos;s shares. Compose shows the
            Pons price re-quoted in USD and in pair shares, so price and volume match on both sites by construction.
            Launching costs Pons&apos;s 0.0005 ETH launch fee; Pons taxes buys in the first three seconds after launch
            (99% decaying to zero), with the creator and up to 32 wallets the creator lists at launch exempt.
          </p>
        </>
      ),
    },
    {
      id: "curve-rules",
      title: "Curve rules",
      keywords: ["supply", "graduation", "dev buy", "launch window", "per wallet cap"],
      body: (
        <Table
          head={["Parameter", "Value"]}
          rows={[
            ["Supply", "1,000,000,000 tokens, all on the curve"],
            ["Quote asset", "The pair's share token"],
            ["Graduation", "Flag set at 3.0976× the starting virtual reserve (about 16.8× starting market cap); trading continues on the curve"],
            ["Dev buy", "Creator may buy up to 5% of supply at launch"],
            ["Launch window", "30 seconds; the launch second is creator-only, then max 5.5% per buy and 5% per wallet"],
          ]}
        />
      ),
    },
    {
      id: "fees",
      title: "Fees and claims",
      keywords: ["trade fee", "creator fee", "treasury", "claim"],
      body: (
        <>
          <p>Every curve buy or sell pays a <strong>1% fee in pair shares</strong>, split two ways:</p>
          <Table
            head={["Recipient", "Share", "Claim"]}
            rows={[
              ["Token creator", "70%", <C key="1">ComposeCurve.claimCreatorFees(token)</C>],
              ["Protocol treasury", "30%", "—"],
            ]}
          />
          <Callout type="tip">
            Anyone may trigger a claim; funds always go to the creator. Fees arrive as pair shares, which can be sold for ETH
            or USDG or redeemed for the two stocks on the pair page.
          </Callout>
        </>
      ),
    },
    {
      id: "why-doppler",
      title: "Why Doppler on mainnet",
      keywords: ["visibility", "axiom", "airlock"],
      body: (
        <Callout type="note">
          Doppler is the launch infrastructure the Robinhood Chain ecosystem already uses, and the terminals index its
          Airlock registry from block one. Launching through it gives creator tokens the same visibility as the pair
          shares. Curve tokens trade on Compose and are indexed by the Compose indexer, not by third-party terminals, until
          they also have a DEX pool.
        </Callout>
      ),
    },
  ],
};

export const oracles: DocPage = {
  slug: "oracles",
  href: "/docs/oracles",
  title: "Oracles & price feeds",
  description: "How contracts get prices, what happens when a feed is stale, and how testnet feeds stay fresh.",
  sections: [
    {
      id: "oracle-adapter",
      title: "OracleAdapter",
      keywords: ["chainlink", "staleness", "getPrice", "getPriceUnchecked"],
      body: (
        <>
          <p>
            Every contract reads prices through <C>OracleAdapter</C>, which maps a token to a Chainlink-compatible feed.
            <C>getPrice</C> reverts if the answer is older than the staleness threshold (one hour by default);{" "}
            <C>getPriceUnchecked</C> ignores staleness and is used only for views such as NAV, so a late keeper never
            breaks reads or redemptions.
          </p>
          <Table
            head={["Call", "Staleness check", "Used by"]}
            rows={[
              [<C key="1">getPrice</C>, "yes", "Basket deposits, launch seeds, pool seeding"],
              [<C key="2">getPriceUnchecked</C>, "no", "NAV, share price, previews, pair redemptions"],
              [<C key="3">isMultiplierPending</C>, "n/a", "Refuses deposits while an ERC-8056 split is scheduled"],
            ]}
          />
        </>
      ),
    },
    {
      id: "testnet-feeds",
      title: "Testnet feeds and the keeper",
      keywords: ["push price feed", "keeper", "heartbeat", "deviation"],
      body: (
        <>
          <p>
            Robinhood Chain testnet has no Chainlink feeds, so each listed token has a <C>PushPriceFeed</C> updated through a{" "}
            <C>PriceFeedUpdater</C> by a keeper. The keeper pushes live market prices whenever a feed moves more than 10 bps
            or its last update is older than 25 minutes.
          </p>
          <Code code={`pnpm keeper:testnet          # loop
pnpm keeper:testnet:once     # single update`} />
          <Callout type="warning" title="Symptom of a stopped keeper">
            If the keeper stops for more than an hour, launches and basket deposits fail with{" "}
            <C>OracleAdapter: stale</C> and the app reports that it cannot determine the deposit token price. Existing pairs keep
            redeeming normally.
          </Callout>
        </>
      ),
    },
  ],
};
