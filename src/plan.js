// Plan breakdown: split a markdown plan into steps, rate complexity 1-5 with transparent heuristics,
// recommend the cheapest model tier that should handle each step, and estimate token / USD ranges.
// Everything here is an ESTIMATE. The reasons for each score are returned so users can disagree.
import { costOfBudget } from './pricing.js';

const SKIP_HEADINGS = /^(context|background|overview|summary|goal|goals|notes?|open questions?|assumptions|out of scope|non-goals|references|tl;?dr|why|problem|motivation)\b/i;

/** Split markdown into steps. Prefers step-like headings, then top-level numbered items, then bullets. */
export function splitPlan(markdown) {
  const text = String(markdown || '').replace(/\r\n/g, '\n');
  const lines = text.split('\n');

  // 1) Headings (##..####) that are not the document title and not context sections.
  const heads = [];
  lines.forEach((l, i) => { const m = /^(#{2,4})\s+(.*)$/.exec(l); if (m) heads.push({ i, level: m[1].length, title: m[2].trim() }); });
  const CONTAINER = /^(steps?|plan|implementation( plan)?|tasks?|changes|approach|proposed changes|work items?)\b/i;
  const stepLike = (h) => !SKIP_HEADINGS.test(h.title.replace(/^(step|phase|part)?\s*\d+[.:)]?\s*/i, '')) && !CONTAINER.test(h.title);
  const byLevel = {};
  for (const h of heads) if (stepLike(h)) (byLevel[h.level] ||= []).push(h);
  const levels = Object.keys(byLevel).map(Number).sort((a, b) => byLevel[b].length - byLevel[a].length || b - a);
  if (levels.length && byLevel[levels[0]].length >= 2) {
    const level = levels[0];
    return byLevel[level].map((h) => {
      const next = heads.find((x) => x.i > h.i && x.level <= level);
      const body = lines.slice(h.i + 1, next ? next.i : lines.length).join('\n').trim();
      return { title: clean(h.title), body };
    });
  }

  // 2) Top-level numbered list items (also "- [ ]" checkboxes), with indented continuation lines.
  for (const re of [/^(\d+)[.)]\s+(.*)$/, /^[-*]\s+\[[ xX]\]\s+(.*)$/, /^[-*]\s+(.*)$/]) {
    const items = [];
    let cur = null;
    for (const l of lines) {
      const m = re.exec(l);
      if (m) { cur = { title: clean(m[m.length - 1]), body: '' }; items.push(cur); continue; }
      if (cur && (/^\s+\S/.test(l) || l.trim() === '')) { cur.body += l.trim() ? l.trim() + '\n' : ''; continue; }
      if (cur && /^#{1,6}\s/.test(l)) cur = null;
      else if (cur && l.trim()) cur = null;
    }
    if (items.length >= 2) return items.map((s) => ({ title: s.title, body: s.body.trim() }));
  }

  // 3) Fallback: paragraphs.
  const paras = text.split(/\n\s*\n/).map((p) => p.trim()).filter((p) => p && !/^#\s/.test(p));
  return paras.slice(0, 30).map((p) => ({ title: clean(p.split('\n')[0]).slice(0, 90), body: p }));
}

function clean(s) {
  return s.replace(/^(step|phase|part)\s*\d+\s*[.:)\-–—]\s*/i, '').replace(/^\d+[.)]\s*/, '').replace(/\*\*|__|`/g, '').trim();
}

const SIGNALS = [
  // [regex, weight, reason]
  [/\b(architect\w*|redesign|re-?architect|system design)\b/i, 2, 'architecture'],
  [/\b(migrat\w+|schema change|data model|backfill)\b/i, 2, 'data/schema migration'],
  [/\b(concurren\w+|race condition|deadlock|lock(ing)?|distributed|consisten\w+|idempoten\w+|transaction\w*)\b/i, 2, 'concurrency/consistency'],
  [/\b(security|auth\w*|permission\w*|encrypt\w*|secret\w*|oauth|csrf|xss|injection)\b/i, 2, 'security-sensitive'],
  [/\b(payment\w*|billing|invoice\w*|money)\b/i, 1, 'money paths'],
  [/\b(performance|optimi[sz]\w+|latency|memory leak|profil\w+)\b/i, 1, 'performance work'],
  [/\b(refactor\w*|restructur\w+|rewrite)\b/i, 1, 'refactor'],
  [/\b(algorithm\w*|parser|compiler|protocol|state machine)\b/i, 2, 'algorithmic'],
  [/\b(debug\w*|investigat\w+|root cause|flaky|intermittent)\b/i, 1, 'debugging/unknowns'],
  [/\b(across|cross-cutting|every (file|module|service)|monorepo|multiple services)\b/i, 1, 'cross-cutting'],
  [/\b(implement\w*|integrat\w+|endpoint|api|component|service|hook|middleware|query|cache|websocket|queue)\b/i, 1, 'new behavior'],
  [/\b(rename|typo|readme|docs?|documentation|comment\w*|changelog|format\w*|lint\w*|prettier|bump|version|copy|wording|text|label)\b/i, -1, 'mechanical/docs'],
  [/\b(config\w*|env(ironment)? var\w*|flag|constant|stub|scaffold\w*|boilerplate|placeholder)\b/i, -1, 'config/boilerplate'],
  [/\b(delete|remove unused|cleanup|clean up|dead code)\b/i, -1, 'cleanup'],
];

/** Score one step. Returns { complexity 1-5, reasons[] }. */
export function scoreStep(step) {
  const text = `${step.title}\n${step.body || ''}`;
  let score = 0;
  const reasons = [];
  for (const [re, w, why] of SIGNALS) if (re.test(text)) { score += w; reasons.push(`${w > 0 ? '+' : ''}${w} ${why}`); }
  const files = new Set((text.match(/[\w@./-]+\.(ts|tsx|js|jsx|mjs|py|go|rs|java|kt|rb|php|cs|swift|sql|vue|svelte|css|scss|json|yaml|yml|md)\b/g) || []));
  if (files.size >= 6) { score += 2; reasons.push(`+2 touches ${files.size} files`); }
  else if (files.size >= 3) { score += 1; reasons.push(`+1 touches ${files.size} files`); }
  if (text.length > 900) { score += 1; reasons.push('+1 long step description'); }
  const complexity = Math.max(1, Math.min(5, Math.round(2 + score * 0.75)));
  if (!reasons.length) reasons.push('no strong signals (default 2)');
  return { complexity, reasons };
}

/**
 * Full breakdown. options: { provider: 'anthropic'|'openai', baseline?: modelKey, allowFrontier?: boolean }
 */
export function analyzePlan(markdown, prices, options = {}) {
  const provider = options.provider || 'anthropic';
  const rec = prices.recommend[provider];
  const baseline = options.baseline || prices.baseline[provider];
  const a = prices.assumptions;
  const steps = splitPlan(markdown).map((s, idx) => {
    const { complexity, reasons } = scoreStep(s);
    let tier = a.complexityToTier[String(complexity)];
    if (complexity === 5 && options.allowFrontier) tier = 'frontier';
    const model = rec[tier];
    const budget = a.stepTokens[String(complexity)];
    const mult = a.tierTokenMultiplier[tier] ?? 1;
    const tokLo = Math.round((budget.input[0] + budget.output[0]) * mult);
    const tokHi = Math.round((budget.input[1] + budget.output[1]) * mult);
    const usdLo = costOfBudget(model, budget.input[0] * mult, budget.output[0] * mult, prices);
    const usdHi = costOfBudget(model, budget.input[1] * mult, budget.output[1] * mult, prices);
    const baseLo = costOfBudget(baseline, budget.input[0], budget.output[0], prices);
    const baseHi = costOfBudget(baseline, budget.input[1], budget.output[1], prices);
    return { n: idx + 1, title: s.title, complexity, reasons, tier, model, modelLabel: prices.models[model].label, alias: prices.models[model].alias || model, tokens: [tokLo, tokHi], usd: [usdLo, usdHi], baselineUsd: [baseLo, baseHi] };
  });
  const sum = (k, i) => steps.reduce((t, s) => t + s[k][i], 0);
  const total = { tokens: [sum('tokens', 0), sum('tokens', 1)], usd: [sum('usd', 0), sum('usd', 1)], baselineUsd: [sum('baselineUsd', 0), sum('baselineUsd', 1)] };
  const mid = (r) => (r[0] + r[1]) / 2;
  total.savingsPct = mid(total.baselineUsd) > 0 ? Math.round((1 - mid(total.usd) / mid(total.baselineUsd)) * 100) : 0;
  return { provider, baseline, baselineLabel: prices.models[baseline].label, steps, total, pricesVerifiedAt: prices.verifiedAt, estimate: true };
}
