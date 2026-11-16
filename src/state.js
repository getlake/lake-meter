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
  annotatePlans: true,
};

export function home() {
  return process.env.LAKE_METER_HOME || join(homedir(), '.lake-meter');
}

function readJson(p, fallback) {
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return fallback; }
}

/** Read a JSON object file. On missing file, returns fallback. On parse failure, warns and returns fallback without mutating the file. */
export function readConfigFile(p, fallback, warn = defaultWarn) {
  if (!existsSync(p)) return fallback;
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch (err) {
    warn(`lake-meter: could not parse ${p}: ${err.message}. Ignoring this file and using defaults for its values.`);
    return fallback;
  }
}

function defaultWarn(msg) {
  process.stderr.write(msg.endsWith('\n') ? msg : msg + '\n');
}

export function writeJsonAtomic(p, data) {
  mkdirSync(join(p, '..'), { recursive: true });
  const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, p);
}

/**
 * Parse a user-supplied USD cap (CLI --cap, `lake-meter cap`).
 * Accepts optional leading $ and commas: 10, $10, "$10", 1,000.50.
 * 'off' / 'none' (case-insensitive) clears the cap when allowOff is true.
 */
export function parseCapUsd(raw, { allowOff = false } = {}) {
  if (raw == null) return { ok: false };
  const s = String(raw).trim();
  if (allowOff && /^(off|none)$/i.test(s)) return { ok: true, value: null };
  const n = Number(s.replace(/^\$/, '').replace(/,/g, ''));
  if (!Number.isFinite(n) || n <= 0) return { ok: false };
  return { ok: true, value: n };
}

const NUMERIC_KEYS = new Set(['capUsd', 'capTokens', 'capFiveHourPct', 'sessionCapUsd', 'extendPct', 'warnPct']);
const NULLABLE_CAPS = new Set(['capUsd', 'capTokens', 'capFiveHourPct', 'sessionCapUsd']);

function coerceNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return { ok: true, value, coerced: false };
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value.trim().replace(/^\$/, '').replace(/,/g, ''));
    if (Number.isFinite(n)) return { ok: true, value: n, coerced: true };
  }
  return { ok: false };
}

/** Validate and coerce a raw config object. Invalid or missing fields fall back to `base` (defaults, or already-normalized user config). */
export function normalizeConfig(raw, warn = defaultWarn, source = 'config', base = DEFAULT_CONFIG) {
  const out = { ...base };
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    warn(`lake-meter: ${source} is not a JSON object; using previous values.`);
    return out;
  }
  for (const key of Object.keys(DEFAULT_CONFIG)) {
    if (!(key in raw)) continue;
    const v = raw[key];
    if (NUMERIC_KEYS.has(key)) {
      if (v == null) {
        if (NULLABLE_CAPS.has(key)) { out[key] = null; continue; }
        warn(`lake-meter: ${source}: ${key} cannot be null; using ${out[key]}.`);
        continue;
      }
      const n = coerceNumber(v);
      if (!n.ok) {
        warn(`lake-meter: ${source}: invalid ${key} ${JSON.stringify(v)}; using ${out[key]}.`);
        continue;
      }
      if (n.coerced) warn(`lake-meter: ${source}: ${key} should be a number, not a string; using ${n.value}.`);
      if (key === 'extendPct') {
        if (!(n.value > 0)) {
          warn(`lake-meter: ${source}: extendPct must be greater than 0; using ${out.extendPct}.`);
          continue;
        }
        out[key] = n.value;
        continue;
      }
      if (key === 'warnPct') {
        if (n.value < 0 || n.value > 100) {
          warn(`lake-meter: ${source}: warnPct must be between 0 and 100; using ${out.warnPct}.`);
          continue;
        }
        out[key] = n.value;
        continue;
      }
      if (n.value <= 0) {
        warn(`lake-meter: ${source}: ${key} must be a positive number; using ${out[key]}.`);
        continue;
      }
      out[key] = n.value;
      continue;
    }
    if (key === 'onCap') {
      const s = String(v).toLowerCase();
      if (s === 'ask' || s === 'stop') { out.onCap = s; continue; }
      warn(`lake-meter: ${source}: invalid onCap ${JSON.stringify(v)}; using '${out.onCap}'.`);
      continue;
    }
    if (key === 'provider') {
      const s = String(v).toLowerCase();
      if (s === 'anthropic' || s === 'openai') { out.provider = s; continue; }
      warn(`lake-meter: ${source}: invalid provider ${JSON.stringify(v)}; using '${out.provider}'.`);
      continue;
    }
    if (key === 'annotatePlans') {
      if (typeof v === 'boolean') { out.annotatePlans = v; continue; }
      if (v === 'true' || v === 'false') {
        out.annotatePlans = v === 'true';
        warn(`lake-meter: ${source}: annotatePlans should be a boolean, not a string; using ${out.annotatePlans}.`);
        continue;
      }
      warn(`lake-meter: ${source}: invalid annotatePlans ${JSON.stringify(v)}; using ${out.annotatePlans}.`);
    }
  }
  // Keep unknown keys out of the runtime config so they cannot poison comparisons.
  return out;
}

/** Config = defaults < ~/.lake-meter/config.json < <project>/.lake-meter.json */
export function loadConfig(cwd, warn = defaultWarn) {
  const userPath = join(home(), 'config.json');
  const user = normalizeConfig(readConfigFile(userPath, {}, warn), warn, userPath);
  if (!cwd) return user;
  const projPath = join(cwd, '.lake-meter.json');
  if (!existsSync(projPath)) return user;
  const projRaw = readConfigFile(projPath, null, warn);
  if (projRaw == null) return user;
  return normalizeConfig(projRaw, warn, projPath, user);
}

export function saveUserConfig(patch, warn = defaultWarn) {
  const p = join(home(), 'config.json');
  let cur = {};
  if (existsSync(p)) {
    try {
      cur = JSON.parse(readFileSync(p, 'utf8'));
    } catch (err) {
      // Throw only (no warn): callers print the message once (M-25).
      throw new Error(`lake-meter: refusing to overwrite unparseable ${p}: ${err.message}. Fix or remove the file, then retry.`);
    }
    if (cur == null || typeof cur !== 'object' || Array.isArray(cur)) {
      throw new Error(`lake-meter: refusing to overwrite ${p}: expected a JSON object.`);
    }
  }
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

/** Identity of a recorded run: same session + same run start ⇒ the same run (M-23). */
export function runKey(record) {
  if (record?.session && record.start) return `${record.session}:${record.start}`;
  return null;
}

/** Dedupe by session+start so /meter or a later Stop cannot double-count the same run. Returns false if skipped. */
export function appendRun(record) {
  const key = runKey(record);
  if (key && readRuns().some((r) => runKey(r) === key)) return false;
  mkdirSync(home(), { recursive: true });
  appendFileSync(join(home(), 'runs.jsonl'), JSON.stringify(record) + '\n');
  return true;
}

/** First occurrence of each session+start, in file order (the original Stop, not a later /meter recopy). */
export function uniqueRuns(runs) {
  const seen = new Set();
  const out = [];
  for (const r of runs) {
    const k = runKey(r);
    if (k) {
      if (seen.has(k)) continue;
      seen.add(k);
    }
    out.push(r);
  }
  return out;
}

export function readRuns() {
  const p = join(home(), 'runs.jsonl');
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}
