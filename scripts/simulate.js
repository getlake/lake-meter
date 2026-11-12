#!/usr/bin/env node
// End-to-end simulation of a Claude Code session driving the real lake-meter CLI through its hooks.
// It writes a transcript in Claude Code's JSONL format (assistant lines with message.usage, streamed
// duplicates, a subagent transcript under <session>/subagents/) and pipes hook payloads shaped like
// https://code.claude.com/docs/en/hooks into `lake-meter hook <event>`, exactly as Claude Code would.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(root, 'bin', 'lake-meter.js');
const quiet = process.argv.includes('--quiet');
const sleepMs = quiet ? 0 : Number(process.env.DEMO_DELAY ?? 350);

export function simulate({ cap = 1.0, mode = 'default', approve = true, home } = {}) {
  const base = home || mkdtempSync(join(tmpdir(), 'lake-meter-sim-'));
  const env = { ...process.env, LAKE_METER_HOME: join(base, 'meter') };
  mkdirSync(env.LAKE_METER_HOME, { recursive: true });
  writeFileSync(join(env.LAKE_METER_HOME, 'config.json'), JSON.stringify({ capUsd: cap, onCap: 'ask', extendPct: 50 }));
  const session = 'sim-' + Math.random().toString(36).slice(2, 8);
  const proj = join(base, 'projects', '-work-acme-api');
  mkdirSync(join(proj, session, 'subagents'), { recursive: true });
  const transcript = join(proj, `${session}.jsonl`);
  const subTranscript = join(proj, session, 'subagents', 'agent-a1b2c3.jsonl');
  const events = [];
  let clock = Date.now();
  let n = 0;

  const common = (evt) => ({ session_id: session, transcript_path: transcript, cwd: '/work/acme-api', permission_mode: mode, hook_event_name: evt });
  const hook = (evt, name, extra = {}) => {
    const input = { ...common(name), ...extra };
    const r = spawnSync(process.execPath, [CLI, 'hook', evt], { input: JSON.stringify(input), env, encoding: 'utf8' });
    const out = r.stdout ? JSON.parse(r.stdout) : null;
    events.push({ evt, input, out, stderr: r.stderr });
    return out;
  };
  const assistant = (file, model, usage, { dup = true, sidechain = false } = {}) => {
    clock += 4000;
    const id = `msg_sim_${++n}`;
    const line = (u) => JSON.stringify({ parentUuid: null, isSidechain: sidechain, userType: 'external', cwd: '/work/acme-api', sessionId: session, version: '2.1.322', type: 'assistant', uuid: `u${n}${Math.random()}`, timestamp: new Date(clock).toISOString(), requestId: `req_${n}`, message: { id, type: 'message', role: 'assistant', model, content: [{ type: 'text', text: '…' }], usage: u } }) + '\n';
    // Streamed responses: same message id on several lines; the last has the final output count.
    if (dup) appendFileSync(file, line({ ...usage, output_tokens: Math.round(usage.output_tokens / 3) }));
    appendFileSync(file, line(usage));
  };
  const usage = (input, cacheWrite, cacheRead, output) => ({ input_tokens: input, cache_creation_input_tokens: cacheWrite, cache_read_input_tokens: cacheRead, cache_creation: { ephemeral_5m_input_tokens: cacheWrite, ephemeral_1h_input_tokens: 0 }, output_tokens: output, service_tier: 'standard' });

  // 1. Plan mode: the user asks for a plan; Opus explores and writes one.
  hook('user-prompt-submit', 'UserPromptSubmit', { prompt: 'Plan: add retries to webhook delivery' });
  for (let i = 0; i < 4; i++) assistant(transcript, 'claude-opus-5-5', usage(6, 9000, 30000 + i * 9000, 1200));
  const plan = readFileSync(join(root, 'test', 'fixtures', 'plan-webhooks.md'), 'utf8');
  const planOut = hook('pre-tool-use', 'PreToolUse', { tool_name: 'ExitPlanMode', tool_input: { plan, planFilePath: '/home/dev/.claude/plans/webhook-retries.md' }, tool_use_id: 'toolu_plan' });
  hook('post-tool-use', 'PostToolUse', { tool_name: 'ExitPlanMode', tool_input: {}, tool_response: { plan }, tool_use_id: 'toolu_plan' });

  // 2. Implementation: tool calls with growing context, one Haiku subagent, until the cap is hit.
  let capOut = null, asks = 0;
  for (let k = 0; k < 24; k++) {
    assistant(transcript, 'claude-opus-5-5', usage(8, 4000, 60000 + k * 5000, 1800));
    if (k === 3) for (let j = 0; j < 6; j++) assistant(subTranscript, 'claude-haiku-5-5', usage(10, 3000, 20000 + j * 4000, 900), { sidechain: true });
    const id = `toolu_${k}`;
    const out = hook('pre-tool-use', 'PreToolUse', { tool_name: k % 2 ? 'Edit' : 'Bash', tool_input: k % 2 ? { file_path: '/work/acme-api/src/queue/worker.ts' } : { command: 'npm test' }, tool_use_id: id });
    const decision = out?.hookSpecificOutput?.permissionDecision;
    if (decision === 'deny') { capOut ||= out; break; }
    if (decision === 'ask') {
      asks++;
      capOut ||= out;
      if (!approve) break; // user pressed No: Claude is told the call was denied and stops
    }
    hook('post-tool-use', 'PostToolUse', { tool_name: k % 2 ? 'Edit' : 'Bash', tool_input: {}, tool_response: {}, tool_use_id: id }); // tool ran (approved if it was asked)
  }

  // 3. Turn ends: Stop hook prints the summary.
  const stopOut = hook('stop', 'Stop', { stop_hook_active: false, last_assistant_message: 'Done. Retries are in place and tests pass.' });
  const status = spawnSync(process.execPath, [CLI, 'status', '--session', session], { env, encoding: 'utf8' }).stdout;
  return { base, env, session, transcript, events, planOut, capOut, asks, stopOut, status };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const r = simulate({ cap: Number(process.env.CAP || 1) });
  const say = async (t) => { console.log(t); await wait(sleepMs); };
  await say('\n\x1b[2m$ claude   # plan mode: "add retries to webhook delivery"\x1b[0m\n');
  await say('\x1b[36m' + r.planOut.systemMessage + '\x1b[0m\n');
  await say('\x1b[2m… Claude implements the plan (tool calls, a Haiku subagent) …\x1b[0m\n');
  if (r.capOut) await say('\x1b[33m⏸  Permission prompt [settings]: ' + r.capOut.hookSpecificOutput.permissionDecisionReason + '\x1b[0m\n\x1b[2m   (you press Yes: +50% headroom)\x1b[0m\n');
  if (r.stopOut) await say('\x1b[32m' + r.stopOut.systemMessage + '\x1b[0m\n');
  console.log(`\x1b[2msimulated session ${r.session}, data in ${r.base}\x1b[0m`);
}
