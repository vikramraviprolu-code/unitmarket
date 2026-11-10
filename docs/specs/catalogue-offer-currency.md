# Spec: the seller chooses the currency of an offer (OFFER-CUR, lane L1)

Task: a publisher picks USD, EUR or GBP for each new offer; no currency is derived by corridor id any more.
Package: `domain/catalogue`, `apps/web`, `packages/contracts` (one schema field), `docs/api`. Owner: builder (Sonnet). Reviewer: Sakthi.
Branch: `feat/catalogue-offer-currency` Commit: `type(catalogue): <what> (OFFER-CUR)`. Design: owner rule of 9 Nov 2026 (D-113), Opus gate "approve with changes", items C1, C5, C7, C8 and the buyer cap form.

Goal: one rule for "which currency does a new offer carry": the seller's explicit choice, checked against an enabled corridor that covers the publisher's country (`enabled AND currency = $1 AND country = ANY(payee_countries)`, else `no_corridor`). With no choice the default is USD, then EUR, then GBP among the enabled currencies that cover the country, never by corridor id. This lane ships and deploys BEFORE migration 0034 and changes no data: with today's rows (US and IN covered by USD only) every answer is identical to today's.

Inputs: `domain/catalogue/src/{write,import-stage,import-publish}.ts`, `apps/web/composition.server.ts` (`offerable`, `create`, `listOffers`), the create route, `SellerOfferCreateRequestSchema`, `CreateForm`, `buyer/agents/page.tsx`, `CapForm`, the approvals routes. Migration 0034, seed data, the ISO constant, per-batch import currency and the money path are NOT in this lane.

Outputs:

- `write.ts`: `offerCurrenciesFor(db, actor)` (covered currencies, USD > EUR > GBP then others by code), `offerCurrencyFor` = its first; `CreateInput.currency?`; `createOfferInTx(..., parts?, currency?)`; the two `ORDER BY id LIMIT 1` derivations in `write.ts` and `import-stage.ts` replaced. Import keeps the deterministic default and passes it explicitly to `createOfferInTx` (the item currency is frozen, lane L4 later).
- Create route (strict zod) and v1 `SellerOfferCreateRequestSchema` (strict) take optional `currency` in `USD|EUR|GBP`; `docs/api/openapi-v1.json` regenerated.
- `offerable()` also returns `currencies` (the list); the new-offer page and `CreateForm` show a currency select when there is more than one, and send `currency` only then.
- `listOffers` uses the rule currency AND payee country.
- Buyer copy for `corridor_unsupported` ("Items from publishers in India are paid separately. Buy them in a separate order.") and `publisher_unverified` in both approval routes.
- Buyer agent cap form: a currency select (USD, EUR, GBP) instead of the hard-coded USD.

Acceptance tests (commit 1 is red, then green). The tests simulate the post-0034 rows by inserting wide corridor rows (`us-usd`, `gb-gbp`, `de-eur` widened; `in-eur`, `in-gbp` added) into the test database:

- `corepack pnpm vitest run domain/catalogue/src/offer-currency` : default USD for US and IN publishers on today's rows and on the wide rows; explicit EUR/GBP honoured; no covering corridor (JPY, bad shape, disabled, IN with EUR off) is `no_corridor`; import stages and publishes in USD on the wide rows.
- `corepack pnpm vitest run packages/contracts/src/v1-offer-currency` : currency accepted for the three codes only, schema stays strict.
- `corepack pnpm vitest run apps/web/src/offer-currency apps/web/src/buyer-cap-currency` : route and v1 route create GBP/EUR offers; `offerable` lists currencies; FR publisher GBP offer bought end to end in GBP (quote, approval, order, capture, ledger, receipt, statement); IN buyer refused with no stored quote, US buyer quoted, on an IN EUR/GBP offer; EUR off removes EUR offers from `listOffers`, the candidate list and live count, old receipts remain; IN plus US basket gives the new copy; `listOffers` hides an IN EUR offer when only a non-IN EUR corridor is on.
- `corepack pnpm check:openapi`, `lint`, `typecheck`, `format:check`, `check:isolation`, `check:no-live-host`, `check:secrets-names`, `check:routes`, and the six suites : pass.

Do not: touch `domain/payments`, ledger, refunds, payouts, statements, transport, paypal or `domain/approval/src/approval.ts`; add a dependency; change a migration, seed or fixture; put a secret anywhere; add a per-currency minimum price.
Evidence for the PR: the red run of commit 1, the green run, every check output, and the list of existing tests edited with the reason.
