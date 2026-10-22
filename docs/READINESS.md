# Readiness

One row per lane. A file existing or a branch being open is not readiness.

| Lane                | State                                                | Note            |
| ------------------- | ---------------------------------------------------- | --------------- |
| 12 runtime, obs, db | built on branch feat/runtime-obs-db, awaiting review | RLS spike below |

## RLS spike (lane 12, informational, not a gate)

Question: does PGlite 0.5.10 enforce row-level security under `SET ROLE`?
Method: `packages/db/migrations/supabase/0001_roles_rls.sql` applied to a migrated in-memory PGlite, two buyers inserted, `SET ROLE ums_app`, `ums.actor_kind=buyer`, `ums.actor_id=buy_a`, `SELECT id FROM buyers`.
Result: the policy file applies without error, and the select returns only `buy_a`. PGlite enforces the policy under `SET ROLE`. The test is `packages/db/src/rls-spike.state.test.ts` (prints `RLS_SPIKE_RESULT`; never fails the suite).
Not covered: the full policy set against every table, and stock Postgres (CI job, PORT-1).

## Wave 1 review A fixes (FIX-W1A)

- Lane 02 (config and safety switches): the reader of `safety_switches` must treat a missing row as OFF. The database now refuses `DELETE` and `TRUNCATE` of that table (migration 0006), but a reader that finds no row for a name, for example in a database where the seed was removed by a test reset, must fail closed.
- Test resets: `resetDatabase` moved from the `@umsbx/db` root export to `packages/db/src/testing.ts` (package export `@umsbx/db/testing`). It refuses unless the driver reports an in-memory target, or the caller passes `confirm: 'RESET_TEST_DATABASE'` for a disposable disk database. The TRUNCATE guard in migration 0001 needs `ums.db_target` as well as `ums.allow_reset`, so a plain session setting no longer opens it. The ESLint rule S1 forbids deep imports (`@umsbx/*/*`), so another package that needs the reset must be given an exception or a testkit re-export by the owner of `eslint.config.mjs`. The nightly logical-export import in architecture section 9 must set both settings itself inside its import transaction.
- RLS: `packages/db/src/rls-spike.state.test.ts` now asserts the policy file under `SET ROLE ums_app` (publisher payee columns, authorisations, content blobs, buyer quotes, order and approval inserts).
## Discovery and the `ai_enabled` switch (note for lane 15)

Discovery must refuse when the `ai_enabled` switch is off, or fall back to a catalogue-only list.
Lane 15 wires the switch into the discovery route; until then the domain function does not read it.
