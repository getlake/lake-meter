// Reads Claude Code session transcripts (JSONL) and the per-subagent transcripts next to them.
// Only `type: "assistant"` lines that carry `message.usage` are used. Streamed responses repeat the
// same message id on several lines, so usage is de-duplicated by message id (keeping the largest counts).
import { openSync, readSync, closeSync, statSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { resolveModel, costOfUsage } from './pricing.js';

/** Files that make up one session: the main transcript plus <session>/subagents/*.jsonl. */
export function sessionFiles(transcriptPath) {
  if (!transcriptPath) return [];
  const files = [];
  if (existsSync(transcriptPath)) files.push(transcriptPath);
  const subDir = join(dirname(transcriptPath), basename(transcriptPath, '.jsonl'), 'subagents');
  if (existsSync(subDir)) {
    for (const f of readdirSync(subDir)) if (f.endsWith('.jsonl')) files.push(join(subDir, f));
  }
  return files;
}

/** Read complete lines from `offset` to EOF. Returns parsed usage entries and the offset after the last full line. */
export function scanFile(path, offset = 0) {
  let size;
  try { size = statSync(path).size; } catch { return { entries: [], offset }; }
  if (size < offset) offset = 0; // file was rewritten
  if (size === offset) return { entries: [], offset };
  const fd = openSync(path, 'r');
  const buf = Buffer.alloc(size - offset);
  try { readSync(fd, buf, 0, buf.length, offset); } finally { closeSync(fd); }
  const text = buf.toString('utf8');
  const lastNl = text.lastIndexOf('\n');
  if (lastNl === -1) return { entries: [], offset };
  const complete = text.slice(0, lastNl);
  const consumed = Buffer.byteLength(complete, 'utf8') + 1;
  const isSub = path.includes(`${'/'}subagents${'/'}`) || path.includes('\\subagents\\');
  const entries = [];
  for (const line of complete.split('\n')) {
    if (!line.includes('"usage"')) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.type !== 'assistant' || !o.message?.usage) continue;
    const model = o.message.model;
    if (!model || model === '<synthetic>') continue;
    entries.push({
      id: o.message.id || o.requestId || o.uuid,
      model,
      usage: o.message.usage,
      ts: o.timestamp ? Date.parse(o.timestamp) : null,
      subagent: isSub || o.isSidechain === true,
      file: path,
    });
  }
  return { entries, offset: offset + consumed };
}

function mergeUsage(a, b) {
  if (!a) return b;
  const pick = (k) => Math.max(a[k] || 0, b[k] || 0);
  const out = { ...a, ...b, input_tokens: pick('input_tokens'), output_tokens: pick('output_tokens'), cache_read_input_tokens: pick('cache_read_input_tokens'), cache_creation_input_tokens: pick('cache_creation_input_tokens') };
  if (a.cache_creation || b.cache_creation) {
    const ac = a.cache_creation || {}, bc = b.cache_creation || {};
    out.cache_creation = { ephemeral_5m_input_tokens: Math.max(ac.ephemeral_5m_input_tokens || 0, bc.ephemeral_5m_input_tokens || 0), ephemeral_1h_input_tokens: Math.max(ac.ephemeral_1h_input_tokens || 0, bc.ephemeral_1h_input_tokens || 0) };
  }
  return out;
}

/** Add entries (with ts >= since) into a `seen` map keyed by message id. */
export function absorb(seen, entries, since = 0) {
  for (const e of entries) {
    if (since && e.ts != null && e.ts < since) continue;
    const key = `${e.file.includes('subagents') ? basename(e.file) + ':' : ''}${e.id}`;
    const prev = seen[key];
    seen[key] = { model: e.model, subagent: e.subagent, usage: mergeUsage(prev?.usage, e.usage) };
  }
  return seen;
}

/** Totals for a `seen` map: measured tokens, and USD at list price. */
export function totals(seen, prices) {
  const t = { requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, usd: 0, unpricedRequests: 0, byModel: {}, subagent: { requests: 0, usd: 0, tokens: 0 } };
  for (const { model, usage, subagent } of Object.values(seen)) {
    const key = resolveModel(model, prices);
    const c = key ? costOfUsage(key, usage, prices) : null;
    const tok = (usage.input_tokens || 0) + (usage.output_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0);
    t.requests++;
    t.input += usage.input_tokens || 0;
    t.output += usage.output_tokens || 0;
    t.cacheRead += usage.cache_read_input_tokens || 0;
    t.cacheWrite += usage.cache_creation_input_tokens || 0;
    if (c == null) t.unpricedRequests++; else t.usd += c;
    const label = key ? prices.models[key].label : model;
    const bm = (t.byModel[label] ||= { requests: 0, tokens: 0, usd: 0 });
    bm.requests++; bm.tokens += tok; bm.usd += c || 0;
    if (subagent) { t.subagent.requests++; t.subagent.usd += c || 0; t.subagent.tokens += tok; }
  }
  t.tokens = t.input + t.output + t.cacheRead + t.cacheWrite;
  return t;
}

/** One-shot: totals for a whole session (or since a timestamp), reading all files from the start. */
export function sessionTotals(transcriptPath, prices, since = 0) {
  const seen = {};
  for (const f of sessionFiles(transcriptPath)) absorb(seen, scanFile(f, 0).entries, since);
  return totals(seen, prices);
}
