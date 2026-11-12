# MCP directory listing (ready to paste)

Status: READY. Use for the official MCP Registry (registry.modelcontextprotocol.io, via `mcp-publisher` once the npm package is live), mcp.so, Smithery, Glama, PulseMCP and the awesome-mcp-servers list (PR). Run scripts/set-placeholders.sh first.

**Name:** lake-meter

**One-liner (≤100 chars):** Per-step model recommendations and cost estimates for coding-agent plans. Local, no telemetry.

**Short description:**
Paste an implementation plan and lake-meter splits it into steps, rates each step's complexity 1–5, recommends the cheapest model tier that should handle it (Anthropic or OpenAI), and estimates token and USD ranges per step and in total, compared with running everything on the top model. With Claude Code, it also reports the measured spend of the current run.

**Tools:**
- `estimate_plan(plan: string, provider?: "anthropic" | "openai")`: markdown table plus structured JSON of steps, complexity, recommended model, token range, cost range, and the all-top-model baseline. Heuristic estimate.
- `meter_status(session_id?: string)`: measured tokens and list-price cost of the current Claude Code run and the active cap (needs `npx lake-meter init`).

**Install (any MCP client):**
```json
{ "mcpServers": { "lake-meter": { "command": "npx", "args": ["-y", "lake-meter", "mcp"] } } }
```

**Claude Code (full features: plan dialog table, per-run cap, receipt):** `npx lake-meter init`

**Category:** Developer tools / Cost & observability
**License:** MIT · **Transport:** stdio · **Auth:** none · **Network access:** none · **Telemetry:** none
**Repository:** GITHUB_URL
**Maintainer:** Lake

**server.json for the official registry** (fill after npm publish):
```json
{
  "$schema": "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json",
  "name": "io.github.LAKE_ORG/lake-meter",
  "description": "Per-step model recommendations and cost estimates for coding-agent plans.",
  "version": "0.1.0",
  "packages": [{ "registryType": "npm", "identifier": "lake-meter", "version": "0.1.0", "transport": { "type": "stdio" }, "packageArguments": [{ "type": "positional", "value": "mcp" }] }]
}
```
(The registry verifies npm ownership via the `mcpName` field already in package.json. Replace LAKE_ORG there and here with the GitHub org, then `mcp-publisher login github` and `mcp-publisher publish`. Steps verified against the registry quickstart on 2026-11-12.)
