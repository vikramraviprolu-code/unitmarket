# Spec: the UK pounds route (MC-GBP), a thin real slice of "settled in each side's own currency"

Task: let a UK buyer buy a UK publisher's article in pounds. Today only US dollars can move: the sealed transport allows `USD` only for both approval scopes (D-023), and the public offer list filters on `USD`.
Package: `packages/transport` (`src/sandbox.ts` and its test), `apps/web` (`composition.server.ts` offer list, new test) Owner: coordinator Reviewer: Vikram
Branch: `feat/multi-currency-gbp` Commit: `feat(transport): the hosted scope may move GBP; the offer list follows the enabled corridors (MC-GBP)`
Decision: the owner (Vikram) lifted the money-path freeze for this change on 2026-11-03 ("our app must be agnostic to the buyer or seller as long as we settle the buyer and seller in their own currency").

Goal, three small changes, nothing else:

1. `SCOPE_CURRENCIES.mvp_c_refunds` becomes `['USD', 'GBP']`. `mvp_b_polling` stays `['USD']`. EUR, JPY and XAU stay refused in both. The gate, the amount binding, the payee rules and the operation list are untouched.
2. `listOffers` lists an authorised offer when its currency has an enabled corridor, not only when it is `USD`. With the seed (only `us-usd` enabled) the list is exactly what it is today.
3. The corridor `gb-gbp` is switched on in the database by a separate owner step, not by code or migration, and recorded in the decision log. A UK buyer (account country GB) then sees the pounds offers through the existing discovery, which already follows enabled corridors.

Inputs: `packages/transport/src/sandbox.ts`, `apps/web/composition.server.ts`.
Outputs: those two files; `packages/transport/src/sandbox.binding.test.ts` (two edited tests, stated in the commit, because they pinned "USD only"); new tests `apps/web/src/offers-corridor.state.test.ts` and `apps/web/src/uk-purchase.state.test.ts` (a UK buyer buys the Northfield article in dry run: quote, approval, order, payment and ledger all in GBP, £1.50).

Acceptance tests:

- `corepack pnpm exec vitest run packages/transport/src/sandbox.binding.test.ts`: GBP create_order and GBP refund are sent under `mvp_c_refunds`; GBP is still blocked under `mvp_b_polling`; EUR, JPY and XAU are blocked under both; the allow-list pin names `mvp_c_refunds: ['USD','GBP']`.
- `corepack pnpm exec vitest run apps/web/src/offers-corridor.state.test.ts`: the Northfield (GBP) offers are not listed while `gb-gbp` is disabled and are listed after it is enabled; the USD offers are listed in both cases.
- `corepack pnpm exec vitest run apps/web/src/uk-purchase.state.test.ts`: the whole dry-run purchase stays in GBP.
- `corepack pnpm exec vitest run tests/mvp-b` and `corepack pnpm test:contract` pass (they hold the other scope tests).
- `corepack pnpm lint`, `typecheck`, `format:check`, `check:isolation`, `check:no-live-host` pass.

Do not: change the approval gate, the outbound approval rows, the payee rules, any other scope or operation, the migrations, or the corridor rows in code; add a dependency.
Evidence: red then green output; after the deploy, the real UK purchase (separate step, separate approval row).
