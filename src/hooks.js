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

export function effectiveCaps(cfg, run) {
  return {
    usd: cfg.capUsd != null ? cfg.capUsd + (run.extraUsd || 0) : null,
    tokens: cfg.capTokens != null ? cfg.capTokens + (run.extraTokens || 0) : null,
    fiveHourPct: cfg.capFiveHourPct != null ? cfg.capFiveHourPct + (run.extraPct || 0) : null,
  };
}

function overCap(t, caps, s, cfg) {
  if (caps.usd != null && t.usd >= caps.usd) return `this run has used about ${usd(t.usd)} (cap ${usd(caps.usd)})`;
  if (caps.tokens != null && t.tokens >= caps.tokens) return `this run has used ${Math.round(t.tokens / 1000)}k tokens (cap ${Math.round(caps.tokens / 1000)}k)`;
  const sl = s.statusline;
  if (caps.fiveHourPct != null && sl?.fiveHourPct != null && Date.now() - sl.at < 10 * 60e3 && sl.fiveHourPct >= caps.fiveHourPct)
    return `your 5-hour usage window is at ${Math.round(sl.fiveHourPct)}% (cap ${caps.fiveHourPct}%)`;
  if (cfg.sessionCapUsd != null && s.sessionUsd != null && s.sessionUsd >= cfg.sessionCapUsd) return `this session has used about ${usd(s.sessionUsd)} (session cap ${usd(cfg.sessionCapUsd)})`;
  return null;
}

/** UserPromptSubmit: a new run starts. */
export function onUserPromptSubmit(input) {
  const s = loadSession(input.session_id);
  if (input.transcript_path) s.transcriptPath = input.transcript_path;
  // Advance offsets so earlier history is never re-read for this run.
  s.offsets ||= {};
  for (const f of sessionFiles(s.transcriptPath)) {
    const { entries, offset } = scanFile(f, s.offsets[f] || 0);
    s.offsets[f] = offset;
    absorb((s.sessionSeen ||= {}), entries, 0);
  }
  const now = Date.now();
  s.run = { start: now, seen: {}, extraUsd: 0, extraTokens: 0, extraPct: 0, capHits: 0, warned: false, pendingAsk: null, startedAt: now };
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

  const caps = effectiveCaps(cfg, run);
  const reason = overCap(t, caps, s, cfg);
  if (reason) {
    run.capHits++;
    const ext = cfg.capUsd != null ? usd(cfg.capUsd * cfg.extendPct / 100) : `${cfg.extendPct}%`;
    const unattended = cfg.onCap === 'stop' || UNATTENDED_MODES.has(input.permission_mode);
    if (unattended) {
      out.continue = false;
      out.stopReason = `Lake Meter paused the run: ${reason}. Reply "continue" to start a new run, or raise the cap with /meter cap <usd>.`;
      out.hookSpecificOutput.permissionDecision = 'deny';
      out.hookSpecificOutput.permissionDecisionReason = `Lake Meter cap reached: ${reason}. The user has been asked how to proceed. Stop and wait for the user.`;
      appendRun({ session: input.session_id, start: run.start || null, end: Date.now(), usd: +t.usd.toFixed(4), tokens: t.tokens, output: t.output, cacheRead: t.cacheRead, requests: t.requests, byModel: t.byModel, subagentUsd: +t.subagent.usd.toFixed(4), capUsd: caps.usd, capHits: run.capHits, stoppedByCap: true });
    } else {
      run.pendingAsk = input.tool_use_id || 'pending';
      out.hookSpecificOutput.permissionDecision = 'ask';
      out.hookSpecificOutput.permissionDecisionReason = `Lake Meter: ${reason}. Approve to continue with +${ext} headroom. Deny to stop here. Or run /meter cap <usd> to set a new cap.`;
    }
  } else if (!run.warned && caps.usd && t.usd >= caps.usd * (cfg.warnPct / 100)) {
    run.warned = true;
    msgs.push(`Lake Meter: this run is at ${usd(t.usd)} of its ${usd(caps.usd)} cap.`);
    ctx.push(`Run spend is at ${Math.round((t.usd / caps.usd) * 100)}% of the user's per-run budget of ${usd(caps.usd)}. Tool calls will need the user's approval once it is reached.`);
  }

  saveSession(s);
  if (ctx.length) out.hookSpecificOutput.additionalContext = ctx.join('\n');
  if (msgs.length) out.systemMessage = msgs.join('\n\n');
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
  if (cfg.capUsd != null) {
    const target = Math.max(t.usd, cfg.capUsd + run.extraUsd) + cfg.capUsd * cfg.extendPct / 100;
    run.extraUsd = target - cfg.capUsd;
  }
  if (cfg.capTokens != null) run.extraTokens = Math.max(t.tokens, cfg.capTokens + run.extraTokens) + cfg.capTokens * cfg.extendPct / 100 - cfg.capTokens;
  if (cfg.capFiveHourPct != null) run.extraPct = Math.max(0, (s.statusline?.fiveHourPct ?? cfg.capFiveHourPct) - cfg.capFiveHourPct) + 5;
  run.pendingAsk = null;
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
  const caps = effectiveCaps(cfg, run);
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
  const caps = s.run ? effectiveCaps(cfg, s.run) : { usd: cfg.capUsd };
  const parts = ['◒ Lake'];
  if (t) parts.push(`run ${usd(t.usd)}${caps.usd != null ? ` / ${usd(caps.usd)}` : ''}`);
  if (s.statusline.costUsd != null) parts.push(`session ${usd(s.statusline.costUsd)}`);
  if (fiveHourPct != null) parts.push(`5h ${Math.round(fiveHourPct)}%`);
  return parts.join(' · ');
}
