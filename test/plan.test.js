import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadPrices } from '../src/pricing.js';
import { splitPlan, scoreStep, analyzePlan } from '../src/plan.js';
import { planTable, planMarkdown } from '../src/format.js';

const P = loadPrices(null);
const webhooks = readFileSync(new URL('./fixtures/plan-webhooks.md', import.meta.url), 'utf8');
const numbered = readFileSync(new URL('./fixtures/plan-numbered.md', import.meta.url), 'utf8');

test('splits heading-style plans into steps and skips context sections', () => {
  const steps = splitPlan(webhooks);
  assert.equal(steps.length, 6);
  assert.equal(steps[0].title, 'Add retry settings to config');
  assert.ok(!steps.some((s) => /context|verification|steps/i.test(s.title)));
  assert.match(steps[1].body, /SKIP LOCKED/);
});

test('splits numbered lists with nested lines', () => {
  const steps = splitPlan(numbered);
  assert.equal(steps.length, 4);
  assert.match(steps[1].body, /middleware\.ts/);
});

test('splits checkbox and bullet plans', () => {
  assert.equal(splitPlan('- [ ] write docs\n- [ ] add migration for users table\n- [x] bump version').length, 3);
  assert.equal(splitPlan('Plan\n\n* do a\n* do b').length, 2);
});

test('complexity: mechanical < feature < migration/concurrency', () => {
  const c = (t) => scoreStep({ title: t, body: '' }).complexity;
  assert.ok(c('Fix typo in README') <= 2);
  assert.ok(c('Implement a new API endpoint for invoices') >= 3);
  assert.ok(c('Design a schema migration and handle the race condition with a transaction') >= 4);
  assert.ok(c('Fix typo in README') < c('Design a schema migration and handle the race condition with a transaction'));
});

test('recommends cheaper models for light steps and never costs more than the top-model baseline', () => {
  const a = analyzePlan(webhooks, P);
  const byTitle = Object.fromEntries(a.steps.map((s) => [s.title, s]));
  assert.equal(byTitle['Update the changelog'].alias, 'haiku');
  assert.equal(byTitle['Design an idempotent delivery queue'].alias, 'opus');
  assert.ok(a.total.usd[0] <= a.total.baselineUsd[0] && a.total.usd[1] <= a.total.baselineUsd[1]);
  assert.ok(a.total.savingsPct >= 0);
  for (const s of a.steps) assert.ok(s.usd[0] <= s.usd[1] && s.tokens[0] < s.tokens[1]);
  assert.equal(a.estimate, true);
});

test('openai provider and renderers', () => {
  const a = analyzePlan(numbered, P, { provider: 'openai' });
  assert.ok(a.steps.every((s) => P.models[s.model].provider === 'openai'));
  assert.match(planTable(a), /Everything on GPT-6\.1 Sol/);
  assert.match(planMarkdown(a), /\| # \| Step \|/);
});
