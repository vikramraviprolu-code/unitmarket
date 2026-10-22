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

`aiEnabled(switches)` and `readSafetyStatus(db, now, ref)` now exist in `@umsbx/safety` (FIX-W2C M11). Lane 15 calls `aiEnabled(deps.switches)` before any model call; it fails closed. The three `pnpm safety:*` scripts exist (`scripts/safety-cli.mjs`, run through `scripts/lib/ts-register.mjs`).

## For 05a/05b (FIX-W2C changes to shared surfaces)

All changes are additive; existing exports keep their signatures.

- **Budget is reserved inside the gate (H3).** `createOutboundGate(...).check()` now reserves one call of the approval's daily budget when it returns `allowed: true` (one `audit_log` row, action `gate.reserve`, target `approval_ref`, written under a row lock on the approval). Call `check()` once per outbound request, and only when the request will be sent. A refused check reserves nothing. The count is per `approval_ref` and per UTC day; `provider_calls` rows no longer count (ASM-02-2 is replaced). `max_amount_minor` stays a per-order cap checked in the same call. New exports: `reservedToday`, `readSafetyStatus`, `aiEnabled`, `MAX_APPROVAL_VALIDITY_MS`.
- **`setSwitch` (M10).** Any switch change needs an `operator` actor; turning `paypal_outbound` on also needs `mfa: true` and an active `outbound_approvals` row for `approval_ref` (new error codes `operator_required`, `approval_not_active`). `runStop` accepts operator actors only. `runApprove` refuses `valid_until` more than 30 days ahead.
- **`withRoute` (M7, M8).** `SecurityDeps.trusted_proxies?: number` (default 0) and `RouteCallContext.remote_addr?: string`. **The composition must pass the socket address as `remote_addr` in the second argument of every route call**, and set `trusted_proxies` to the number of reverse proxies in front (1 on Vercel-style hosting). Without either, every client without an address shares one limiter bucket, and `X-Forwarded-For` and `User-Agent` are ignored. The idempotency request hash now includes the real path and the merged params: a stored key from before this change does not replay.
- **Delivery (H2, M9).** `planServe` refuses (`store_unavailable`, with a `delivery_failed` event reason `content_hash_mismatch`) when the stored bytes' hash differs from the hash recorded at `access_ready` or the article's catalogue hash. `issueLink` and `planServe` take an optional `session_id`; a link issued with one is `not_found` in any other session. **Route handlers must pass `session_id` from the session record to both.** Migration `0007_links_session` adds `links.session_id` (nullable).
- **Lint (H1).** Inline `eslint-disable` comments are no longer honoured anywhere. Exceptions are by path in `eslint.config.mjs`. `node:module`, `node:child_process`, `node:worker_threads`, `node:vm` are barred outside `scripts/` and `packages/transport`; default and namespace imports of `node:crypto` and `node:process` are barred (import `createHash` and friends by name); `const g = globalThis`, `Reflect.get(globalThis, ...)`, `process.getBuiltinModule`, `Function(...)`, `eval` and a non-literal `require()` are errors. A payments file that needs `node:crypto` hashing must be added to `HASH_ONLY` in `eslint.config.mjs`.
- **Guards (M4, M5, M6).** `check:isolation` fails on any symlink in the repository, on git or URL dependencies and on `npm:` aliases to the forbidden scopes. `check:no-live-host` flags every paypal.com or paypalobjects.com host except `*.sandbox.paypal.com` and `developer.paypal.com`, folds concatenations and `join` calls, and bars string methods on `SANDBOX_API` (use `new URL(path, SANDBOX_API)`). Test files may still assemble host names from parts. `check:routes` requires every exported verb to be exactly `withRoute(routeMeta, ...)` and refuses `'use server'` anywhere under `apps/web`.

## Notes for 05a from review 4 (M12)

- `offer-entry` `already_owned` looks only at entitlements that are `available` or `running`. An entitlement that is `locked` with a capture in flight gets a fresh quote. Payments must dedupe: one open order per buyer and article, and refuse to create an order for an article whose entitlement is locked with a capture in flight.
- Payments must refuse a payee without `payee_verified_at` and `paypal_merchant_id` before creating an order; the catalogue does not filter them out.
