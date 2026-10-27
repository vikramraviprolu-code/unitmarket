# Spec: Postgres wiring, loop leader and real-Postgres race tests (PG-2)

Task: make the app run on `UMS_DB=postgres`, guard the job loop with a Postgres leader lock, and prove the money paths under real concurrency on Postgres 16.
Package: `apps/web` (composition only), `packages/db`, `packages/jobs`, `scripts` (safety CLI), tests Owner: PG-2 builder Reviewer: Opus, one round (D-048)
Branch: `feat/db-postgres-wiring` Commit: `feat(db): <what> (PG-2)` Decisions: D-014, D-020, D-045, D-048, D-049, D-050. Parent lane: PG-1 (merged, `packages/db/src/pg.ts`).

Goal: a Cloud Run instance with `UMS_DB=postgres` boots, migrates, serves, runs one job loop at a time, and the safety CLIs work through a TCP or socket URL. The ASM-55 waiver (D-045) is retired for the paths tested here.

Time cap 90 minutes. Do the items in this order and STOP when the time is up; report what is done and what is not. Items 1 to 3 are required; 4 to 6 only if time remains.

1. Wiring. `apps/web/composition.server.ts` (about line 539 throws "postgres is not wired in MVP-A"): reveal the config secret and call `openDatabase({ kind: 'postgres', url })`; boot runs `migrate` (advisory lock already in PG-1); no URL in any log. Add `pg` to `serverExternalPackages` in `apps/web/next.config.mjs`. A boot test on a throwaway Postgres (use the PG-1 helper `pg-testing.ts`) with `UMS_DB=postgres`: boots, `/healthz` ok, one dry-run purchase completes. `safety:status`, `safety:stop`, `safety:resume`, `safety:approve` open the database through the same config path with `UMS_DB=postgres`; prove `safety:status` and one approval-row insert against the throwaway server, and that the running app's gate sees a row inserted by another process without a restart.
2. Loop leader. In `packages/jobs` (postgres only, PGlite unchanged): the loop body runs only while this process holds a session-level `pg_try_advisory_lock` on a dedicated non-pooled connection; otherwise it retries every few seconds; the lock is released on shutdown, and a dropped lock connection stops the loop at once and re-elects. Tests with two processes or two loop instances on one database: only one runs a pass; killing the leader hands over within a bounded time. The per-process call gap and poll allowance stay as they are.
3. Race tests on real Postgres (new files under `tests/mvp-c-pg/`, run only when `UMS_TEST_PG_BIN` is set): concurrent capture, poll, refund and sweeper on one order (C-12 and D-020 lock order, many seeds, N at least 20 rounds): one transition, one sale, no deadlock left unretried, INV1 to INV7 hold after each round; two loops without the leader lock do not double-send a capture (PayPal-Request-Id is deterministic). Fix the test artifact the PG-1 review found: `domain/entitlements/src/refund-access.adversarial.test.ts` "refund first" assumes array order equals commit order; derive the expected `credit_ms` from the observed event order (2 h only if `credit_granted` precedes `revoked`). This is the only existing test you may edit; say so in the commit.
4. PG-1 LOW fixes: `pg.ts` throw if COMMIT returns command `ROLLBACK`; pass `ssl: false` and `options` explicitly so `PGSSLMODE` and `PGOPTIONS` cannot change the session; a lint rule or test that no production file in `packages/db` imports `./pg-testing`.
5. Audit and report (do not rewrite) every use of `db` instead of `tx` inside a `transaction(fn)` callback (PG-1 L9: on PGlite it joins the transaction, on pg it is a second connection that can block).
6. `tests/mvp-c/c-offline.adversarial.test.ts` fails under `UMS_TEST_DB=postgres` because the offline guard blocks the driver's unix-socket connect: allow only the throwaway test server's socket path when the switch is on; the C run stays offline otherwise.

Acceptance tests (run; paste output):

- `UMS_TEST_PG_BIN=/usr/lib/postgresql/16/bin corepack pnpm exec vitest run --maxWorkers=2 tests/mvp-c-pg packages/jobs packages/db apps/web/src/postgres` (names yours), green, with the race rounds count in the output.
- Default PGlite path unchanged: `pnpm lint`, `typecheck`, `format:check`, `test:unit`, `test:contract`, `check:isolation`, `check:no-live-host`, `check:secrets-names`, `check:routes`, `check:hosting`, `check:hosting-gcp`, `tests/mvp-b/sealed-callers.test.ts`.
- DISK: the machine disk is nearly full. Run `df -h /` before heavy steps; stop and report under 400 MB free. Delete only throwaway directories you created.

Do not: add a dependency; touch a migration or a contract; contact any network or PayPal; read or create a secret; run mutation checks; edit an existing test other than the one named above.
Evidence for the PR: commands with output, rounds run, what was not done, a cost line (runs, rounds, approximate tokens).
