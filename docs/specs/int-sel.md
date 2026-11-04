# INT-SEL: seller screens

Task: Give sellers a home, sales they can open, and money and offer pages that answer "how am I doing".
Package: `apps/web` (seller tabs), seller composition module. Builder: Sonnet 5.5 medium. Reviewer: Opus 5.5 gate.
Items: SEL.1 to SEL.9, 18 points (SEL.1 to SEL.3 must, 6; SEL.4 to SEL.9 should, 12). Needs UI0, TR1, SR1, OPS-B.1. Sources: `/mnt/project-files/operator-ux/seller-console.html` items 2 to 9; UX-13, 14, 24, 25, 26. On-screen name "Seller" (V2).

## Goal

A sale opens a detail from the seller timeline (units, fee, refund with reason, net, person or agent) with no buyer identity anywhere. Sales split into All, Pending and Refunds with the filter bar. Home shows this week, needs you, top offers and the agent share tile. Should items: setup path; money tab with statement, CSV, payee status, modelled fee and net labelled from stored data; offers list and offer page; performance per offer and option; agent share and top offers queries; journey tests S1 to S5.

## Outputs

Pages under `apps/web/src/app/publisher/(home|sales|sales/[unit]|money|offers|offers/[id])` (URLs keep `/publisher`, labels say "Seller"), seller composition module, `apps/web/src/lib/seller-copy.ts`.

## Acceptance tests (commit 1: tests only, run red)

| Item | Test file | Command | Expected |
|---|---|---|---|
| SEL.1 | `apps/web/src/seller-sale.adversarial.test.ts` | `pnpm test:adversarial -- seller-sale` | Deep scan of page props and HTML: no buyer id, name, agent key or context; another seller's unit 404 |
| SEL.2, SEL.3 | `apps/web/src/seller-sales.state.test.ts` | `pnpm test:state -- seller-sales` | Split counts match; agent share equals agent units over all units |
| SEL.4 to SEL.8 | `apps/web/src/seller-should.state.test.ts` | `pnpm test:state -- seller-should` | Fee and net labelled "modelled" in dry run from stored `environment`; performance numbers match the ledger |
| SEL.9 | `tests/e2e/seller-journeys.spec.ts` | `pnpm test:e2e -- seller-journeys` | S1 to S5 pass; axe clean |

Branch: `feat/int-sel`. Commit: `feat(web): seller home, sales detail and money pages (INT-SEL)`.
