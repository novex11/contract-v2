# Explorer verification inputs (mainnet, chain 4663)

`launchpad-4663.input.json` is the solc standard-JSON input (v0.8.24, optimizer 200,
EVM cancun) that compiles the whole launchpad stack deployed on 2026-09-16, and
`launchpad-4663.json` lists each contract's address and ABI-encoded constructor
arguments. Every launched pair vault and curve token is an EIP-1167 clone of the
PairVault / CreatorToken implementations, so once those two are verified every
launch is shown verified instantly; the stack contracts are verified for
completeness.

The mainnet explorer only accepts verification submissions from a browser page
(one per ~30 minutes per IP): open any address on
https://robinhoodchain.blockscout.com and POST
`/api/v2/smart-contracts/<address>/verification/via/standard-input` with
`compiler_version`, `license_type=mit`, `constructor_args` and the input file as
`files[0]`. Testnet accepts `pnpm verify:implementations` directly.
