# INT-OPS-A: operator Home, alerts, cases and order page

Task: The operator screens that turn "something is wrong" into one click to the fix.
Package: `apps/web` (operator Home, Money › Problems, alerts, cases, order page). Builder: Sonnet 5.5 medium. Reviewer: Opus 5.5 gate.
Items: OPS-A.1 to OPS-A.7, 12 points, all "must". Needs UI0, TR1 and AL merged. Decision V6. Sources: operator page items 6, 7, 7b, 9; UX-01, 02, 03, 06, 07, 08. Includes `int-wave2-conventions.md` (C1 to C7).

## Goal

- **OPS-A.1:** Home shows four health lights: app, database, PayPal gateway and job loop. They come from `engine.health()` and the lock read; up, down and unknown are each shown in words.
- **OPS-A.2:** Home shows the AL needs-you list, and the shell bell shows open alerts by severity.
- **OPS-A.3:** The alerts list filters by state, severity and kind (AL.1), with a "show resolved" toggle and true totals. Alert detail shows cause, money at risk, case link, the fix button (catalogue `fix`), and acknowledge, resolve with a reason code, and reopen. These post to AL's `/api/ops/alerts/[id]/*` routes.
- **OPS-A.4:** The order page `/ops/money/orders/[ref]` shows a summary, the TR1 operator timeline with a "verified" or "first broken row" mark, an evidence pack button (MFA; it links to TR1's `/api/ops/units/[id]/evidence.html`) and the one fix action from the catalogue. Identity appears only on an MFA session (C3).
- **OPS-A.5:** The case queue `/ops/buyers/cases` (ordered by SLA due, filter by state) and the case detail with AL's six actions, posting to `/api/ops/cases/[id]/actions`.
- **OPS-A.6:** Each failing invariant on Money links to a filtered list of its rows, and each operation-state tile opens the operations in that state.
- **OPS-A.7 (V6):** `/ops/publishers` and `/ops/payee-requests` render their queues read-only for an operator session without MFA. Every action button there still posts to a route that answers 403 `mfa_required` without MFA, and the button says "needs your authenticator code".

## Outputs (only these files)

New:
- pages `apps/web/src/app/ops/money/problems/page.tsx`, `ops/money/orders/[ref]/page.tsx`, `ops/alerts/page.tsx`, `ops/alerts/[id]/page.tsx`, `ops/buyers/cases/page.tsx`, `ops/buyers/cases/[id]/page.tsx`
- `apps/web/src/ui/ops/{HealthLights,AlertList,AlertDetail,CaseCard}.tsx`
- `apps/web/src/lib/{ops-health-view,ops-alerts-view,ops-cases-view,ops-copy}.ts`
- the tests below

Changed:
- `apps/web/src/app/ops/page.tsx` (lights, needs-you)
- `apps/web/src/app/ops/publishers/page.tsx`, `ops/payee-requests/page.tsx` (read without MFA)
- composition modules `ops-home.ts`, `ops-money.ts`, `ops-buyers.ts` (read functions only)
- `apps/web/src/lib/shell-tabs.ts` (`ready: true` for Buyers once cases exist)
- tests that assert the old MFA wall on those two pages: `e2e/zd-ops-publishers.spec.ts` and the `publishers-mfa-needed` cases, moved per C6

No API, domain or migration change.

## Acceptance tests (commit 1: tests only, run red)

| Item | Test file | Command | Expected |
|---|---|---|---|
| OPS-A.1, A.2 | `apps/web/src/ops-home-view.state.test.ts` | `corepack pnpm vitest run apps/web/src/ops-home-view.state.test.ts` | Seeded down database, gateway off and a stale job pass each give the right light and words; needs-you rows and the bell counts equal AL's seed; each href is in `OPS_PAGES` |
| OPS-A.3 | `apps/web/src/ops-alerts-view.state.test.ts`, `apps/web/src/ops-alerts-page.adversarial.test.ts` | `corepack pnpm vitest run apps/web/src/ops-alerts-view.state.test.ts apps/web/src/ops-alerts-page.adversarial.test.ts` | Filters and totals match AL; resolve offers only the closed reason codes. A buyer or seller session on the alert pages lands on sign-in. The detail's fix link is a relative path accepted by `lib/next-path.ts` |
| OPS-A.4 | `apps/web/src/ops-order-view.state.test.ts`, `apps/web/e2e/ops-order.spec.ts` | `corepack pnpm vitest run apps/web/src/ops-order-view.state.test.ts`; `corepack pnpm --filter @umsbx/web test:e2e ops-order.spec.ts` | Without MFA the view has no buyer name, provider id or `ip_hash` (deep scan); with MFA it has them. e2e: one click from an alert opens the order page anchored at the raising event, and the verified mark shows |
| OPS-A.5 | `apps/web/src/ops-cases-view.state.test.ts` | `corepack pnpm vitest run apps/web/src/ops-cases-view.state.test.ts` | Queue ordered by `sla_due_at`; detail shows only the actions allowed in the case state; the refund action posts to AL's route with an idempotency key |
| OPS-A.6 | `apps/web/src/ops-invariants-view.test.ts` | `corepack pnpm vitest run apps/web/src/ops-invariants-view.test.ts` | Each failing invariant and each operation-state tile maps to a filtered list URL that returns those rows |
| OPS-A.7 | `apps/web/src/ops-queues.adversarial.test.ts` | `corepack pnpm vitest run apps/web/src/ops-queues.adversarial.test.ts` | A no-MFA operator session reads both queues; every POST from them without MFA answers 403 `mfa_required`; buyer and seller sessions still land on sign-in |
| Journeys | `apps/web/e2e/ops-journeys.spec.ts` | `corepack pnpm --filter @umsbx/web test:e2e ops-journeys.spec.ts` | J1 morning check, J2 alert to fix and J3 "paid but cannot open" finish within the click counts in the operator page source (J1 2, J2 3, J3 4) |

No L item, so no mutation target. C4 to C7 apply.

## Do not

Add or change an API, domain or migration; move or change the kill switch, Start, Stop or gate panels; show identity on a non-MFA session.

Branch: `feat/int-ops-a`. Commit: `feat(web): operator home, alerts, cases and order page (INT-OPS-A)`.
