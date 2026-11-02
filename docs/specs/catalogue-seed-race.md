# Spec: two simultaneous boots can both seed the catalogue (D-045 follow-up, SEED-RACE)

Task: `seedCatalogue` (and `seedSupplement`, which calls it) and `seedAgreements` read whether a row exists and then insert it, so two boots on an empty database can both insert, and the second stops with `publishers_slug_key` or `publisher_agreements_publisher_id_terms_version_key`.
Package: `domain/catalogue` (`src/seed.ts`) Owner: coordinator Reviewer: Vikram
Branch: `feat/catalogue-seed-race` Commit: `fix(catalogue): seed takes a transaction lock so two boots do not race (SEED-RACE)`

Found by: `tests/mvp-c-pg/pg-wiring.integration.test.ts`, "two apps booting at the same moment on one fresh database both come up", on real Postgres 16. It failed in 1 of 4 runs on 2 Nov (D-073). The hosted database is already seeded and Cloud Run runs one instance, so the live app is not exposed; this closes the gap D-045 left open.

Goal: each boot seed transaction that looks up then inserts (`seedCatalogue`, `seedAgreements`) first takes a transaction-scoped advisory lock (`pg_advisory_xact_lock`, one fixed key for the catalogue seed). A second boot waits, then finds the rows the first one wrote and inserts nothing. Behaviour on an already seeded database, the counts returned, and every row written are unchanged.

Inputs: `domain/catalogue/src/seed.ts`, `domain/catalogue/src/agreements.ts`.
Outputs: those two files and a small shared helper `domain/catalogue/src/seed-lock.ts`; a new test `domain/catalogue/src/seed-lock.state.test.ts`.

Found while proving the first fix: with the lock only in `seedCatalogue`, runs 4 and 7 of 8 failed on the agreements insert instead. Steps that already write with `ON CONFLICT` or with a guarded `UPDATE` (personas, payees) do not need the lock.

Acceptance tests:

- `corepack pnpm exec vitest run --project state domain/catalogue/src/seed-lock.state.test.ts`: fails before the change (the first statement of a seed transaction is not the lock, for both functions), passes after.
- `corepack pnpm exec vitest run domain/catalogue` passes unchanged.
- On real Postgres: `UMS_TEST_PG_BIN=/usr/lib/postgresql/16/bin corepack pnpm exec vitest run tests/mvp-c-pg/pg-wiring.integration.test.ts` passes 20 runs in a row (it failed 1 in 4 before).
- `corepack pnpm lint`, `typecheck`, `format:check`, `check:isolation` pass.

Do not: change what is seeded, the payee seed (`seedSandboxPayees`), migrations, or any money, safety or transport code; add a dependency.
Evidence: red then green output, and the 20 runs.
