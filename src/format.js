// Plain-text rendering for terminals, hook messages and MCP results.
export const usd = (n) => (n == null ? 'n/a' : n < 0.01 && n > 0 ? '<$0.01' : `$${n < 10 ? n.toFixed(2) : n < 100 ? n.toFixed(1) : Math.round(n)}`);
export const range = (r) => (r[1] < 0.01 ? '<$0.01' : `${usd(r[0])}–${usd(r[1])}`);
export const tok = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
export const tokRange = (r) => `${tok(r[0])}–${tok(r[1])}`;

const pad = (s, n) => { s = String(s); return s.length >= n ? s.slice(0, n - 1) + '…' : s + ' '.repeat(n - s.length); };
const dots = (c) => '●'.repeat(c) + '○'.repeat(5 - c);

export function planTable(a, { reasons = false } = {}) {
  const lines = [];
  lines.push(`Lake Meter · plan breakdown (estimate, ${a.provider} list prices verified ${a.pricesVerifiedAt})`);
  lines.push('');
  lines.push(`${pad('#', 3)}${pad('Step', 42)}${pad('Complexity', 12)}${pad('Model', 14)}${pad('Tokens', 13)}Cost`);
  for (const s of a.steps) {
    lines.push(`${pad(s.n, 3)}${pad(s.title, 42)}${pad(dots(s.complexity), 12)}${pad(s.modelLabel, 14)}${pad(tokRange(s.tokens), 13)}${range(s.usd)}`);
    if (reasons) lines.push(`   ${s.reasons.join(', ')}`);
  }
  lines.push('');
  lines.push(`Total with per-step models: ${range(a.total.usd)}  (${tokRange(a.total.tokens)} tokens)`);
  lines.push(`Everything on ${a.baselineLabel}:  ${range(a.total.baselineUsd)}  → about ${a.total.savingsPct}% less with the mix above`);
  lines.push('Estimates come from keyword heuristics and token budgets in prices.json. Measured spend shows at the end of each run.');
  return lines.join('\n');
}

export function planMarkdown(a) {
  const rows = a.steps.map((s) => `| ${s.n} | ${s.title.replace(/\|/g, '/')} | ${s.complexity}/5 | ${s.modelLabel} (\`${s.alias}\`) | ${tokRange(s.tokens)} | ${range(s.usd)} |`);
  return [
    `**Lake Meter plan breakdown** (estimate; ${a.provider} list prices verified ${a.pricesVerifiedAt})`,
    '',
    '| # | Step | Complexity | Recommended model | Tokens | Est. cost |',
    '|---|---|---|---|---|---|',
    ...rows,
    '',
    `Total: **${range(a.total.usd)}** vs **${range(a.total.baselineUsd)}** with everything on ${a.baselineLabel} (about ${a.total.savingsPct}% less).`,
  ].join('\n');
}

export function runSummary(t, ctx = {}) {
  const parts = [`Lake Meter · run ${usd(t.usd)}`];
  parts.push(`${tok(t.tokens)} tok (${tok(t.cacheRead)} cache reads, ${tok(t.output)} out)`);
  const models = Object.entries(t.byModel).sort((a, b) => b[1].usd - a[1].usd).map(([m, v]) => `${m} ${usd(v.usd)}`);
  if (models.length) parts.push(models.join(' + '));
  if (t.subagent.requests) parts.push(`subagents ${usd(t.subagent.usd)}`);
  if (ctx.cap) parts.push(`cap ${usd(ctx.cap)}`);
  if (ctx.capHits) parts.push(`cap hit ×${ctx.capHits}`);
  let s = parts.join(' · ');
  if (ctx.plan) s += `\nSince plan approved: ${usd(ctx.plan.actualUsd)} measured vs ${range(ctx.plan.estimateUsd)} estimated`;
  if (t.unpricedRequests) s += `\n${t.unpricedRequests} responses used a model missing from prices.json (tokens counted, $ not).`;
  return s;
}
