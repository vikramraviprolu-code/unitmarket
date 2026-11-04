# INT-TR0: transaction journal (trace spine)

Task: Record every change to a money, delivery, agent-cap or control row in one append-only, hash-chained journal, with who, when and from where.
Package: `packages/db` (migration, wrapper, verifier), `packages/contracts` (new `trace.ts`), `packages/obs` (context store), entry points listed below. Owner: Vikram. Builder: Sonnet 5.5 high. Reviewer: Opus 5.5 gate thread.
Items: TR0.1 to TR0.6, 20 points (plan section 5). Needs decision V1.

## Goal

After this lane, any insert or update of a tracked row writes one `trace_events` row in the same transaction, by trigger, with the old and new value of each tracked column, the actor, the channel and a hash linking it to the previous row of its chain. A missing actor is recorded as `unattributed` and fails an invariant. `pnpm trace:verify` recomputes every chain, seal and source digest and names the first broken row. Existing rows are backfilled as `imported`. No application call site of `db.transaction` changes.

## Design (fixed by the plan, section 3)

- Tables: `trace_context`, `trace_events` (PK `chain_key, seq`), `trace_heads`, `trace_seals` with columns as in plan 3.3. No `DEFAULT`, no `now()`: `occurred_at` comes from the source row's `updated_at` (or the column named per table in the capture config); seq from the head row.
- Tracked tables and columns are one SQL config table `trace_tracked (table_name, columns text[], time_column, chain_expr)` seeded by the migration and mirrored by a golden list in `packages/contracts/src/trace.ts`. Updates that change no tracked column write nothing (for example `operations.lease_until`).
- Tracked: `approvals`, `orders`, `provider_orders`, `order_units`, `operations`, `provider_calls`, `webhook_events`, `refund_requests`, `ledger_entries`, `receipts`, `entitlements`, `access_windows`, `links`, `access_events`, `recovery_cases`, `recovery_actions`, `alerts`, `audit_log`, `mandates`, `mandate_reservations`, `api_keys`, `safety_switches`, `outbound_approvals`, `publishers` (status, payee columns), `offers` (status), `payee_decisions`, `publisher_applicant_decisions`.
- Chain key: `ord:<order_id>` when the row resolves to an order; else `mdt:`, `pub:`, `buy:`, `key:`, or `plat`. Lock order: entity chain before order chain.
- Hash: `sha256(convert_to(prev_hash||'|'||chain_key||'|'||seq||'|'||occurred_at||'|'||actor_kind||'|'||coalesce(actor_id,'')||'|'||event_type||'|'||body::text,'UTF8'))`, built-in `sha256()`. Genesis `prev_hash` = 64 zeros. Inserts into append-only tables carry `source_digest = sha256(row_to_json(NEW)::text)` in the body.
- Context: `withTraceContext(ctx, fn)` and `currentTraceContext()` in `packages/obs/src/trace-context.ts` (AsyncLocalStorage). `withTraceDb(db, get)` in `packages/db/src/trace-db.ts` wraps `transaction` to run `SELECT set_config('ums.trace', $1, true)` first, and runs a bare `query` that writes inside a one-statement transaction when a context is set. Composition wires the getter. Entry points that open a context: `packages/security/src/route.ts` (`withRoute`: actor from the principal, `req_id`, `ip_hash`, `ua_family`, API key id, agent buyer and mandate), `packages/jobs/src/loop.ts` (one context per pass, actor system, job name), `apps/web/src/server/webhook.ts` (actor `paypal`, channel webhook), `apps/web/src/app/api/v1/mcp/dispatch.ts` (inherits from `withRoute`, adds the tool name), `packages/safety/src/cli-*.ts` and `scripts/accounts-cli.mjs` (channel cli), the seed (channel seed).
- `ua_family` is one of `browser`, `curl`, `sdk`, `other`, derived from the User-Agent; the raw string is never stored.

## Outputs (only these files)

New: `packages/db/migrations/common/00NN_trace_journal.sql` (next free number at merge, planned 0023), `packages/db/src/trace-db.ts`, `packages/db/src/trace-verify.ts`, `packages/db/src/trace-backfill.ts`, `packages/contracts/src/trace.ts`, `packages/obs/src/trace-context.ts`, `scripts/trace-verify.mjs`, tests below, `docs/specs/int-tr0-journal.md`. Changed (minimal): `packages/contracts/src/index.ts` (export), `packages/obs/src/index.ts` (export), `packages/db/src/index.ts` (export), `packages/db/src/export-sql.ts` (`checkInvariants` adds INV-T1 chain intact and INV-T2 no unattributed rows after seed), `packages/security/src/route.ts`, `packages/jobs/src/loop.ts`, `apps/web/src/server/webhook.ts`, `apps/web/src/app/api/v1/mcp/dispatch.ts`, the CLI entry files named above, `apps/web/composition.server.ts` (wire `withTraceDb`, one block), `package.json` (`trace:verify` script), `docs/decision-log.md` (row for V1), `docs/PROVENANCE.md` if needed.

## Acceptance tests (commit 1: tests only, run red)

| Item | Test file | Command | Expected |
|---|---|---|---|
| TR0.1 | `packages/contracts/src/trace.golden.test.ts` | `pnpm test:golden -- trace` | Golden list of tracked tables, columns and event types matches `trace_tracked` after migration |
| TR0.2 | `packages/obs/src/trace-context.test.ts`, `packages/db/src/trace-db.state.test.ts`, `tests/int/trace-entrypoints.integration.test.ts` | `pnpm test:state -- trace-db` ; `pnpm test:integration -- trace-entrypoints` | A buyer web request, an agent MCP buy, a job pass, a webhook and a CLI stop each produce journal rows with the right `actor_kind`, `channel`, `req_id`; nested contexts do not leak across concurrent requests (100 interleaved promises) |
| TR0.3 | `packages/db/src/migration-00NN.state.test.ts`, `packages/db/src/trace-capture.state.test.ts` | `pnpm test:state -- trace-capture` | For each tracked table: insert writes one event; update of a tracked column writes one event with `[old,new]`; update of an untracked column writes none; UPDATE, DELETE and TRUNCATE on `trace_events`, `trace_context`, `trace_seals` raise |
| TR0.4 | `packages/db/src/trace-verify.state.test.ts`, `scripts/trace-verify.test.ts` | `pnpm trace:verify` on a seeded offline DB | Exit 0, prints chains, rows, seals checked; INV-T1 and INV-T2 empty |
| TR0.5 | `packages/db/src/trace.adversarial.test.ts`, `packages/db/src/pg.trace-race.integration.test.ts`, `packages/db/src/trace-pii.adversarial.test.ts`, `packages/db/src/trace-perf.state.test.ts` | `pnpm test:adversarial -- trace` ; `pnpm test:integration -- trace-race` | With triggers disabled (test target only): editing a ledger amount, editing a journal body, deleting a journal row and swapping two seqs are each reported with chain and seq; a write with no context gives `unattributed` and INV-T2 lists it; canary names, emails and IPs in requests appear nowhere in `trace_events` or `trace_context`; two writers on one chain and the cap-plus-order agent buy finish with no deadlock and a valid chain (50 runs); seeded order flow p95 grows under 5 ms |
| TR0.6 | `packages/db/src/trace-backfill.state.test.ts` | `pnpm test:state -- trace-backfill` | On a DB exported before the migration: every order, refund, mandate and switch gets one `imported` event; second run adds nothing; verify passes |

Mutation: `pnpm mutation --target packages/db/src/trace-verify.ts --target packages/db/src/trace-db.ts --target packages/obs/src/trace-context.ts --test-cmd "pnpm vitest run packages/db packages/obs"`, at least 80 percent each.

## Do not

Touch domain packages or any `db.transaction` call site; add a dependency or a Postgres extension; store names, emails, raw IPs or User-Agent strings; change `event_outbox` or webhooks; weaken an existing guard trigger; call PayPal.

## Evidence for the PR

Red run of commit 1; green `corepack pnpm run ci`; `pnpm trace:verify` output; the race test output on real Postgres; p95 before and after; mutation report; one sample order timeline as JSON (sanitised ids).

Branch: `feat/int-tr0-journal`. Commit: `feat(db): transaction journal with hash chain and context capture (INT-TR0)`.
