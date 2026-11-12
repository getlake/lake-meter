# Publishing lake-meter: what you need to do

Nothing has been published, pushed, registered or paid for. Everything below is free.

## 0. Pick names (2 min)
- **npm package:** `lake-meter` was free on 2026-11-12 (`npm view lake-meter` → 404). Also free: `lakemeter`, `claude-lake-meter`.
- **GitHub org/user** for the repo, e.g. a new free org `lake-dev` (any free name). This becomes `LAKE_ORG`.
- Then fill every placeholder at once:
  `scripts/set-placeholders.sh <github-org> <org>.github.io/lake-meter <goatcounter-code> [formspree-endpoint]`

## 1. GitHub (free): code + landing hosting
1. Create a free GitHub account or org for Lake (no personal name on it). Turn on 2FA.
2. Create the public repo `lake-meter`, then push:
   `cd /workspace/lake/exp-a-meter && git add -A && git commit -m "lake-meter 0.1.0" && git branch -M main && git remote add origin git@github.com:<org>/lake-meter.git && git push -u origin main`
3. Settings → Pages → Source: **GitHub Actions**. The included `.github/workflows/pages.yml` publishes `landing/` to `https://<org>.github.io/lake-meter/`.
4. Add repo topics: `claude-code`, `mcp`, `ai-agents`, `llm-cost`, `developer-tools`.
5. Optional later: a custom domain (costs money, so it needs your approval).

## 2. npm (free): the package
1. Create a free npm account for Lake (e.g. user `lake-dev`) and turn on 2FA.
2. `npm login`, then from the repo: `npm test && npm publish --access public`
3. Check: `npx lake-meter@latest --version` prints `0.1.0`.

## 3. Visit counting (free, cookieless): GoatCounter
1. Sign up at https://www.goatcounter.com (free, donation-supported) with the Lake email, and pick a code such as `lake-meter`.
2. That code is `GOATCOUNTER_CODE` (the placeholder script fills it). It counts page views plus two events: install-command copies and waitlist submits. No cookies, so no consent banner.
   Alternative: Cloudflare Web Analytics (also free and cookieless) if you host on Cloudflare Pages.

## 4. Waitlist (free)
- **Works today with no account:** the form opens a pre-filled email to lake.research1@gmail.com.
- **Better (free):** create a Formspree form (free tier) or a Tally form, and pass its endpoint as the 4th argument to `set-placeholders.sh`. The page then submits in place and falls back to email if the service fails.

## 5. Usage measurement (no hidden telemetry)
The tool sends nothing. We measure from public numbers only:
- npm downloads + GitHub stars/forks/issues: `scripts/stats.sh lake-meter <org>/lake-meter`
- GitHub clones, views, referrers: repo → Insights → Traffic (admin), or `gh api repos/<org>/lake-meter/traffic/clones`
- Landing visits and install-copy clicks: GoatCounter dashboard
- Waitlist signups: Formspree/Tally dashboard or the Lake inbox

## 6. Launch posts (final, paste after step 0)
| Where | File | Account needed |
|---|---|---|
| Hacker News (Show HN) | `launch/show-hn.md` | an HN account for Lake (free) |
| r/ClaudeCode | `launch/reddit-claudecode.md` | u/LakeResearchTeam exists; check the sub's self-promo rules that day |
| MCP Registry + directories | `launch/mcp-directory.md` | GitHub login for `mcp-publisher`; mcp.so / Smithery / Glama via GitHub sign-in or PR |

Suggested order: npm + GitHub live → landing live → MCP listings → r/ClaudeCode → Show HN (weekday ~16:00 Israel time). Someone should answer comments for the first ~3 hours.

## 7. Five-minute check before publishing
- [ ] `npm test` passes (38 tests; the real-Claude test runs when the Claude Code binary is installed)
- [ ] `grep -rn "LAKE_ORG\|LAKE_SITE_URL\|GOATCOUNTER_CODE\|GITHUB_URL" --exclude=set-placeholders.sh --exclude=PUBLISH.md .` returns nothing
- [ ] Record a GIF of a real session (`docs/demo-shot-list.md`) and put it at the top of the README
- [ ] Prices in `src/prices.json` still match the two pricing pages (verified 2026-11-12)
