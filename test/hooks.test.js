import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadPrices } from '../src/pricing.js';
import { onUserPromptSubmit, onPreToolUse, onPostToolUse, onStop, onStatusLine, PLAN_SECTION } from '../src/hooks.js';
import { readRuns, loadSession } from '../src/state.js';
import { sandbox, U } from './helpers.js';

const P = loadPrices(null);
const plan = readFileSync(new URL('./fixtures/plan-webhooks.md', import.meta.url), 'utf8');
const base = (sb, extra = {}) => ({ session_id: 'sess1', transcript_path: sb.transcript, cwd: sb.base, permission_mode: 'default', ...extra });
// $1.00 of Opus 5.5 output = 50,000 output tokens.
const oneDollar = U(0, 0, 0, 50000);

test('under the cap: no output (zero interference)', () => {
  const sb = sandbox({ capUsd: 5 });
  onUserPromptSubmit(base(sb));
  sb.write(sb.transcript, 'claude-opus-5-5', oneDollar);
  assert.equal(onPreToolUse(base(sb, { tool_name: 'Bash', tool_use_id: 't1' }), P), null);
});

test('history before the run does not count toward the run cap', () => {
  const sb = sandbox({ capUsd: 1 });
  sb.write(sb.transcript, 'claude-opus-5-5', U(0, 0, 0, 500000), { ts: Date.now() - 3600e3 }); // $10 earlier
  onUserPromptSubmit(base(sb));
  assert.equal(onPreToolUse(base(sb, { tool_name: 'Bash', tool_use_id: 't1' }), P), null);
});

test('cap reached: asks the user; approving grants headroom; next call passes', () => {
  const sb = sandbox({ capUsd: 1, extendPct: 50 });
  onUserPromptSubmit(base(sb));
  sb.write(sb.transcript, 'claude-opus-5-5', U(0, 0, 0, 55000)); // $1.10
  const out = onPreToolUse(base(sb, { tool_name: 'Edit', tool_use_id: 't9' }), P);
  assert.equal(out.hookSpecificOutput.permissionDecision, 'ask');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /\$1\.10.*cap \$1\.00/);
  onPostToolUse(base(sb, { tool_name: 'Edit', tool_use_id: 't9' }), P); // user said yes, tool ran
  assert.equal(onPreToolUse(base(sb, { tool_name: 'Bash', tool_use_id: 't10' }), P), null);
  sb.write(sb.transcript, 'claude-opus-5-5', U(0, 0, 0, 12000)); // +$0.24 → $1.34 < $1.60
  assert.equal(onPreToolUse(base(sb, { tool_name: 'Bash', tool_use_id: 't11' }), P), null);
  sb.write(sb.transcript, 'claude-opus-5-5', U(0, 0, 0, 15000)); // +$0.30 → $1.64 ≥ $1.60
  assert.equal(onPreToolUse(base(sb, { tool_name: 'Bash', tool_use_id: 't12' }), P).hookSpecificOutput.permissionDecision, 'ask');
});

test('a denied ask (no PostToolUse) keeps asking', () => {
  const sb = sandbox({ capUsd: 1 });
  onUserPromptSubmit(base(sb));
  sb.write(sb.transcript, 'claude-opus-5-5', U(0, 0, 0, 60000));
  assert.equal(onPreToolUse(base(sb, { tool_name: 'Bash', tool_use_id: 'a' }), P).hookSpecificOutput.permissionDecision, 'ask');
  onPostToolUse(base(sb, { tool_name: 'Read', tool_use_id: 'other' }), P); // unrelated tool, not an approval
  assert.equal(onPreToolUse(base(sb, { tool_name: 'Bash', tool_use_id: 'b' }), P).hookSpecificOutput.permissionDecision, 'ask');
});

test('unattended modes stop the turn instead of prompting', () => {
  for (const mode of ['bypassPermissions', 'dontAsk']) {
    const sb = sandbox({ capUsd: 1 });
    onUserPromptSubmit(base(sb, { permission_mode: mode }));
    sb.write(sb.transcript, 'claude-opus-5-5', U(0, 0, 0, 60000));
    const out = onPreToolUse(base(sb, { permission_mode: mode, tool_name: 'Bash', tool_use_id: 'x' }), P);
    assert.equal(out.continue, false);
    assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
    assert.equal(out.hookSpecificOutput.permissionDecisionReason, 'Lake Meter paused the run at $1.20 (cap $1.00)');
    assert.match(out.stopReason, /Lake Meter paused the run at \$1\.20 \(cap \$1\.00\)/);
    assert.match(out.systemMessage, /Lake Meter paused the run at \$1\.20 \(cap \$1\.00\)/);
    assert.doesNotMatch(JSON.stringify(out), /hook error|has been asked how to proceed/i);
  }
});

test('onCap "stop" works in default mode too, and token caps work', () => {
  const sb = sandbox({ capUsd: null, capTokens: 10000, onCap: 'stop' });
  onUserPromptSubmit(base(sb));
  sb.write(sb.transcript, 'claude-haiku-5-5', U(1000, 0, 9500, 100));
  const out = onPreToolUse(base(sb, { tool_name: 'Bash', tool_use_id: 'x' }), P);
  assert.equal(out.continue, false);
  assert.match(out.stopReason, /tokens/);
});

test('80% heads-up is shown once, to the user and to Claude', () => {
  const sb = sandbox({ capUsd: 1 });
  onUserPromptSubmit(base(sb));
  sb.write(sb.transcript, 'claude-opus-5-5', U(0, 0, 0, 42000)); // $0.84
  const a = onPreToolUse(base(sb, { tool_name: 'Bash', tool_use_id: '1' }), P);
  assert.match(a.systemMessage, /\$0\.84 of its \$1\.00 cap/);
  assert.match(a.hookSpecificOutput.additionalContext, /84%/);
  assert.equal(a.hookSpecificOutput.permissionDecision, undefined);
  assert.equal(onPreToolUse(base(sb, { tool_name: 'Bash', tool_use_id: '2' }), P), null);
});

test('ExitPlanMode: breakdown to the user, short guidance to Claude, no permission decision', () => {
  const sb = sandbox({ capUsd: 5 });
  onUserPromptSubmit(base(sb));
  const out = onPreToolUse(base(sb, { tool_name: 'ExitPlanMode', tool_input: { plan }, tool_use_id: 'p' }), P);
  assert.match(out.systemMessage, /plan breakdown/);
  assert.match(out.systemMessage, /Haiku 5\.5/);
  assert.match(out.hookSpecificOutput.additionalContext, /lake-light/);
  assert.equal(out.hookSpecificOutput.permissionDecision, undefined);
  assert.equal(loadSession('sess1').plan.steps.length, 6);
});

test('Stop: summary with per-model split, subagents, plan comparison, and a local run log', async () => {
  const sb = sandbox({ capUsd: 5 });
  onUserPromptSubmit(base(sb));
  onPreToolUse(base(sb, { tool_name: 'ExitPlanMode', tool_input: { plan }, tool_use_id: 'p' }), P);
  sb.write(sb.transcript, 'claude-opus-5-5', oneDollar);
  sb.write(sb.sub, 'claude-haiku-5-5', U(0, 0, 0, 100000)); // $0.05
  const out = await onStop(base(sb, { stop_hook_active: false }), P, { settleMs: 0 });
  assert.match(out.systemMessage, /run \$1\.05/);
  assert.match(out.systemMessage, /Opus 5\.5 \$1\.00 \+ Haiku 5\.5 \$0\.05/);
  assert.match(out.systemMessage, /subagents \$0\.05/);
  assert.match(out.systemMessage, /Since plan approved: \$1\.05 measured vs/);
  assert.equal(out.decision, undefined); // never blocks Claude from stopping
  const runs = readRuns();
  assert.equal(runs.length, 1);
  assert.equal(runs[0].usd, 1.05);
});

test('statusline: renders the meter and enables the 5-hour-window cap', () => {
  const sb = sandbox({ capUsd: null, capFiveHourPct: 80 });
  onUserPromptSubmit(base(sb));
  const line = onStatusLine({ session_id: 'sess1', cost: { total_cost_usd: 3.21 }, rate_limits: { five_hour: { used_percentage: 85 } } }, P);
  assert.match(line, /session \$3\.21 · 5h 85%/);
  const out = onPreToolUse(base(sb, { tool_name: 'Bash', tool_use_id: 'z' }), P);
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /5-hour usage window is at 85%/);
});

test('missing transcript never throws', async () => {
  const sb = sandbox({ capUsd: 1 });
  const input = { session_id: 'nope', transcript_path: sb.base + '/missing.jsonl', cwd: sb.base, tool_name: 'Bash' };
  assert.equal(onPreToolUse(input, P), null);
  assert.equal(await onStop(input, P, { settleMs: 0 }), null);
});

test('plan file written in plan mode gets a summary line and a per-step table, idempotently', () => {
  const sb = sandbox({ capUsd: 5 });
  const dir = join(sb.base, '.claude', 'plans'); mkdirSync(dir, { recursive: true });
  const fp = join(dir, 'webhooks.md');
  writeFileSync(fp, plan);
  const input = base(sb, { permission_mode: 'plan', tool_name: 'Write', tool_input: { file_path: fp }, tool_use_id: 'w1' });
  onPostToolUse(input, P);
  onPostToolUse({ ...input, tool_name: 'Edit', tool_use_id: 'w2' }, P); // Claude edits the plan again
  const out = readFileSync(fp, 'utf8');
  assert.ok(out.startsWith('> **Lake Meter estimate:**'));
  assert.equal(out.split(PLAN_SECTION).length, 2, 'section appears exactly once');
  assert.equal(out.split('Lake Meter estimate').length, 2, 'summary line appears exactly once');
  assert.match(out, /\| 6 \| Update the changelog \| 1\/5 \| Haiku 5\.5/);
  assert.ok(out.includes('SKIP LOCKED'), 'original plan kept');
  assert.equal(loadSession('sess1').plan.steps.length, 6);
  // ExitPlanMode receives the annotated plan; the analysis ignores our own section
  const pre = onPreToolUse(base(sb, { tool_name: 'ExitPlanMode', tool_input: { plan: out }, tool_use_id: 'p' }), P);
  assert.equal(loadSession('sess1').plan.steps.length, 6);
  assert.match(pre.systemMessage, /plan breakdown/);
});

test('files outside plans/ or outside plan mode are never touched', () => {
  const sb = sandbox({ capUsd: 5 });
  const fp = join(sb.base, 'README.md');
  writeFileSync(fp, plan);
  onPostToolUse(base(sb, { permission_mode: 'plan', tool_name: 'Write', tool_input: { file_path: fp } }), P);
  const dir = join(sb.base, 'plans'); mkdirSync(dir);
  const fp2 = join(dir, 'x.md'); writeFileSync(fp2, plan);
  onPostToolUse(base(sb, { permission_mode: 'default', tool_name: 'Write', tool_input: { file_path: fp2 } }), P);
  assert.equal(readFileSync(fp, 'utf8'), plan);
  assert.equal(readFileSync(fp2, 'utf8'), plan);
});
