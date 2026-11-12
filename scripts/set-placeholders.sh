#!/usr/bin/env bash
# Fill every launch placeholder in one go.
# Usage: scripts/set-placeholders.sh <github-org> <site-host> <goatcounter-code> [formspree-endpoint]
#   e.g. scripts/set-placeholders.sh lake-dev lake-dev.github.io/lake-meter lake-meter https://formspree.io/f/abcd1234
set -euo pipefail
ORG=${1:?github org}; SITE=${2:?site host without https://}; GOAT=${3:?goatcounter code}; FORM=${4:-}
cd "$(dirname "$0")/.."
FILES=$(grep -rlE 'LAKE_ORG|LAKE_SITE_URL|GOATCOUNTER_CODE|FORMSPREE_ENDPOINT|GITHUB_URL|SITE_URL' --include='*.md' --include='*.json' --include='*.html' . | grep -v node_modules | grep -v scripts/set-placeholders.sh)
for f in $FILES; do
  sed -i.bak -e "s#LAKE_ORG#${ORG}#g" -e "s#LAKE_SITE_URL#${SITE}#g" -e "s#GOATCOUNTER_CODE#${GOAT}#g" \
    -e "s#GITHUB_URL#https://github.com/${ORG}/lake-meter#g" -e "s#\bSITE_URL\b#https://${SITE}#g" "$f"
  [ -n "$FORM" ] && sed -i.bak -e "s#FORMSPREE_ENDPOINT#${FORM}#g" "$f"
  rm -f "$f.bak"
done
echo "Updated:"; echo "$FILES"
grep -rnE 'LAKE_ORG|LAKE_SITE_URL|GOATCOUNTER_CODE|GITHUB_URL' --include='*.md' --include='*.json' --include='*.html' . | grep -v set-placeholders || echo "No placeholders left (FORMSPREE_ENDPOINT may remain: the form then falls back to email)."
