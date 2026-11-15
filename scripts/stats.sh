#!/usr/bin/env bash
# Public usage numbers, no login needed: npm downloads and GitHub stars/forks/issues.
# Clones and page views need repo admin access: gh api repos/ORG/lake-meter/traffic/clones (and /views).
PKG=${1:-lake-meter}; REPO=${2:-getlake/lake-meter}
echo "npm $PKG"
for p in last-day last-week last-month; do printf "  %-11s " $p; curl -s "https://api.npmjs.org/downloads/point/$p/$PKG" | sed -E 's/.*"downloads":([0-9]+).*/\1/'; echo; done
echo "github $REPO"
curl -s "https://api.github.com/repos/$REPO" | grep -E '"(stargazers_count|forks_count|open_issues_count|subscribers_count)"' | sed 's/^ */  /'
