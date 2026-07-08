#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Alan Johnson

set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: scripts/publish-foundrymods.sh --manifest-url URL --package-url URL --notes-url URL [options]

Options:
  --dry-run true|false            Validate without saving. Default: true.
  --changelog-file PATH           Markdown changelog body to send to FoundryMods.
  --sync-description true|false   Ask FoundryMods to sync the GitHub README. Default: true.
  --discord-announce true|false   Ask FoundryMods to announce on Discord. Default: false.

Environment:
  FOUNDRYMODS_TOKEN               Required. FoundryMods per-module token, usually fmp_...

Example dry run:
  FOUNDRYMODS_TOKEN=fmp_... scripts/publish-foundrymods.sh \
    --dry-run true \
    --manifest-url https://github.com/thystra/vision-restrictor-module/releases/download/v0.1.8/module.json \
    --package-url  https://github.com/thystra/vision-restrictor-module/releases/download/v0.1.8/vision-restrictor-module.zip \
    --notes-url    https://github.com/thystra/vision-restrictor-module/releases/tag/v0.1.8
USAGE
}

MANIFEST_URL=""
PACKAGE_URL=""
NOTES_URL=""
CHANGELOG_FILE=""
DRY_RUN="true"
SYNC_DESCRIPTION="true"
DISCORD_ANNOUNCE="false"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --manifest-url) MANIFEST_URL="${2:-}"; shift 2 ;;
    --package-url) PACKAGE_URL="${2:-}"; shift 2 ;;
    --notes-url) NOTES_URL="${2:-}"; shift 2 ;;
    --changelog-file) CHANGELOG_FILE="${2:-}"; shift 2 ;;
    --dry-run) DRY_RUN="${2:-}"; shift 2 ;;
    --sync-description) SYNC_DESCRIPTION="${2:-}"; shift 2 ;;
    --discord-announce) DISCORD_ANNOUNCE="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "ERROR: Unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if [[ -z "${FOUNDRYMODS_TOKEN:-}" ]]; then
  echo "ERROR: FOUNDRYMODS_TOKEN is required." >&2
  exit 2
fi

for value in MANIFEST_URL PACKAGE_URL NOTES_URL; do
  if [[ -z "${!value}" ]]; then
    echo "ERROR: --${value,,} is required." >&2
    exit 2
  fi
done

case "$DRY_RUN" in true|false) ;; *) echo "ERROR: --dry-run must be true or false." >&2; exit 2 ;; esac
case "$SYNC_DESCRIPTION" in true|false) ;; *) echo "ERROR: --sync-description must be true or false." >&2; exit 2 ;; esac
case "$DISCORD_ANNOUNCE" in true|false) ;; *) echo "ERROR: --discord-announce must be true or false." >&2; exit 2 ;; esac

TMP_PAYLOAD="$(mktemp)"
trap 'rm -f "$TMP_PAYLOAD"' EXIT

export MANIFEST_URL PACKAGE_URL NOTES_URL CHANGELOG_FILE DRY_RUN SYNC_DESCRIPTION DISCORD_ANNOUNCE
python3 - <<'PY' > "$TMP_PAYLOAD"
import json
import os
from pathlib import Path

payload = {
    "dry-run": os.environ["DRY_RUN"] == "true",
    "release": {
        "manifest": os.environ["MANIFEST_URL"],
        "package": os.environ["PACKAGE_URL"],
        "notes": os.environ["NOTES_URL"],
        "foundrymods": {
            "sync_description_from_github": os.environ["SYNC_DESCRIPTION"] == "true",
            "discord_announce": os.environ["DISCORD_ANNOUNCE"] == "true",
        },
    },
}

changelog_file = os.environ.get("CHANGELOG_FILE", "")
if changelog_file:
    path = Path(changelog_file)
    if path.exists():
        text = path.read_text(encoding="utf-8")
        if text.strip():
            payload["release"]["changelog"] = text

print(json.dumps(payload, indent=2))
PY

echo "Publishing to FoundryMods release API (dry-run=${DRY_RUN})"
if curl --help all 2>/dev/null | grep -q -- '--fail-with-body'; then
  CURL_FAIL=(--fail-with-body)
else
  CURL_FAIL=(--fail)
fi

curl "${CURL_FAIL[@]}" \
  -X POST "https://foundrymods.com/api/public/v1/packages/release_version" \
  -H "Content-Type: application/json" \
  -H "Authorization: ${FOUNDRYMODS_TOKEN}" \
  -d "@$TMP_PAYLOAD"

echo
