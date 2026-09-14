#!/bin/bash
# Reshoot button: return the demo world to its starting state.
set -euo pipefail
cd "$(dirname "$0")/.."

rm -rf claims-outbox/packets claims-outbox/cards
rm -f  data/claims-index.json data/processed-files.json data/audit.jsonl data/ledger.jsonl
rm -rf data/records data/.approval-lock
find receipts-inbox -type f ! -name '.gitkeep' -delete 2>/dev/null || true

cat > data/fsa-account.json <<'EOF'
{
  "accountHolder": "Sample User",
  "planYear": 2026,
  "annualElection": 2000.0,
  "remainingBalance": 280.0,
  "startingBalance": 280.0,
  "spendDeadline": "2026-12-31",
  "claimFilingDeadline": "2027-03-31",
  "note": "Synthetic demo account. FSA administrators do not offer public APIs; real products v1 use user-entered balances exactly like this."
}
EOF

echo "Demo reset: balance \$280.00, inbox empty, outbox cleared, indexes wiped."
