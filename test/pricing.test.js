import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadPrices, resolveModel, costOfUsage } from '../src/pricing.js';

const P = loadPrices(null);
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);

test('resolves model ids, aliases, dated and provider-prefixed ids', () => {
  assert.equal(resolveModel('claude-opus-5-5', P), 'claude-opus-5-5');
  assert.equal(resolveModel('claude-opus-5-5-20261001', P), 'claude-opus-5-5');
  assert.equal(resolveModel('claude-opus-5', P), 'claude-opus-5');
  assert.equal(resolveModel('us.anthropic.claude-sonnet-5-5-v1:0', P), 'claude-sonnet-5-5');
  assert.equal(resolveModel('claude-sonnet-5-5[1m]', P), 'claude-sonnet-5-5');
  assert.equal(resolveModel('haiku', P), 'claude-haiku-5-5');
  assert.equal(resolveModel('claude-haiku-4-5-20251001', P), 'claude-haiku-4-5');
  assert.equal(resolveModel('gpt-6.1-terra', P), 'gpt-6.1-terra');
  assert.equal(resolveModel('claude-opus-9-future', P), 'claude-opus-5-5'); // family fallback
  assert.equal(resolveModel('mystery-model', P), null);
});

test('cost of one response at list price (Opus 5.5: $4 in, $5 5m write, $0.20 read, $20 out)', () => {
  const c = costOfUsage('claude-opus-5-5', { input_tokens: 1000, cache_creation_input_tokens: 10000, cache_read_input_tokens: 100000, output_tokens: 2000 }, P);
  close(c, (1000 * 4 + 10000 * 5 + 100000 * 0.2 + 2000 * 20) / 1e6);
});

test('1h cache writes are priced separately when the split is present', () => {
  const c = costOfUsage('claude-sonnet-5-5', { input_tokens: 0, cache_creation_input_tokens: 3000, cache_creation: { ephemeral_5m_input_tokens: 1000, ephemeral_1h_input_tokens: 2000 }, cache_read_input_tokens: 0, output_tokens: 0 }, P);
  close(c, (1000 * 2.5 + 2000 * 4) / 1e6);
});

test('Haiku 5.5 switches to long-context prices for prompts over 100k tokens', () => {
  const small = costOfUsage('claude-haiku-5-5', { input_tokens: 90000, output_tokens: 1000 }, P);
  const big = costOfUsage('claude-haiku-5-5', { input_tokens: 110000, output_tokens: 1000 }, P);
  close(small, (90000 * 0.1 + 1000 * 0.5) / 1e6);
  close(big, (110000 * 0.5 + 1000 * 2.5) / 1e6);
});

test('price table carries sources and a verification date', () => {
  assert.match(P.verifiedAt, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(P.sources.anthropic.startsWith('https://'));
  for (const [prov, tiers] of Object.entries(P.recommend)) for (const k of Object.values(tiers)) assert.ok(P.models[k], `${prov} ${k}`);
});
