// Runs the REAL Claude Code binary against a local mock of the Messages API (scripts/mock-anthropic.js).
// No account or network needed. Skipped unless a Claude Code binary is found (set CLAUDE_BIN to point at one).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, execSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function findClaude() {
  if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN;
  try {
    const root = execSync('npm root -g', { encoding: 'utf8' }).trim();
    for (const p of [join(root, '@anthropic-ai/claude-code/bin/claude.exe'), join(root, '@anthropic-ai/claude-code/bin/claude')]) {
      if (existsSync(p) && spawnSync(p, ['--version']).status === 0) return p;
    }
  } catch {}
  return null;
}

const CLAUDE = findClaude();
const root = new URL('..', import.meta.url).pathname;

function runClaude({ mode, cap, port }) {
  const base = mkdtempSync(join(tmpdir(), 'lm-real-'));
  const home = join(base, 'home'), proj = join(base, 'proj');
  mkdirSync(home, { recursive: true }); mkdirSync(proj);
  const env = { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: join(home, '.claude'), LAKE_METER_HOME: '', ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`, ANTHROPIC_API_KEY: 'sk-ant-mock-not-a-real-key', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1' };
  delete env.LAKE_METER_HOME;
  spawnSync(process.execPath, [join(root, 'bin/lake-meter.js'), 'init', '--cap', String(cap)], { env, encoding: 'utf8' });
  const args = ['-p', 'Run the mock steps', '--model', 'claude-opus-5-5', '--output-format', 'stream-json', '--verbose'];
  if (mode === 'bypassPermissions') args.push('--permission-mode', 'bypassPermissions'); else args.push('--allowedTools', 'Bash');
  const r = spawnSync(CLAUDE, args, { cwd: proj, env, encoding: 'utf8', timeout: 120000 });
  const events = r.stdout.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return { events, home, env };
}

test('real Claude Code: hooks fire, cap enforced, measured spend equals Claude Code total_cost_usd', { skip: !CLAUDE && 'Claude Code binary not found' }, async () => {
  const port = 18787 + Math.floor(Math.random() * 1000);
  const mock = spawn(process.execPath, [join(root, 'scripts/mock-anthropic.js'), String(port)], { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, MOCK_STEPS: '4' } });
  await new Promise((res) => mock.stderr.once('data', res));
  try {
    // default mode in -p: the "ask" has no one to answer, so Claude Code denies the call and Claude reads our reason
    const a = runClaude({ mode: 'default', cap: 1, port });
    const denied = a.events.filter((e) => e.type === 'system' && e.subtype === 'permission_denied');
    assert.ok(denied.length >= 1, 'cap produced a permission decision');
    assert.match(denied[0].decision_reason, /Lake Meter: this run has used about \$1\.\d\d \(cap \$1\.00\)/);
    const stopMsg = a.events.find((e) => e.type === 'system' && /Lake Meter · run/.test(e.content || ''));
    assert.ok(stopMsg, 'Stop hook summary was shown');
    const result = a.events.find((e) => e.type === 'result');
    const ours = Number(/run \$(\d+\.\d+)/.exec(stopMsg.content)[1]);
    assert.ok(Math.abs(ours - result.total_cost_usd) < 0.01, `ours ${ours} vs Claude Code ${result.total_cost_usd}`);

    // bypassPermissions: the turn is stopped (continue:false) right at the cap
    const b = runClaude({ mode: 'bypassPermissions', cap: 1, port });
    const toolErr = b.events.flatMap((e) => (e.type === 'user' ? e.message.content : [])).find((c) => c.is_error);
    assert.match(toolErr.content, /Lake Meter cap reached/);
    const runs = readFileSync(join(b.home, '.lake-meter', 'runs.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.ok(runs.some((r) => r.stoppedByCap));
  } finally {
    mock.kill();
  }
});
