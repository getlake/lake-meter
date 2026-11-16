// Claude Code hook handlers. Each takes the hook's stdin JSON and returns the JSON to print (or null).
// Docs: https://code.claude.com/docs/en/hooks
import { loadPrices } from './pricing.js';
import { sessionFiles, scanFile, absorb, totals } from './transcript.js';
import { loadConfig, loadSession, saveSession, appendRun } from './state.js';
import { analyzePlan } from './plan.js';
import { usd, range, runSummary, planTable, planMarkdown } from './format.js';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const UNATTENDED_MODES = new Set(['bypassPermissions', 'dontAsk']);

function ensureRun(s, now) {
  if (!s.run) s.run = { start: 0, seen: {}, extraUsd: 0, extraTokens: 0, capHits: 0, warned: false, pendingAsk: null, startedAt: now };
  return s.run;
}

/** Scan new transcript bytes into the current run. Returns run totals (measured tokens, list-price USD). */
export function refresh(s, input, prices) {
  if (input.transcript_path) s.transcriptPath = input.transcript_path;
  const run = ensureRun(s, Date.now());
  s.offsets ||= {};
  s.sessionSeen ||= {};
  for (const f of sessionFiles(s.transcriptPath)) {
    const { entries, offset } = scanFile(f, s.offsets[f] || 0);
    s.offsets[f] = offset;
    absorb(run.seen, entries, run.start);
    absorb((s.sessionSeen ||= {}), entries, 0);
  }
  const fresh = s.statusline?.costUsd != null && Date.now() - s.statusline.at < 10 * 60e3;
  s.sessionUsd = fresh ? s.statusline.costUsd : totals(s.sessionSeen, prices).usd;
  return totals(run.seen, prices);
}

export function effectiveCaps(cfg, run, s = {}) {
  return {
    usd: cfg.capUsd != null ? cfg.capUsd + (run?.extraUsd || 0) : null,
    tokens: cfg.capTokens != null ? cfg.capTokens + (run?.extraTokens || 0) : null,
    fiveHourPct: cfg.capFiveHourPct != null ? cfg.capFiveHourPct + (run?.extraPct || 0) : null,
    sessionUsd: cfg.sessionCapUsd != null ? cfg.sessionCapUsd + (s.extraSessionUsd || 0) : null,
  };
}

function overCap(t, caps, s) {
  if (caps.usd != null && t.usd >= caps.usd)
    return { kind: 'usd', reason: `this run has used about ${usd(t.usd)} (cap ${usd(caps.usd)})`, amount: t.usd, cap: caps.usd };
  if (caps.tokens != null && t.tokens >= caps.tokens)
    return { kind: 'tokens', reason: `this run has used ${Math.round(t.tokens / 1000)}k tokens (cap ${Math.round(caps.tokens / 1000)}k)`, amount: t.tokens, cap: caps.tokens };
  const sl = s.statusline;
  if (caps.fiveHourPct != null && sl?.fiveHourPct != null && Date.now() - sl.at < 10 * 60e3 && sl.fiveHourPct >= caps.fiveHourPct)
    return { kind: 'fiveHour', reason: `your 5-hour usage window is at ${Math.round(sl.fiveHourPct)}% (cap ${Math.round(caps.fiveHourPct)}%)`, amount: sl.fiveHourPct, cap: caps.fiveHourPct };
  if (caps.sessionUsd != null && s.sessionUsd != null && s.sessionUsd >= caps.sessionUsd)
    return { kind: 'session', reason: `this session has used about ${usd(s.sessionUsd)} (session cap ${usd(caps.sessionUsd)})`, amount: s.sessionUsd, cap: caps.sessionUsd };
  return null;
}

function headroomLabel(hit, cfg) {
  const pct = cfg.extendPct;
  if (hit.kind === 'usd' && cfg.capUsd != null) return usd(cfg.capUsd * pct / 100);
  if (hit.kind === 'session' && cfg.sessionCapUsd != null) return usd(cfg.sessionCapUsd * pct / 100);
  if (hit.kind === 'tokens' && cfg.capTokens != null) return `${Math.round(cfg.capTokens * pct / 100 / 1000)}k tokens`;
  return `${pct}%`;
}

/** Exact user-facing pause line. Do not wrap this in hook-error language. */
export function pauseMessage(hit) {
  if (hit.kind === 'usd' || hit.kind === 'session')
    return `Lake Meter paused the run at ${usd(hit.amount)} (cap ${usd(hit.cap)})`;
  if (hit.kind === 'tokens')
    return `Lake Meter paused the run at ${Math.round(hit.amount / 1000)}k tokens (cap ${Math.round(hit.cap / 1000)}k)`;
  if (hit.kind === 'fiveHour')
    return `Lake Meter paused the run at ${Math.round(hit.amount)}% of the 5-hour window (cap ${Math.round(hit.cap)}%)`;
  return `Lake Meter paused the run: ${hit.reason}`;
}

function applyHeadroom(cfg, run, s, t, kinds) {
  const pct = cfg.extendPct / 100;
  for (const kind of kinds) {
    if (kind === 'usd' && cfg.capUsd != null) {
      const target = Math.max(t.usd, cfg.capUsd + (run.extraUsd || 0)) + cfg.capUsd * pct;
      run.extraUsd = target - cfg.capUsd;
    }
    if (kind === 'tokens' && cfg.capTokens != null) {
      run.extraTokens = Math.max(t.tokens, cfg.capTokens + (run.extraTokens || 0)) + cfg.capTokens * pct - cfg.capTokens;
    }
    if (kind === 'fiveHour' && cfg.capFiveHourPct != null) {
      run.extraPct = Math.max(0, (s.statusline?.fiveHourPct ?? cfg.capFiveHourPct) - cfg.capFiveHourPct) + 5;
    }
    if (kind === 'session' && cfg.sessionCapUsd != null) {
      const current = cfg.sessionCapUsd + (s.extraSessionUsd || 0);
      const target = Math.max(s.sessionUsd ?? 0, current) + cfg.sessionCapUsd * pct;
      s.extraSessionUsd = target - cfg.sessionCapUsd;
    }
  }
}

/** /meter (and /meter status, /meter cap, …) is itself a UserPromptSubmit; it must not start a new run. */
export function isMeterCommand(prompt) {
  const p = String(prompt || '').trim();
  if (/^\/meter\b/i.test(p)) return true;
  if (/<(?:command-name|command_name)>\s*\/?meter\b/i.test(p)) return true;
  return false;
}

/** UserPromptSubmit: a new run starts, unless this prompt is the /meter slash command. */
export function onUserPromptSubmit(input) {
  const s = loadSession(input.session_id);
  if (input.transcript_path) s.transcriptPath = input.transcript_path;
  // Advance offsets so earlier history is never re-read for this run.
  s.offsets ||= {};
  for (const f of sessionFiles(s.transcriptPath)) {
    const { entries, offset } = scanFile(f, s.offsets[f] || 0);
    s.offsets[f] = offset;
    absorb((s.sessionSeen ||= {}), entries, 0);
    if (s.run) absorb(s.run.seen, entries, s.run.start);
  }
  if (!isMeterCommand(input.prompt)) {
    const now = Date.now();
    s.run = { start: now, seen: {}, extraUsd: 0, extraTokens: 0, extraPct: 0, capHits: 0, warned: false, pendingAsk: null, pendingAskKind: null, startedAt: now };
  }
  saveSession(s);
  return null;
}

/** PreToolUse (all tools): enforce the cap; on ExitPlanMode also produce the plan breakdown. */
export function onPreToolUse(input, prices = loadPrices()) {
  const cfg = loadConfig(input.cwd);
  const s = loadSession(input.session_id);
  const t = refresh(s, input, prices);
  const run = s.run;
  const out = { hookSpecificOutput: { hookEventName: 'PreToolUse' } };
  const ctx = [];
  const msgs = [];

  if (input.tool_name === 'ExitPlanMode' && input.tool_input?.plan) {
    const a = analyzePlan(stripPlanSection(input.tool_input.plan), prices, { provider: cfg.provider });
    if (a.steps.length) {
      s.plan = { createdAt: Date.now(), estimateUsd: a.total.usd, baselineUsd: a.total.baselineUsd, steps: a.steps.map((x) => ({ title: x.title, complexity: x.complexity, model: x.alias, usd: x.usd })) };
      msgs.push(planTable(a));
      const light = a.steps.filter((x) => x.tier === 'light').map((x) => x.n);
      const std = a.steps.filter((x) => x.tier === 'standard').map((x) => x.n);
      ctx.push(`Lake Meter estimated this plan at ${range(a.total.usd)} with per-step models, vs ${range(a.total.baselineUsd)} on ${a.baselineLabel} for everything.`
        + (light.length ? ` Steps ${light.join(', ')} are rated light (mechanical); the lake-light subagent (model: haiku) exists for steps like these.` : '')
        + (std.length ? ` Steps ${std.join(', ')} are rated standard; the lake-standard subagent (model: sonnet) exists for steps like these.` : '')
        + ' Delegating is optional and up to the user and the main agent.');
    }
  }

  const caps = effectiveCaps(cfg, run, s);
  const hit = overCap(t, caps, s);
  if (hit) {
    run.capHits++;
    const ext = headroomLabel(hit, cfg);
    const unattended = cfg.onCap === 'stop' || UNATTENDED_MODES.has(input.permission_mode);
    if (unattended) {
      const pause = pauseMessage(hit);
      out.continue = false;
      out.stopReason = `${pause}. Reply "continue" to start a new run, or raise the cap with /meter cap <usd>.`;
      // permissionDecision: deny is what actually blocks the tool in unattended modes.
      // The reason must be the clear pause line — not "hook error" / "the user has been asked".
      out.hookSpecificOutput.permissionDecision = 'deny';
      out.hookSpecificOutput.permissionDecisionReason = pause;
      out.systemMessage = `${pause}\n${runSummary(t, { cap: caps.usd ?? caps.sessionUsd, capHits: run.capHits })}`;
      appendRun({ session: input.session_id, start: run.start || null, end: Date.now(), usd: +t.usd.toFixed(4), tokens: t.tokens, output: t.output, cacheRead: t.cacheRead, requests: t.requests, byModel: t.byModel, subagentUsd: +t.subagent.usd.toFixed(4), capUsd: caps.usd, capHits: run.capHits, stoppedByCap: true });
    } else {
      run.pendingAsk = input.tool_use_id || 'pending';
      run.pendingAskKind = hit.kind;
      out.hookSpecificOutput.permissionDecision = 'ask';
      out.hookSpecificOutput.permissionDecisionReason = `Lake Meter: ${hit.reason}. Approve to continue with +${ext} headroom. Deny to stop here. Or run /meter cap <usd> to set a new cap.`;
    }
  } else if (!run.warned && caps.usd && t.usd >= caps.usd * (cfg.warnPct / 100)) {
    run.warned = true;
    msgs.push(`Lake Meter: this run is at ${usd(t.usd)} of its ${usd(caps.usd)} cap.`);
    ctx.push(`Run spend is at ${Math.round((t.usd / caps.usd) * 100)}% of the user's per-run budget of ${usd(caps.usd)}. Tool calls will need the user's approval once it is reached.`);
  }

  saveSession(s);
  if (ctx.length) out.hookSpecificOutput.additionalContext = ctx.join('\n');
  if (msgs.length) out.systemMessage = (out.systemMessage ? out.systemMessage + '\n\n' : '') + msgs.join('\n\n');
  const hso = out.hookSpecificOutput;
  if (!out.systemMessage && !hso.additionalContext && !hso.permissionDecision && out.continue === undefined) return null;
  return out;
}

export const PLAN_SECTION = '## Lake Meter: model per step (estimate)';

/** Strip a previous Lake Meter section so re-analysis never feeds on itself. */
const TOP_MARK = '> **Lake Meter estimate:**';
export function stripPlanSection(text) {
  let t = String(text);
  const i = t.indexOf(PLAN_SECTION);
  if (i !== -1) t = t.slice(0, i).trimEnd() + '\n';
  if (t.startsWith(TOP_MARK)) t = t.slice(t.indexOf('\n') + 1).replace(/^\n+/, '');
  return t;
}

/**
 * When Claude writes or edits its plan file in plan mode, append (or refresh) a per-step model and cost
 * section at the end of that file, so it shows up in Claude Code's own "Ready to code?" plan dialog.
 */
export function annotatePlanFile(input, prices, cfg, s) {
  const fp = input.tool_input?.file_path;
  if (!fp || !/[\\/]plans[\\/][^\\/]+\.md$/.test(fp) || !existsSync(fp)) return false;
  if (input.permission_mode && input.permission_mode !== 'plan') return false;
  if (cfg.annotatePlans === false) return false;
  const original = stripPlanSection(readFileSync(fp, 'utf8'));
  const a = analyzePlan(original, prices, { provider: cfg.provider });
  if (a.steps.length < 2) return false;
  s.plan = { createdAt: Date.now(), estimateUsd: a.total.usd, baselineUsd: a.total.baselineUsd, steps: a.steps.map((x) => ({ title: x.title, complexity: x.complexity, model: x.alias, usd: x.usd })) };
  const md = planMarkdown(a).replace(/^\*\*Lake Meter plan breakdown\*\* /, '');
  const top = `${TOP_MARK} ${range(a.total.usd)} with a model per step, vs ${range(a.total.baselineUsd)} all on ${a.baselineLabel}. Table at the end.\n\n`;
  writeFileSync(fp, `${top}${original.trimEnd()}\n\n${PLAN_SECTION}\n\n${md}\n\nCheap steps can go to the \`lake-light\` (Haiku) or \`lake-standard\` (Sonnet) subagents. Heuristic estimate by lake-meter; measured spend is shown when the run ends.\n`);
  return true;
}

/** PostToolUse: plan-file annotation, and cap approvals (the tool we asked about ran, so the user said yes). */
export function onPostToolUse(input, prices = loadPrices()) {
  const s = loadSession(input.session_id);
  if (/^(Write|Edit|MultiEdit)$/.test(input.tool_name || '')) {
    try { if (annotatePlanFile(input, prices, loadConfig(input.cwd), s)) saveSession(s); } catch { /* never break the session */ }
  }
  const run = s.run;
  if (!run?.pendingAsk) return null;
  if (run.pendingAsk !== 'pending' && input.tool_use_id && input.tool_use_id !== run.pendingAsk) return null;
  const cfg = loadConfig(input.cwd);
  const t = totals(run.seen, prices);
  // Session totals may have been computed on the last PreToolUse; keep them current if we have statusline/sessionSeen.
  if (s.sessionUsd == null && s.sessionSeen) {
    try { s.sessionUsd = totals(s.sessionSeen, prices).usd; } catch { /* ignore */ }
  }
  const kinds = new Set();
  if (run.pendingAskKind) kinds.add(run.pendingAskKind);
  const still = overCap(t, effectiveCaps(cfg, run, s), s);
  if (still) kinds.add(still.kind);
  if (!kinds.size && cfg.capUsd != null) kinds.add('usd');
  applyHeadroom(cfg, run, s, t, kinds);
  run.pendingAsk = null;
  run.pendingAskKind = null;
  run.warned = true; // the user just chose to continue; no extra heads-up for this extension
  saveSession(s);
  return null;
}

/** Stop: end-of-run summary (shown to the user, never blocks). */
export async function onStop(input, prices = loadPrices(), { settleMs = 300 } = {}) {
  if (settleMs) await new Promise((r) => setTimeout(r, settleMs)); // transcript is written asynchronously
  const cfg = loadConfig(input.cwd);
  const s = loadSession(input.session_id);
  const t = refresh(s, input, prices);
  const run = s.run;
  let plan = null;
  if (s.plan) {
    const seen = {};
    for (const f of sessionFiles(s.transcriptPath)) absorb(seen, scanFile(f, 0).entries, s.plan.createdAt);
    plan = { actualUsd: totals(seen, prices).usd, estimateUsd: s.plan.estimateUsd };
  }
  const caps = effectiveCaps(cfg, run, s);
  const summary = runSummary(t, { cap: caps.usd, capHits: run.capHits, plan });
  appendRun({ session: input.session_id, start: run.start || null, end: Date.now(), usd: +t.usd.toFixed(4), tokens: t.tokens, output: t.output, cacheRead: t.cacheRead, requests: t.requests, byModel: t.byModel, subagentUsd: +t.subagent.usd.toFixed(4), capUsd: caps.usd, capHits: run.capHits, plan, statuslineSessionUsd: s.statusline?.costUsd ?? null });
  s.lastRun = { usd: t.usd, tokens: t.tokens, end: Date.now() };
  saveSession(s);
  if (!t.requests) return null;
  return { systemMessage: summary };
}

/** statusLine command: show the meter, and keep Claude Code's own session cost + rate-limit % for cap checks. */
export function onStatusLine(input, prices = loadPrices()) {
  const cfg = loadConfig(input.cwd || input.workspace?.current_dir);
  const s = loadSession(input.session_id);
  const fiveHourPct = input.rate_limits?.five_hour?.used_percentage ?? null;
  s.statusline = { costUsd: input.cost?.total_cost_usd ?? null, fiveHourPct, sevenDayPct: input.rate_limits?.seven_day?.used_percentage ?? null, at: Date.now() };
  s.sessionUsd = s.statusline.costUsd ?? s.sessionUsd ?? null;
  const t = s.run ? totals(s.run.seen, prices) : null;
  saveSession(s);
  const caps = s.run ? effectiveCaps(cfg, s.run, s) : { usd: cfg.capUsd };
  const parts = ['◒ Lake'];
  if (t) parts.push(`run ${usd(t.usd)}${caps.usd != null ? ` / ${usd(caps.usd)}` : ''}`);
  if (s.statusline.costUsd != null) parts.push(`session ${usd(s.statusline.costUsd)}`);
  if (fiveHourPct != null) parts.push(`5h ${Math.round(fiveHourPct)}%`);
  return parts.join(' · ');
}
