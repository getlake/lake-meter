# Changelog

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
