# INT-SEL: seller screens

Task: Give sellers a home, sales they can open, and money and offer pages that answer "how am I doing".
Package: `apps/web` (seller tabs, one session export route). Builder: Sonnet 5.5 medium. Reviewer: Opus 5.5 gate.
Items: SEL.1 to SEL.9, 18 points: SEL.1 to SEL.3 "must" (6), SEL.4 to SEL.9 "should" (12). Needs UI0, TR1, SR1 and OPS-B.1 merged. Decision V2 (on-screen name "Seller"). Sources: `/mnt/project-files/operator-ux/seller-console.html` items 2 to 9; UX-13, 14, 24, 25, 26. Includes `int-wave2-conventions.md`.

## Goal

URLs keep `/publisher` (UI0): Home `/publisher`, Offers `/publisher/offers`, Sales `/publisher/sales`, Money `/publisher/statement`, Account `/publisher/payout-account`. UI0 renamed the nav label. SEL renames the page copy ("publisher" becomes "seller" on screen), and lists every copy golden it changes (C6).

- **SEL.1, sale detail.** `/publisher/sales/[unit]` comes from the TR1 seller timeline. It shows the units, fee, refund with its reason code, net, and "a person" or "an agent". It never shows buyer identity (id, name, agent key or context) in props, HTML or JSON. Another seller's unit gives 404 with the same body as an unknown unit.
- **SEL.2, Sales.** `/publisher/sales` has All, Pending and Refunds views over SR1's seller list (keyset paging), with the shared filter bar showing seller fields only. CSV comes from a session route `GET /api/publisher/sales/export` (`auth: 'publisher'`) using SR1's seller export read. It has no buyer column.
- **SEL.3, Home after setup.** This week's sales and net, needs you, top 3 offers, and the agent share tile (agent units over all units, last 30 days).
- **SEL.4, setup path.** Shown on Home until done: application, terms, payout account, payee check, first offer. Each step's state comes from stored data.
- **SEL.5, Money.** The statement, the existing PUB-E1 CSV, payee status, and fee and net labelled "modelled" when the stored `environment` is `dryrun` (never from a literal).
- **SEL.6, offers.** The offers list filters by status. The offer page `/publisher/offers/[id]` shows details, price history (offer versions) and sales.
- **SEL.7, queries.** `agentShare(publisher_id, from, to)` and `topOffers(publisher_id, from, to, n)`, as read functions in the seller composition module over `txn_rows` with the seller projection.
- **SEL.8, performance.** Units, gross, refunds and net per offer option.
- **SEL.9, journeys.** S1 to S5.

## Outputs (only these files)

New:
- page `apps/web/src/app/publisher/sales/[unit]/page.tsx`
- route `apps/web/src/app/api/publisher/sales/export/route.ts`
- `apps/web/src/ui/seller/{SaleDetail,SetupPath,AgentShare,OfferPerformance}.tsx`
- `apps/web/src/lib/{seller-sale-view,seller-sales-view,seller-home-view,seller-money-view,seller-offer-view,seller-copy}.ts`
- the tests below

Changed:
- `apps/web/src/app/publisher/{page,sales/page,statement/page,offers/page,offers/[id]/page}.tsx`
- composition module `seller.ts`
- `apps/web/src/lib/publisher-copy.ts` (page words)
- copy goldens that hold "publisher" page words (listed in the PR)

No domain or migration change.

## Acceptance tests (commit 1: tests only, run red)

| Item | Test file | Command | Expected |
|---|---|---|---|
| SEL.1 | `apps/web/src/seller-sale.adversarial.test.ts` | `corepack pnpm vitest run apps/web/src/seller-sale.adversarial.test.ts` | On a two-seller order with an agent buyer, a deep scan of the view, props and JSON finds no buyer id, buyer name, agent key id, `req_id` or `ip_hash`; no other seller's unit or amount appears; another seller's unit gives 404 with the unknown-unit body; buyer and operator sessions are refused |
| SEL.2 | `apps/web/src/seller-sales-view.state.test.ts`, `apps/web/src/seller-export.adversarial.test.ts` | `corepack pnpm vitest run apps/web/src/seller-sales-view.state.test.ts apps/web/src/seller-export.adversarial.test.ts` | All, Pending and Refunds counts match the seed. CSV rows equal the filtered list, with no buyer column. `buyer=` or `agent_key=` give 400 `field_not_allowed`. Seller A's export never holds seller B's rows; cells are neutralised |
| SEL.3, SEL.7 | `apps/web/src/seller-home-view.state.test.ts` | `corepack pnpm vitest run apps/web/src/seller-home-view.state.test.ts` | Agent share equals agent units over all units for the seed; top offers are ordered by net with ties by id; this week's figures equal the ledger |
| SEL.4 to SEL.6, SEL.8 | `apps/web/src/seller-should-view.state.test.ts` | `corepack pnpm vitest run apps/web/src/seller-should-view.state.test.ts` | Each setup step follows its stored state. "Modelled" shows only when the stored `environment` is `dryrun`. The offer status filter narrows. Price history lists versions in order. Per-option performance equals the ledger |
| SEL.9 | `apps/web/e2e/seller-journeys.spec.ts` | `corepack pnpm --filter @umsbx/web test:e2e seller-journeys.spec.ts` | S1 to S5 pass; the text-read a11y check (C2) passes for each changed page |

No L item. SEL.1 is the persona rule, so its adversarial file is required anyway. C4 to C7 apply.

## Do not

Show buyer identity anywhere; label fees "modelled" from a literal; change PUB-E1's statement export; change URLs.

Branch: `feat/int-sel`. Commit: `feat(web): seller home, sales detail and money pages (INT-SEL)`.
