#!/usr/bin/env node
// Local stand-in for the Anthropic Messages API, so the REAL Claude Code binary can run end to end
// (hooks, transcript writing) without an account. Usage: node scripts/mock-anthropic.js [port]
// Main-model requests without a tool result get a Bash tool_use; others get a short text answer.
// Each response reports large usage so a $1 cap is crossed after a couple of turns.
import { createServer } from 'node:http';
import { appendFileSync, readFileSync } from 'node:fs';
const require_plan = () => readFileSync(process.env.MOCK_PLAN, 'utf8');

const port = Number(process.argv[2] || 8787);
const log = process.env.MOCK_LOG;
let n = 0;

function sse(res, events) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'request-id': `req_mock_${n}` });
  for (const [event, data] of events) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  res.end();
}

createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    if (log) appendFileSync(log, `${req.method} ${req.url}\n`);
    if (!req.url.startsWith('/v1/messages') || req.method !== 'POST') { res.writeHead(404, { 'content-type': 'application/json' }); return res.end('{"type":"error","error":{"type":"not_found_error","message":"mock"}}'); }
    if (req.url.includes('count_tokens')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"input_tokens":1000}'); }
    let j = {}; try { j = JSON.parse(body); } catch {}
    n++;
    if (log) appendFileSync(log, `  model=${j.model} tools=${(j.tools || []).map((t) => t.name).join(',')}\n`);
    const model = j.model || 'claude-opus-5-5';
    const last = j.messages?.[j.messages.length - 1];
    const hasToolResult = Array.isArray(last?.content) && last.content.some((c) => c.type === 'tool_result');
    const toolResults = (j.messages || []).flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((c) => c.type === 'tool_result').length;
    const mainLoop = Array.isArray(j.tools) && j.tools.some((t) => t.name === 'Bash');
    const offersPlanExit = Array.isArray(j.tools) && j.tools.some((t) => t.name === 'ExitPlanMode');
    const raw = JSON.stringify(j);
    const planPath = (raw.match(/\/[^\s"'\\]*\/plans\/[^\s"'\\]*\.md/) || [])[0];
    const inPlanMode = process.env.MOCK_PLAN && (offersPlanExit || raw.toLowerCase().includes('plan mode'));
    const writePlan = mainLoop && inPlanMode && planPath && toolResults === 0;
    const usePlan = mainLoop && inPlanMode && toolResults === (planPath ? 1 : 0);
    const useTool = mainLoop && toolResults < Number(process.env.MOCK_STEPS || 4);
    const id = `msg_mock_${n}`;
    const usage = { input_tokens: 12, cache_creation_input_tokens: 8000, cache_read_input_tokens: 40000 + n * 1000, cache_creation: { ephemeral_5m_input_tokens: 8000, ephemeral_1h_input_tokens: 0 }, output_tokens: 1 };
    const finalOut = mainLoop ? 30000 : 50; // 30k output on Opus 5.5 = $0.60 per turn
    const ev = [['message_start', { type: 'message_start', message: { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage } }]];
    if (writePlan) {
      ev.push(['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: `toolu_mock_${n}`, name: 'Write', input: {} } }]);
      ev.push(['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ file_path: planPath, content: require_plan() }) } }]);
      ev.push(['content_block_stop', { type: 'content_block_stop', index: 0 }]);
      ev.push(['message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { ...usage, output_tokens: 3000 } }]);
    } else if (usePlan) {
      const plan = require_plan();
      ev.push(['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: `toolu_mock_${n}`, name: 'ExitPlanMode', input: {} } }]);
      ev.push(['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(planPath ? {} : { plan }) } }]);
      ev.push(['content_block_stop', { type: 'content_block_stop', index: 0 }]);
      ev.push(['message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { ...usage, output_tokens: 2000 } }]);
    } else if (useTool) {
      ev.push(['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: `toolu_mock_${n}`, name: 'Bash', input: {} } }]);
      ev.push(['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ command: `echo step ${toolResults + 1}`, description: 'Mock step' }) } }]);
      ev.push(['content_block_stop', { type: 'content_block_stop', index: 0 }]);
      ev.push(['message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { ...usage, output_tokens: finalOut } }]);
    } else {
      ev.push(['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }]);
      ev.push(['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: hasToolResult || !mainLoop ? 'Done.' : 'OK' } }]);
      ev.push(['content_block_stop', { type: 'content_block_stop', index: 0 }]);
      ev.push(['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { ...usage, output_tokens: finalOut } }]);
    }
    ev.push(['message_stop', { type: 'message_stop' }]);
    if (j.stream === false) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ id, type: 'message', role: 'assistant', model, content: [{ type: 'text', text: 'Done.' }], stop_reason: 'end_turn', usage: { ...usage, output_tokens: finalOut } }));
    }
    sse(res, ev);
  });
}).listen(port, '127.0.0.1', () => console.error(`mock Anthropic API on http://127.0.0.1:${port}`));
