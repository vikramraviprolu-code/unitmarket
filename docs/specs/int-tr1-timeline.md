# INT-TR1: timeline, activity log, evidence pack and seals, round 2

Task: Turn the journal into one timeline per order or unit for each persona, an operator activity log, an evidence pack and a daily seal.
Package: new `domain/trace` (`@umsbx/trace`), `apps/web` routes, `packages/jobs` (seal step). Builder: Sonnet 5.5 high. Reviewer: Opus 5.5 gate.
Items: TR1.1 to TR1.6, 14 points. Needs TR0 merged (`trace_canon`, `trace_seal(day, at)`, `trace_verify()`). Round 2 answers `tr1-scorecard.md` F1 to F9 and N1 to N4.

## Goal

A buyer, a seller and an operator can each read the timeline of one order or unit, in plain words and in time order. Each step shows its actor and channel, limited to what that role may see. The operator can filter all journal rows by actor, channel, event type, chain and date. A unit's evidence pack downloads as JSON, and as a printable page, with a chain proof anyone can check offline. The job loop seals the previous UTC day once, and a verify route reports the result.

## Routes and who sees what

| Route | Auth | View |
|---|---|---|
| `GET /api/v1/orders/[ref]/timeline` | scope `orders:read` (buyer key, agent key, buyer session) | buyer |
| `GET /api/v1/seller/sales/[unit]/timeline` | scope `sales:read` (F2) | seller |
| `GET /api/v1/ops/orders/[ref]/timeline` | scope `ops:read` (operator key, `mfa: false`) | operator, identity-free |
| `GET /api/ops/orders/[ref]/timeline` | operator session | operator full with MFA; identity-free without |
| `GET /api/ops/activity` | operator session | identity-free without MFA; full with MFA. An `actor_id` filter without MFA gives 403 `mfa_required` |
| `GET /api/ops/units/[id]/evidence` and `apps/web/src/app/api/ops/units/[id]/evidence.html/route.ts` | operator session **with MFA** (403 `mfa_required` otherwise) | evidence |
| `GET /api/v1/ops/trace/verify` | scope `ops:read` | counts only: `{ok, chains, rows, seals, drift, first_broken?}` |

This follows the v1 rule from SR1: an operator key gets no buyer or publisher identity and no PayPal ids. Identity appears only on the operator session routes when the session has MFA.

**Entry:** `{ at, seq, event_type, words_key, actor: {kind, label}, channel, amount_minor?, state_from?, state_to?, source: {table, id}, verified }`. Words come from `domain/trace/src/words.ts`, one entry per TR0 event type; an unmapped type fails the golden test. A timeline is capped at 500 entries and returns `truncated: true` beyond that (N1). It is not paged.

**Buyer view.** Only chains of orders where `orders.buyer_id` is the principal's buyer. An agent key gets its buyer's view, never operator context (F7). Actor labels: "You", "Your agent (key …abcd)" (the last 4 characters of `api_keys.id`, never the secret; N4), "UnitMarket" (system, job, operator), "PayPal". No `trace_context` field, no provider debug id, no operator id.

**Seller view (F7).** Only events whose `unit_id` belongs to the seller's publisher. Order-level payment events are rewritten for the seller: they carry only that seller's unit ids and amounts, with no `total_minor` and no other unit. The view never shows `buyer_id`, a buyer name, an agent key or context. Actor labels: "Buyer", "Buyer's agent", "UnitMarket", "PayPal".

**Operator view.**
- Identity-free (key route, and session without MFA): every event on the order, with actor kind, channel, `job` and `tool`. Actor ids are shown for `system` and `operator` only. Provider ids (`provider_order_id`, `capture_id`, `refund_id`, `debug_id`) are replaced by `"…" + last 4`. No `req_id`, `ip_hash`, `ua_family` or `api_key_id`.
- Full (session with MFA): adds actor ids, provider ids, `req_id`, `ip_hash` prefix of 8, `ua_family`, `api_key_id` and `mfa`.
- The redaction lives in one function, `operatorView(entries, {mfa})` in `domain/trace/src/views.ts`. GA.4 uses the identity-free shape (N3).

**Activity log.** Newest first, keyset on `(occurred_at, chain_key, seq)` descending, 50 per page, max 200. Filters: `actor_kind`, `actor_id`, `channel`, `event_type` prefix, `chain_key`, `from`, `to`. The cursor is base64url `{v:'a1', k:[occurred_at, chain_key, seq], h}`, where `h` is a sha256 over the canonical filter set plus the principal id. A malformed cursor, an unknown tag, or an `h` from another filter or principal gives 400 `bad_cursor`; reusing your own cursor is normal paging (N1). At seed size no new index is needed; an index on `trace_events (occurred_at DESC, chain_key, seq)` goes to the later list (N2).

**Evidence pack (F5).** `{unit_id, order_ref, events[], chain: {key, from_seq, to_seq}, seal?: {day, root_hash, prev_root_hash, head}, verify_steps[]}`.
- Each event carries its `canon` text (from TR0's `trace_canon`) and `row_hash`, so a checker recomputes `sha256(canon)` and the `prev_hash` links without Postgres. No hashing happens in TypeScript in domain code.
- `events` cover the whole order chain from seq 1 to the head named by the latest seal covering it, or to the current head with `sealed: false`.
- `source_rows` may hold only `order_units`, `ledger_entries`, `receipts` (`version`, `sha256` only), `entitlements` (states only), `access_events` (`kind`, `at`), `refund_requests` (no `reason`) and `provider_calls` (status columns only, no redacted bodies). Never `buyers`, `buyer_accounts`, `trace_context` or free text.
- `buyer_id` appears only as the opaque id inside `canon`, never as a name, email, IP or User-Agent.
- The `.html` page renders the same events and steps, as a printable page.

**Seal (F1).** TR0 owns the formula and the table: `trace_seal(day, at)` with a unique `day`, heads ordered by `chain_key`, and the root over `prev_root_hash | day | heads`. TR1 adds one job step, `sealPreviousDay`. On the first pass at or after 00:05 UTC it calls `trace_seal(<previous UTC day>, deps.clock.now())` inside the job-pass trace context (actor `system`, channel `job`, job `seal`). A second pass the same day is a no-op. A seal covers rows by head, not by `occurred_at`, so a late row lands in the next seal and is never reported as tamper. The verify route calls TR0's `trace_verify()`.

## Outputs (only these files)

New:
- `domain/trace/{package.json,tsconfig.json}`, `domain/trace/src/{index,timeline,views,words,activity,evidence,seal}.ts`
- `packages/contracts/src/v1-trace.ts`
- routes: `apps/web/src/app/api/v1/orders/[ref]/timeline/route.ts`, `apps/web/src/app/api/v1/seller/sales/[unit]/timeline/route.ts`, `apps/web/src/app/api/v1/ops/orders/[ref]/timeline/route.ts`, `apps/web/src/app/api/v1/ops/trace/verify/route.ts`, `apps/web/src/app/api/ops/orders/[ref]/timeline/route.ts`, `apps/web/src/app/api/ops/activity/route.ts`, `apps/web/src/app/api/ops/units/[id]/evidence/route.ts`, `apps/web/src/app/api/ops/units/[id]/evidence.html/route.ts`
- the tests below

Changed:
- `eslint.config.mjs` (add `'trace'` to `DOMAIN`)
- `apps/web/package.json`, `packages/jobs/package.json` (workspace dependency `@umsbx/trace`), `pnpm-lock.yaml`
- `packages/contracts/src/index.ts` (export `v1-trace`), `packages/contracts/src/v1.ts` (3 v1 entries)
- `packages/jobs/src/loop.ts` (seal step)
- `apps/web/src/composition/ops-controls.ts` (UI0.7 module, merged in W0) for the operator reads, and `apps/web/src/composition/buyer.ts` and `seller.ts` for the persona reads. If UI0.7 has not merged when TR1 starts, the builder stops and reports.
- `docs/api/openapi-v1.json` (via `pnpm openapi:emit`); `pnpm check:routes` must pass.

## Acceptance tests (commit 1: tests only, run red)

| Item | Test file | Command | Expected |
|---|---|---|---|
| TR1.1 | `domain/trace/src/words.golden.test.ts`, `domain/trace/src/timeline.state.test.ts` | `pnpm vitest run domain/trace/src/words.golden.test.ts domain/trace/src/timeline.state.test.ts` | Every TR0 event type has words; a seeded paid, downloaded, refunded order gives the expected ordered entries; 501 events give 500 entries and `truncated: true` |
| TR1.2 | `domain/trace/src/views.adversarial.test.ts` | `pnpm vitest run domain/trace/src/views.adversarial.test.ts` | Buyer B reading buyer A's order gets 404 with the same body as an unknown ref. An agent key reads its own buyer's timeline in the buyer view, and gets 404 on another buyer's order. On a **two-seller order**, seller A sees no `total_minor`, no unit id or amount of seller B, and gets 404 on B's unit. A deep scan finds no `buyer_id`, buyer name, agent key or context field in any seller answer, and no buyer identity, provider id, `req_id` or `ip_hash` in the operator key answer or the non-MFA session answer. The MFA session answer has them |
| TR1.3 | `apps/web/src/v1-timeline.contract.test.ts` | `pnpm vitest run apps/web/src/v1-timeline.contract.test.ts` | The three v1 timeline routes and `ops/trace/verify` match `v1-trace.ts` and OpenAPI. Scopes `orders:read`, `sales:read` and `ops:read` are enforced; a buyer key gets 403 on both ops routes; verify answers `{ok, chains, rows, seals, drift}` |
| TR1.4 | `apps/web/src/ops-activity.state.test.ts` | `pnpm vitest run apps/web/src/ops-activity.state.test.ts` | Filters combine with AND. Pages hold 50 by default and 200 at most (`limit=500` gives 200). Over 260 rows, with 20 new rows written between page calls, no row is skipped or repeated. A cursor with another filter or principal gives 400 `bad_cursor`; `actor_id` without MFA gives 403. A switch-off by the operator appears with `mfa` and channel `web` |
| TR1.5 | `domain/trace/src/evidence.state.test.ts`, `apps/web/src/ops-evidence.state.test.ts` | `pnpm vitest run domain/trace/src/evidence.state.test.ts apps/web/src/ops-evidence.state.test.ts` | The pack verifies offline with the documented steps (the test uses `node:crypto`); editing one event's `canon` or `row_hash` breaks the check. A canary deep scan finds no name, email, raw IP or User-Agent, and no table outside the `source_rows` list. `evidence.html` renders, lists the same events as the JSON, and holds no buyer id outside the `canon` text. Without MFA, both routes give 403 |
| TR1.6 | `domain/trace/src/seal.state.test.ts`, `packages/jobs/src/loop.seal.state.test.ts` | `pnpm vitest run domain/trace/src/seal.state.test.ts packages/jobs/src/loop.seal.state.test.ts` | The first pass after 00:05 UTC seals the previous day once, and the second pass is a no-op. The seal chains to the previous seal. The seal row's trace context is `system`/`job`/`seal`. A late row committed after the seal lands in the next seal, and verify stays ok |
| Gate | as TR0 | `pnpm trace:verify` after the seed and the journeys | Exit 0; INV-T1 and INV-T2 empty |

Mutation (F9): `pnpm mutation --require-targets --targets domain/trace/src/views.ts,domain/trace/src/evidence.ts --test-cmd "pnpm vitest run domain/trace apps/web/src/v1-timeline.contract.test.ts apps/web/src/ops-evidence.state.test.ts" --threshold 80`.

## Safety

Read-only lane except the seal row. No PayPal call, no change to `packages/transport`, `packages/paypal` or `endpoints.ts`, no secret. The gate runs `pnpm check:no-live-host`, `pnpm check:secrets-names`, `pnpm check:isolation` and the offline proof (no fetch, socket or DNS during the suite, as in `pnpm run ci`).

## Do not

Change TR0 tables, triggers or SQL functions; read source tables for personas except through `views.ts`; add a scope or change `OWNER_SCOPE_MATRIX`; add a dependency; hash in domain TypeScript; add identity to any `/api/v1/ops/*` answer.

## Evidence

Red run; green `corepack pnpm run ci`; `pnpm trace:verify` output; three timelines (buyer, seller, operator MFA) for the same two-seller order side by side, sanitised; mutation report.

Branch: `feat/int-tr1-timeline`. Commit: `feat(trace): timelines, activity log, evidence pack and daily seal (INT-TR1)`.
