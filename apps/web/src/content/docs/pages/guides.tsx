import Link from "next/link";
import type { DocPage } from "../registry";
import { Callout, Code, C, Steps, Step, Figure, Table } from "@/components/docs/docs-ui";

export const createBasket: DocPage = {
  slug: "guides/create-basket",
  href: "/docs/guides/create-basket",
  title: "Create a basket",
  description: "Walk through the Create page from choosing a deposit to a minted receipt token.",
  sections: [
    {
      id: "walkthrough",
      title: "Walkthrough",
      keywords: ["create page", "deposit asset", "amount", "strategy", "confirm"],
      body: (
        <>
          <Figure src="/docs/create.png" alt="Create basket page" caption="The basket builder with the live summary card." />
          <Steps>
            <Step title="Connect a wallet">Use the Connect wallet button. Compose supports injected wallets, Coinbase, Rainbow and WalletConnect through Privy.</Step>
            <Step title="Pick the deposit asset">Search or choose from the featured grid. The selected tile shows the live quote.</Step>
            <Step title="Enter an amount">Presets are provided. Below the basket minimum the button stays disabled; below the Stockback floor the basket still creates but no reward posts. The summary card shows how much more unlocks the bonus.</Step>
            <Step title="Choose a strategy">Each card shows its risk level, category bands, single-stock cap and how much of the deposit is retained.</Step>
            <Step title="Shape the basket">Prefer or exclude stocks and set the basket size. Watch the donut and lines update in the summary card.</Step>
            <Step title="Confirm">The button enables once the allocator preview is live and free of violations. You will sign an approval and then the deposit. The stepper shows approve, deposit and record.</Step>
          </Steps>
        </>
      ),
    },
    {
      id: "what-can-block-confirm",
      title: "What can block confirm",
      keywords: ["disabled", "no vault", "indexer offline", "violation"],
      body: (
        <Table
          head={["Message", "Meaning", "Fix"]}
          rows={[
            ["Showing a local estimate", "The allocator has not answered", "Wait a moment or check the allocator service"],
            ["Max single stock exceeds cap", "A preferred stock is above the strategy cap", "Remove a preference or pick a larger basket size"],
            ["No vault for X · Strategy", "The factory has no vault for that asset and strategy on this network", "Choose another combination"],
            ["Indexer offline", "The ledger cannot record the deposit", "Start the indexer service"],
          ]}
        />
      ),
    },
  ],
};

export const launchPair: DocPage = {
  slug: "guides/launch-pair",
  href: "/docs/guides/launch-pair",
  title: "Launch a stock × stock pair",
  description: "Create a pair vault, seed it, and optionally list its share on Uniswap v4 in one transaction.",
  sections: [
    {
      id: "before-you-start",
      title: "Before you start",
      keywords: ["faucet", "test tokens", "usdg"],
      body: (
        <ul>
          <li>Hold both stock tokens you want to pair. On testnet, claim them from the Robinhood faucet.</li>
          <li>If you want a DEX pool, also hold USDG worth the slice of the seed you will move into the pool.</li>
          <li>Prices must be fresh. If the launch button says prices are refreshing, wait a minute.</li>
        </ul>
      ),
    },
    {
      id: "steps",
      title: "Steps",
      keywords: ["wizard", "identity", "weights", "fee", "seed", "pool toggle"],
      body: (
        <Steps>
          <Step title="Choose the pair">Any two listed tokens. Uniqueness is enforced on the sorted pair, so TSLA × AMD and AMD × TSLA are the same pair.</Step>
          <Step title="Give it an identity">Name, symbol, description, banner and logo. Metadata is signed with your wallet and stored by the indexer.</Step>
          <Step title="Set the weight split">Between 10% and 90% for token A. The seed you send must match this split within 3% at oracle prices.</Step>
          <Step title="Set the creator fee">1% to 5% of shares minted on other people's deposits, paid to you as shares.</Step>
          <Step title="Enter the seed and, optionally, list on a DEX">Turn on the DEX toggle to move 10–50% of your seed shares into a Uniswap v4 pool against USDG. The card shows the USDG required.</Step>
          <Step title="Launch">Approve token A, approve token B (and USDG if pooling), then one launch transaction. The success screen shows the pair, the transactions and the pool id.</Step>
          <Step title="Source verification happens for you">Right after launch the indexer publishes the vault, share token and creator token source to Sourcify and the block explorer. The pair and token pages show a verified pill that links to the published source once it is through.</Step>
        </Steps>
      ),
    },
    {
      id: "after-launch",
      title: "After launch",
      keywords: ["pair page", "chart", "candles", "creator earnings"],
      body: (
        <>
          <Figure src="/docs/pair.png" alt="Pair detail page" caption="The pair page: value chart, legs, trading and activity." />
          <p>
            Your pair appears on the <Link href="/launchpad">Launchpad</Link> immediately and gets a value chart from the
            first deposit. Creator earnings accrue as shares and show on the pair page.
          </p>
        </>
      ),
    },
  ],
};

export const runLocally: DocPage = {
  slug: "guides/run-locally",
  href: "/docs/guides/run-locally",
  title: "Run the stack locally",
  description: "Developer setup for the web app, services, database and contracts.",
  sections: [
    {
      id: "processes",
      title: "Processes and ports",
      keywords: ["ports", "turbo", "docker compose"],
      body: (
        <>
          <Table
            head={["Process", "Command", "Port"]}
            rows={[
              ["Web", <C key="1">pnpm --filter @compose/web dev</C>, "3000"],
              ["Allocator", <C key="2">pnpm --filter @compose/allocator dev</C>, "3001"],
              ["Quote", <C key="3">pnpm --filter @compose/quote dev</C>, "3002"],
              ["Indexer", <C key="4">pnpm --filter @compose/indexer dev</C>, "3003"],
              ["Everything + keeper", <C key="5">pnpm dev:testnet</C>, "all of the above"],
            ]}
          />
          <p>With Docker, <C>pnpm docker:up</C> builds and starts Redis plus the three services; add <C>--profile local-db</C> for a local Postgres.</p>
        </>
      ),
    },
    {
      id: "database",
      title: "Database",
      keywords: ["postgres", "neon", "schema", "migrations"],
      body: (
        <p>
          The indexer creates and migrates its own tables on boot (<C>ensureSchema</C>), so a fresh Postgres works
          immediately. Point it at a hosted Postgres for production; inside Docker it defaults to the local container.
        </p>
      ),
    },
    {
      id: "contracts",
      title: "Contracts",
      keywords: ["forge", "tests", "fork test"],
      body: (
        <>
          <Code
            code={`cd packages/contracts
forge build
forge test                                             # unit suite
FORK_RPC_URL=https://rpc.testnet.chain.robinhood.com \\
  forge test --match-contract PairPoolFork -vv          # real Uniswap v4 on a testnet fork`}
          />
          <Callout type="note">
            Foundry libraries live under <C>lib/</C> as git submodules. Clone with <C>--recurse-submodules</C> or run{" "}
            <C>git submodule update --init</C>.
          </Callout>
        </>
      ),
    },
  ],
};

export const deployTestnet: DocPage = {
  slug: "guides/deploy-testnet",
  href: "/docs/guides/deploy-testnet",
  title: "Deploy to testnet",
  description: "Deploy the launchpad stack to Robinhood Chain testnet, sync addresses into the app, and keep prices fresh.",
  sections: [
    {
      id: "deploy",
      title: "Deploy",
      keywords: ["deploy:testnet", "forge script", "opening prices"],
      body: (
        <>
          <Steps>
            <Step title="Fund the deployer wallet">The deployer wallet configured in your local environment needs testnet ETH and faucet stock tokens.</Step>
            <Step title="Run the deploy script">
              <Code code={`pnpm deploy:testnet`} />
              <p>The script fetches opening prices, deploys the oracle, push feeds, updater and PairFactory, lists the faucet tokens and writes <C>deployments-testnet.json</C>.</p>
            </Step>
            <Step title="Sync addresses into the app">
              <Code code={`pnpm sync:testnet && pnpm --filter @compose/config build`} />
            </Step>
            <Step title="Enable pool seeding">
              <Code code={`TESTNET_PAIR_FACTORY=0x... TESTNET_USDG=0x... \\
  forge script script/EnableTestnetPool.s.sol --rpc-url $ROBINHOOD_TESTNET_RPC_URL --broadcast`} />
              <p>Points the factory at the real Uniswap v4 PositionManager and Permit2 on testnet with the test USDG as quote.</p>
            </Step>
          </Steps>
        </>
      ),
    },
    {
      id: "keep-prices-fresh",
      title: "Keep prices fresh",
      keywords: ["keeper", "cron", "stale"],
      body: (
        <>
          <Code code={`pnpm keeper:testnet`} />
          <p>Run it as a long-lived process. Without it, feeds go stale after an hour and launches stop until it returns.</p>
        </>
      ),
    },
    {
      id: "mainnet",
      title: "Mainnet",
      keywords: ["RegisterFeeds", "chainlink", "position manager"],
      body: (
        <p>
          <C>DeployMainnet.s.sol</C> deploys the full stack against the real stock tokens. Price feeds are registered
          afterwards with <C>RegisterFeeds.s.sol</C>, which reads one <C>FEED_TICKER</C> variable per token and, when{" "}
          <C>UNISWAP_V4_POSITION_MANAGER</C> is set, enables pool seeding against USDG.
        </p>
      ),
    },
  ],
};
