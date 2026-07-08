#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Alan Johnson
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: scripts/publish-foundrymods.sh --manifest-url URL --package-url URL --notes-url URL [options]

Options:
  --id ID                        Foundry module id. Default: read from module.json.
  --dry-run true|false           Validate without saving. Default: true.
  --changelog-file PATH          Markdown changelog body to send to FoundryMods.
  --sync-description true|false  Ask FoundryMods to sync the GitHub README. Default: true.
  --discord-announce true|false  Ask FoundryMods to announce on Discord. Default: false.

Environment:
  FOUNDRYMODS_TOKEN              Required. FoundryMods per-module token, usually fmp_...

Important:
  The package id is the manifest id, not the human-readable title.
  For this module: id=vision-restrictor-module, title=Vision Restrictor.
USAGE
}

read_manifest_field() {
  local field="$1"
  python3 - "$field" <<'PY_READ_FIELD'
import json
import sys
from pathlib import Path
field = sys.argv[1]
manifest = json.loads(Path("module.json").read_text(encoding="utf-8"))
print(manifest[field])
PY_READ_FIELD
}

PACKAGE_ID=""
MANIFEST_URL=""
PACKAGE_URL=""
NOTES_URL=""
CHANGELOG_FILE=""
DRY_RUN="true"
SYNC_DESCRIPTION="true"
DISCORD_ANNOUNCE="false"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --id) PACKAGE_ID="${2:-}"; shift 2 ;;
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

if [[ -z "$PACKAGE_ID" ]]; then
  PACKAGE_ID="$(read_manifest_field id)"
fi
MANIFEST_ID="$(read_manifest_field id)"
MANIFEST_TITLE="$(read_manifest_field title)"

if [[ "$PACKAGE_ID" != "$MANIFEST_ID" ]]; then
  echo "ERROR: --id '$PACKAGE_ID' does not match module.json id '$MANIFEST_ID'." >&2
  exit 2
fi

if [[ -z "${FOUNDRYMODS_TOKEN:-}" ]]; then
  echo "ERROR: FOUNDRYMODS_TOKEN is required." >&2
  exit 2
fi

for value in MANIFEST_URL PACKAGE_URL NOTES_URL; do
  if [[ -z "${!value}" ]]; then
    echo "ERROR: $value is required." >&2
    exit 2
  fi
done

case "$DRY_RUN" in true|false) ;; *) echo "ERROR: --dry-run must be true or false." >&2; exit 2 ;; esac
case "$SYNC_DESCRIPTION" in true|false) ;; *) echo "ERROR: --sync-description must be true or false." >&2; exit 2 ;; esac
case "$DISCORD_ANNOUNCE" in true|false) ;; *) echo "ERROR: --discord-announce must be true or false." >&2; exit 2 ;; esac

TMP_PAYLOAD="$(mktemp)"
TMP_RESPONSE="$(mktemp)"
trap 'rm -f "$TMP_PAYLOAD" "$TMP_RESPONSE"' EXIT

export PACKAGE_ID MANIFEST_URL PACKAGE_URL NOTES_URL CHANGELOG_FILE DRY_RUN SYNC_DESCRIPTION DISCORD_ANNOUNCE
python3 - <<'PY_PAYLOAD' > "$TMP_PAYLOAD"
import json
import os
from pathlib import Path

payload = {
    "id": os.environ["PACKAGE_ID"],
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
PY_PAYLOAD

echo "Publishing to FoundryMods release API"
echo "  manifest id:    $MANIFEST_ID"
echo "  manifest title: $MANIFEST_TITLE"
echo "  request id:     $PACKAGE_ID"
echo "  dry-run:        $DRY_RUN"
echo "  manifest URL:   $MANIFEST_URL"
echo "  package URL:    $PACKAGE_URL"

HTTP_CODE="$(curl -sS \
  -o "$TMP_RESPONSE" \
  -w '%{http_code}' \
  -X POST "https://foundrymods.com/api/public/v1/packages/release_version" \
  -H "Content-Type: application/json" \
  -H "Authorization: ${FOUNDRYMODS_TOKEN}" \
  -d "@$TMP_PAYLOAD")"

cat "$TMP_RESPONSE"
echo

if [[ "$HTTP_CODE" -ge 400 ]]; then
  if grep -qi 'id mismatch' "$TMP_RESPONSE"; then
    cat >&2 <<'MISMATCH_HELP'

FoundryMods reported an id mismatch.

The release request uses id=vision-restrictor-module. If the API says it expected
"Vision Restrictor", the token is still attached to a FoundryMods package record
whose internal id is the title rather than the manifest id, or the token was
created before the package record was corrected.

Do not change module.json to the human title. Keep:
  id:    vision-restrictor-module
  title: Vision Restrictor

On FoundryMods, save the module page where Module ID / URL Slug is
vision-restrictor-module, then generate a fresh Package Release Token from that
same page and update the GitHub Actions secret FOUNDRYMODS_TOKEN.
MISMATCH_HELP
  fi
  exit 22
fi
