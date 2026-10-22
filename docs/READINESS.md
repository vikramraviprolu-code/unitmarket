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

## Wave 2 review D fixes (FIX-W2D)

### For 05a/05b

All changes below are additive. A caller that ignores them still compiles.

- Contract: `CapturedPart.amount: Money` (capture amount as PayPal reports it) on `OrderReadUnit.capture` and `CaptureRead.capture`. 05a must compare `unit.capture.amount` with `unit.amount` (currency and minor) before it marks a unit `captured_verified`. A 5.00 USD unit with a 500.00 EUR capture maps cleanly and is the payments lane's to refuse. A capture without a readable amount now reads as `unavailable` (malformed).
- Refunds: take refunded amounts from GET refund (05b). Treat `capture.refunded_minor` as advisory: PayPal may report 0 there for a refunded capture. Every get_order and get_capture call record carries `refunded_advisory=use_get_refund` in its outcome.
- Capture body id: `captureOrder` now returns `unavailable` when the 201/200/207 body id differs from the requested order id; payments reads back as for any unavailable claim.
- OAuth: a throwing transport now maps to `timeout` in the token cache.
- Amount strings: `007.50`, `.5`, `00` are refused (`bad_amount`).
- Approval: `verifyApproval` check order is now hash and reader, token, owner (404), expiry (410), used (409). A wrong buyer always gets `not_owner`. A row whose `snapshot.reader.buyer_id` differs from `buyer_id` is `snapshot_tampered`. `canonicalJson` throws on a string, boolean or object under a `_minor` key, formats arrays under one, and NFC-normalises strings and keys; do not put free text under a key ending `_minor`.
- Access clock: `recordDeliveryEvent` returns `WindowState & { inserted: boolean }`. Only `link_issued` is once per link (`inserted: false` on a replay); `download_completed`, `delivery_failed`, `delivery_restored`, `reader_rendered`, `download_aborted` and `reader_beacon` are repeatable, so a caller that retries must not assume a retry is deduplicated. `grantCredit` has a new error code `window_ended` (recovery lane 10 should surface it). Migration `0008_access_events_unique.sql` adds `access_events.seq`; events order by `(at, seq)`.
- Receipts: debug ids come only from `capture_order` and `refund_capture` provider calls; buyer-sourced events, `reader_beacon` and `link_issued` are excluded from the receipt body. `renderReceiptHtml(r, label?)` derives the label from `r.environment` and throws on a contradicting label.
- Ledger: a replay of an existing `(capture, kind, refund_id)` key with a different amount or currency throws `LedgerRuleError('conflicting_replay…')`; the same money still returns `duplicate`. 05b must treat the throw as a programmer error and alert.
- M12 from review 4 (`already_owned` and a locked entitlement with a capture in flight; payee needs `payee_verified_at` and a merchant id) stays with 05a.
- Concurrency tests (ledger, entitlements, access clock) run on PGlite, which is single-connection: they prove the SQL ordering and constraints, not Postgres lock behaviour. The sweep lock order (entitlement, then window) is asserted from the query log; a real Postgres run belongs to the PORT-1 CI job.
- Migration 0007 (links.session_id) is added by FIX-W2C; the migration-name test in `packages/db` checks the first six names and `0008` by name so either merge order passes.

`aiEnabled(switches)` and `readSafetyStatus(db, now, ref)` now exist in `@umsbx/safety` (FIX-W2C M11). Lane 15 calls `aiEnabled(deps.switches)` before any model call; it fails closed. The three `pnpm safety:*` scripts exist (`scripts/safety-cli.mjs`, run through `scripts/lib/ts-register.mjs`).

## For 05a/05b (FIX-W2C changes to shared surfaces)

All changes are additive; existing exports keep their signatures.

- **Budget is reserved inside the gate (H3).** `createOutboundGate(...).check()` now reserves one call of the approval's daily budget when it returns `allowed: true` (one `audit_log` row, action `gate.reserve`, target `approval_ref`, written under a row lock on the approval). Call `check()` once per outbound request, and only when the request will be sent. A refused check reserves nothing. The count is per `approval_ref` and per UTC day; `provider_calls` rows no longer count (ASM-02-2 is replaced). `max_amount_minor` stays a per-order cap checked in the same call. New exports: `reservedToday`, `readSafetyStatus`, `aiEnabled`, `MAX_APPROVAL_VALIDITY_MS`.
- **`setSwitch` (M10).** Any switch change needs an `operator` actor; turning `paypal_outbound` on also needs `mfa: true` and an active `outbound_approvals` row for `approval_ref` (new error codes `operator_required`, `approval_not_active`). `runStop` accepts operator actors only. `runApprove` refuses `valid_until` more than 30 days ahead.
- **`withRoute` (M7, M8).** `SecurityDeps.trusted_proxies?: number` (default 0) and `RouteCallContext.remote_addr?: string`. **The composition must pass the socket address as `remote_addr` in the second argument of every route call**, and set `trusted_proxies` to the number of reverse proxies in front (1 on Vercel-style hosting). Without either, every client without an address shares one limiter bucket, and `X-Forwarded-For` and `User-Agent` are ignored. The idempotency request hash now includes the real path and the merged params: a stored key from before this change does not replay.
- **Delivery (H2, M9).** `planServe` refuses (`store_unavailable`, with a `delivery_failed` event reason `content_hash_mismatch`) when the stored bytes' hash differs from the hash recorded at `access_ready` or the article's catalogue hash. `issueLink` and `planServe` take an optional `session_id`; a link issued with one is `not_found` in any other session. **Route handlers must pass `session_id` from the session record to both.** Migration `0007_links_session` adds `links.session_id` (nullable).
- **Lint (H1).** Inline `eslint-disable` comments are no longer honoured anywhere. Exceptions are by path in `eslint.config.mjs`. `node:module`, `node:child_process`, `node:worker_threads`, `node:vm` are barred outside `scripts/` and `packages/transport`; default and namespace imports of `node:crypto` and `node:process` are barred (import `createHash` and friends by name); `const g = globalThis`, `Reflect.get(globalThis, ...)`, `process.getBuiltinModule`, `Function(...)`, `eval` and a non-literal `require()` are errors. A payments file that needs `node:crypto` hashing must be added to `HASH_ONLY` in `eslint.config.mjs`.
- **Guards (M4, M5, M6).** `check:isolation` fails on any symlink in the repository, on git or URL dependencies and on `npm:` aliases to the forbidden scopes. `check:no-live-host` flags every host under the two PayPal registrable names except the sandbox subdomains and the developer documentation host, folds concatenations and `join` calls, and bars string methods on `SANDBOX_API` (use `new URL(path, SANDBOX_API)`). Test files may still assemble host names from parts. `check:routes` requires every exported verb to be exactly `withRoute(routeMeta, ...)` and refuses `'use server'` anywhere under `apps/web`.

## Notes for 05a from review 4 (M12)

- `offer-entry` `already_owned` looks only at entitlements that are `available` or `running`. An entitlement that is `locked` with a capture in flight gets a fresh quote. Payments must dedupe: one open order per buyer and article, and refuse to create an order for an article whose entitlement is locked with a capture in flight.
- Payments must refuse a payee without `payee_verified_at` and `paypal_merchant_id` before creating an order; the catalogue does not filter them out.

## Lane 15b (web wired to the real payments engine)

- `composition.server.ts` binds `placeOrder`, `beginCheckout`, `onBuyerReturn` (05a), `checkInvariants`, `requestRefund`, `recoverOnStartup` (05b) and `startLoop`/`health` (`@umsbx/jobs`). `requestRefund` is passed to the recovery `ResolveDeps` (ASM-10-2); the engine exposes `resolveCase` for the operator.
- `instrumentation.ts` calls `app.startJobs()`: `recoverOnStartup` (awaited, so a boot that returns has read what was in flight), then `startLoop` with the window sweep and the recovery rules as its sweep; it stops on SIGTERM and SIGINT. `startLoop` runs due payments work only while `paypal_outbound` is on, so in a default dry run the loop sweeps windows and cases but does no reconcile polling.
- Dry run answers come from `apps/web/src/server/dryrun-model.ts`, an order model adapted from the testkit model with the behaviour of the lane 03 fixture scenarios (`happy`, `capture_202`, `pending_receiving_pref`, `pending_then_completed`, `lost_capture_response`, `declined`, `mismatch_amount`, `mismatch_payee`). Fixtures cannot serve the web app: they carry fixed amounts, ids and payee. The model's state lives in the process; with a `pglite-disk` database an order from an earlier run reads as unknown at the pretend PayPal. Refund calls are not modelled (`blocked: dry_run_miss`).
- The pretend approval is `GET /checkout/return?ref=..&scenario=..` in dry run only (`engine.dryRunApprove`, buyer-owned orders in `awaiting_buyer`). The scenario selector on `/checkout/dry-run/[order]` lists `engine.dryRunScenarios()`.
- Delivery links are bound to the session: `engine.sessionIdOf(cookie, actor)` gives the session id, the link route and `/c/[token]` pass it to `issueLink` and `planServe`.
- Not adopted: `remote_addr`. Next.js route handlers get no socket address and `withRoute(...)` is fixed to the exact form `check:routes` pins, so the second argument cannot carry it. `trusted_proxies` is 0, so X-Forwarded-For is never read and every client shares one `no-address` ip bucket (the passcode limiter is then global). Needs either a proxy count in `packages/config` or a decision to allow a wrapper in the route inventory.
- Checkout has its own rate bucket (`checkout`, 5 per minute per actor); before, it drew from the `order` bucket, so one purchase cost two tokens.

## Lane 05a review fixes (FIX-05A)

Branch `fix/05a-review`. Decisions: D-014 in `docs/decision-log.md`.

- **Migration 0009** (`entitlements_one_active_per_buyer_article`): a buyer holds one entitlement per article while its money is pending, unknown or captured and its access is locked or available. The migration refuses to run with a clear error if such duplicates already exist. 0008 (access events unique) is on main and merged here; the schema test checks 0001 to 0007 by position and 0008 and 0009 by name.
- **`placeOrder`** answers `already_owned` (409) when any article of the approval is held (also when locked, also while an order is in flight) and `payee_unavailable` (409) when a publisher's merchant id changed or lost `payee_verified_at` since the approval. Neither consumes the approval. `startFromOffer` uses the same held set for `already_owned`.
- **Capture answers** (`captureOnce`, `retryCapture`) change the order only from `capture_requested`. Lock order is order, then operation, everywhere.
- **Pre-gate**: a return takes a short lease on the capture operation row before its pre-capture read. A `prepared` capture row with `first_sent_at` null can therefore exist before any capture; it means nothing was sent.
- **Unit in `mismatch`**: the order is `frozen` (with an alert), never `failed`. A definitive capture refusal (`rejected`, `invalid_request`) with no capture on the read closes the order as `failed` (not charged).
- **M1 done**: `matchReadback` compares the captured amount and currency with the unit (mismatch, field `amount`; the contract has no separate `capture_amount` field, a change request if wanted) and `apply.ts` books the sale from the captured amount.
- **For owners**: a `PARTIALLY_REFUNDED` verified unit can still start a not-started window after the unlock switch is turned back on (kept: the buyer paid and keeps what was not refunded; the refund path in 05b revokes access when the refund covers the whole unit).

## MVP-A gate (lane 18)

Branch `feat/mvp-a-gate`. Verdict and evidence: `docs/evidence/mvp-a-gate-2026-10-22.md`. The state of a lane below is what the gate observed through public entry points, not a claim that nothing else is needed.

| Lane                            | Gate state                                                              | Acceptance ids exercised    |
| ------------------------------- | ----------------------------------------------------------------------- | --------------------------- |
| 02 config and safety            | ready, one low finding (F-1: A-01 wording is wider than the boot check) | A-01, A-03                  |
| 03 transport and fixtures       | ready                                                                   | A-02, A-04, A-23            |
| 04 PayPal adapter               | ready                                                                   | A-23, A-24                  |
| 06 approval                     | ready                                                                   | A-05, A-08, A-09            |
| 07 entitlements and clock       | ready                                                                   | A-12, A-18, A-19            |
| 08 ledger and receipts          | ready                                                                   | A-12, A-13, A-21, A-22      |
| 09 delivery                     | ready                                                                   | A-17, A-18                  |
| 10 recovery and library         | ready                                                                   | A-11, A-13, A-16, A-19      |
| 11 security                     | ready                                                                   | A-20 (HTTP)                 |
| 12 runtime, obs, db             | ready                                                                   | A-21                        |
| 14a catalogue and offer entry   | ready                                                                   | A-05, A-06, A-07            |
| 05a payments order and capture  | ready                                                                   | A-10 to A-17                |
| 05b payments reconcile and jobs | ready                                                                   | A-14                        |
| 15, 15b web                     | ready                                                                   | A-20, A-22, A-25 and PERF-2 |
| 16 testkit                      | ready                                                                   | A-24                        |

Known deviations the gate carries (each is stated elsewhere in this file; none is closed by the gate):

- No `remote_addr`: every client shares one `no-address` ip bucket and `trusted_proxies` is 0 (lane 15b note).
- Refund calls are not modelled in the dry-run order model (`blocked: dry_run_miss`); refunds are exercised by the payments lane tests only.
- The dry-run model keeps its state in the process; an order from an earlier run on a `pglite-disk` database reads as unknown.
- Concurrency tests run on PGlite (one connection): they prove SQL ordering and constraints, not Postgres lock behaviour (PORT-1 CI job).
- The RLS spike covers a subset of tables and runs on PGlite only.
- The contract has no separate `capture_amount` mismatch field (change request if wanted).
- A `PARTIALLY_REFUNDED` verified unit can still start a not-started window after the unlock switch is turned back on.
- No sandbox recording exists: every fixture is `docs-example` or `synthetic`.
- `@vitest/coverage-v8` is not on the approved list, so MAINT-6 (branch coverage on money modules) is unmeasured.
- A-10 says the create operation is `prepared` when the provider call starts; the engine has moved it to `sent` by then (lease taken). The gate accepts either state.
- `pnpm audit --prod` reports two high and two moderate postcss advisories through `next` (finding F-2 in the gate report).

## Payments second-pass fixes (FIX-PAY2)

Branch `fix/payments-pass2`. Decisions: D-018, D-019, D-020 in `docs/decision-log.md`. Findings: Opus second-pass review at main 7345ad4.

- **H-1 capture claim.** The claim transaction stores the read-back operation (`ensureReadbackOp`) together with `capture_claimed`. A process that dies between the claim and the post-capture read is finished by the poll. New invariant INV5: every order in `capture_requested`, `capture_claimed` or `unresolved` has an operation that is `sent` or `unknown` (or gave up with `failed`, `window_expired` after the 24 h window, which raised an alert).
- **H-2, M-1 refunds.** `refund_readback` (`umsRB-<request id>`) is created in the transaction that stores `pending`. Refund operations are looked up by their own request id, never per order. New invariant INV6: every open refund request (`sent`, `unknown`, `pending`) has an operation that is `sent` or `unknown`. A refund operation no longer switches off the 7 day re-read of a paid order.
- **M-2 `refunded_minor`.** Booking needs GET refund `COMPLETED` and the capture status `PARTIALLY_REFUNDED` or `REFUNDED`; the reported total is used only when it is above 0. `observeReadback` acts on the capture status first. A request that cannot be proven not refunded ends `unresolved` (reservation kept, alert), not `failed`. The test world reports `refunded_minor` 0 by default (`reportRefunded`). **Not done:** the refunded AMOUNT of a dashboard refund is not booked, because the PayPal port has no call that lists the refunds of a capture (`packages/paypal` and `packages/contracts` are outside this task). The unit ends `refunded` and access is revoked for a full refund; a partial dashboard refund raises `refund_unbooked` for a human. A change request for a `listRefunds(capture_id)` adapter method with fixtures is the next step.
- **M-3 lock order.** Documented below, applied to every money path, pinned by `lockorder.state.test.ts` (a spy on the SqlExecutor asserts the order of the locks of each transaction). `withSerializationRetry` (`packages/db/src/retry.ts`) retries 40P01 and 40001 up to 3 times; it is in the path of the PGlite driver and will be for the pg adapter.
- **LOW.** Startup recovery skips operations whose lease is still running and runs once per process (`startLoop` option `recover_on_start`, composition passes `false`); `nextDueAt` wakes the loop when a `sent` lease runs out. Capture re-send refusals close the capture as failed (D-018). The D-014 cap counts keys. Event ordering uses `seq` (INV4, recovery cases). `GET /checkout/return` starts the capture only for a page navigation (`Sec-Fetch-Dest: document`, `Sec-Fetch-Mode: navigate`); anything else gets a confirm button. A cross-site top-level navigation (which is also how PayPal returns the buyer) cannot be told from a hostile link by headers; it is harmless because the return only captures an order the buyer already approved at PayPal and the order reference is not guessable. The confirm button is a GET form (a page navigation), because server actions are barred by `check:routes`; a client that sends no Sec-Fetch headers at all cannot pass. `observeReadback` and `suspectReversal` lock the unit row before changing it.

### Lock order

Every transaction that moves money takes its row locks in this order, and a statement on a class already locked in the same transaction takes nothing new:

1. `orders` (and `provider_orders`), then every `operations` row of that order (`lockOrderRows` in `domain/payments/src/store.ts`);
2. `order_units`;
3. `refund_requests`;
4. `entitlements` (with `access_windows`, `access_events`);
5. `ledger_entries`, `receipts`.

Alerts, audit and provider-call rows are leaf inserts and are not part of the order. PGlite serialises all statements, so a deadlock cannot be reproduced here. **Real-Postgres race tests (concurrent capture/poll/refund/sweeper on one order, with the pg adapter) are required before MVP-C.**
