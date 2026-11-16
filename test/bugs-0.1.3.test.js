import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPrices } from '../src/pricing.js';
import { onUserPromptSubmit, onPreToolUse, onStop } from '../src/hooks.js';
import { readRuns, appendRun, uniqueRuns } from '../src/state.js';
import { sandbox, U } from './helpers.js';

const P = loadPrices(null);
const CLI = fileURLToPath(new URL('../bin/lake-meter.js', import.meta.url));
const base = (sb, extra = {}) => ({ session_id: 'sess1', transcript_path: sb.transcript, cwd: sb.base, permission_mode: 'default', ...extra });

function tmpHome() {
  const home = mkdtempSync(join(tmpdir(), 'lm-cli-'));
  mkdirSync(join(home, '.lake-meter'), { recursive: true });
  mkdirSync(join(home, '.claude'), { recursive: true });
  return home;
}

function cli(args, { home, input } = {}) {
  const env = { ...process.env };
  if (home) {
    env.HOME = home;
    env.LAKE_METER_HOME = join(home, '.lake-meter');
    env.CLAUDE_CONFIG_DIR = join(home, '.claude');
  }
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env, cwd: home || process.cwd(), input });
}

test('M-23: /meter after a finished run does not record or re-print the same run', async () => {
  const sb = sandbox({ capUsd: 5 });
  onUserPromptSubmit(base(sb, { prompt: 'implement the webhooks' }));
  sb.write(sb.transcript, 'claude-opus-5-5', U(0, 0, 0, 162160)); // ~$3.24
  const first = await onStop(base(sb), P, { settleMs: 0 });
  assert.match(first.systemMessage, /Lake Meter · run/);
  assert.equal(readRuns().length, 1);
  const firstUsd = readRuns()[0].usd;

  onUserPromptSubmit(base(sb, { prompt: '/meter' }));
  const second = await onStop(base(sb), P, { settleMs: 0 });
  assert.equal(second, null, 'Stop after /meter must not reprint the receipt');
  assert.equal(readRuns().length, 1, 'same run must not be appended twice');
  assert.equal(readRuns()[0].usd, firstUsd);

  onUserPromptSubmit(base(sb, { prompt: '/meter status' }));
  await onStop(base(sb), P, { settleMs: 0 });
  assert.equal(readRuns().length, 1);

  const r = cli(['report']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal((r.stdout.match(/\$/g) || []).length >= 1, true);
  assert.doesNotMatch(r.stdout, /Total of these runs: \$6/);
  const totalLine = r.stdout.split('\n').find((l) => l.startsWith('Total of these runs:'));
  assert.ok(totalLine);
  assert.equal(totalLine.includes(String(firstUsd)) || /\$3\.\d{2}/.test(totalLine) || /\$3\.24/.test(totalLine) || /\$3\.2/.test(totalLine), true, totalLine);
});

test('M-23: unattended cap record is not duplicated by the following Stop hook', async () => {
  const sb = sandbox({ capUsd: 1, onCap: 'stop' });
  onUserPromptSubmit(base(sb, { prompt: 'go' }));
  sb.write(sb.transcript, 'claude-opus-5-5', U(0, 0, 0, 60000)); // $1.20
  const pre = onPreToolUse(base(sb, { tool_name: 'Bash', tool_use_id: 'x' }), P);
  assert.equal(pre.continue, false);
  assert.equal(readRuns().length, 1);
  assert.equal(readRuns()[0].stoppedByCap, true);
  const stop = await onStop(base(sb), P, { settleMs: 0 });
  assert.equal(stop, null);
  assert.equal(readRuns().length, 1);
});

test('M-23: report and appendRun dedupe rows that share session+start', () => {
  const sb = sandbox({ capUsd: 5 });
  const rec = { session: 'sessA', start: 100, end: 200, usd: 3.24, tokens: 405000 };
  assert.equal(appendRun(rec), true);
  assert.equal(appendRun({ ...rec, end: 300, usd: 3.24 }), false);
  assert.equal(readRuns().length, 1);
  assert.deepEqual(uniqueRuns([rec, { ...rec, end: 300, usd: 3.24 }, { session: 'sessB', start: 100, end: 200, usd: 1 }]).map((r) => r.session + r.usd), ['sessA3.24', 'sessB1']);
});

test('M-22: a broken config.json surfaces as a hook systemMessage, not only stderr', () => {
  const sb = sandbox({ capUsd: 1 });
  writeFileSync(join(process.env.LAKE_METER_HOME, 'config.json'), '{ "capUsd": 1, }\n');
  onUserPromptSubmit(base(sb, { prompt: 'go' }));
  sb.write(sb.transcript, 'claude-opus-5-5', U(0, 0, 0, 162160)); // ~$3.24, default cap is $5 so no ask
  const out = onPreToolUse(base(sb, { tool_name: 'Bash', tool_use_id: 't1' }), P);
  assert.ok(out, 'hook must return a visible message');
  assert.match(out.systemMessage, /could not parse/);
  assert.match(out.systemMessage, /config\.json/);
  // shown once
  const again = onPreToolUse(base(sb, { tool_name: 'Bash', tool_use_id: 't2' }), P);
  assert.equal(again, null);
});

test('M-24: init cap hint uses the user cap and formats $1,000.50', () => {
  const a = cli(['init', '--cap', '5', '--no-agents'], { home: tmpHome() });
  assert.equal(a.status, 0, a.stderr);
  assert.match(a.stdout, /per-run cap: \$5\.00 \(change with: npx lake-meter cap 5\)/);
  const b = cli(['init', '--cap', '1,000.50', '--no-agents'], { home: tmpHome() });
  assert.equal(b.status, 0, b.stderr);
  assert.match(b.stdout, /per-run cap: \$1,000\.50 \(change with: npx lake-meter cap 1000\.50\)/);
});

test('M-25: refusing a broken config prints the error once', () => {
  const home = tmpHome();
  writeFileSync(join(home, '.lake-meter', 'config.json'), '{ "capUsd": 5, }\n');
  const r = cli(['cap', '2'], { home });
  assert.notEqual(r.status, 0);
  const text = r.stdout + r.stderr;
  const n = (text.match(/refusing to overwrite/g) || []).length;
  assert.equal(n, 1, text);
});
