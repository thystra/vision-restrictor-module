#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Alan Johnson

set -euo pipefail

MODULE_ID="vision-restrictor-module"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${1:-${ROOT}/../${MODULE_ID}.zip}"

command -v zip >/dev/null 2>&1 || {
  echo "ERROR: zip is required to package ${MODULE_ID}." >&2
  exit 1
}

rm -f "$OUT"
mkdir -p "$(dirname "$OUT")"

(
  cd "$ROOT/.."
  zip -r "$OUT" "$MODULE_ID" \
    -x "${MODULE_ID}/.git/*" \
    -x "${MODULE_ID}/.github/*" \
    -x "${MODULE_ID}/node_modules/*" \
    -x "${MODULE_ID}/dist/*" \
    -x "${MODULE_ID}/.DS_Store" \
    -x "${MODULE_ID}/*.zip"
)

echo "Created $OUT"
