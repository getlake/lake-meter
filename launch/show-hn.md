# Show HN (ready to paste)

Status: READY. Run scripts/set-placeholders.sh first so the links are filled in. Post from the Lake HN account. Don't ask anyone for upvotes; HN penalizes it.

**Title** (80 char max):

Show HN: Lake Meter – per-step model picks and a hard per-run cap for Claude Code

**URL:** GITHUB_URL

**Text** (leave empty when a URL is given; post this as the first comment instead):

Hi HN. We kept seeing the same Claude Code complaints: the 5-hour window gone before lunch, a loop that ran all night, six subagents on one bill, and Opus doing the changelog. The tools to see this exist, but mostly after the fact.

Lake Meter is a small, MIT-licensed npm package that uses Claude Code's own extension points:

- In plan mode, when Claude writes a plan, it rates each step 1 to 5, recommends the cheapest model that should handle it (Haiku / Sonnet / Opus), and adds token and dollar ranges per step next to the cost of running everything on Opus. The table shows up inside Claude Code's "Ready to code?" dialog.
- During a run, a PreToolUse hook prices new usage from the session transcript. When the run reaches your cap (dollars, tokens, or a % of the 5-hour window), the next tool call becomes a permission prompt: Yes adds headroom, No stops Claude. In bypassPermissions it ends the turn instead.
- When Claude stops, you get a receipt: measured tokens and list-price cost, split by model and subagents, next to the plan's estimate.

Install: `npx lake-meter init` (uninstall restores your settings exactly).

What's measured and what isn't: token counts come straight from the transcript's usage fields (subagent transcripts included). Dollars are tokens × list prices from one JSON file; in our tests they matched Claude Code's own total_cost_usd. The plan breakdown is a heuristic estimate, and the README says so, with `--why` showing every reason behind a score. The cap is checked before each tool call, so one long response can overshoot it.

No network calls, no telemetry, everything stays in ~/.lake-meter. The MCP server also gives Cursor users the plan estimate, though the cap needs Claude Code's hooks.

We'd love to hear where the complexity heuristic gets your plans wrong, and whether a per-run cap or a 5-hour-window cap is the one you'd actually use.
