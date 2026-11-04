# INT-TR1: timeline, activity log, evidence pack and seals

Task: Turn the journal into one timeline per order or unit for each persona, an operator activity log, an evidence pack and a daily seal.
Package: new `domain/trace` (`@umsbx/trace`), `apps/web` routes, `packages/jobs` (seal). Owner: Vikram. Builder: Sonnet 5.5 high. Reviewer: Opus 5.5 gate.
Items: TR1.1 to TR1.6, 14 points. Needs TR0 merged.

## Goal

A buyer, a seller and an operator can each read the timeline of one order or unit through `/api/v1`, in plain words, in time order, with the actor and channel of every step, limited to what that role may see. The operator can filter all journal rows by actor, channel, event type, chain and date. A unit's evidence pack downloads as JSON with its chain proof. The job loop writes one seal per UTC day, and a verify endpoint reports the result.

## Rules

- Timeline entry: `{ at, seq, event_type, words_key, actor: {kind, label}, channel, amount?, state_from?, state_to?, source: {table, id}, verified }`. Words come from a catalogue in `domain/trace/src/words.ts`, one entry per event type; an unmapped type fails the golden test.
- **Buyer view:** chains of orders where `orders.buyer_id = me` only. Actor labels: "You", "Your agent (key …abcd)", "UnitMarket", "PayPal", "Support". No `trace_context` fields, no provider debug ids, no operator ids.
- **Seller view:** only events whose `unit_id` belongs to the seller's publisher, plus order-level payment events for those units. Never `buyer_id`, buyer name, agent key or context; actor label "Buyer" or "Buyer's agent".
- **Operator view:** everything, including context (channel, `req_id`, `ip_hash` prefix of 8, `ua_family`, API key id, job name) and `mfa`.
- Activity log: keyset paging on `(occurred_at, chain_key, seq)`, 50 per page, max 200; filters `actor_kind`, `actor_id`, `channel`, `event_type` prefix, `chain_key`, `from`, `to`.
- Evidence pack: `{unit, order_ref, events[], source_rows{}, chain: {key, from_seq, to_seq, hashes[]}, seal?: {day, root_hash}, verify_steps}`, plus `GET .../evidence.html` printable. Contains no buyer personal data.
- Seal: `sealDay(db, day)` writes one `trace_seals` row (idempotent per day), chained to the previous seal; run by the job loop after 00:05 UTC.

## Outputs

New: `domain/trace/src/{index,timeline,views,words,activity,evidence,seal}.ts`, `domain/trace/package.json`, routes `apps/web/src/app/api/v1/orders/[ref]/timeline/route.ts`, `apps/web/src/app/api/v1/seller/sales/[unit]/timeline/route.ts`, `apps/web/src/app/api/v1/ops/orders/[ref]/timeline/route.ts`, `apps/web/src/app/api/v1/ops/activity/route.ts`, `apps/web/src/app/api/v1/ops/units/[id]/evidence/route.ts` (and `.html` variant), `apps/web/src/app/api/v1/ops/trace/verify/route.ts`, contracts `packages/contracts/src/v1-trace.ts`, tests below. Changed: `packages/jobs/src/loop.ts` (seal step), the tab composition module from UI0 (or `composition.server.ts` if UI0 has not merged, one block), OpenAPI and route inventory.

## Acceptance tests (commit 1: tests only, run red)

| Item | Test file | Command | Expected |
|---|---|---|---|
| TR1.1 | `domain/trace/src/words.golden.test.ts`, `timeline.state.test.ts` | `pnpm test:golden -- trace/words` ; `pnpm test:state -- trace/timeline` | Every TR0 event type has words; a seeded paid, downloaded, refunded order yields the expected ordered entries |
| TR1.2 | `domain/trace/src/views.adversarial.test.ts` | `pnpm test:adversarial -- trace/views` | Buyer B cannot read buyer A's order (404, same body as unknown ref); seller never receives `buyer_id`, agent key or context in any field (deep scan); a seller cannot read another seller's unit; tampered or replayed cursors are refused 400 |
| TR1.3 | `apps/web/src/v1-timeline.contract.test.ts` | `pnpm test:contract -- v1-timeline` | Three endpoints match `v1-trace.ts` schemas and OpenAPI; scopes `orders:read`, `seller:read`, `ops:read` enforced |
| TR1.4 | `apps/web/src/v1-activity.state.test.ts` | `pnpm test:state -- v1-activity` | Filters combine with AND; a switch off by the operator appears with `mfa` and channel web |
| TR1.5 | `domain/trace/src/evidence.state.test.ts` | `pnpm test:state -- trace/evidence` | Pack verifies offline with the documented steps; editing one event in the pack breaks the check |
| TR1.6 | `domain/trace/src/seal.state.test.ts`, `packages/jobs/src/loop.seal.test.ts` | `pnpm test:state -- trace/seal` | One seal per day, second run no-op, chained to the previous seal; verify route returns `{ok:true, chains, rows, seals}` |

Mutation: `views.ts` and `evidence.ts` at least 80 percent, scoped `--test-cmd "pnpm vitest run domain/trace"`.

## Do not

Change TR0 tables or triggers; read source tables for personas in ways that bypass the views; add a dependency; call PayPal.

## Evidence

Red run; green ci; three sample timelines (buyer, seller, operator) for the same order side by side; mutation report.

Branch: `feat/int-tr1-timeline`. Commit: `feat(trace): timelines, activity log, evidence pack and daily seal (INT-TR1)`.
