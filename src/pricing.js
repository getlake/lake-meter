// Price lookups and cost math. All prices come from prices.json (USD per 1M tokens).
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const here = fileURLToPath(new URL('.', import.meta.url));

/** Load the bundled table, optionally overridden by ~/.lake-meter/prices.json (same shape). */
export function loadPrices(overridePath = join(process.env.LAKE_METER_HOME || join(homedir(), '.lake-meter'), 'prices.json')) {
  const base = JSON.parse(readFileSync(join(here, 'prices.json'), 'utf8'));
  if (overridePath && existsSync(overridePath)) {
    try {
      const o = JSON.parse(readFileSync(overridePath, 'utf8'));
      return { ...base, ...o, models: { ...base.models, ...(o.models || {}) }, assumptions: { ...base.assumptions, ...(o.assumptions || {}) } };
    } catch { /* ignore a broken override, fall back to bundled table */ }
  }
  return base;
}

export function normalizeModelId(id) {
  return String(id || '').toLowerCase().replace(/\[.*?\]/g, '').replace(/^.*\//, '').replace(/\./g, '-').trim();
}

/** Resolve a raw model id (e.g. "claude-opus-5-5-20261001", "opus", "us.anthropic.claude-sonnet-5-5") to a table key. */
export function resolveModel(rawId, prices) {
  if (!rawId) return null;
  const id = normalizeModelId(rawId);
  if (prices.models[rawId]) return rawId;
  let best = null, bestLen = 0;
  for (const [key, m] of Object.entries(prices.models)) {
    for (const token of [key, ...(m.match || [])]) {
      const t = normalizeModelId(token);
      if (id.includes(t) && t.length > bestLen) { best = key; bestLen = t.length; }
    }
    if (m.alias && id === m.alias) return key;
  }
  if (best) return best;
  for (const [fam, key] of Object.entries(prices.familyFallback || {})) if (id.includes(fam)) return key;
  return null;
}

function rate(m, field, promptTokens) {
  const lc = m.longContext;
  const src = lc && promptTokens > lc.overPromptTokens ? lc : m;
  const v = src[field] ?? m[field];
  if (v != null) return v;
  if (field === 'cacheWrite1h') return (src.input ?? m.input) * 2;
  if (field === 'cacheWrite5m') return (src.input ?? m.input) * 1.25;
  if (field === 'cacheRead') return (src.input ?? m.input) * 0.1;
  return 0;
}

/**
 * Cost of one API response's usage object (Anthropic usage shape, as written to Claude Code transcripts).
 * Long-context pricing is decided per request from its own prompt size.
 */
export function costOfUsage(modelKey, usage, prices) {
  const m = prices.models[modelKey];
  if (!m || !usage) return null;
  const inp = usage.input_tokens || 0;
  const cr = usage.cache_read_input_tokens || 0;
  const cwTotal = usage.cache_creation_input_tokens || 0;
  const cw1h = usage.cache_creation?.ephemeral_1h_input_tokens || 0;
  const cw5m = usage.cache_creation?.ephemeral_5m_input_tokens ?? Math.max(0, cwTotal - cw1h);
  const out = usage.output_tokens || 0;
  const prompt = inp + cr + cwTotal;
  return (inp * rate(m, 'input', prompt) + cr * rate(m, 'cacheRead', prompt) + cw5m * rate(m, 'cacheWrite5m', prompt)
    + cw1h * rate(m, 'cacheWrite1h', prompt) + out * rate(m, 'output', prompt)) / 1e6;
}

/** Estimated cost of an aggregate token budget on a model, using the configured input mix. */
export function costOfBudget(modelKey, inputTokens, outputTokens, prices) {
  const m = prices.models[modelKey];
  const a = prices.assumptions;
  const mix = a.inputMix;
  const p = a.avgPromptTokens;
  return (inputTokens * (mix.uncached * rate(m, 'input', p) + mix.cacheWrite * rate(m, 'cacheWrite5m', p) + mix.cacheRead * rate(m, 'cacheRead', p))
    + outputTokens * rate(m, 'output', p)) / 1e6;
}

export function providerOf(modelKey, prices) {
  return prices.models[modelKey]?.provider || 'anthropic';
}
