// Minimal MCP server over stdio (JSON-RPC 2.0, newline-delimited), no dependencies.
// Tools: estimate_plan (any MCP client: Claude Code, Cursor, ...) and meter_status (Claude Code sessions).
import { createInterface } from 'node:readline';
import { loadPrices } from './pricing.js';
import { analyzePlan } from './plan.js';
import { planMarkdown, runSummary } from './format.js';
import { loadSession, latestSessionId, loadConfig } from './state.js';
import { totals } from './transcript.js';
import { effectiveCaps } from './hooks.js';

const TOOLS = [
  {
    name: 'estimate_plan',
    description: 'Split a markdown implementation plan into steps, rate each step\'s complexity, recommend the cheapest model tier that should handle it, and estimate token and USD cost ranges per step and in total, compared with running everything on the top model. Heuristic estimate, not a measurement.',
    inputSchema: {
      type: 'object',
      properties: {
        plan: { type: 'string', description: 'The plan in markdown (numbered steps, headings or bullets).' },
        provider: { type: 'string', enum: ['anthropic', 'openai'], description: 'Model family to recommend from. Default anthropic.' },
      },
      required: ['plan'],
    },
  },
  {
    name: 'meter_status',
    description: 'Measured spend of the current Claude Code run (tokens from the session transcript, priced at list price) and the active cap. Only works where the Lake Meter hooks are installed.',
    inputSchema: { type: 'object', properties: { session_id: { type: 'string' } } },
  },
];

export function handle(msg, prices = loadPrices()) {
  const { id, method, params } = msg;
  const ok = (result) => ({ jsonrpc: '2.0', id, result });
  if (method === 'initialize') {
    return ok({ protocolVersion: params?.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'lake-meter', version: '0.1.0' } });
  }
  if (method === 'notifications/initialized' || id === undefined) return null;
  if (method === 'ping') return ok({});
  if (method === 'tools/list') return ok({ tools: TOOLS });
  if (method === 'tools/call') {
    const args = params?.arguments || {};
    try {
      if (params.name === 'estimate_plan') {
        const a = analyzePlan(args.plan, prices, { provider: args.provider });
        return ok({ content: [{ type: 'text', text: planMarkdown(a) }], structuredContent: a });
      }
      if (params.name === 'meter_status') {
        const sid = args.session_id || latestSessionId();
        const s = sid ? loadSession(sid) : null;
        if (!s?.run) return ok({ content: [{ type: 'text', text: 'No Lake Meter run found. Are the hooks installed (npx lake-meter init)?' }] });
        const t = totals(s.run.seen, prices);
        return ok({ content: [{ type: 'text', text: runSummary(t, { cap: effectiveCaps(loadConfig(process.cwd()), s.run).usd }) }] });
      }
      return { jsonrpc: '2.0', id, error: { code: -32602, message: `Unknown tool ${params.name}` } };
    } catch (e) {
      return ok({ content: [{ type: 'text', text: `lake-meter error: ${e.message}` }], isError: true });
    }
  }
  return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
}

export function serve() {
  const prices = loadPrices();
  const rl = createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let msg; try { msg = JSON.parse(line); } catch { return; }
    const res = handle(msg, prices);
    if (res) process.stdout.write(JSON.stringify(res) + '\n');
  });
}
