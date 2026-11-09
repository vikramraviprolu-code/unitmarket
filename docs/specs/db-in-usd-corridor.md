# Spec: an enabled India corridor in USD (COR-IN)

Task: let a publisher whose payee country is India price and sell in USD, to buyers outside India only.
Package: `packages/db` (one migration) and tests in `domain/offer-entry`, `domain/catalogue`, `apps/web`. Owner: builder (Sonnet). Reviewer: Sakthi.
Branch: `feat/db-in-usd-corridor` Commit: `type(db): <what> (COR-IN)`. Decision: owner words in the session, 9 Nov 2026: "go on the India corridor, outside india buyers only".

Goal: today one corridor is enabled, `us-usd` (payee US). A publisher with country `IN` gets "We cannot set prices for your country yet", for the web import and for a hand made offer. After this lane, an `IN` publisher can import or create offers in USD, a buyer outside India can approve and pay for them (dry run and sandbox), and a buyer in India cannot. Nothing else changes.

Inputs: `packages/db/migrations/common/0001_core.sql` (the `us-usd` row, the pattern to follow), `0032_*` (the latest migration, take the next free number on main at the time you start, planned 0033), `domain/catalogue/src/corridors.ts` (`corridorFor`), `domain/offer-entry/src/start.ts` (the `domestic_supported` refusal), `domain/catalogue/src/import-stage.ts` (price kept only when the site currency equals the corridor currency), `domain/approval/src/approval.ts` (`payee_countries` check).

Behaviour:
- Migration `0033_in_usd_corridor.sql` (forward only, no down step, no defaults) inserts one row into `corridors`: id `in-usd`, currency `USD`, minor_units 2, buyer_countries `ARRAY['*']`, payee_countries `ARRAY['IN']`, domestic_supported `false`, min_charge_minor NULL, enabled true, created_at and updated_at `1970-01-01T00:00:00Z` as in 0001. Use `ON CONFLICT (id) DO NOTHING`. Do not change any other corridor row.
- "Outside India only" is enforced by `domestic_supported = false`: `domain/offer-entry/src/start.ts` already refuses a buyer whose country equals the publisher's country. A test must prove it for IN.
- No code change is expected. If a test shows one is needed, stop and report it before changing money or approval code.

Tests first (commit 1 holds only tests and data, run red): `packages/db/src/migration-0033.state.test.ts` (the row, exactly; every other corridor row unchanged; us-usd still enabled; gb-gbp and de-eur still disabled), `domain/catalogue/src/corridors-in.state.test.ts` (`corridorFor` for USD, payee IN, buyer US and buyer null returns in-usd; for payee US returns us-usd), `domain/offer-entry/src/in-corridor.state.test.ts` (an IN publisher's offer: a US buyer may start, an IN buyer is refused), `domain/catalogue/src/import-in.state.test.ts` (an IN publisher imports a page whose price currency is USD: the price is kept and staged in USD; a page in EUR keeps no price), and one dry run purchase in `apps/web` (IN publisher with a verified payee, a US buyer approves and pays, access opens, the label says Dry run). Edit any existing test that lists corridors and say so in the PR; never loosen one to pass.

Acceptance (run, paste output):
- `corepack pnpm vitest run packages/db/src/migration-0033 domain/catalogue/src/corridors-in domain/offer-entry/src/in-corridor domain/catalogue/src/import-in`: red for commit 1, all pass after.
- `corepack pnpm lint`, `typecheck`, `format:check`, `check:routes`, `check:isolation`, `check:no-live-host`, `check:secrets-names`, and the six suites: pass.
Do not: touch payments, ledger, transport, paypal, safety or the approval code; change the us-usd row; add a dependency; put an email, a payee id or a secret in a test other than synthetic ones; add live PayPal anything.
Evidence for the PR: the red run, the green run, the check outputs, the list of existing tests edited.
Deploy note for the PR body: this migration needs a Cloud SQL backup first, then a human deploy. No agent deploys.
