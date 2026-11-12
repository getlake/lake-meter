import { mkdtempSync, mkdirSync, appendFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function sandbox(config) {
  const base = mkdtempSync(join(tmpdir(), 'lm-test-'));
  process.env.LAKE_METER_HOME = join(base, 'meter');
  mkdirSync(process.env.LAKE_METER_HOME, { recursive: true });
  if (config) writeFileSync(join(process.env.LAKE_METER_HOME, 'config.json'), JSON.stringify(config));
  const transcript = join(base, 'proj', 'sess1.jsonl');
  mkdirSync(join(base, 'proj', 'sess1', 'subagents'), { recursive: true });
  writeFileSync(transcript, '');
  let n = 0;
  const write = (file, model, usage, { ts = Date.now() + 1000, id } = {}) => {
    const mid = id || `msg_${++n}`;
    appendFileSync(file, JSON.stringify({ type: 'assistant', timestamp: new Date(ts).toISOString(), message: { id: mid, model, usage } }) + '\n');
    return mid;
  };
  return { base, transcript, sub: join(base, 'proj', 'sess1', 'subagents', 'agent-x.jsonl'), write };
}

export const U = (input, cw, cr, out) => ({ input_tokens: input, cache_creation_input_tokens: cw, cache_read_input_tokens: cr, output_tokens: out });
