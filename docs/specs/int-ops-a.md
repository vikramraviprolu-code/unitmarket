# INT-OPS-A: operator Home, alerts, cases and order page

Task: The operator screens that turn "something is wrong" into one click to the fix.
Package: `apps/web` (ops Home, Money › Problems, Buyers › Cases, order page). Builder: Sonnet 5.5 medium. Reviewer: Opus 5.5 gate.
Items: OPS-A.1 to OPS-A.7, 12 points. Needs UI0, TR1, AL. Sources: operator page items 6, 7, 7b, 9; UX-01, 02, 03, 06, 07, 08.

## Goal

Home shows four health lights and the needs-you list; the bell shows open alerts by severity. The alerts list filters by state, severity and kind and opens an alert detail with cause, money at risk, case link, fix button, acknowledge and resolve. The order page shows the summary, the operator timeline with a "verified" mark, the evidence pack button and the one fix action. Cases have a queue (state, SLA due) and a detail with actions. Invariant failures and operation-state tiles open the matching rows. Seller and payee queues are readable without the authenticator code; every action still needs it (decision V6).

## Outputs

Pages under `apps/web/src/app/ops/(home|money/problems|alerts|alerts/[id]|orders/[ref]|cases|cases/[id])`, components in `apps/web/src/components/ops/`, the `ops-home` and `ops-money` composition modules, copy in `apps/web/src/lib/ops-copy.ts`. No API or domain change.

## Acceptance tests (commit 1: tests only, run red)

| Item | Test file | Command | Expected |
|---|---|---|---|
| OPS-A.1, A.2 | `apps/web/src/ops-home.state.test.ts` | `pnpm test:state -- ops-home` | Lights reflect seeded states; needs-you rows link to valid routes |
| OPS-A.3 | `apps/web/src/ops-alerts.state.test.ts`, `ops-alerts.adversarial.test.ts` | `pnpm test:adversarial -- ops-alerts` | Resolve button needs MFA; a buyer session gets 403 |
| OPS-A.4 | e2e `tests/e2e/ops-order.spec.ts` | `pnpm test:e2e -- ops-order` | From an alert, one click opens the order page anchored at the raising event |
| OPS-A.5 | `apps/web/src/ops-cases.state.test.ts` | `pnpm test:state -- ops-cases` | Queue sorted by SLA due; refund action routes through the existing MFA flow |
| OPS-A.6 | `apps/web/src/ops-invariants.test.ts` | `pnpm test -- ops-invariants` | Each failing invariant links to its rows |
| OPS-A.7 | `apps/web/src/ops-queues.adversarial.test.ts` | `pnpm test:adversarial -- ops-queues` | Read without code works; every POST without code 403 mfa_required |
| Journeys | `tests/e2e/ops-journeys.spec.ts` | `pnpm test:e2e -- ops-journeys` | J1 morning check, J2 alert to fix, J3 "paid but cannot open" each within the click counts on the operator page |

Branch: `feat/int-ops-a`. Commit: `feat(web): operator home, alerts, cases and order page (INT-OPS-A)`.
