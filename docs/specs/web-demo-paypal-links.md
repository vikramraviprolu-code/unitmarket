# POB-DEMOLINK: a synthetic payee link for the dry run demo publishers

Task: in dry run only, the boot seed gives each demo publisher a clearly synthetic verified PayPal link, so the offline demo can show a payout; payouts refuse such a link in the sandbox environment.
Package: `apps/web` (seed in `composition.server.ts`), `domain/payments` (`payout.ts`), `domain/alerts` (`catalogue.ts`), `packages/contracts` (`payout.ts`, one constant and one predicate) Owner: Sonnet 5.5 builder Reviewer: Opus 5.5 high (money lane); Sakthi merges
Offline only: no deploy, no hosted database, no PayPal call, no approval row, no migration, no new dependency.

Findings (from code; the hosted database cannot be read from here):

- Modes: `UMS_MODE` is `offline` (environment `dryrun`) or `sandbox` (`envLabel`). The seed runs in `buildApp.open()` on first database use in every mode, after `migrate`, on every boot and restart (hosted Cloud Run included). The dry run branch (`mode === 'offline'`) sets `paypal_merchant_id = 'DRYRUN...'` and turns the dry run outbound switch on; the `sandbox` branch runs `seedSandboxPayees`, which flags Harbour, Quayside and Rheinwerft `payee_shared`. Demo publishers (Harbour Ledger, Northfield Quarterly, Quayside Gazette, Rheinwerft Kurier) are not `payee_shared` in dry run, only in sandbox mode.
- Idempotent today: every seed step looks rows up first or uses `ON CONFLICT DO NOTHING` or `WHERE ... IS NULL`. Playwright runs `UMS_MODE=offline` with `NODE_ENV=production`, so the e2e app runs the seed too; vitest runs with `NODE_ENV=test`, where optional steps are off unless `test_seed` asks.
- Hosted: Cloud Run runs `UMS_MODE=sandbox` (owner statement), so the dry run branch never runs there; `payoutPort` is null in sandbox mode and the PayPal path stays closed by the two key approval. The hosted database holds no `publisher_paypal_links` row for demo publishers unless a publisher claimed an account and asked for one (cannot be read from here; the demo publishers are persona sign ins without an account, so none is expected).
- `publisher_paypal_links`: `verified_by text`, `verified_at timestamptz`, both set exactly when `state = 'verified'` (CHECK). No FK to an operator. Real operator ids are `opr_<name>` with `name` in `[a-z][a-z0-9_]{0,31}`, so `seed:synthetic` (a colon) can never be a real operator id. Ops lists show only the masked address (`d***@payee.invalid`) and the state.

Goal: with `environment = 'dryrun'` the boot seed inserts, for each demo publisher that has no link row, one row `demo-<slug>@payee.invalid`, state `verified`, `verified_by = 'seed:synthetic'`, `verified_at` = the injected clock at seed time, plus one audit row. An existing row (any state) is never touched, so a second boot adds nothing and a real address survives. In any other environment, and in tests unless `test_seed.demo_links: true`, the seed writes nothing. Defence in depth: `isSyntheticPayee(email, verified_by)` (address ends `.invalid`, or marker `seed:synthetic`) is checked when payouts are created and in `prepare`; in environment `sandbox` such a payee is refused with reason `synthetic_payee`: at creation the unit is skipped and one `payout_failed` alert `payout_refused_<unit>_synthetic_payee` is raised; at send the payout is not sent, alert `payout_refused_<payout>_synthetic_payee`, and a `due` payout is cancelled like `no_payee` (a `sending` one is never cancelled). The alert copy is added next to the other `payout_refused_` causes (D-051: no dashes, no italics).

Inputs: `docs/specs/` pob specs, `domain/payments/src/payout.ts`, `domain/catalogue/src/paypal-link.ts`, `apps/web/composition.server.ts` seed, `domain/catalogue/src/seed-data.ts` (publisher slugs). Env vars: none new.

Outputs: `packages/contracts/src/payout.ts`, `apps/web/composition.server.ts` (`seedDemoPaypalLinks`, `test_seed.demo_links`), `domain/payments/src/payout.ts`, `domain/alerts/src/catalogue.ts`, tests: `apps/web/src/demo-links.state.test.ts`, `domain/payments/src/payout.synthetic.state.test.ts`, additions to `packages/contracts/src/payout.test.ts`, the export list in `packages/contracts/src/index.test.ts` and `domain/alerts/src/catalogue.golden.test.ts`.

Acceptance tests:

- `corepack pnpm vitest run --project state apps/web/src/demo-links.state.test.ts`: dry run boot gives every demo publisher exactly one synthetic verified `.invalid` link, unique, marked `seed:synthetic`, stamped with the clock; two more boots add nothing and keep a replaced address; sandbox mode boot creates no link; a dry run order for Harbour Ledger reaches a due payout to `demo-harbour-ledger@payee.invalid` that the dry run port confirms.
- `corepack pnpm vitest run --project state domain/payments/src/payout.synthetic.state.test.ts`: in environment `sandbox` a synthetic link creates no payout and raises the new alert once; a synthetic payee on a stored payout is refused at send (port not called); the same link in `dryrun` is paid.
- `corepack pnpm vitest run --project golden domain/alerts/src/catalogue.golden.test.ts` and `--project contract packages/contracts/src/payout.test.ts`: new cause text without dashes, and the predicate.
- Unchanged and green: `payout.state.test.ts`, `payout.crash.state.test.ts`, `apps/web/src/payouts.state.test.ts`, `apps/web/src/pob-journey.state.test.ts`, `de-corridor.state.test.ts`, `publisher-link.state.test.ts`.
- `lint`, `typecheck`, `format:check`, `check:isolation`, `check:no-live-host`, `check:routes`, `check:secrets-names`: exit 0.

Do not: touch other packages, add a link state or a migration, mark anything verified by an operator id, insert approval rows or touch outbound access, set `payee_shared`, run the seed in sandbox mode, add a dependency.

Evidence for the PR: red run of commit 1, green run of commit 2, the file list.

Review notes (Opus review, 2026-11-07):

- Labels: a verified link that `isSyntheticPayee` flags reads "Demo address. Not a real PayPal account." on the publisher page and the ops access line, never "Checked by an operator."; the flag is derived from data in `ownPaypalLink` and `listPublisherAccess`. Payout guards are `environment !== 'dryrun'` (fail closed). The seed call is wrapped like `applyDemoPrices` (`demo_links.failed` warning, boot continues).
- Note, offline with Postgres: the seed runs for `UMS_MODE=offline` on any database, so an offline app pointed at a shared Postgres would also get the synthetic links; they are `.invalid`, refused by sandbox payouts, and never overwrite an existing row.
- Note, account claim: a demo publisher that later claims an account and requests an address now has a link row, so in dry run that request clears `payee_verified_at` until an operator verifies it (the existing rule for a changed address); before this change a first request left it alone.

Branch: `feat/web-demo-paypal-links` Commit: `feat(web): synthetic dry run payee links for demo publishers (POB-DEMOLINK)`
