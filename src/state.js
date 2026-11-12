// Local state only. Nothing leaves the machine. Layout under ~/.lake-meter (or $LAKE_METER_HOME):
//   config.json            user settings (cap, mode, provider)
//   sessions/<id>.json     per-session meter state (offsets, current run, plan estimate)
//   runs.jsonl             one line per finished run, for `lake-meter report`
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, appendFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export const DEFAULT_CONFIG = {
  capUsd: 5,            // per-run cap in USD (API list-price equivalent)
  capTokens: null,      // optional per-run cap in total tokens (input + output + cache)
  capFiveHourPct: null, // optional: stop when the 5-hour subscription window passes this % (needs the statusline)
  sessionCapUsd: null,  // optional cap across the whole session
  onCap: 'ask',         // 'ask' = permission prompt before the next tool call; 'stop' = end the turn
  extendPct: 50,        // approving a cap prompt adds this % of the cap as headroom
  warnPct: 80,          // one heads-up when a run passes this % of its cap
  provider: 'anthropic',
};

export function home() {
  return process.env.LAKE_METER_HOME || join(homedir(), '.lake-meter');
}

function readJson(p, fallback) {
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return fallback; }
}

export function writeJsonAtomic(p, data) {
  mkdirSync(join(p, '..'), { recursive: true });
  const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, p);
}

/** Config = defaults < ~/.lake-meter/config.json < <project>/.lake-meter.json */
export function loadConfig(cwd) {
  const user = readJson(join(home(), 'config.json'), {});
  const proj = cwd ? readJson(join(cwd, '.lake-meter.json'), {}) : {};
  return { ...DEFAULT_CONFIG, ...user, ...proj };
}

export function saveUserConfig(patch) {
  const p = join(home(), 'config.json');
  const cur = readJson(p, {});
  writeJsonAtomic(p, { ...cur, ...patch });
}

const safeId = (id) => String(id || 'unknown').replace(/[^\w.-]/g, '_');

export function sessionPath(sessionId) {
  return join(home(), 'sessions', `${safeId(sessionId)}.json`);
}

export function loadSession(sessionId) {
  return readJson(sessionPath(sessionId), { sessionId, offsets: {}, run: null, plan: null, statusline: null });
}

export function saveSession(s) {
  writeJsonAtomic(sessionPath(s.sessionId), s);
}

/** Most recently touched session (for CLI commands run outside Claude Code). */
export function latestSessionId() {
  const dir = join(home(), 'sessions');
  if (!existsSync(dir)) return null;
  let best = null, bestT = 0;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    const t = statSync(join(dir, f)).mtimeMs;
    if (t > bestT) { bestT = t; best = f.slice(0, -5); }
  }
  return best;
}

export function appendRun(record) {
  mkdirSync(home(), { recursive: true });
  appendFileSync(join(home(), 'runs.jsonl'), JSON.stringify(record) + '\n');
}

export function readRuns() {
  const p = join(home(), 'runs.jsonl');
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}
