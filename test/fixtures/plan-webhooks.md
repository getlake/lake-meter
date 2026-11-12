# Plan: Add retries to webhook delivery

## Context
Webhook deliveries fail silently when the receiver is down. We want bounded retries without duplicate side effects.

## Steps

### 1. Add retry settings to config
Add `WEBHOOK_MAX_ATTEMPTS` and `WEBHOOK_BACKOFF_MS` env vars to `src/config.ts` with defaults and document them in README.md.

### 2. Design an idempotent delivery queue
Introduce a `deliveries` table (schema change + migration) with a unique idempotency key per event and receiver. Handle the race condition where two workers pick the same delivery: use a transaction with `SELECT ... FOR UPDATE SKIP LOCKED`. Touches `db/schema.sql`, `db/migrations/0042_deliveries.sql`, `src/queue/worker.ts`, `src/queue/claim.ts`.

### 3. Implement the retry worker
Implement exponential backoff with jitter in `src/queue/worker.ts`, re-sign the payload on every attempt with the current signing secret, and stop after max attempts.

### 4. Expose delivery status in the API
Add a `GET /webhooks/:id/deliveries` endpoint in `src/api/webhooks.ts` returning attempts and last error.

### 5. Tests for failure paths
Add tests for replay, duplicates and timeouts in `test/queue.test.ts` and `test/api.test.ts`.

### 6. Update the changelog
Add an entry to CHANGELOG.md and fix the typo in the docs heading.

## Verification
Run `npm test` and a local end-to-end delivery against a mock receiver.
