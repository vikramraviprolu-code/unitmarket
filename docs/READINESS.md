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
