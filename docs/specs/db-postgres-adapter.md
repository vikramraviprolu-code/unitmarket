# Spec: Postgres adapter for the database port (PG-1)

Task: add a node-postgres driver behind the existing `Database` port, so the app and its migrations run on a real Postgres 16 (Cloud SQL now, Supabase later) with the behaviour they have on PGlite.
Package: `packages/db` Owner: PG-1 builder Reviewer: Opus, one round (D-048)
Branch: `feat/db-postgres-adapter` Commit: `feat(db): <what> (PG-1)` Decisions: D-049, D-050, D-014, D-020.

Goal: `UMS_DB=postgres` with `DATABASE_URL` gives a pooled, transactional `SqlDriver` (target `postgres`) that passes the same contract tests as the PGlite driver. All migrations apply on a real Postgres 16, twice-safe and race-safe. PGlite stays the default and its behaviour does not change.

Inputs: `packages/db/src/{driver,pglite,migrate,retry,reset,testing,index}.ts`, `packages/contracts` (`Database`, `SqlExecutor`), `packages/config/src/load.ts` (the `postgres` kind and `DATABASE_URL` already exist; the URL is a secret value), `packages/db/migrations/common/0001..0011`, docs/design/architecture.md section 9, `docs/READINESS.md` (lock order; real-Postgres race tests required before the app stays live).
Outputs: `packages/db/src/pg.ts` (driver), `packages/db/src/pg-testing.ts` (test-only throwaway Postgres under `UMS_TEST_PG_BIN`, default `/usr/lib/postgresql/16/bin`: `initdb` in a temp dir, random port, unix socket or localhost, removed after), `driver.ts` (`DbTarget` gains `{ kind: 'postgres' }`), `index.ts` (export), `packages/db/package.json` and the lockfile (`pg` and `@types/pg`, exact versions, D-050), the repo's approved-dependency allow-list citing D-050, tests below. Touch `packages/config` only if the postgres target cannot reach `openDatabase` without it.

Requirements:

1. Interface parity with `pglite.ts`: `query`, `transaction` (one pooled client per transaction, BEGIN/COMMIT/ROLLBACK, rollback on throw, the isolation level the callers ask for), `close`, `target`. Pool size configurable, default 5. No lock file (the single-opener lock is PGlite only).
2. `DATABASE_URL` forms: `postgres://u:p@host:5432/db?sslmode=require` and the Cloud SQL socket form `postgres://u:p@/db?host=/cloudsql/PROJECT:REGION:INSTANCE`. The URL, user and password never appear in a log, error message, stack or test output (redact; add a test that throws on a bad URL and greps the message).
3. Session settings the code relies on (`SET LOCAL ums.*`, role settings, `ums.allow_reset`, `ums.db_target`) behave as on PGlite. `resetDatabase` (tests only) keeps refusing a non-disposable target; for `postgres` it needs `confirm: 'RESET_TEST_DATABASE'` and a database whose name starts with `ums_test_`.
4. `withSerializationRetry` retries 40001 and 40P01 on this driver (existing code; prove it with a real forced conflict).
5. `migrate()` on Postgres holds a session advisory lock for the whole run, so two processes booting together apply each migration once. A migration that fails on real Postgres is a STOP-AND-REPORT with the exact error: do not edit a shipped migration file.
6. Statement and connection timeouts set from named options with safe defaults (statement 30 s, connect 10 s); `application_name` = `umsbx`.

Acceptance tests (run; paste output):

- `corepack pnpm exec vitest run --project contract packages/db` and the PGlite state tests: unchanged and green.
- `UMS_TEST_PG_BIN=/usr/lib/postgresql/16/bin corepack pnpm exec vitest run --maxWorkers=2 packages/db/src/pg`: one shared contract suite runs against PGlite and real Postgres: commit and rollback; two parallel transactions with a forced 40001 retried to success; advisory lock mutual exclusion; `SET LOCAL` visible only inside the transaction; `migrate()` twice leaves one row per version; two concurrent `migrate()` calls leave one row per version and no error; the DP-1 `ums_publisher_payee_guard` trigger refuses REPEATABLE READ and the payee-shared rule on real Postgres; redaction test; socket-form URL parses.
- The existing state, integration and contract suites that open a database through the test world, run once against real Postgres through an env switch you add in the testing helper (`UMS_TEST_DB=postgres`), report pass and fail counts per suite and list every failing test with its first error line. Do not fix failures outside `packages/db`; they go to PG-2.
- `pnpm lint`, `typecheck`, `format:check`, `check:isolation`, `check:no-live-host`, `check:secrets-names`, `tests/mvp-b/sealed-callers.test.ts`.

Do not: touch other packages (except the allow-list and, if needed, `packages/config`); add any dependency but `pg` and `@types/pg`; change a migration or a contract; contact any network or PayPal; read or create a secret; run mutation checks beyond 20 minutes in total (D-048).
Evidence for the PR: the commands above with output, the per-suite pass and fail table for the real-Postgres run, the list of failures handed to PG-2, a cost line (runs, rounds, approximate tokens).
