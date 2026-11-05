# INT-SEL: seller screens

Task: Give sellers a home, sales they can open, and money and offer pages that answer "how am I doing".
Package: `apps/web` (seller tabs, one session export route). Builder: Sonnet 5.5 medium. Reviewer: Opus 5.5 gate.
Items: SEL.1 to SEL.9, 18 points: SEL.1 to SEL.3 "must" (6), SEL.4 to SEL.9 "should" (12). Needs UI0, TR1, SR1 and OPS-B.1 merged. Decision V2 (on-screen name "Seller"). Sources: `/mnt/project-files/operator-ux/seller-console.html` items 2 to 9; UX-13, 14, 24, 25, 26. Includes `int-wave2-conventions.md`. Round 2 passed 11/12 (`sel-scorecard.md`); R2-1 and R2-2 are applied in the text; build notes below.

## Goal

URLs keep `/publisher` (UI0): Home `/publisher`, Offers `/publisher/offers`, Sales `/publisher/sales`, Money `/publisher/statement`, Account `/publisher/payout-account`. UI0 renamed the nav label; SEL renames page words (see Copy below).

**Seller projection (F2).** Every SEL view and the SEL export use SR0's seller projection **minus `order_total_minor`**. A seller sees no order total and no other seller's unit (TR1 F7). The drop happens in `src/composition/seller.ts`, so the views and CSV never receive the field.

**Windows (F4).** All from the injected Clock, UTC. "This week" is the 7 days ending at `now`. "Last 30 days" is the 30 days ending at `now`. Both filter on `captured_verified_at`. Zero units shows words ("No sales in the last 30 days"), never NaN or a blank.

**Money formula (F3).** Net is the statement net from `domain/publisher-console/src/totals.ts`: gross minus refunds minus reversals. The PayPal fee is shown beside the net and is never subtracted. SEL.3, SEL.7 and SEL.8 all use this formula over `ledger_entries`.

**Offer join (F3).** `txn_rows` has no offer, option, fee or net. Per-offer figures join the seller projection of `txn_rows` to `entitlements` (option on `entitlements.option`), then `entitlements.article_id` to `articles` to `offers`, then `ledger_entries` for the unit's money. A unit that holds several articles counts **once toward each offer it holds**; the tile notes "a sale with several articles counts toward each". Its money is split evenly across the unit's distinct offers in minor units, with the remainder to the lowest offer id, so per-offer nets still sum to the statement net (R2-1). Because `offers` has primary key `(id, version)`, each `(unit, offer id)` pair counts once, never once per version (R2-2).

- **SEL.1, sale detail.** `/publisher/sales/[unit]` comes from the TR1 seller timeline. It shows the units, fee, refund (amount, state and date only), net, and "a person" or "an agent". **No refund reason text** (F1): `refund_requests.reason` is operator free text and can hold buyer identity; a reason code is a later item that needs a migration. It never shows buyer identity (id, name, agent key or context). Another seller's unit gives 404 with the same body as an unknown unit.
- **SEL.2, Sales.** `/publisher/sales` has All, Pending and Refunds views over SR1's seller list (keyset paging), with the shared filter bar showing seller fields only. CSV comes from `GET /api/publisher/sales/export`: `auth: 'publisher'`, `csrf: false`, `idempotent: false`, `risk: 'medium'`, `max_body_bytes: 1024`, `rate: {name: 'publisher_sales_export', per: 'actor', limit: 10, window_ms: 60_000}` (F6). It uses SR1's seller export read with the projection above. It has no buyer column and no order total.
- **SEL.3, Home after setup.** This week's sales and net, needs you, top 3 offers, and the agent share tile (agent units over all units, last 30 days).
- **SEL.4, setup path.** Shown on Home until done: application, terms, payout account, payee check, first offer. Each step's state comes from stored data.
- **SEL.5, Money.** The statement, the existing PUB-E1 CSV, payee status, and fee and net labelled "modelled" only on a statement block whose stored `environment` is `dryrun` (F8). An empty statement shows no "modelled" label.
- **SEL.6, offers.** The offers list filters by status. The offer page `/publisher/offers/[id]` shows details, price history (offer versions) and sales.
- **SEL.7, queries.** `agentShare(publisher_id, from, to)` and `topOffers(publisher_id, from, to, n)` in `src/composition/seller.ts`, using the join and formula above. Top offers are ordered by net descending, ties by offer id ascending.
- **SEL.8, performance.** Units, gross, refunds and net per offer option, same join and formula.
- **SEL.9, journeys.** S1 to S5.

**Copy (F5).** "Publisher" becomes "Seller" in on-screen strings only. Identifiers, URLs, the PUB-E1 CSV filename and its headers stay.
- Change: `lib/publisher-copy.ts`, `lib/publisher-home-copy.ts`, `lib/publisher-forms-copy.ts`, `lib/publisher-e1-copy.ts` (page words only), `lib/statement-copy.ts`, `lib/payee-copy.ts`, `lib/offer-copy.ts`.
- Their goldens move with them (C6): `publisher-copy.golden.test.ts`, `publisher-home-copy.golden.test.ts`, `lib/publisher-forms-copy.test.ts`, `publisher-e1-copy.golden.test.ts`, `statement-copy.golden.test.ts`, `payee-copy.golden.test.ts`, `offer-copy.golden.test.ts`. And the e2e files `publisher-pages.spec.ts`, `ze-publisher-offers.spec.ts`, `purchase-reader-statement.spec.ts`.
- Keep "publisher": `legal-copy.ts`, `agreement-copy.ts`, `apply-copy.ts` and `account-copy.ts` (contract term), and `ops-publishers-copy.ts` (operator view).

## Outputs (only these files)

New:
- page `apps/web/src/app/publisher/sales/[unit]/page.tsx`
- route `apps/web/src/app/api/publisher/sales/export/route.ts`
- `apps/web/src/ui/seller/{SaleDetail,SetupPath,AgentShare,OfferPerformance}.tsx`
- `apps/web/src/lib/{seller-sale-view,seller-sales-view,seller-home-view,seller-money-view,seller-offer-view}.ts`
- `apps/web/src/seller-fixture.ts`: the test seed, built on SR1's `domain/txn-search/fixtures/views-seed.ts`. It adds two sellers, a two-seller order bought by an agent with a canary order total no single unit has, one multi-article unit, one refund whose reason text holds a canary buyer name, and sales inside and outside the 7 and 30 day windows.
- the tests below

Changed:
- `apps/web/src/app/publisher/{page,sales/page,statement/page,offers/page,offers/[id]/page}.tsx`
- composition module `seller.ts`
- the seven copy files, seven goldens and three e2e files named under Copy
- `apps/web/src/flow-a11y.state.test.ts` (adds the changed pages)

No domain or migration change.

## Acceptance tests (commit 1: tests only, run red)

| Item | Test file | Command | Expected |
|---|---|---|---|
| SEL.1 | `apps/web/src/seller-sale.adversarial.test.ts` | `corepack pnpm vitest run apps/web/src/seller-sale.adversarial.test.ts` | On the two-seller agent order, a deep scan of the composition answer and the `seller-sale-view.ts` output (F7) finds no buyer id, buyer name, agent key id, `req_id`, `ip_hash`, canary order total or canary refund reason; no other seller's unit or amount appears; another seller's unit gives 404 with the unknown-unit body; buyer and operator sessions are refused |
| SEL.2 | `apps/web/src/seller-sales-view.state.test.ts`, `apps/web/src/seller-export.adversarial.test.ts` | `corepack pnpm vitest run apps/web/src/seller-sales-view.state.test.ts apps/web/src/seller-export.adversarial.test.ts` | All, Pending and Refunds counts match the fixture. CSV rows equal the filtered list, with no buyer column and no order total; the canary total and reason are in no cell. `buyer=`, `agent_key=` and `seller=` (any value) give 400 `field_not_allowed`. Buyer and operator sessions 403, anonymous 401, the 11th export in a minute 429. Seller A's export never holds seller B's rows; cells are neutralised |
| SEL.3, SEL.7 | `apps/web/src/seller-home-view.state.test.ts` | `corepack pnpm vitest run apps/web/src/seller-home-view.state.test.ts` | Agent share equals agent units over all units in the 30-day window; top offers are ordered by net with ties by id, and the multi-article unit counts toward each offer; this week's figures equal the ledger by the statement formula; a seller with no sales sees words |
| SEL.4 to SEL.6, SEL.8 | `apps/web/src/seller-should-view.state.test.ts` | `corepack pnpm vitest run apps/web/src/seller-should-view.state.test.ts` | Each setup step follows its stored state. "Modelled" shows only on a `dryrun` block, never on an empty statement. The offer status filter narrows. Price history lists versions in order. Per-option performance equals the ledger, and per-offer nets sum to the statement net |
| SEL.9 | `apps/web/e2e/seller-journeys.spec.ts` | `corepack pnpm --filter @umsbx/web test:e2e seller-journeys.spec.ts` | S1 to S5 pass; `page.content()` of `/publisher/sales/[unit]` for the two-seller agent order holds no buyer identity, canary total or canary reason |
| a11y | `apps/web/src/flow-a11y.state.test.ts` | `corepack pnpm vitest run apps/web/src/flow-a11y.state.test.ts` | The text-read check passes for each changed page |

No L item. SEL.1 is the persona rule, so its adversarial file is required anyway. C4 to C7 apply.

## Build notes (round 2, binding)

- N1: SR0's `SELLER_COLUMNS` also drops `order_total_minor` (now in the SR0 spec); SEL still strips it in `seller.ts`.
- N2: `seller-fixture.ts` is test-only; no page or route imports it.

## Do not

Show buyer identity, an order total or refund reason text anywhere; label fees "modelled" from a literal; change PUB-E1's statement export, its filename or headers; change URLs; rename "publisher" in legal, agreement, apply, account or ops copy.

Branch: `feat/int-sel`. Commit: `feat(web): seller home, sales detail and money pages (INT-SEL)`.
