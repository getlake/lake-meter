import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPrices } from '../src/pricing.js';
import { onUserPromptSubmit, onPreToolUse, onPostToolUse, isMeterCommand, pauseMessage } from '../src/hooks.js';
import { loadSession, loadConfig, parseCapUsd, normalizeConfig, saveUserConfig } from '../src/state.js';
import { handle } from '../src/mcp.js';
import { init, uninstall } from '../src/init.js';
import { sandbox, U } from './helpers.js';

const P = loadPrices(null);
const CLI = fileURLToPath(new URL('../bin/lake-meter.js', import.meta.url));
const PKG = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const base = (sb, extra = {}) => ({ session_id: 'sess1', transcript_path: sb.transcript, cwd: sb.base, permission_mode: 'default', ...extra });

function cli(args, { home, input, cwd } = {}) {
  const env = { ...process.env };
  if (home) {
    env.HOME = home;
    env.LAKE_METER_HOME = join(home, '.lake-meter');
    env.CLAUDE_CONFIG_DIR = join(home, '.claude');
    mkdirSync(env.LAKE_METER_HOME, { recursive: true });
    mkdirSync(env.CLAUDE_CONFIG_DIR, { recursive: true });
  }
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env, input, cwd: cwd || home || process.cwd() });
}

function tmpHome() {
  const home = mkdtempSync(join(tmpdir(), 'lm-cli-'));
  mkdirSync(join(home, '.lake-meter'), { recursive: true });
  mkdirSync(join(home, '.claude'), { recursive: true });
  return home;
}

test('M-01: /meter does not reset the run, so status still shows spend', () => {
  const sb = sandbox({ capUsd: 5 });
  onUserPromptSubmit(base(sb, { prompt: 'implement the webhooks' }));
  sb.write(sb.transcript, 'claude-opus-5-5', U(0, 0, 0, 50000)); // $1.00
  assert.equal(onPreToolUse(base(sb, { tool_name: 'Bash', tool_use_id: 't1' }), P), null);
  assert.equal(loadSession('sess1').run.seen && Object.keys(loadSession('sess1').run.seen).length > 0, true);
  const usdBefore = Object.keys(loadSession('sess1').run.seen).length;
  onUserPromptSubmit(base(sb, { prompt: '/meter' }));
  onUserPromptSubmit(base(sb, { prompt: '/meter status' }));
  onUserPromptSubmit(base(sb, { prompt: '  /meter cap 10' }));
  const s = loadSession('sess1');
  assert.ok(s.run, 'run is kept');
  assert.equal(Object.keys(s.run.seen).length, usdBefore);
  // A real user prompt after /meter still starts a new run
  onUserPromptSubmit(base(sb, { prompt: 'keep going' }));
  assert.equal(Object.keys(loadSession('sess1').run.seen).length, 0);
  assert.equal(isMeterCommand('/meter'), true);
  assert.equal(isMeterCommand('/meter status'), true);
  assert.equal(isMeterCommand('implement /meter later'), false);
});

test('M-02: --cap "$10" is $10; invalid caps exit non-zero and do not write NaN/null', () => {
  assert.deepEqual(parseCapUsd('$10'), { ok: true, value: 10 });
  assert.deepEqual(parseCapUsd('1,000.5'), { ok: true, value: 1000.5 });
  assert.equal(parseCapUsd('abc').ok, false);
  assert.equal(parseCapUsd('0').ok, false);
  assert.equal(parseCapUsd('-5').ok, false);
  assert.deepEqual(parseCapUsd('off', { allowOff: true }), { ok: true, value: null });

  const home = tmpHome();
  const ok = cli(['init', '--cap', '$10', '--no-agents'], { home });
  assert.equal(ok.status, 0, ok.stderr);
  const cfg = JSON.parse(readFileSync(join(home, '.lake-meter', 'config.json'), 'utf8'));
  assert.equal(cfg.capUsd, 10);
  assert.equal(cfg.capUsd == null, false);

  const home2 = tmpHome();
  const bad = cli(['init', '--cap', 'abc', '--no-agents'], { home2 });
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /invalid --cap/);
  assert.equal(existsSync(join(home2, '.lake-meter', 'config.json')), false);

  const capBad = cli(['cap', 'abc'], { home });
  assert.notEqual(capBad.status, 0);
  assert.match(capBad.stdout + capBad.stderr, /invalid cap/);
  assert.equal(JSON.parse(readFileSync(join(home, '.lake-meter', 'config.json'), 'utf8')).capUsd, 10);

  const capOk = cli(['cap', '$7.5'], { home });
  assert.equal(capOk.status, 0, capOk.stderr + capOk.stdout);
  assert.equal(JSON.parse(readFileSync(join(home, '.lake-meter', 'config.json'), 'utf8')).capUsd, 7.5);
});

test('M-03: unparseable config.json warns loudly and is not silently applied; save refuses to clobber it (M-05)', () => {
  const sb = sandbox({ capUsd: 5 });
  writeFileSync(join(process.env.LAKE_METER_HOME, 'config.json'), '{\n  "capUsd": 1,\n  // comment\n  "sessionCapUsd": 20\n}\n');
  const warnings = [];
  const cfg = loadConfig(sb.base, (m) => warnings.push(m));
  assert.equal(cfg.capUsd, 5, 'falls back to default, does not apply a half-parsed file');
  assert.ok(warnings.some((w) => /could not parse/.test(w) && /config\.json/.test(w)), warnings.join('\n'));
  // file left untouched
  assert.match(readFileSync(join(process.env.LAKE_METER_HOME, 'config.json'), 'utf8'), /sessionCapUsd/);

  assert.throws(() => saveUserConfig({ capUsd: 2 }, (m) => warnings.push(m)), /refusing to overwrite/);
  assert.match(readFileSync(join(process.env.LAKE_METER_HOME, 'config.json'), 'utf8'), /"sessionCapUsd": 20/);

  const home = tmpHome();
  writeFileSync(join(home, '.lake-meter', 'config.json'), '{ "capUsd": 1, }');
  const r = cli(['cap', '2'], { home });
  assert.notEqual(r.status, 0);
  assert.match(r.stdout + r.stderr, /refusing to overwrite|could not parse/i);
  assert.match(readFileSync(join(home, '.lake-meter', 'config.json'), 'utf8'), /"capUsd": 1,/);
});

test('M-03/R1: README JSON fences are valid JSON with no comments', () => {
  const md = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  const blocks = [...md.matchAll(/```json\n([\s\S]*?)```/g)].map((m) => m[1]);
  assert.ok(blocks.length >= 2, 'expected config and Cursor JSON examples');
  for (const b of blocks) {
    assert.doesNotMatch(b, /\/\//, 'no comments inside JSON fences');
    JSON.parse(b);
  }
});

test('M-04: sessionCapUsd Yes adds session headroom that survives the next tool call and a new run', () => {
  const sb = sandbox({ capUsd: 5, sessionCapUsd: 1, extendPct: 50 });
  onUserPromptSubmit(base(sb, { prompt: 'first run' }));
  // Statusline is the source of sessionUsd when fresh; $1.20 session vs $1 cap.
  const at = Date.now();
  const sess = loadSession('sess1');
  sess.statusline = { costUsd: 1.20, fiveHourPct: null, at };
  // Need to persist before PreToolUse? onPreToolUse loadSession then refresh may overwrite sessionUsd from statusline if present.
  writeFileSync(join(process.env.LAKE_METER_HOME, 'sessions', 'sess1.json'), JSON.stringify(sess, null, 2));
  const ask = onPreToolUse(base(sb, { tool_name: 'Bash', tool_use_id: 's1' }), P);
  assert.equal(ask.hookSpecificOutput.permissionDecision, 'ask');
  assert.match(ask.hookSpecificOutput.permissionDecisionReason, /session cap \$1\.00/);
  assert.match(ask.hookSpecificOutput.permissionDecisionReason, /\+\$0\.50 headroom/);
  assert.doesNotMatch(ask.hookSpecificOutput.permissionDecisionReason, /\+\$2\.50/);
  onPostToolUse(base(sb, { tool_name: 'Bash', tool_use_id: 's1' }), P);
  const afterYes = loadSession('sess1');
  assert.ok(afterYes.extraSessionUsd > 0, `extraSessionUsd=${afterYes.extraSessionUsd}`);
  // Same run, same session spend: must not re-ask.
  afterYes.statusline = { costUsd: 1.20, fiveHourPct: null, at: Date.now() };
  writeFileSync(join(process.env.LAKE_METER_HOME, 'sessions', 'sess1.json'), JSON.stringify(afterYes, null, 2));
  assert.equal(onPreToolUse(base(sb, { tool_name: 'Bash', tool_use_id: 's2' }), P), null);
  // A new user prompt starts a new run; session headroom must persist.
  onUserPromptSubmit(base(sb, { prompt: 'second run' }));
  const s2 = loadSession('sess1');
  s2.statusline = { costUsd: 1.20, fiveHourPct: null, at: Date.now() };
  writeFileSync(join(process.env.LAKE_METER_HOME, 'sessions', 'sess1.json'), JSON.stringify(s2, null, 2));
  assert.equal(onPreToolUse(base(sb, { tool_name: 'Read', tool_use_id: 's3' }), P), null);
  assert.ok(loadSession('sess1').extraSessionUsd > 0);
});

test('M-06: config type validation coerces, rejects, and never throws in hooks', () => {
  const warns = [];
  const warn = (m) => warns.push(m);
  const n = normalizeConfig({ capUsd: '5', onCap: 'STOP', extendPct: 0, capTokens: -1, provider: 'nope', warnPct: 150, annotatePlans: 'true' }, warn, 't');
  assert.equal(n.capUsd, 5);
  assert.equal(n.onCap, 'stop');
  assert.equal(n.extendPct, 50, 'extendPct 0 is invalid and would re-ask forever');
  assert.equal(n.capTokens, null);
  assert.equal(n.provider, 'anthropic');
  assert.equal(n.warnPct, 80);
  assert.equal(n.annotatePlans, true);
  assert.ok(warns.length >= 4, warns.join('\n'));

  const sb = sandbox();
  writeFileSync(join(process.env.LAKE_METER_HOME, 'config.json'), JSON.stringify({ capUsd: '5', extendPct: 50 }));
  onUserPromptSubmit(base(sb, { prompt: 'go' }));
  sb.write(sb.transcript, 'claude-opus-5-5', U(0, 0, 0, 300000)); // $6
  const out = onPreToolUse(base(sb, { tool_name: 'Bash', tool_use_id: 'x' }), P);
  assert.equal(out.hookSpecificOutput.permissionDecision, 'ask');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /cap \$5\.00/);
});

test('M-07: unattended pause message is the clear $X (cap $Y) line, not a hook error', () => {
  const sb = sandbox({ capUsd: 1 });
  onUserPromptSubmit(base(sb, { prompt: 'go', permission_mode: 'bypassPermissions' }));
  sb.write(sb.transcript, 'claude-opus-5-5', U(0, 0, 0, 60000)); // $1.20
  const out = onPreToolUse(base(sb, { permission_mode: 'bypassPermissions', tool_name: 'Bash', tool_use_id: 'x' }), P);
  assert.equal(out.continue, false);
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  const msg = 'Lake Meter paused the run at $1.20 (cap $1.00)';
  assert.equal(out.hookSpecificOutput.permissionDecisionReason, msg);
  assert.equal(out.stopReason.startsWith(msg), true, out.stopReason);
  assert.match(out.systemMessage, /Lake Meter paused the run at \$1\.20 \(cap \$1\.00\)/);
  assert.doesNotMatch(JSON.stringify(out), /hook error|The user has been asked/i);
  assert.equal(pauseMessage({ kind: 'usd', amount: 1.2, cap: 1 }), msg);
});

test('M-13: re-running init keeps the original settings backup', () => {
  const home = tmpHome();
  const claudeHome = join(home, '.claude');
  writeFileSync(join(claudeHome, 'settings.json'), JSON.stringify({ model: 'opus', hooks: {} }));
  process.env.LAKE_METER_HOME = join(home, '.lake-meter');
  init({ claudeHome, node: 'node', cli: '/x/lake-meter.js', agents: false, log: () => {} });
  const bak1 = JSON.parse(readFileSync(join(claudeHome, 'settings.json.lake-meter.bak'), 'utf8'));
  assert.equal(bak1.model, 'opus');
  assert.equal(JSON.stringify(bak1.hooks), '{}');
  init({ claudeHome, node: 'node', cli: '/x/lake-meter.js', agents: false, capUsd: 8, log: () => {} });
  const bak2 = JSON.parse(readFileSync(join(claudeHome, 'settings.json.lake-meter.bak'), 'utf8'));
  assert.deepEqual(bak2, bak1);
  assert.equal(JSON.stringify(bak2.hooks || {}), '{}');
  uninstall({ claudeHome, log: () => {} });
  const restored = JSON.parse(readFileSync(join(claudeHome, 'settings.json'), 'utf8'));
  assert.ok(!JSON.stringify(restored).includes('lake-meter') && !JSON.stringify(restored).includes('/x/lake-meter.js'));
});

test('M-14: MCP initialize version matches package.json', () => {
  const res = handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }, P);
  assert.equal(res.result.serverInfo.name, 'lake-meter');
  assert.equal(res.result.serverInfo.version, PKG.version);
  assert.notEqual(res.result.serverInfo.version, '0.1.0');
});

test('M-16: CLI errors exit non-zero; help, version, and hook garbage stay 0', () => {
  const home = tmpHome();
  const missing = cli(['plan', join(home, 'no-such-plan.md')], { home });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stdout + missing.stderr, /File not found/);

  const unknown = cli(['foobar'], { home });
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stderr, /unknown command/);

  const capUsage = cli(['cap'], { home });
  assert.notEqual(capUsage.status, 0);

  const help = cli([], { home });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /lake-meter/);

  const ver = cli(['--version'], { home });
  assert.equal(ver.status, 0);
  assert.match(ver.stdout.trim(), /^\d+\.\d+\.\d+$/);

  const hook = cli(['hook', 'pre-tool-use'], { home, input: 'not json' });
  assert.equal(hook.status, 0);
});
