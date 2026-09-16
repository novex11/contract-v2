# Pons v2 integration: one market, two lenses

Written 2026-09-16. Contracts in `packages/contracts/src/pons/`, tests in
`test/PonsLaunchpad.t.sol` (mock) and `test/PonsForkMainnet.t.sol` (real factory).

## What was verified on-chain (Robinhood Chain 4663)

Pons v2 launch factory `0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e`
(verified source on Sourcify: `PonsV2LaunchFactory`, solc 0.8.35).

| Check | Result |
|---|---|
| `canLaunch(x)` | `launchEnabled \|\| whitelistedLaunchers[x]`; `launchEnabled()` is **true**, so any address (contracts included) can launch. The docs' "whitelist only" note is stale. |
| Launches, blocks 63.90M–63.99M | 3,193 `TokenLaunched` events from 2,316 distinct deployers |
| `launchFee()` | 0.0005 ETH |
| Launch config 0 | 1B supply, 1% curve fee, 1.68 ETH phantom / 4.2 ETH threshold (ETH quote), tick spacing 200 |
| Approved quote tokens | 43 ERC-20s: the **Robinhood stock tokens** (NVDA, TSLA, AAPL, SPY, GME, GLD, SGOV, …) plus USDG. 41 of them are in `packages/config/src/mainnet-manifest.json`. |
| Stock economics | e.g. NVDA: phantom 16.64, threshold 41.6 (18 dec); USDG: phantom 3,236, threshold 8,090 (6 dec) |
| Snipe tax | 99% in the launch second, decaying to 0 over 3 s; launcher, creator fee recipient and up to 32 declared wallets are exempt |
| `maxCreatorTaxBps()` | 1,000 |

The gate is owner-controlled (`setLaunchEnabled`), so Pons can close it later.
`PonsLauncher.launch` checks `canLaunch(address(this))` and fails with a clear
reason if that happens; the fallback is asking Pons to whitelist the launcher.

## Design

A token can only have one market. To make price and volume identical on Pons
and Compose, the **Pons v2 bonding curve is the single venue** and Compose is
a second lens on it:

- **`PonsLauncher.launch(pair, …)`** — only the pair creator, once per pair.
  Calls `PonsV2LaunchFactory.launchToken` with the pair's receipt name/symbol
  (same identity as `ComposeCurve.createToken`), the creator as
  `creatorFeeRecipient`, and one of the pair's two stocks (or USDG) as the
  quote asset. Forwards the 0.0005 ETH launch fee, optional snipe-tax
  exemptions and an optional untaxed dev buy in the same transaction. Records
  pair ↔ token ↔ curve.
- **`PonsRouter`** — every trade lands on the Pons curve:
  - `buy` / `sell`: quote stock (direct), USDG or ETH (swap along a v3 path
    floored at the oracle price, like `PairRouter`).
  - `buyWithShares`: redeem pair shares → both stocks → swap the non-quote leg
    → curve. `sellForShares`: curve → quote → split at the vault's reserve
    ratio → both stocks → `depositFor` → shares to the seller (router must be
    fee-exempt on `PairFactory`).
  - Views: `priceInQuote`, `priceUsd8`, `priceInShares`, `marketCapUsd8`,
    `progressBps`, `quoteBuy`, `quoteSell`. `priceInShares × sharePrice ==
    priceUsd8` holds exactly; the "two stocks" price is a unit conversion of
    the Pons price, not a second market.

What changes versus `ComposeCurve`: the curve reserve is one stock (or USDG)
held by Pons, not the pair share, so token buys no longer create demand for
both stocks. Compose's 30% protocol share of curve fees goes away (Pons keeps
its own 30% protocol share of the 1% curve fee; the remaining 70% plus any
creator tax belongs to the creator). A splitter as `creatorFeeRecipient` or a
router fee can restore a Compose cut later. Fees on the Pons side: 1% curve fee
plus an optional creator tax up to 10%.

## Creator fees: sweep, then claim (verified on-chain 2026-09-16)

Pons never pushes fees to the creator. This was checked against live curves
and matches cudapad.com (a frontend + keeper built purely on Pons v2) and
docs.ponsfamily.com/docs/v2:

| Step | Where | Who |
|---|---|---|
| Accrue | on the token's curve: `quoteFeeBalance()` (curve fee) and `creatorTaxBalance()` (creator tax) | every buy/sell |
| Sweep | `curve.sweepFees(minBuybackTokensOut)` credits the creator's share to the shared fee escrow `0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e` and pays Pons its protocol share | **only the creator fee recipient** (`NotFeeSweepOperator` for anyone else, including the launch's deployer) |
| Claim | `escrow.claimToken(quote)` (or `claim()` for ETH quotes) pays `msg.sender`'s balance | the creator fee recipient |
| After graduation | `sweepPoolFees(poolId, minConversionQuoteOut, minBuybackTokensOut)` on the Pons meme hook, then the same claim | the creator fee recipient |

`PonsLauncher` sets `creatorFeeRecipient = msg.sender` (the pair creator), so
the creator can do all of this from their own wallet, and nobody else can do it
for them; a keeper cannot sweep on the creator's behalf. The web exposes both
steps on the token page (`PonsCreatorFees`, backed by `usePonsCreatorFees` and
`usePonsCreatorFeeActions`). The recipient can be changed later through the
factory's `setCreatorFeeRecipient(token, newRecipient)`, behind a 3-day timelock
(`CREATOR_FEE_RECIPIENT_TIMELOCK = 259200`), which is the path to a fee
splitter if Compose wants a cut.

## Deployer of record on Pons

The Pons factory attributes each launch to `msg.sender`, so Pons shows
`PonsLauncher` as the deployer of tokens launched from Compose (the creator is
still the fee recipient, exempt from the snipe tax, and receives the dev buy).
`launchTokenFor(params, configId, quote, deployer, exemptions)` would fix the
attribution, but it reverts with `NotLaunchForwarder` for anyone except Pons's
own launch-and-buy forwarder `0xe33E9E479dF8802cb0866d5d05258bEc4cF62948`, so
it needs Pons to whitelist our launcher. Until then, an "adopt an existing
Pons token" path (creator launches on Pons directly, then links the token to
the pair on Compose) is the alternative; see follow-ups.

Other facts checked on-chain: `snipeTaxSeconds() = 3`, `snipeTaxStartBps() =
9900`, `maxCreatorTaxBps() = 1000`, curves are full contracts (not clones) and
are not verified on Sourcify; only the factory is.

## Deploy

```
bash scripts/deploy-pons.sh mainnet
```
Deploys `PonsLauncher(pairFactory, ponsFactory, usdg)` and
`PonsRouter(launcher, pairRouter)`, sets the router fee-exempt when the deployer
owns `PairFactory`, writes `packages/contracts/deployments-pons-4663.json` and
merges the addresses into `deployments-mainnet-launchpad.json` and
`packages/config/src/mainnet-deployments.json` (`contracts.ponsFactory /
ponsLauncher / ponsRouter`). Pons v2 has no known testnet deployment; pass
`PONS_FACTORY` explicitly.

**Superseded deployment (2026-09-16):** PonsLauncher
`0x1E6783DDf818945849003B7b2BB11c1e7874ac19` and PonsRouter
`0x6Fd711D16c82Fe3635bd8E6e928f6Ab344083B65` were deployed against the
pre-cutover PairFactory `0x5Aa9…E764`. The launcher's factory is immutable, so
they cannot see pairs on the live factory `0x14F7…dc69` (PR #5) and must be
redeployed; the config keeps `ponsLauncher` / `ponsRouter` empty until then.

## Done on this branch

- Indexer ingests `TokenLaunched` from `PonsLauncher` and `CurveBuy` /
  `CurveSell` from every launched curve, converting quote → USD → pair shares
  (`services/indexer/src/pons-indexer.ts`).
- Web: "Launch on Pons" venue on the pair page (quote pick, dev buy, snipe-tax
  exemptions, pinned economics), token page on `PonsRouter` views, trade panel
  paying/receiving ETH, USDG, the quote stock or pair shares, creator fee
  sweep + claim, graduated tokens link to Pons.
- `PonsRouter` refuses trades on a graduated curve with
  `PonsRouter: graduated, trade on Uniswap` instead of bubbling Pons's error.
- Config keys `ponsFactory`, `ponsLauncher`, `ponsRouter` in the mainnet and
  testnet deployment JSON; addresses filled in by `scripts/deploy-pons.sh`.

## Follow-ups (phase 2)

1. **Post-graduation trading**: Pons moves liquidity into a Uniswap v4 pool
   (`PoolManager 0x8366a3…e40951`, `PonsV2MemeHook 0xE5e702…6Be044`, locker
   `0x267444…574952`); the router needs a v4 leg so the pair-share lens keeps
   working, and the creator fee card needs `sweepPoolFees` on the hook.
2. **Adopt an existing Pons token**: let a creator who launched on Pons
   directly (creator as deployer of record, Pons's own launch-and-buy) link
   that token to their pair: `curve.deployer() == msg.sender == vault.creator()`,
   quote ∈ pair legs ∪ USDG, name/symbol equal to the receipt's.
3. **Compose fee share**: a splitter contract set as the creator fee recipient
   through the factory's timelocked `setCreatorFeeRecipient`.
4. **Indexer**: read the escrow's `Credited*` / `Claimed*` events to show
   lifetime creator earnings; today the card reads live balances only.
5. **Deploy target**: redeploy against the PairFactory that `main` will use
   after PR #10 (`0x94E271F4B53B536E867c128792B62701d9eC4f5A`, PairRouter
   `0x2562c91CaD2d998a6ECaC4cAbe9033abEBb06Fa3`), not the PR #5 one, so the
   launcher does not go stale again.
