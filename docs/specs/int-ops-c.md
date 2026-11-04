# INT-OPS-C: operator buyer, seller, agent and money pages

Task: A detail page for every buyer, seller and agent key, and a money tab that opens into ledger lines.
Package: `apps/web` (Buyers, Sellers, Agents and API, Money tabs), read-only queries in the tab composition modules, one ops route for pause and revoke. Builder: Sonnet 5.5 high. Reviewer: Opus 5.5 gate.
Items: OPS-C.1 to OPS-C.5, 12 points, cut "should". Sources: operator items 11 to 15; UX-09, UX-19 (operator half), UX-20.

## Goal

Buyer page: orders, library, refunds, caps and keys of one buyer. Seller page: offers, sales, payee, agreement. Agents and API: caps with spent and remaining in money and count, reservations, agent purchases, keys, webhook subscriptions and deliveries, with pause cap and revoke key (both MFA, journaled). Money tab: problems, reconciler, totals that open a ledger list filtered by currency and kind, exchange rates. Home gets the money-flow strip (find, quote, approve, pay, unlock, refund) with counts and stuck counts.

## Outputs

Pages under `apps/web/src/app/ops/(buyers/[id]|sellers/[id]|agents|money)`, `apps/web/src/app/api/ops/mandates/[id]/pause/route.ts` (if pause does not exist; revoke reuses the existing key route), tab composition modules.

## Acceptance tests (commit 1: tests only, run red)

| Item | Test file | Command | Expected |
|---|---|---|---|
| OPS-C.1, C.2 | `apps/web/src/ops-entity-pages.state.test.ts` | `pnpm test:state -- ops-entity-pages` | Seeded buyer and seller pages list the expected rows |
| OPS-C.3 | `apps/web/src/ops-agents.adversarial.test.ts` | `pnpm test:adversarial -- ops-agents` | Pause and revoke need MFA and CSRF; a paused cap refuses `buy_unit`; journal shows the operator |
| OPS-C.4 | `apps/web/src/ops-ledger.state.test.ts` | `pnpm test:state -- ops-ledger` | Totals equal the sum of listed ledger lines per currency |
| OPS-C.5 | `apps/web/src/money-flow.state.test.ts` | `pnpm test:state -- money-flow` | Counts match the seeded journey run |

Mutation: pause route at least 80 percent.

Branch: `feat/int-ops-c`. Commit: `feat(web): operator buyer, seller, agent and money pages (INT-OPS-C)`.
