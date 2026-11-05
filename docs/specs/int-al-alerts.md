# INT-AL: alerts you can act on, and cases, round 2 (passed 10 of 12, with fixes R2-1 to R2-5)

Task: Give every alert a severity, a sentence, a fix link and a state with history; add needs-you, two new signals, the case queue and case actions.
Package: new `domain/alerts` (`@umsbx/alerts`), `domain/payments` (raise path only), `domain/recovery` (read model and operator actor), `apps/web` routes, `packages/jobs` (sweep step). Builder: Sonnet 5.5 high. Reviewer: Opus 5.5 gate.
Items: AL.1 to AL.8, 18 points. Needs TR0 merged and UI0.7 merged. Source: UX audit section 3 and 3.2, operator items 7, 7b, 8. Round 2 answers `al-scorecard.md` F1 to F15.

## Goal

AL.1: an operator list of alerts with true totals, filters and paging. Each alert carries title, severity, cause, order, unit, money at risk, linked case, fix target and next action.
AL.2: one catalogue maps every alert kind and gate reason.
AL.3: alerts can be acknowledged, resolved with a reason code, and reopened, each journaled with the operator.
AL.4: the job loop resolves an alert when its condition clears, by exact rules.
AL.5: two new signals, `mandate_near_cap` and `webhook_failing`, raise once per entity and re-raise on recurrence.
AL.6: a needs-you list gathers everything waiting on an operator.
AL.7: a case queue and case detail.
AL.8: case actions that reuse `domain/recovery` and the existing refund path, with no new money logic.

## Routes (F1)

Reads are apikey `ops:read` for partners, plus composition functions for the OPS-A pages. Writes are operator session routes beside `/api/refunds`, each `auth: 'operator'`, `csrf: true`, `idempotent: true`, `risk: 'high'`. The wrapper already demands MFA on every operator POST (`route.ts:429-431`), so acknowledge and reopen need MFA too. No `/api/v1/ops/*` route writes.

| Route                                                                | Auth                                         |
| -------------------------------------------------------------------- | -------------------------------------------- |
| `GET /api/v1/ops/alerts`, `GET /api/v1/ops/alerts/[id]`              | apikey `ops:read`                            |
| `GET /api/v1/ops/needs-you`                                          | apikey `ops:read`                            |
| `GET /api/v1/ops/cases`, `GET /api/v1/ops/cases/[id]`                | apikey `ops:read`                            |
| `POST /api/ops/alerts/[id]/acknowledge`, `.../resolve`, `.../reopen` | operator session, MFA, CSRF, idempotency key |
| `POST /api/ops/cases/[id]/actions`                                   | operator session, MFA, CSRF, idempotency key |

The v1 reads carry no buyer or publisher identity and no PayPal ids (the SR1 rule): order refs, unit ids, amounts, states and ids only.

## Rules

**Catalogue (AL.2, F7).** `domain/alerts/src/catalogue.ts` gives, for each of the 12 `AlertKind` values, the 2 new kinds and each `BLOCKED_BY` value: `severity` (critical, high, medium, info, from the audit table), `title`, `cause(reason, detail)`, `fix: {route, anchor}`, `runbook`, and `money_at_risk` (`unit_amount`, `order_total`, `refund_amount` or `null`; the two new kinds are `null`). `BLOCKED_BY` becomes a const in `packages/contracts/src/gate.ts`, and `apps/web/src/lib/gate-lines.ts` derives its `BlockedBy` type from it. The golden test fails on any unmapped kind or reason prefix.

**State and history (AL.3, F5, F13).**

- `alert_events` (migration, next free at merge, planned 0025) has columns `id, alert_id, kind, reason_code, note_sha256, at, created_at, updated_at`. `kind` is one of `acknowledged`, `resolved`, `auto_resolved`, `reopened`. It has append-only guards (`ums_deny_mutation`, `ums_deny_truncate`) and is added to TR0's `trace_tracked` and golden list in the same migration, with `note_sha256` as a copied column.
- Resolve takes `reason_code` from a closed list (`fixed_upstream`, `false_positive`, `duplicate`, `accepted_risk`, `other`) and an optional note of at most 200 characters. The note is stored only as `note_sha256`, never as text.
- Current state is the latest event, or `open` if there is none. A second resolve of a resolved alert is a no-op (200, same answer). Who and when come from joining `trace_events` on the `alert_events` row, because the table has no actor column.

**Auto-resolve (AL.4, F3, F8).** The sweep `autoResolve` runs in the job loop, in the job-pass trace context (actor `system`, channel `job`). It writes `auto_resolved` once per alert whose rule holds. The rules, keyed by kind and reason prefix:

| Alert                                                                               | Resolves when                                                                                                                                                                                                                               |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `payment_unresolved`, `frozen_order`                                                | the order is `paid`, `paid_partial`, `failed` or `abandoned`. These are the terminal order states; there is no `refunded` order status (`OrderStatusSchema`, `payments.ts:26`), which is why the plan's "paid or refunded" became this list |
| `refund_unresolved` with reason `refund_outcome_unknown_<rq>`                       | request `<rq>` is `completed` **and** a `ledger_entries` row with `kind = 'refund'` and that `refund_id` exists                                                                                                                             |
| `refund_unresolved` with reason `cannot_book_*`, `ledger_rule_*`, `refund_unbooked` | never: manual only (PayPal paid out but the ledger did not book)                                                                                                                                                                            |
| `refund_failed`                                                                     | a later request for the same unit is `completed` with its ledger row                                                                                                                                                                        |
| `mandate_near_cap`                                                                  | the mandate is revoked, expired or exhausted (the alert served its purpose)                                                                                                                                                                 |
| `webhook_failing`                                                                   | the subscription's latest delivery is `delivered`                                                                                                                                                                                           |
| every other kind                                                                    | manual only                                                                                                                                                                                                                                 |

**New signals (AL.5, F2, F15).** The sweep `signals` runs in the same job step and calls `raiseAlert`. `raiseAlert` changes in two ways: `order_id` becomes `Id | null`, and a conflict on `alerts_one_per_kind` whose latest event is `resolved` or `auto_resolved` appends `reopened` by `system`. This is the only change to raising logic.

- Signals skip entities that are already finished, so the signal and auto-resolve sweeps never flap (R2-1). That means mandates with `revoked_at` or `exhausted_at` set or `expires_at` past, and disabled subscriptions.
- `mandate_near_cap`: raised when `spent_minor * 10 >= max_total_minor * 9`, or `used_count * 10 >= max_count * 9`, integer arithmetic. A count cap of 3 fires at 3, and a cap of 10 fires at 9. The reason is `cap90_<mandate_id>`.
- `webhook_failing`: raised when the last 3 `webhook_deliveries` rows of one subscription, by `(created_at, id)`, are all `failed` or `dead`. The reason is `webhook_failing_<subscription_id>_<id of the first of those 3>`, so a new failure run after a recovery raises a new alert.
- `domain/mandates` and `packages/jobs/src/deliver.ts` are not touched.

**List (AL.1, F11).** Filters `state` (open, acknowledged, resolved, all), `severity`, `kind`. Keyset paging on `(created_at DESC, id DESC)`, default 25, max 100. Each answer includes `total` for the current filter. `money_at_risk` follows the catalogue.

**Needs-you (AL.6, F12).** `{kind, sentence, href, count}` rows for:

- open alerts by severity
- applicants waiting (`publishers.status = 'applied'` with no `publisher_applicant_decisions` row; a rejected applicant keeps `applied`, R2-3)
- payee checks waiting (`payee_change_requests` with no `payee_decisions` row)
- caps near the limit (open `mandate_near_cap`)

Each `href` comes from `OPS_PAGES`, a typed list of page paths in `packages/contracts/src/ops-pages.ts` that UI0 also uses. The test checks that each href is in that list, and that each listed path has a `page.tsx` or a UI0 redirect.

**Cases (AL.7, AL.8, F9, F10).**

- The queue is ordered by `sla_due_at`, with a filter by state. The detail carries `state`, `kind`, `sla_due_at`, `credit_ms`, linked alerts (through `recovery_actions.detail.alert_id`), and the allowed actions. `recovery_cases.buyer_message` is the system's message to the buyer (`messages.ts`), not buyer input (R2-2). The v1 answer carries `buyer_message_present` only; the OPS-A composition read returns the text.
- Actions are exactly `diagnose`, `restore`, `credit`, `close_not_charged`, `offer_refund` and `close_no_fault`, mapped to `domain/recovery` `diagnose()` and `resolve()` (`rules.ts` `ResolveAction`). `offer_refund` calls the existing refund path. An operator `diagnose` records the operator as actor (a new optional `actor` argument; today it writes `system`, `cases.ts:439`).
- An action not allowed in the case's state answers 409 `wrong_state`.

## Outputs (only these files)

New:

- `domain/alerts/{package.json,tsconfig.json}`, `domain/alerts/src/{index,catalogue,read,state,autoresolve,signals,needs-you}.ts`
- `packages/db/migrations/common/00NN_alert_events.sql`
- `packages/contracts/src/{v1-alerts,gate,ops-pages}.ts`
- the routes in the table above
- the tests below

Changed:

- `packages/contracts/src/index.ts`, `packages/contracts/src/v1.ts` (5 read entries), `packages/contracts/src/trace.ts` (golden list adds `alert_events`)
- `apps/web/src/lib/gate-lines.ts` (type from `BLOCKED_BY`)
- `domain/payments/src/alerts.ts` (two kinds, nullable `order_id`, reopen on conflict)
- `domain/recovery/src/cases.ts` (read model export, operator actor on diagnose)
- `packages/jobs/src/loop.ts` (sweep step), `packages/jobs/package.json` (`@umsbx/alerts`)
- `apps/web/package.json`, `pnpm-lock.yaml`, `eslint.config.mjs` (`'alerts'` in `DOMAIN`)
- `apps/web/src/composition/ops-home.ts` (UI0.7 module; AL adds read functions only and replaces the `kind, created_at LIMIT 20` read)
- `docs/api/openapi-v1.json`

If UI0.7 has not merged, the builder stops and reports.

## Acceptance tests (commit 1: tests only, run red)

| Item | Test file                                                                                                                                                   | Command                                                                                                                                                                                | Expected                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AL.1 | `domain/alerts/src/read.state.test.ts`                                                                                                                      | `pnpm vitest run domain/alerts/src/read.state.test.ts`                                                                                                                                 | 25 seeded alerts over two pages (25 at `limit=20`: 20 then 5), each page with `total` 25; the filters narrow, with true totals; each row has order ref, unit, money at risk per catalogue, case id where one exists                                                                                                                                                                                                                                           |
| AL.2 | `domain/alerts/src/catalogue.golden.test.ts`                                                                                                                | `pnpm vitest run domain/alerts/src/catalogue.golden.test.ts`                                                                                                                           | All 12 kinds, 2 new kinds and 5 `BLOCKED_BY` values mapped; a fake kind or reason prefix fails                                                                                                                                                                                                                                                                                                                                                                |
| AL.3 | `domain/alerts/src/state.adversarial.test.ts` (domain rules), `apps/web/src/ops-alerts-state.adversarial.test.ts` (route MFA, CSRF and bearer checks, R2-4) | `pnpm vitest run domain/alerts/src/state.adversarial.test.ts apps/web/src/ops-alerts-state.adversarial.test.ts`                                                                        | Each write without MFA gives 403; buyer and seller sessions and any bearer key give 401 or 403; a missing CSRF token gives 403; a double resolve is a no-op; the journal shows the operator, channel `web` and reason code; an email in a note appears nowhere in `alert_events` or `trace_events`                                                                                                                                                            |
| AL.4 | `domain/alerts/src/autoresolve.state.test.ts`, `domain/alerts/src/autoresolve.adversarial.test.ts`                                                          | `pnpm vitest run domain/alerts/src/autoresolve.state.test.ts domain/alerts/src/autoresolve.adversarial.test.ts`                                                                        | Each table row resolves once, as `system`/`job`; a still-unresolved condition does not resolve; a `cannot_book_` alert on a `completed` request is **not** auto-resolved; `refund_outcome_unknown_<rq>` without its ledger row is not resolved                                                                                                                                                                                                                |
| AL.5 | `domain/alerts/src/signals.state.test.ts`                                                                                                                   | `pnpm vitest run domain/alerts/src/signals.state.test.ts`                                                                                                                              | Two mandates at 90 percent raise two alerts; caps of 3 and 10 purchases fire at 3 and 9; 3 failed deliveries raise once; recovery then 3 new failures raise a new alert; a resolved `cap90_` alert whose condition returns is reopened by `system`; two sweep passes over an exhausted, revoked or expired mandate and a disabled subscription write no new event                                                                                             |
| AL.6 | `apps/web/src/v1-needs-you.contract.test.ts`                                                                                                                | `pnpm vitest run apps/web/src/v1-needs-you.contract.test.ts`                                                                                                                           | Shape matches `v1-alerts.ts`; counts match the seed for each source; every href is in `OPS_PAGES`, and each path has a page or a redirect                                                                                                                                                                                                                                                                                                                     |
| AL.7 | `domain/recovery/src/cases-api.state.test.ts`                                                                                                               | `pnpm vitest run domain/recovery/src/cases-api.state.test.ts`                                                                                                                          | The queue is ordered by `sla_due_at` and filters by state; the detail has the fields above and the allowed actions; the v1 answer has no message text, and the composition read has it                                                                                                                                                                                                                                                                        |
| AL.8 | `apps/web/src/ops-cases-actions.adversarial.test.ts`, `tests/mvp-c-pg/case-refund-race.integration.test.ts` (PG-2 exception, R2-5)                          | `pnpm vitest run apps/web/src/ops-cases-actions.adversarial.test.ts`, then `UMS_TEST_PG_BIN=$(pg_config --bindir) pnpm vitest run tests/mvp-c-pg/case-refund-race.integration.test.ts` | Refund from a case needs MFA and an idempotency key; a replay returns the stored answer; buyer and seller sessions and bearer keys are refused; missing CSRF gives 403; an action on a closed or `refund_pending` case gives 409 `wrong_state`; each action is journaled with the operator actor; the ledger guard still holds. The race file: two concurrent `offer_refund` calls on one case make exactly one refund request, 20 runs; **a skip is a fail** |
| Gate |                                                                                                                                                             | `pnpm trace:verify` after the seed and the AL suites                                                                                                                                   | Exit 0; INV-T2 empty, including the sweep and signal rows                                                                                                                                                                                                                                                                                                                                                                                                     |

Mutation: `pnpm mutation --require-targets --targets domain/alerts/src/state.ts,domain/alerts/src/autoresolve.ts,domain/alerts/src/signals.ts,domain/recovery/src/cases.ts --test-cmd "pnpm vitest run domain/alerts domain/recovery apps/web/src/ops-cases-actions.adversarial.test.ts apps/web/src/ops-alerts-state.adversarial.test.ts" --threshold 80`.

## Safety

No PayPal call, no change to `packages/transport`, `packages/paypal` or `endpoints.ts`, no secret. The refund action goes through the existing gated refund path, which stays offline in tests. The gate runs `pnpm check:no-live-host`, `pnpm check:secrets-names`, `pnpm check:isolation` and the offline proof (no transport call during the AL suites).

## Do not

Change raising logic beyond the two kinds, nullable `order_id` and reopen-on-conflict; add money logic; touch `domain/mandates` or `packages/jobs/src/deliver.ts`; store note text; add a write under `/api/v1/ops`.

Branch: `feat/int-al-alerts`. Commit: `feat(alerts): alert catalogue, state, signals, needs-you and case API (INT-AL)`.
