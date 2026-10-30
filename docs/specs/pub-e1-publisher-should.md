# Spec: publisher SHOULD features, CSV, refunds view, since your last visit, create offer (PUB-E1)

Task: the four publisher side SHOULD features cut from the first build (proposal 3C, 3F, 3G, 3H, section 6).
Package: `domain/publisher-console`, `domain/catalogue`, `packages/db` (migration 0014), `apps/web` Owner: builder
(Sonnet) Reviewer: Opus. Branch `feat/pub-e1-should`. Commit `feat(<package>): <what> (PUB-E1)`. Depends on: PUB-A1, B, C.
Every feature is scoped by the session's `publisher_id`; no input carries a publisher id. No money-path file is touched.

Goal: a publisher downloads its statement and sales as CSV, sees refunds apart from sales, sees what changed since its last
visit, and puts an own article without a live offer on sale.

1. CSV. `GET /api/publisher/export?kind=statement|sales` (`withRoute`, auth publisher, no csrf, rate 10 per minute per
   actor, strict query). Answer: ordinary JSON `{ filename, csv, truncated }` (the standard wrapper; the stream allow-list
   of D-016 is not widened); a button on the sales and statement pages saves the text as a file in the browser. The CSV is
   built in `domain/publisher-console/src/csv.ts` (pure), at most 5000 rows, `truncated` says so. Columns carry a `currency`
   and an `environment` column, so one file may hold several currencies. Amounts are minor unit integers plus a decimal
   column. Order refs: last 6. No buyer id. Every cell that starts with `=`, `+`, `-`, `@`, tab or CR gets a single quote
   prefix. Cells with a comma, quote or line break are quoted. Sales rows are the paid units (same rule as the page); dry run
   PayPal fee lines are left out (same rule as the page). The maintenance walk list names the route.
2. Refunds. `refundsFor(db, actor)` in `domain/publisher-console/src/refunds.ts`: one row per unit of the publisher that is
   refunded, partly refunded, reversal suspected or reversed, or has a refund or reversal ledger row: date (latest ledger
   refund or reversal row, else the unit's last change), order ref 6, items, original amount, refunded and reversed sums from
   the ledger, currency, status words, environment. A separate section "Refunds" on `/publisher/sales`.
3. Since your last visit. Migration `0014_publisher_visits.sql`: table `publisher_visits` (publisher_id PK, since_at
   nullable, last_seen_at, created_at, updated_at; no defaults, forward only, nothing deleted). `touchVisit(db, actor, now)`
   in `domain/catalogue/src/visits.ts` (the only writer, own publisher only): first visit stores a row and returns null;
   a visit 30 minutes or more after `last_seen_at` moves `since_at` to the old `last_seen_at`; any visit sets `last_seen_at`.
   `countsSince(db, actor, since)` in `domain/publisher-console/src/since.ts` (read only): new sale rows, refund rows, offer
   and publisher changes by an operator (audit rows, operator actor, target the publisher or its offers), payee decisions.
   Shown on `/publisher`.
4. Create offer. `createOffer(deps, actor, { article_id, options, attestation })` in `domain/catalogue/src/write.ts`:
   publisher must be active; the article must be the actor's and have no current authorised or draft offer; prices pass
   `checkPrice` against `offer_max_minor`; options non empty subset; `attestation` true. One transaction: lock the article,
   insert offer version `1` (status authorised, currency from the enabled corridor of the publisher's country, terms
   `terms-1`, rights personal use with AI on review, fixed price, valid from now), one authorisation row with `PUB-ATTEST-1`,
   one audit row `offer.created`. `listOfferableArticles(db, actor)`. Route `POST /api/publisher/offers/create` (csrf, rate 20
   per minute, 2 KB, strict). Page `/publisher/offers/new`; link from `/publisher/offers`. The 0012 article freeze holds.

Tests first (red run before code): `csv.test.ts`, `refunds.state.test.ts`, `since.state.test.ts`, `isolation` cases in
`publisher-console.adversarial.test.ts`, `catalogue/src/create.state.test.ts`, `create.adversarial.test.ts`,
`visits.state.test.ts`, `packages/db/src/migration-0014.state.test.ts`, `apps/web/src/publisher-e1.state.test.ts`,
`publisher-e1.adversarial.test.ts`, `publisher-e1-copy.golden.test.ts`.

Acceptance: `corepack pnpm test:state domain/publisher-console domain/catalogue packages/db apps/web` (targeted files),
`test:adversarial`, `test:golden`, `corepack pnpm check:routes`, `check:isolation`, lint, typecheck, format check, build.
Do not: edit `globals.css`; touch payments, approval, paypal, transport; add a dependency; delete data; show buyer identity.
Deviations and open points: refund reason and operator are not shown (they are not on the ledger rows; they could name a buyer).
