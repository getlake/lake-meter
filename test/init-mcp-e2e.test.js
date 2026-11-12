import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { init, uninstall } from '../src/init.js';
import { handle } from '../src/mcp.js';
import { loadPrices } from '../src/pricing.js';
import { simulate } from '../scripts/simulate.js';

const CLI = new URL('../bin/lake-meter.js', import.meta.url).pathname;

test('init merges into existing settings, is idempotent, keeps a backup; uninstall restores', () => {
  const base = mkdtempSync(join(tmpdir(), 'lm-init-'));
  process.env.LAKE_METER_HOME = join(base, 'meter');
  const claudeHome = join(base, '.claude');
  mkdirSync(claudeHome);
  const existing = { model: 'opus', hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '/usr/local/bin/guard.sh' }] }] }, statusLine: { type: 'command', command: 'my-status' } };
  writeFileSync(join(claudeHome, 'settings.json'), JSON.stringify(existing));
  const opts = { claudeHome, node: '/usr/bin/node', cli: '/home/u/.lake-meter/runtime/bin/lake-meter.js', log: () => {} };
  init(opts); init(opts);
  const s = JSON.parse(readFileSync(join(claudeHome, 'settings.json'), 'utf8'));
  assert.equal(s.model, 'opus');
  assert.equal(s.hooks.PreToolUse.length, 2); // user's guard + ours, not duplicated
  assert.equal(s.hooks.PreToolUse[1].matcher, '*');
  assert.deepEqual(s.hooks.PreToolUse[1].hooks[0].args, [opts.cli, 'hook', 'pre-tool-use']);
  for (const e of ['UserPromptSubmit', 'PostToolUse', 'Stop']) assert.equal(s.hooks[e].length, 1);
  assert.equal(s.statusLine.command, 'my-status'); // not overwritten without --statusline
  assert.ok(existsSync(join(claudeHome, 'settings.json.lake-meter.bak')));
  assert.ok(existsSync(join(claudeHome, 'skills', 'meter', 'SKILL.md')));
  assert.match(readFileSync(join(claudeHome, 'agents', 'lake-light.md'), 'utf8'), /model: haiku/);
  uninstall({ claudeHome, log: () => {} });
  const after = JSON.parse(readFileSync(join(claudeHome, 'settings.json'), 'utf8'));
  assert.deepEqual(after, existing);
  assert.ok(!existsSync(join(claudeHome, 'skills', 'meter')));
});

test('init --statusline replaces and uninstall restores the previous statusline', () => {
  const base = mkdtempSync(join(tmpdir(), 'lm-init-'));
  process.env.LAKE_METER_HOME = join(base, 'meter');
  mkdirSync(process.env.LAKE_METER_HOME, { recursive: true });
  const claudeHome = join(base, '.claude');
  mkdirSync(claudeHome);
  writeFileSync(join(claudeHome, 'settings.json'), JSON.stringify({ statusLine: { type: 'command', command: 'mine' } }));
  init({ claudeHome, node: 'node', cli: '/x/lake-meter.js', statusline: true, agents: false, log: () => {} });
  assert.match(JSON.parse(readFileSync(join(claudeHome, 'settings.json'), 'utf8')).statusLine.command, /lake-meter\.js" statusline/);
  uninstall({ claudeHome, log: () => {} });
  assert.equal(JSON.parse(readFileSync(join(claudeHome, 'settings.json'), 'utf8')).statusLine.command, 'mine');
});

test('init refuses to clobber a broken settings.json', () => {
  const base = mkdtempSync(join(tmpdir(), 'lm-init-'));
  process.env.LAKE_METER_HOME = join(base, 'meter');
  const claudeHome = join(base, '.claude');
  mkdirSync(claudeHome);
  writeFileSync(join(claudeHome, 'settings.json'), '{ broken');
  assert.throws(() => init({ claudeHome, node: 'node', cli: '/x/lake-meter.js', log: () => {} }));
  assert.equal(readFileSync(join(claudeHome, 'settings.json'), 'utf8'), '{ broken');
});

test('MCP server: initialize, list tools, estimate a plan', () => {
  const P = loadPrices(null);
  assert.equal(handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }, P).result.serverInfo.name, 'lake-meter');
  assert.equal(handle({ jsonrpc: '2.0', method: 'notifications/initialized' }, P), null);
  const names = handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, P).result.tools.map((t) => t.name);
  assert.deepEqual(names, ['estimate_plan', 'meter_status']);
  const r = handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'estimate_plan', arguments: { plan: '1. fix typo in docs\n2. migrate the users schema with a transaction' } } }, P).result;
  assert.match(r.content[0].text, /Recommended model/);
  assert.equal(r.structuredContent.steps.length, 2);
});

test('MCP server over real stdio', () => {
  const msgs = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'estimate_plan', arguments: { plan: '- a\n- b' } } },
  ].map((m) => JSON.stringify(m)).join('\n') + '\n';
  const r = spawnSync(process.execPath, [CLI, 'mcp'], { input: msgs, encoding: 'utf8' });
  const lines = r.stdout.trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.length, 2);
  assert.equal(lines[1].id, 2);
});

test('end to end: simulated Claude Code session through the real CLI hooks', () => {
  const r = simulate({ cap: 1 });
  assert.match(r.planOut.systemMessage, /plan breakdown/);
  assert.equal(r.capOut.hookSpecificOutput.permissionDecision, 'ask');
  assert.ok(r.asks >= 2, 'cap re-arms after approval');
  assert.match(r.stopOut.systemMessage, /Lake Meter · run \$\d/);
  assert.match(r.stopOut.systemMessage, /subagents/);
  assert.match(r.status, /Lake Meter · run/);
  assert.ok(r.events.every((e) => !e.stderr), r.events.map((e) => e.stderr).join(''));
});

test('end to end: user denies at the cap, bypass mode stops the turn', () => {
  const r = simulate({ cap: 1, approve: false });
  assert.equal(r.asks, 1);
  const b = simulate({ cap: 1, mode: 'bypassPermissions' });
  assert.equal(b.capOut.continue, false);
});

test('CLI plan command and hook command with garbage input stay safe', () => {
  const p = spawnSync(process.execPath, [CLI, 'plan', new URL('./fixtures/plan-numbered.md', import.meta.url).pathname], { encoding: 'utf8' });
  assert.match(p.stdout, /Everything on Opus 5\.5/);
  const h = spawnSync(process.execPath, [CLI, 'hook', 'pre-tool-use'], { input: 'not json', encoding: 'utf8' });
  assert.equal(h.status, 0);
  assert.equal(h.stdout, '');
});
