# INT-AL: alerts you can act on, and cases

Task: Give every alert a severity, a sentence, a fix link and a state with history; add needs-you, the case queue and case actions as APIs.
Package: `domain/payments` (read model only), new `domain/alerts` (`@umsbx/alerts`), `domain/recovery` (case read model and actions), `apps/web` routes. Builder: Sonnet 5.5 high. Reviewer: Opus 5.5 gate.
Items: AL.1 to AL.8, 18 points. Needs TR0 merged. Source: UX audit section 3 and 3.2, operator items 7, 7b, 8.

## Goal

An operator API returns open alerts with title, severity, cause, order, unit, money at risk, linked case, fix target and next action, with true counts. Alerts can be acknowledged, resolved with a reason (MFA) and reopened; the job loop resolves an alert when its condition clears. A needs-you endpoint gathers everything waiting on an operator. Cases have a queue, a detail and actions, including a refund through the existing flow.

## Rules

- Catalogue `domain/alerts/src/catalogue.ts`: for each of the 12 `AlertKind` values and every gate `blocked_by` value: `severity` (critical, high, medium, info, from the audit table), `title`, `cause(reason, detail)`, `fix: {route, anchor}`, `runbook`, `autoResolve?: SQL predicate id`. Golden fails on any unmapped kind or reason prefix.
- `alert_events` (migration, next free, planned 0025): `id, alert_id, kind (acknowledged, resolved, auto_resolved, reopened, note), note, at, created_at, updated_at`; append-only guards; tracked by the TR0 journal. Current state = latest event, default `open`.
- Auto-resolve rules: `payment_unresolved` and `frozen_order` when the order is `paid`, `failed` or `abandoned`; `refund_unresolved` and `refund_failed` when the request is `confirmed`; others manual.
- New kinds through `raiseAlert`: `mandate_near_cap` (spent at least 90 percent of money or count), `webhook_failing` (3 consecutive failed deliveries for one subscription). `alerts.order_id` is nullable already; these use `detail.mandate_id` or `detail.subscription_id`.
- Needs-you: open alerts by severity, applicants waiting, payee checks waiting, caps near limit, each `{kind, sentence, href}`.
- Case actions reuse `domain/recovery` and the existing refund path (MFA, CSRF, idempotency key). No new money logic.

## Outputs

New: `domain/alerts/src/{catalogue,read,state,autoresolve,needs-you}.ts`, migration `00NN_alert_events.sql`, routes under `apps/web/src/app/api/v1/ops/alerts/`, `.../ops/needs-you/`, `.../ops/cases/`, contracts `packages/contracts/src/v1-alerts.ts`. Changed: `domain/payments/src/alerts.ts` (two kinds added to the union), `domain/recovery/src/cases.ts` (read model export), `packages/jobs/src/loop.ts` (auto-resolve step), `apps/web/composition.server.ts` alert query (the `kind, created_at LIMIT 20` read at line 2942 is replaced) or the UI0 module.

## Acceptance tests (commit 1: tests only, run red)

| Item | Test file | Command | Expected |
|---|---|---|---|
| AL.1 | `domain/alerts/src/read.state.test.ts` | `pnpm test:state -- alerts/read` | 25 seeded alerts return 25 with count; each has order ref, unit, money at risk, case id where one exists |
| AL.2 | `domain/alerts/src/catalogue.golden.test.ts` | `pnpm test:golden -- alerts/catalogue` | All 12 kinds, 2 new kinds and all gate reasons mapped; a fake kind fails |
| AL.3 | `domain/alerts/src/state.adversarial.test.ts` | `pnpm test:adversarial -- alerts/state` | Resolve without MFA 403; seller and buyer keys 403; double resolve is a no-op; journal shows actor and reason |
| AL.4 | `domain/alerts/src/autoresolve.state.test.ts` | `pnpm test:state -- alerts/autoresolve` | Order reaching paid writes `auto_resolved` by system once |
| AL.5 | `domain/alerts/src/signals.state.test.ts` | `pnpm test:state -- alerts/signals` | 90 percent cap and 3 failed deliveries raise once each |
| AL.6 | `apps/web/src/v1-needs-you.contract.test.ts` | `pnpm test:contract -- needs-you` | Shape and hrefs valid routes from the route inventory |
| AL.7, AL.8 | `domain/recovery/src/cases-api.state.test.ts`, `cases-actions.adversarial.test.ts` | `pnpm test:adversarial -- cases-actions` | Refund from a case needs MFA and idempotency key; replay returns the stored answer; ledger guard still holds |

Mutation: `state.ts`, `autoresolve.ts` and the case action handler at least 80 percent.

## Do not

Change alert raising logic beyond the two new kinds; add money logic; call PayPal.

Branch: `feat/int-al-alerts`. Commit: `feat(alerts): alert catalogue, state, needs-you and case API (INT-AL)`.
