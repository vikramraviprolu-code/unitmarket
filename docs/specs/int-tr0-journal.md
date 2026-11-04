# INT-TR0: transaction journal (trace spine), round 2

Task: Record every change to a money, delivery, agent-cap or control row in one append-only, hash-chained journal, with who, when and from where.
Package: `packages/db` (migration, wrapper, verifier, export/import), `packages/contracts` (new `trace.ts`), `packages/obs` (context store), the entry points listed below. Builder: Sonnet 5.5 high. Reviewer: Opus 5.5 gate thread.
Items: TR0.1 to TR0.6, 20 points (plan section 5). Decision V1, logged as D-094. Round 2 answers `tr0-scorecard.md` F1 to F15.

## Goal

After this lane, any insert or update of a tracked row writes one `trace_events` row in the same transaction, by trigger, with the old and new value of each tracked column, the actor, the channel and a hash linking it to the previous row of its chain. A write with no context is stored with `actor_kind = 'unattributed'`, and invariant INV-T2 fails on it. Rows that exist before the migration are journaled once by the migration itself as `system`/`backfill` events (TR0.6). `pnpm trace:verify` recomputes every chain, head, seal, source digest and current tracked value, and names the first broken row. No application call site of `db.transaction` changes.

## Design

**Tables** (migration, no `DEFAULT`, no `now()`):
- `trace_context (id, at, channel, actor_kind, actor_id, on_behalf_of, mandate_id, mfa, req_id, ip_hash, ua_family, api_key_id, job, tool)`. It is append-only and prunable after 13 months: the delete guard honours `ums.allow_reset` and a `ums.trace_prune` setting used only by a later pruning job.
- `trace_events (chain_key, seq, prev_hash, row_hash, occurred_at, actor_kind, actor_id, on_behalf_of, mandate_id, mfa, ctx_id, channel, event_type, source_table, source_id, order_id, unit_id, mandate_ref, publisher_id, buyer_id, body jsonb)`, with PK `(chain_key, seq)`. `ctx_id` has no foreign key, so pruning `trace_context` never touches a chain.
- `trace_heads (chain_key, seq, row_hash)`, `trace_seals (id, at, root_hash, prev_root_hash, heads jsonb)`, and `trace_tracked (table_name, columns text[], digest_columns text[], hashed_columns text[], time_column, chain_expr)`.
- UPDATE, DELETE and TRUNCATE on `trace_events`, `trace_seals` and `trace_context` raise through the existing `ums_deny_mutation` and `ums_deny_truncate` functions (0001), so `resetDatabase` keeps working.

**Enums** (in `trace.ts` and as CHECKs):
- `actor_kind`: `buyer`, `publisher`, `operator`, `agent`, `api_client`, `system`, `paypal`, `unattributed`.
- `channel`: `web`, `api`, `mcp`, `job`, `webhook`, `cli`, `seed`, `backfill`.

**Tracked columns: the allow-list (F4).** `trace_tracked` and the golden list in `packages/contracts/src/trace.ts` are the only source; nothing else is copied. Ids, states, amounts, currencies, booleans and times are copied as values. Columns in `hashed_columns` are stored only as `sha256` hex of their text, never as text.

| Table | Copied | Hashed only | Time column | Chain |
|---|---|---|---|---|
| approvals | `content_hash`, `used_at`, `expires_at`, `environment` | `snapshot` | `updated_at` | `buy:` buyer |
| orders | `status`, `total_minor`, `currency`, `corridor_id`, `order_ref`, `environment` | `expected` | `updated_at` | `ord:` id |
| provider_orders | `status`, `state`, `provider_order_id`, `publisher_id`, `position`, `first_approved_at` | none | `updated_at` | `ord:` order_id |
| order_units | `status`, `amount_minor`, `platform_fee_minor`, `paypal_fee_minor`, `refunded_minor`, `capture_id`, `captured_verified_at`, `status_reason`, `mismatch_reason` | `payee_merchant_id` | `updated_at` | `ord:` order_id |
| operations | `kind`, `state`, `attempt`, `failure_reason` | none | `updated_at` | `ord:` order_id |
| provider_calls | `operation`, `method`, `http_status`, `outcome`, `debug_id`, `transport_kind` | `request_redacted`, `response_redacted` | `created_at` | `ord:` via operation |
| webhook_events | `event_id`, `type`, `verified`, `outcome`, `applied_at` | `resource` | `received_at` | `ord:` when resolvable, else `plat` |
| refund_requests | `amount_minor`, `currency`, `state`, `refund_id`, `capture_id`, `requested_by` | `reason` | `updated_at` | `ord:` via unit |
| ledger_entries | `kind`, `amount_minor`, `currency`, `capture_id`, `refund_id`, `ref_entry_id` | none | `created_at` | `ord:` via unit |
| receipts | `version`, `sha256` | `body` | `created_at` | `ord:` order_id |
| entitlements | `money_state`, `access_state`, `licence_state`, `article_id`, `unit_id` | `option`, `policy` | `updated_at` | `ord:` via unit |
| access_windows | `state`, `started_at`, `ends_at`, `paused_at`, `credit_ms` | none | `updated_at` | `ord:` via entitlement |
| links | `expires_at`, `uses` | none (`token_hash` not copied) | `updated_at` | `ord:` via entitlement |
| access_events | `kind`, `at`, `source`, `seq` | `evidence` | `at` | `ord:` via entitlement |
| recovery_cases | `kind`, `state`, `order_id`, `sla_due_at`, `credit_ms`, `opened_by` | `buyer_message` | `updated_at` | `ord:` order_id |
| recovery_actions | `action`, `actor` | `detail` | `at` | `ord:` via case |
| alerts | `kind`, `order_id`, `unit_id` | `detail` | `created_at` | `ord:` or `plat` |
| audit_log | `actor_kind`, `actor_id`, `action`, `target` | `reason`, `detail` | `created_at` | `plat` |
| mandates | `max_total_minor`, `max_count`, `max_per_purchase_minor`, `expires_at`, `revoked_at`, `spent_minor`, `used_count`, `exhausted_at` | none | `updated_at` | `mdt:` id |
| mandate_reservations | `amount_minor`, `state`, `order_id`, `settled_at` | none | `settled_at`, else `ums.trace.at` | `mdt:` until `order_id` is set, then `ord:` |
| api_keys | `key_kind`, `scopes`, `revoked_at` (`last_used_at` untracked) | none | `ums.trace.at` (insert: `created_at`) | `key:` id |
| safety_switches | `on`, `changed_at` | `reason`, `changed_by` | `changed_at` | `plat` |
| outbound_approvals | `scope`, `operations`, `max_amount_minor`, `max_calls_per_day`, `valid_until` | `approved_by` | `updated_at` | `plat` |
| publishers | `status`, `payee_verified_at`, `payee_shared` | `paypal_merchant_id` | `updated_at` | `pub:` id |
| offers | `status` | none | `updated_at` | `pub:` publisher_id |
| payee_decisions, publisher_applicant_decisions | `decision`, `operator_id` | `reason` | `created_at` | `pub:` via request or publisher |

When the named time column is absent or unchanged on an update, `occurred_at` is the `at` value in `ums.trace`, set from `deps.clock` (F14). Untracked: `entitlements.transition_log`, `api_keys.last_used_at`, `operations.lease_until`, `idem_safe_until`, `next_retry_at`, `reconcile_until`. An update that changes no copied or hashed column writes nothing.

**Hash (F6, F7).**
- `row_hash = sha256(convert_to(trace_canon(row), 'UTF8'))`. `trace_canon` is one SQL function: the `jsonb` of every `trace_events` column except `row_hash`, rendered with `jsonb::text` (keys sorted by jsonb). `occurred_at` is inside it as `to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`. So `mfa`, `on_behalf_of`, `mandate_id`, `ctx_id`, `source_*` and the subject keys are all covered.
- Genesis `prev_hash` is 64 zeros. The function is the built-in `sha256()`, with no extension.
- Inserts into the append-only tables (`ledger_entries`, `receipts`, `access_events`, `audit_log`, `recovery_actions`, `provider_calls`, `payee_decisions`, `publisher_applicant_decisions`) carry `source_digest` in `body`. This is sha256 over `jsonb_build_object` of the frozen `digest_columns` list, using the same time format, not `row_to_json(NEW)`. A later column added to the table does not change it.
- `trace:verify` recomputes all hashes **in SQL** (`trace_verify()` function), so driver date parsing cannot drift.

**Seals (F10).** TR0 defines `trace_seal(at)`, which writes one `trace_seals` row. The row holds `heads` (every chain's `chain_key, seq, row_hash`), `root_hash = sha256(prev_root_hash || heads::text)` and `prev_root_hash`. TR1 only schedules the call. Verify checks: each `trace_heads` row equals the last row of its chain; each seal's root recomputes; each sealed head still exists with the same hash. So tail truncation is caught once a seal covers it. Before the first seal, a truncated tail with a rewound head is not detectable; the spec accepts this, and TR1's daily seal closes it.

**State drift (F8).** For each tracked row, verify compares the current value of each copied column (and the sha256 of each hashed column) with the latest journaled value for that row. A mismatch is reported as `drift <table> <id> <column>`. This catches edits made with triggers disabled.

**Context.**
- `withTraceContext(ctx, fn)` and `currentTraceContext()` live in `packages/obs/src/trace-context.ts` (AsyncLocalStorage).
- `withTraceDb(db, get)` in `packages/db/src/trace-db.ts` sets `ums.trace` for every write while a context is set (F13). It wraps `transaction` so `SELECT set_config('ums.trace', $1, true)` runs first. A bare `query` or `exec` runs inside a one-statement transaction that does the same. Without a context, calls pass through unchanged, and the capture trigger records `unattributed`.
- `ums.trace` JSON: `{ctx_id, at, actor_kind, actor_id, on_behalf_of, mandate_id, mfa, channel}`. The `trace_context` row is inserted once per context, on its first write.

**Entry points (F2, F3).**

| Entry point | Context |
|---|---|
| `packages/security/src/route.ts` `withRoute` | actor from principal, `req_id`, `ip_hash`, `ua_family`, `api_key_id`, agent buyer as `on_behalf_of`, mandate |
| `apps/web/src/app/api/v1/mcp/dispatch.ts` | inherits from `withRoute`, adds `tool` |
| `packages/jobs/src/loop.ts` | one context per pass, actor `system`, channel `job`, job name |
| `apps/web/src/server/webhook.ts` | actor `paypal`, channel `webhook` |
| `scripts/lib/safety-cli-main.mjs`, `scripts/lib/privacy-main.mjs`, `scripts/lib/accounts-cli-main.mjs` | channel `cli`, actor `operator` with id `cli:<os user hash>` |
| the boot-seed block and the demo-seed block in `apps/web/composition.server.ts` | channel `seed`, actor `system` |

`packages/safety` stays barred from `@umsbx/obs` (`eslint.config.mjs:1303`); the CLI context opens in `scripts/lib`. `packages/security` and `packages/jobs` gain a workspace edge to `@umsbx/obs` in `package.json` and `pnpm-lock.yaml`. This is not a new dependency under D-008. `ua_family` is one of `browser`, `curl`, `sdk`, `other`; the raw User-Agent is never stored.

**Backfill (F1).** The last statement of the migration calls `trace_backfill()`. It writes one `<table>.imported` event per existing tracked row, with actor `system`, channel `backfill` and `occurred_at` from the row's time column, in id order per chain. It runs inside the migration transaction, so no app write can land before it. A second call adds nothing (it skips rows that already have an event). INV-T2 counts only rows with `actor_kind = 'unattributed'`.

**Lock order (F11).** No trigger-level lock order is claimed. Cap-plus-order paths are serialised by the existing `SELECT ... FROM mandates FOR UPDATE` (`domain/mandates/src/reserve.ts:77,96`). When `attachOrder` sets `order_id`, the reservation's next event goes to `ord:<order_id>`, and its earlier events stay on `mdt:`. The race test proves there is no deadlock.

**Restore and reset (F12).** `importSql` (`export-sql.ts`) runs `set_config('ums.trace', '{"mode":"restore"}', true)` before loading rows. The capture function returns early in that mode, so imported state rows are not journaled twice and imported `trace_events` keep their seqs. `expectedTriggers` and `guardProblems` list the new triggers. Reset truncates through the existing `ums.allow_reset` path.

## Outputs (only these files)

New:
- `packages/db/migrations/common/00NN_trace_journal.sql` (next free number at merge, planned 0023)
- `packages/db/src/trace-db.ts`, `packages/db/src/trace-verify.ts`
- `packages/contracts/src/trace.ts`, `packages/obs/src/trace-context.ts`
- `scripts/trace-verify.mjs`
- the tests below

Changed:
- `packages/contracts/src/index.ts`, `packages/obs/src/index.ts`, `packages/db/src/index.ts` (exports)
- `packages/db/src/export-sql.ts` (INV-T1 chains intact, INV-T2 no unattributed rows, restore mode, new triggers in `expectedTriggers`)
- `packages/security/src/route.ts`, `packages/security/package.json`
- `packages/jobs/src/loop.ts`, `packages/jobs/package.json`, `pnpm-lock.yaml`
- `apps/web/src/server/webhook.ts`, `apps/web/src/app/api/v1/mcp/dispatch.ts`
- `scripts/lib/safety-cli-main.mjs`, `scripts/lib/privacy-main.mjs`, `scripts/lib/accounts-cli-main.mjs`
- `apps/web/composition.server.ts` (wire `withTraceDb`, plus the two seed blocks)
- `package.json` (`trace:verify` script)
- `docs/decision-log.md` (D-094 for V1)

## Acceptance tests (commit 1: tests only, run red)

| Item | Test file | Command | Expected |
|---|---|---|---|
| TR0.1 | `packages/contracts/src/trace.golden.test.ts` | `pnpm vitest run packages/contracts/src/trace.golden.test.ts` | Golden list (table, copied, hashed, digest columns, time column, chain) equals `trace_tracked` after migration |
| TR0.2 | `packages/obs/src/trace-context.test.ts`, `packages/db/src/trace-db.state.test.ts`, `apps/web/src/trace-entrypoints.integration.test.ts` | `pnpm vitest run packages/obs/src/trace-context.test.ts packages/db/src/trace-db.state.test.ts apps/web/src/trace-entrypoints.integration.test.ts` | A buyer web request, an agent MCP buy (with `on_behalf_of` and `mandate_id`), a job pass, a webhook, a safety CLI stop, a `privacy:delete` and the seed each produce rows with the right `actor_kind`, `channel` and `req_id`; a bare `exec` under a context is attributed; 100 interleaved promises never mix contexts |
| TR0.3 | `packages/db/src/trace-capture.state.test.ts` | `pnpm vitest run packages/db/src/trace-capture.state.test.ts` | For each tracked table: an insert writes one event; an update of a copied column writes `[old,new]`; an update of an untracked column writes none; UPDATE, DELETE and TRUNCATE on `trace_events`, `trace_context` and `trace_seals` raise; reset with `ums.allow_reset` still works; adding a column to `ledger_entries` in the test then verifying still passes |
| TR0.4 | `packages/db/src/trace-verify.state.test.ts`, `packages/db/src/trace-restore.state.test.ts` | `pnpm vitest run packages/db/src/trace-verify.state.test.ts packages/db/src/trace-restore.state.test.ts`, then `pnpm trace:verify` on the offline seeded DB (`UMS_DB_TARGET=offline`) | Exit 0, prints chains, rows, seals and drift checked; INV-T1 and INV-T2 empty. Export, import and verify pass, with no duplicate `(chain_key, seq)` |
| TR0.5 | `packages/db/src/trace.adversarial.test.ts`, `packages/db/src/trace-pii.adversarial.test.ts`, `packages/db/src/pg.trace-race.integration.test.ts`, `packages/db/src/trace-perf.state.test.ts` | `pnpm vitest run packages/db/src/trace.adversarial.test.ts packages/db/src/trace-pii.adversarial.test.ts packages/db/src/trace-perf.state.test.ts`, then `UMS_TEST_PG_BIN=$(pg_config --bindir) pnpm vitest run packages/db/src/pg.trace-race.integration.test.ts` | With triggers disabled (test target only), each of these is reported with chain and seq: editing a ledger amount; editing a journal body; flipping `mfa` and `on_behalf_of`; deleting a mid-chain row; swapping two seqs; deleting a sealed tail and rewinding its head (from a hand-written seal fixture). `orders.status` and `mandates.spent_minor` edited with triggers off are reported as drift. A write with no context is listed by INV-T2. Canary text in a refund reason, a switch reason, a case message, request names and IPs appears nowhere in `trace_events` or `trace_context` (only its sha256). The race file: two writers on one chain and the cap-plus-order agent buy run 50 times each with no deadlock and a valid chain. **A skip is a fail**: output shows 50 runs per case. Seeded order flow p95 grows under 5 ms |
| TR0.6 | `packages/db/src/trace-backfill.state.test.ts` | `pnpm vitest run packages/db/src/trace-backfill.state.test.ts` | On a DB built to the previous migration with seeded orders, refunds, mandates and switches, migrating writes one `system`/`backfill` `<table>.imported` event per tracked row; calling `trace_backfill()` again adds nothing; INV-T2 is empty; verify passes |

Mutation: `pnpm mutation --require-targets --targets packages/db/src/trace-verify.ts,packages/db/src/trace-db.ts,packages/obs/src/trace-context.ts --test-cmd "pnpm vitest run packages/db packages/obs" --threshold 80`.

## Safety

Offline only. No PayPal call, no change to `packages/transport`, `packages/paypal` or `endpoints.ts`, no secret. The gate runs `pnpm check:no-live-host`, `pnpm check:secrets-names`, `pnpm check:isolation` and the offline proof in `pnpm run ci`.

## Do not

Touch domain packages or any `db.transaction` call site. Add a dependency or a Postgres extension. Store free text, names, raw IPs or User-Agent strings. Change `event_outbox` or webhooks. Weaken an existing guard trigger. Open a context inside `packages/safety`.

## Evidence for the PR

Red run of commit 1; green `corepack pnpm run ci`; `pnpm trace:verify` output; race output on real Postgres showing 50 runs; p95 before and after; mutation report; one sample order chain as JSON (sanitised ids).

Branch: `feat/int-tr0-journal`. Commit: `feat(db): transaction journal with hash chain and context capture (INT-TR0)`.
