# Spec: publisher offer revise and withdraw, demo prices (PUB-B)

Task: catalogue writes for a publisher's own offers (list, revise price and options, withdraw), pages S2 and S3, and the
demo price revision to 1.00 to 2.50 USD (decision 37).
Package: `domain/catalogue` (writes), `apps/web` (pages, routes, engine, seed step) Owner: builder (Sonnet) Reviewer:
Opus, money-path review (snapshot freeze, versioning)
Branch: `feat/catalogue-pub-b-offers` Commit: `feat(<package>): <what> (PUB-B)` Decisions: D-065 items 35, 37; A-08 (snapshot
freezes offer version and price); architecture 9.12 (no universal floor); proposal 3C, 5. Depends on: CFG-0
(`offer_max_minor`), PUB-A1 (personas, `attestation_version` column). Common rules: plan section 2.

Goal: a publisher changes the price of an option or withdraws an offer; every change is a new offer version with its own
authorisation row, never an in-place price update; a buyer who already approved keeps the price they saw.

Domain, new `domain/catalogue/src/write.ts` (exported from the package root):

- `listOwnOffers(db, actor)`: newest version per offer of `actor.publisher_id`, with status and option prices.
- `reviseOffer(deps, actor, { offer_id, expected_version, options: [{ option, price_minor }], attestation })`: refuses unless
  the offer belongs to the actor, `expected_version` is the newest (else `conflict`), each price is an integer 1 to
  `offer_max_minor` (passed in, from config), the option set is a non-empty subset of `keep_retrieve`, `online_read`, and
  `attestation` is `true`. Currency, article, terms, rights and window never change here. In one transaction: insert version
  `v<n+1>` (copy of the newest, new options, status `authorised`), set `superseded_by` on the old row, insert one
  `publisher_authorisations` row with `attestation_version` (a constant `PUB-ATTEST-1`), one `audit_log` row.
- `withdrawOffer(deps, actor, { offer_id, expected_version, reason })`: new version with status `withdrawn`, same audit.
  After it, `startFromOffer` answers `no_match` reason `withdrawn` (existing behaviour; test it).
- `checkPrice(minor, cap)`: pure, exported for the page's validation messages.
  Version order: `getOffer` sorts by `created_at`, then the version number; with a fake clock the number decides. Keep it so.

Demo prices: `applyDemoPrices(deps)` in `domain/catalogue/src/demo-prices.ts`: every current, authorised USD offer with an
option price below 100 or above 250 minor units gets one `reviseOffer` call as its own publisher, prices clamped into 100 to
250 (Harbour tide-tables 40 becomes 100; 300, 450 become 250; Quayside 90 becomes 100; 120, 125, 150, 200 stay). Audit
reason `seed: demo prices (decision 37)`. Idempotent: a second run revises nothing. GBP offers are untouched. Composition
runs it at boot after the seed when `opts.test_seed?.demo_prices !== false`; `apps/web/src/support.ts` `bootTestApp` passes
`demo_prices: false` so existing tests keep the seed prices (a test helper change, not a test edit; say so).

Routes (`withRoute`, auth publisher, CSRF, rate 20 per minute per actor, body cap 2 KB, `.strict()`):
`POST /api/publisher/offers/revise`, `POST /api/publisher/offers/withdraw`. Pages:
`apps/web/src/app/publisher/offers/page.tsx` (S2: article, options, price, status, link) and
`apps/web/src/app/publisher/offers/[id]/page.tsx` (S3: price per option, which options are offered, access window "set by
UnitMarket", licence summary and terms version read-only, attestation tick, save as new version, withdraw, the note "Buyers
who already approved keep the price they saw.", version history). Copy in `apps/web/src/lib/offer-copy.ts`.

Tests first: `domain/catalogue/src/write.state.test.ts` (revise writes v2, sets `superseded_by`, one authorisation with
attestation; withdraw gives `no_match` withdrawn; price 0, 2001, 1.5, wrong option, empty set, no attestation refused;
stale `expected_version` gives `conflict`; demo prices: values above, idempotent second run, GBP untouched);
`domain/catalogue/src/write.adversarial.test.ts` (publisher A cannot list, revise or withdraw B's offer, also by a guessed
id; buyer, operator and system actors refused; a body with `currency` or `publisher_id` refused by the route schema);
`apps/web/src/offers.state.test.ts` (an approval made before a revise still charges the frozen price; a new quote after it
shows the new price); `apps/web/src/offer-copy.golden.test.ts`.

Acceptance: `corepack pnpm test:state domain/catalogue apps/web`, `corepack pnpm test:adversarial domain/catalogue apps/web`,
`corepack pnpm test:golden apps/web`, `corepack pnpm check:routes`, plan section 3. All pass.
Do not: edit `seed-data.ts` or `fixtures/catalogue/*.json`; touch `domain/approval`, `domain/payments`, `domain/offer-entry`
code; add create-offer or article upload (SHOULD, later); edit `globals.css`; change `getOffer` ordering.
Evidence: outputs, red run, the list of offers the demo step revised (ids and old to new minor units), cost line.
