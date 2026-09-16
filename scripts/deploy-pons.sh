#!/usr/bin/env bash
# Deploy PonsLauncher + PonsRouter against the live PairFactory / PairRouter and Pons v2.
#   bash scripts/deploy-pons.sh mainnet            # Pons v2 factory on Robinhood Chain (4663)
#   PONS_FACTORY=0x... bash scripts/deploy-pons.sh testnet
# Writes packages/contracts/deployments-pons-<chainId>.json.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

NETWORK="${1:-}"
if [[ "$NETWORK" != "testnet" && "$NETWORK" != "mainnet" ]]; then
  echo "usage: $0 testnet|mainnet"
  exit 1
fi

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi
export PATH="$HOME/.foundry/bin:$PATH"
if [[ -z "${DEPLOYER_PRIVATE_KEY:-}" ]]; then
  echo "❌  DEPLOYER_PRIVATE_KEY is not set in .env"
  exit 1
fi
export DEPLOYER_PRIVATE_KEY="0x${DEPLOYER_PRIVATE_KEY#0x}"

# Pons v2 launch factory (verified PonsV2LaunchFactory) on Robinhood Chain mainnet.
PONS_MAINNET_FACTORY="0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e"

if [[ "$NETWORK" == "testnet" ]]; then
  RPC="${ROBINHOOD_TESTNET_RPC_URL:-https://rpc.testnet.chain.robinhood.com}"
  CONFIG="packages/config/src/testnet-deployments.json"
  CHAIN_ID=46630
  if [[ -z "${PONS_FACTORY:-}" ]]; then
    echo "❌  Pons v2 has no known testnet deployment; set PONS_FACTORY explicitly"
    exit 1
  fi
else
  RPC="${ROBINHOOD_RPC_URL:-https://rpc.mainnet.chain.robinhood.com}"
  CONFIG="packages/contracts/deployments-mainnet-launchpad.json"
  CHAIN_ID=4663
  PONS_FACTORY="${PONS_FACTORY:-$PONS_MAINNET_FACTORY}"
fi

read_contract() { node -p "require('./$CONFIG').contracts.$1 || ''"; }
PONS_PAIR_FACTORY="$(read_contract pairFactory)"
PONS_PAIR_ROUTER="$(read_contract pairRouter)"
export PONS_FACTORY PONS_PAIR_FACTORY PONS_PAIR_ROUTER

echo "🔁  $NETWORK: Pons factory $PONS_FACTORY, pair factory $PONS_PAIR_FACTORY, pair router $PONS_PAIR_ROUTER"
echo "    Pons launchEnabled: $(cast call "$PONS_FACTORY" 'launchEnabled()(bool)' --rpc-url "$RPC")"
echo "    Pons launchFee:     $(cast call "$PONS_FACTORY" 'launchFee()(uint256)' --rpc-url "$RPC" | awk '{print $1}') wei"

cd packages/contracts
forge clean >/dev/null
forge script script/DeployPons.s.sol:DeployPons --rpc-url "$RPC" --broadcast --slow -vv
cd "$ROOT"

OUT="packages/contracts/deployments-pons-$CHAIN_ID.json"
echo "✅  wrote $OUT"
cat "$OUT"

# Carry the addresses into the launchpad deployment file and the synced config
# (contracts.ponsFactory / ponsLauncher / ponsRouter) so the indexer and web pick them up.
merge_into() {
  node -e '
    const fs = require("fs");
    const out = require("./'"$OUT"'");
    const file = process.argv[1];
    const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
    cfg.contracts = cfg.contracts || {};
    cfg.contracts.ponsFactory = out.ponsFactory;
    cfg.contracts.ponsLauncher = out.ponsLauncher;
    cfg.contracts.ponsRouter = out.ponsRouter;
    fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n");
    console.log("   updated " + file);
  ' "$1"
}
merge_into "$CONFIG"
if [[ "$NETWORK" == "mainnet" ]]; then
  merge_into "packages/config/src/mainnet-deployments.json"
fi
echo
echo "Next: commit the updated deployment files, redeploy the indexer + web, and set NEXT_PUBLIC_PONS_* on Render if env overrides are used."
