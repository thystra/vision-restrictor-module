#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Alan Johnson / Thystra

set -euo pipefail

API_URL="https://foundrymods.com/api/public/v1/packages/release_version"
DRY_RUN="true"
MANIFEST_URL=""
PACKAGE_URL=""
NOTES_URL=""
CHANGELOG_FILE=""
SYNC_DESCRIPTION="true"

usage() {
  cat <<'EOF_USAGE'
Usage: scripts/publish-foundrymods.sh --manifest-url URL [options]

Options:
  --manifest-url URL       Version-specific module.json URL. Required.
  --package-url URL        Version-specific release zip URL. Recommended.
  --notes-url URL          Release notes URL.
  --changelog-file PATH    Markdown changelog body to send inline.
  --dry-run true|false     Validate only when true. Default: true.
  --sync-description true|false
                           Ask FoundryMods to sync README from GitHub. Default: true.

Requires:
  FOUNDRYMODS_TOKEN        fmp_... package release token from FoundryMods.

This script intentionally omits the top-level id when release.manifest is provided.
FoundryMods derives id/version/compatibility from the manifest; if explicit fields are
sent, they must match the manifest exactly.
EOF_USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --manifest-url)
      MANIFEST_URL="${2:-}"; shift 2 ;;
    --package-url)
      PACKAGE_URL="${2:-}"; shift 2 ;;
    --notes-url)
      NOTES_URL="${2:-}"; shift 2 ;;
    --changelog-file)
      CHANGELOG_FILE="${2:-}"; shift 2 ;;
    --dry-run)
      DRY_RUN="${2:-}"; shift 2 ;;
    --sync-description)
      SYNC_DESCRIPTION="${2:-}"; shift 2 ;;
    -h|--help)
      usage; exit 0 ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 2 ;;
  esac
done

if [[ -z "${FOUNDRYMODS_TOKEN:-}" ]]; then
  echo "ERROR: FOUNDRYMODS_TOKEN is not set." >&2
  exit 2
fi
if [[ -z "$MANIFEST_URL" ]]; then
  echo "ERROR: --manifest-url is required." >&2
  exit 2
fi
if [[ "$DRY_RUN" != "true" && "$DRY_RUN" != "false" ]]; then
  echo "ERROR: --dry-run must be true or false." >&2
  exit 2
fi
if [[ "$SYNC_DESCRIPTION" != "true" && "$SYNC_DESCRIPTION" != "false" ]]; then
  echo "ERROR: --sync-description must be true or false." >&2
  exit 2
fi

# Validate the public manifest URL before asking FoundryMods to fetch it.
echo "Checking manifest URL is publicly fetchable..."
HTTP_CODE="$(curl -L -sS -o /tmp/fm-manifest.json -w '%{http_code}' "$MANIFEST_URL" || true)"
if [[ "$HTTP_CODE" != "200" ]]; then
  echo "ERROR: Manifest URL did not return HTTP 200: $HTTP_CODE" >&2
  echo "URL: $MANIFEST_URL" >&2
  exit 22
fi
python3 -m json.tool /tmp/fm-manifest.json >/dev/null
MANIFEST_ID="$(python3 - <<'PY'
import json
print(json.load(open('/tmp/fm-manifest.json')).get('id', ''))
PY
)"
MANIFEST_TITLE="$(python3 - <<'PY'
import json
print(json.load(open('/tmp/fm-manifest.json')).get('title', ''))
PY
)"
MANIFEST_VERSION="$(python3 - <<'PY'
import json
print(json.load(open('/tmp/fm-manifest.json')).get('version', ''))
PY
)"

if [[ -n "$PACKAGE_URL" ]]; then
  echo "Checking package URL is publicly fetchable..."
  PACKAGE_HTTP_CODE="$(curl -L -sS -o /dev/null -w '%{http_code}' "$PACKAGE_URL" || true)"
  if [[ "$PACKAGE_HTTP_CODE" != "200" && "$PACKAGE_HTTP_CODE" != "302" ]]; then
    echo "WARNING: Package URL returned HTTP $PACKAGE_HTTP_CODE before publish." >&2
    echo "URL: $PACKAGE_URL" >&2
  fi
fi

TMP_PAYLOAD="$(mktemp)"
export DRY_RUN MANIFEST_URL PACKAGE_URL NOTES_URL CHANGELOG_FILE SYNC_DESCRIPTION TMP_PAYLOAD
python3 <<'PY'
import json, os
release = {"manifest": os.environ["MANIFEST_URL"]}
if os.environ.get("PACKAGE_URL"):
    release["package"] = os.environ["PACKAGE_URL"]
if os.environ.get("NOTES_URL"):
    release["notes"] = os.environ["NOTES_URL"]
if os.environ.get("CHANGELOG_FILE"):
    with open(os.environ["CHANGELOG_FILE"], "r", encoding="utf-8") as f:
        release["changelog"] = f.read()
release["foundrymods"] = {
    "sync_description_from_github": os.environ.get("SYNC_DESCRIPTION", "true") == "true"
}
payload = {
    "dry-run": os.environ["DRY_RUN"] == "true",
    "release": release
}
with open(os.environ["TMP_PAYLOAD"], "w", encoding="utf-8") as f:
    json.dump(payload, f, indent=2)
    f.write("\n")
PY

echo "Publishing to FoundryMods release API"
echo "  manifest id:      $MANIFEST_ID"
echo "  manifest title:   $MANIFEST_TITLE"
echo "  manifest version: $MANIFEST_VERSION"
echo "  request id:       <omitted; derived from manifest>"
echo "  dry-run:          $DRY_RUN"
echo "  manifest URL:     $MANIFEST_URL"
echo "  package URL:      ${PACKAGE_URL:-<omitted>}"

set +e
RESPONSE="$(curl -sS -X POST "$API_URL" \
  -H "Content-Type: application/json" \
  -H "Authorization: ${FOUNDRYMODS_TOKEN}" \
  --data-binary "@$TMP_PAYLOAD")"
STATUS=$?
set -e

echo "$RESPONSE"
rm -f "$TMP_PAYLOAD"

if [[ $STATUS -ne 0 ]]; then
  exit $STATUS
fi

if python3 - <<'PY' <<<"$RESPONSE"
import json, sys
data = json.load(sys.stdin)
sys.exit(0 if data.get('status') == 'success' else 1)
PY
then
  exit 0
fi

if grep -q 'Package id does not match this token' <<<"$RESPONSE"; then
  cat >&2 <<'EOF_ERROR'

FoundryMods rejected the token/id pairing. The request is deriving the id from
release.manifest, so if the manifest id above is correct, this is not a workflow
payload mismatch. It means the FoundryMods token is scoped to a different/stale
internal package id. Recreate the FoundryMods package entry from the manifest URL,
or ask FoundryMods support to repair the package's internal id.
EOF_ERROR
fi

exit 22
