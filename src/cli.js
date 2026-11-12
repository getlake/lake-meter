import { readFileSync, existsSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadPrices } from './pricing.js';
import { analyzePlan } from './plan.js';
import { planTable, runSummary, usd } from './format.js';
import { onUserPromptSubmit, onPreToolUse, onPostToolUse, onStop, onStatusLine, effectiveCaps } from './hooks.js';
import { loadConfig, saveUserConfig, loadSession, latestSessionId, readRuns, home } from './state.js';
import { totals } from './transcript.js';
import { init, uninstall } from './init.js';
import { serve } from './mcp.js';

const HELP = `lake-meter · per-step model picks and a hard per-run cap for Claude Code

  npx lake-meter init [--project] [--cap 5] [--no-agents] [--statusline]   install hooks, statusline, /meter
  lake-meter plan <file.md> [--openai] [--why]   plan breakdown: complexity, model per step, cost ranges
  lake-meter cap <usd> | off                     set the per-run cap (also: /meter cap 10 inside Claude Code)
  lake-meter status                              this run's measured spend
  lake-meter report                              your last runs (local history)
  lake-meter mcp                                 run the MCP server (estimate_plan, meter_status)
  lake-meter uninstall [--project]               remove everything init added
Data stays in ${'~'}/.lake-meter. No telemetry.`;

function readStdin() {
  return new Promise((res) => {
    if (process.stdin.isTTY) return res('');
    let d = ''; process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (d += c)); process.stdin.on('end', () => res(d));
  });
}

const flag = (args, f) => args.includes(f);
const opt = (args, f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };

function status(sessionId) {
  const sid = sessionId || latestSessionId();
  const s = sid ? loadSession(sid) : null;
  if (!s?.run) return 'No run recorded yet. Is Lake Meter installed? Run: npx lake-meter init';
  const cfg = loadConfig(process.cwd());
  const t = totals(s.run.seen, loadPrices());
  return runSummary(t, { cap: effectiveCaps(cfg, s.run).usd, capHits: s.run.capHits });
}

function setCap(v) {
  if (v === 'off' || v === 'none') { saveUserConfig({ capUsd: null }); return 'Per-run cap turned off.'; }
  const n = Number(String(v).replace('$', ''));
  if (!Number.isFinite(n) || n <= 0) return 'Usage: cap <usd> | off   e.g. cap 10';
  saveUserConfig({ capUsd: n });
  return `Per-run cap set to ${usd(n)} (API list-price equivalent). Applies from the next tool call.`;
}

function report() {
  const runs = readRuns().slice(-15);
  if (!runs.length) return 'No finished runs yet.';
  const lines = ['Lake Meter · last runs (measured tokens, list-price $)', ''];
  for (const r of runs) {
    const when = new Date(r.end).toLocaleString();
    lines.push(`${when.padEnd(24)} ${usd(r.usd).padStart(7)}  ${String(Math.round(r.tokens / 1000) + 'k tok').padStart(9)}${r.capHits ? `  cap hit ×${r.capHits}` : ''}${r.plan ? `  plan est ${usd(r.plan.estimateUsd[0])}–${usd(r.plan.estimateUsd[1])}` : ''}`);
  }
  const sum = runs.reduce((a, r) => a + r.usd, 0);
  lines.push('', `Total of these runs: ${usd(sum)}`);
  return lines.join('\n');
}

export async function main(argv) {
  const [cmd, ...args] = argv;
  switch (cmd) {
    case 'hook': {
      const raw = await readStdin();
      let input = {}; try { input = JSON.parse(raw || '{}'); } catch { return; }
      if (existsSync(join(home(), 'debug'))) appendFileSync(join(home(), 'debug.jsonl'), JSON.stringify({ event: args[0], input }) + '\n'); // opt-in local debug log: touch ~/.lake-meter/debug
      let out = null;
      try {
        if (args[0] === 'user-prompt-submit') out = onUserPromptSubmit(input);
        else if (args[0] === 'pre-tool-use') out = onPreToolUse(input);
        else if (args[0] === 'post-tool-use') out = onPostToolUse(input);
        else if (args[0] === 'stop') out = await onStop(input);
      } catch (e) {
        // Never break the user's session because of the meter: report on stderr and exit 0 (non-blocking).
        process.stderr.write(`lake-meter: ${e.message}\n`);
        return;
      }
      if (out) process.stdout.write(JSON.stringify(out));
      return;
    }
    case 'statusline': {
      const raw = await readStdin();
      try { process.stdout.write(onStatusLine(JSON.parse(raw || '{}'))); } catch { process.stdout.write('◒ Lake'); }
      return;
    }
    case 'cmd': { // used by the /meter skill
      const sid = opt(args, '--session');
      const rest = args.filter((a, i) => a !== '--session' && args[i - 1] !== '--session');
      const sub = rest[0] || 'status';
      if (sub === 'status') console.log(status(sid));
      else if (sub === 'cap') console.log(setCap(rest[1]));
      else if (sub === 'report') console.log(report());
      else if (sub === 'plan') console.log(planFile(rest[1], rest));
      else console.log('Usage: /meter [status | cap <usd> | cap off | plan <file> | report]');
      return;
    }
    case 'plan': {
      console.log(planFile(args[0], args));
      return;
    }
    case 'cap': console.log(setCap(args[0])); return;
    case 'status': console.log(status(opt(args, '--session'))); return;
    case 'report': console.log(report()); return;
    case 'mcp': serve(); return;
    case 'init': {
      const cap = opt(args, '--cap');
      init({ project: flag(args, '--project'), capUsd: cap != null ? Number(cap) : undefined, agents: !flag(args, '--no-agents'), statusline: flag(args, '--statusline') });
      return;
    }
    case 'uninstall': uninstall({ project: flag(args, '--project') }); return;
    case 'where': console.log(home()); return;
    case '--version': case '-v': console.log(JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).version); return;
    default: console.log(HELP);
  }
}

function planFile(file, args) {
  let text;
  if (!file || file === '-') text = readFileSync(0, 'utf8');
  else if (existsSync(file)) text = readFileSync(file, 'utf8');
  else return `File not found: ${file}`;
  const a = analyzePlan(text, loadPrices(), { provider: flag(args, '--openai') ? 'openai' : loadConfig(process.cwd()).provider });
  if (!a.steps.length) return 'Could not find steps in that plan (use numbered items, headings or bullets).';
  return flag(args, '--json') ? JSON.stringify(a, null, 2) : planTable(a, { reasons: flag(args, '--why') });
}
