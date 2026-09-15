#!/usr/bin/env bash
# Writes source-verification inputs (standard JSON) for the contracts our
# factories deploy at launch time: PairVault + PairShareToken (PairFactory) and
# CreatorToken (ComposeCurve). The indexer publishes every newly launched
# contract to Sourcify and the explorer with these.
#
# Re-run after changing any of those contracts or the compiler settings.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="$HOME/.foundry/bin:$PATH"
# foundry.toml references ETHERSCAN_API_KEY; Blockscout does not need a real key.
export ETHERSCAN_API_KEY="${ETHERSCAN_API_KEY:-blockscout}"

OUT="$ROOT/services/indexer/verification"
mkdir -p "$OUT"

cd "$ROOT/packages/contracts"
forge build --no-lint >/dev/null

for name in PairVault PairShareToken CreatorToken; do
  forge verify-contract 0x0000000000000000000000000000000000000001 "src/$name.sol:$name" \
    --verifier blockscout --show-standard-json-input > "$OUT/$name.input.json"
done

node -e '
const fs = require("fs");
const artifact = JSON.parse(fs.readFileSync("out/PairVault.sol/PairVault.json", "utf8"));
const metadata = typeof artifact.metadata === "object" ? artifact.metadata : JSON.parse(artifact.rawMetadata);
const compilerVersion = "v" + metadata.compiler.version;
fs.writeFileSync(process.argv[1], JSON.stringify({ compilerVersion }, null, 2) + "\n");
console.log("compiler", compilerVersion);
' "$OUT/compiler.json"

echo "✅  Verification inputs written to services/indexer/verification"
