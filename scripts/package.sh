#!/usr/bin/env bash
set -euo pipefail
MODULE_ID="vision-restrictor"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${ROOT}/../${MODULE_ID}.zip"
rm -f "$OUT"
(
  cd "$ROOT/.."
  zip -r "$OUT" "$MODULE_ID" \
    -x "${MODULE_ID}/.git/*" \
    -x "${MODULE_ID}/node_modules/*" \
    -x "${MODULE_ID}/.DS_Store"
)
echo "Created $OUT"
