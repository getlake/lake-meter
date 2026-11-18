# Changelog

## 0.1.5 (2026-11-18)
- lake-meter is now the cost layer of Lake (getlake.dev): README, npm description and homepage point to Lake. No code changes.
- License: 0.1.5 and later are under the Lake Commercial License (14-day free trial, then paid). 0.1.4 and earlier stay MIT.

## 0.1.3 (2026-11-16)
- `/meter` after a finished run no longer records that run a second time (`report` no longer double-counts)
- An unattended cap stop still ends the turn and records once; a later Stop hook does not add a duplicate row
- A typo in `config.json` now appears as a hook system message inside Claude Code, not only on hook stderr
- `init` cap hint uses the cap you set and formats `$1,000.50`
- `cap` on a broken config prints the error once


## 0.1.2 (2026-11-16)
- `/meter` no longer resets the current run (it was showing $0.00)
- `init --cap '$10'` and `cap '$10'` parse as $10; invalid values exit non-zero and do not disable the cap
- README config example is valid JSON; an unparseable `config.json` is warned about on stderr and ignored; `cap` refuses to overwrite a broken file
- `sessionCapUsd` headroom is stored on the session, so Yes no longer re-asks on every later call
- Config values are validated (string numbers coerced, `onCap` case-insensitive, `extendPct` must be > 0, invalid fields fall back with a warning)
- Unattended stop (`bypassPermissions` / `onCap: "stop"`) says `Lake Meter paused the run at $X (cap $Y)` and includes a receipt, not "The user has been asked"
- MCP `serverInfo.version` is read from `package.json`
- CLI errors (missing plan file, unknown command, bad cap) exit non-zero
- Re-running `init` keeps the original `settings.json.lake-meter.bak`
- README and landing: `npx lake-meter@latest` command forms; subagents are installed by default; `init --project` notes skills/agents paths; `npm run demo` is marked clone-only


## 0.1.1 (2026-11-16)
- Demo of a plan split into steps with model picks, a cost estimate, and the cap stopping a run
- README and landing: removed the stale “npm package is not available yet” install fallback
- Official MCP Registry metadata (`server.json`); `mcpName` was already present in 0.1.0

## 0.1.0 (2026-11-15)
- Per-step plan breakdown with complexity, recommended model and cost ranges, shown in Claude Code's plan dialog
- Per-run cap (USD, tokens, or 5-hour window %) that asks before the next tool call, or stops in unattended modes
- End-of-run receipt with measured tokens and list-price dollars by model and subagents
- `/meter` skill, statusline, CLI, MCP server (`estimate_plan`, `meter_status`)
- Price table verified 2026-11-12
