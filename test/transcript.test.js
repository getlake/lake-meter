import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { loadPrices } from '../src/pricing.js';
import { scanFile, sessionFiles, absorb, totals, sessionTotals } from '../src/transcript.js';
import { sandbox, U } from './helpers.js';

const P = loadPrices(null);

test('streamed duplicates of one message are counted once (largest counts kept)', () => {
  const sb = sandbox();
  sb.write(sb.transcript, 'claude-opus-5-5', U(5, 0, 1000, 10), { id: 'm1' });
  sb.write(sb.transcript, 'claude-opus-5-5', U(5, 0, 1000, 300), { id: 'm1' });
  sb.write(sb.transcript, 'claude-opus-5-5', U(5, 0, 2000, 50), { id: 'm2' });
  const t = sessionTotals(sb.transcript, P);
  assert.equal(t.requests, 2);
  assert.equal(t.output, 350);
  assert.equal(t.cacheRead, 3000);
});

test('subagent transcripts are included and labelled', () => {
  const sb = sandbox();
  sb.write(sb.transcript, 'claude-opus-5-5', U(0, 0, 0, 1000));
  sb.write(sb.sub, 'claude-haiku-5-5', U(0, 0, 0, 1000));
  assert.equal(sessionFiles(sb.transcript).length, 2);
  const t = sessionTotals(sb.transcript, P);
  assert.equal(t.subagent.requests, 1);
  assert.ok(Math.abs(t.usd - (1000 * 20 + 1000 * 0.5) / 1e6) < 1e-12);
});

test('incremental scan resumes at the last complete line and ignores partial lines', () => {
  const sb = sandbox();
  sb.write(sb.transcript, 'claude-sonnet-5-5', U(0, 0, 0, 100));
  appendFileSync(sb.transcript, '{"type":"assistant","message":{"id":"half"'); // partial write in progress
  const a = scanFile(sb.transcript, 0);
  assert.equal(a.entries.length, 1);
  appendFileSync(sb.transcript, ',"model":"claude-sonnet-5-5","usage":{"output_tokens":7}},"timestamp":"2026-11-12T00:00:00Z"}\n');
  const b = scanFile(sb.transcript, a.offset);
  assert.equal(b.entries.length, 1);
  assert.equal(b.entries[0].usage.output_tokens, 7);
});

test('since-filter keeps only messages from the current run; synthetic and non-assistant lines skipped', () => {
  const sb = sandbox();
  const t0 = Date.now();
  sb.write(sb.transcript, 'claude-opus-5-5', U(0, 0, 0, 999), { ts: t0 - 60000 });
  sb.write(sb.transcript, '<synthetic>', U(0, 0, 0, 5), { ts: t0 + 1 });
  appendFileSync(sb.transcript, JSON.stringify({ type: 'user', message: { usage: { output_tokens: 1 } } }) + '\n');
  sb.write(sb.transcript, 'claude-opus-5-5', U(0, 0, 0, 10), { ts: t0 + 1000 });
  const seen = absorb({}, scanFile(sb.transcript, 0).entries, t0);
  const t = totals(seen, P);
  assert.equal(t.requests, 1);
  assert.equal(t.output, 10);
});

test('unknown models count tokens but not dollars', () => {
  const sb = sandbox();
  sb.write(sb.transcript, 'some-local-model', U(100, 0, 0, 100));
  const t = sessionTotals(sb.transcript, P);
  assert.equal(t.unpricedRequests, 1);
  assert.equal(t.usd, 0);
  assert.equal(t.tokens, 200);
});
