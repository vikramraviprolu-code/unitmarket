# Lane 12: runtime ports, logging and redaction, PGlite database with migrations

Task: real clock and ids, the logger with redaction and the audit sink, the database driver (PGlite now, `pg` later) and the complete MVP-A schema.
Package: `packages/runtime`, `packages/obs`, `packages/db` Owner: Sonnet worker W-12 Reviewer: Opus 5.5 ($ money lane for the schema)
Wave: 1 (needs lane 01 F1 for port types). Size: 8 h (runtime and obs 2 h, driver and runner 2 h, schema 4 h). Single owner of the database schema: every table change after merge is a schema change request to this lane's reviewer.

## Goal
Every domain lane in wave 2 finds its tables already migrated, with the constraints that make races and tampering fail in the database. Timestamps always come from the clock port. Logs never carry secrets or personal data.

## Inputs
- Architecture sections 5, 8, 9.9; nfr.md P12, OBS-1, OBS-2, REL-5, PORT-1.
- Lane 01 F1 types: `Clock`, `Ids`, `IdPrefix`, `Logger`, `LogEvent`, `AuditSink`, `AuditEntry`, `Database`, `SqlExecutor`, `Secret`.
- Copy and adapt (`/home/user/AIC_Hackathon_UnitMarket` at `a36ddc03fd0b962000f686291c145b50ee337f90`): `packages/db/src/migrate.ts` (runner, one transaction per file, clock-stamped `schema_migrations`), `packages/db/src/database.ts` (`asDatabase`, `resetDatabase` with the `um.allow_reset` guard renamed `ums.allow_reset`), `packages/db/migrations/0001_init.sql` (domains, `um_deny_mutation` trigger, unique open-order partial index, entitlement CHECKs), `0102_truncate_guards.sql`, `0103` (alerts unique with `NULLS NOT DISTINCT` on `detail->>'reason'`).
- Dependencies: `@electric-sql/pglite` (approved). `pg` is approved for later; do not add it in this lane.

## Outputs
- `packages/runtime/src/{system-clock.ts, crypto-ids.ts, fake-clock.ts, seeded-ids.ts, index.ts}`.
- `packages/obs/src/{logger.ts, redact.ts, audit.ts, index.ts}`.
- `packages/db/src/{driver.ts, pglite.ts, migrate.ts, reset.ts, export-sql.ts (skeleton: list tables in FK order), index.ts}`; `packages/db/migrations/common/0001_core.sql` ... `0006_platform.sql`; `packages/db/migrations/supabase/0001_roles_rls.sql` (written, not run in MVP-A).

## Interfaces (exposed)
```ts
// runtime
export function systemClock(): Clock;
export function cryptoIds(): Ids;                       // node:crypto randomBytes; base32 Crockford lowercase
export function fakeClock(startIso: IsoUtc): Clock & { advance(ms: number): void; set(iso: IsoUtc): void };
export function seededIds(seed: string): Ids;           // deterministic, for tests only
// obs
export function createLogger(sink: (line: string) => void, base: LogEvent['fields']): Logger;
export function redact(value: unknown): unknown;        // by key and by pattern, see below
export function createAuditSink(ids: Ids, clock: Clock): AuditSink; // inserts into audit_log
// db
export type DbTarget = { kind: 'pglite-memory' } | { kind: 'pglite-disk'; dir: string };
export function openDatabase(t: DbTarget): Promise<Database & { close(): Promise<void> }>;
export function migrate(db: Database, clock: Clock, set?: 'common' | 'supabase'): Promise<string[]>;
export function resetDatabase(db: Database): Promise<void>;   // tests only
export function tablesInDependencyOrder(db: Database): Promise<string[]>;
```
Redaction keys (case-insensitive, anywhere in nested objects): `authorization`, `access_token`, `refresh_token`, `client_secret`, `client_id`, `secret`, `password`, `passcode`, `cookie`, `set-cookie`, `payer`, `email_address`, `email`, `name`, `given_name`, `surname`, `address`, `phone`, `payer_id`, `paypal-transmission-sig`. Patterns: bearer tokens, `A21AA[A-Za-z0-9_-]{20,}`, email addresses. Replacement `[redacted]`; emails become `sha256:<first 12 hex>`.

## Schema (common set; every table has `id ums_id PRIMARY KEY`, `created_at timestamptz NOT NULL`, `updated_at timestamptz NOT NULL`; no `now()` defaults; money and evidence tables add `environment text NOT NULL CHECK (environment IN ('dryrun','sandbox'))`)
- `0001_core.sql`: domains `ums_id`, `ums_minor` (integer >= 0), `ums_currency`, `ums_sha256`; function `ums_deny_mutation()`; `corridors` (id, currency, minor_units, buyer_countries text[], payee_countries text[], domestic_supported, min_charge_minor null, enabled); `publishers` (slug unique, display_name, country, paypal_merchant_id unique null, payee_verified_at null); `articles` (publisher_id FK, title, abstract, language, topics text[], published_at, sha256, content_key unique, bytes, mime); `content_blobs` (content_key PK, sha256, mime, bytes, data bytea); `access_policies` (id, version, option CHECK in two values, window_ms, start_rule; unique (id, version)); `offers` (id, version, publisher_id, article_id, status, currency, options jsonb, affordability jsonb, terms_version, rights jsonb, valid_from, valid_until, superseded_by; unique (id, version)); `publisher_authorisations` (offer_id, offer_version, authorised_by, at; append-only trigger).
- `0002_buyers.sql`: `buyers` (display_name, auth_subject unique, country); `consents` (buyer_id, kind, text_version, granted_at, revoked_at); `identity_links` (buyer_id, provider, subject_hash, consent_id, revoked_at); `sessions` (actor_kind, actor_id, csrf_token_hash, created_at, last_seen_at, expires_at, revoked_at).
- `0003_entry.sql`: `briefs`, `proposals` (brief_id, buyer_id, items jsonb, fit jsonb), `quotes` (buyer_id null, offer_id, offer_version, option, price_minor, currency, corridor_id FK, source, expires_at).
- `0004_money.sql`: `approvals` (buyer_id, snapshot jsonb, content_hash, nonce unique, created_at, expires_at, used_at, environment; trigger: UPDATE allowed only setting `used_at` from null; DELETE refused); `orders` (approval_id unique, buyer_id, content_hash, order_ref unique, expected jsonb, status CHECK in the ten `OrderStatus` values, mismatch boolean, corridor_id FK, currency, total_minor, environment; trigger: currency equals the corridor's currency); unique partial index one open order per (buyer_id, content_hash) where status not in ('paid','paid_partial','failed','abandoned'); `provider_orders` (order_id, provider_order_id unique null, route CHECK in ('single','per_publisher'), approve_url null, status null); `order_units` (order_id, provider_order_ref FK provider_orders, publisher_id, reference_id, payee_merchant_id, amount_minor, platform_fee_minor CHECK = 0, capture_id unique null, status CHECK in the nine `UnitStatus` values, status_reason null, paypal_fee_minor null, refunded_minor default none (NOT NULL, app-supplied 0), captured_verified_at null, mismatch_reason null; unique (order_id, reference_id)); `operations` (order_id, unit_id null, kind CHECK, state CHECK, attempt, request_id unique, first_sent_at null, idem_safe_until null, lease_until null, next_retry_at null, reconcile_until null, failure_reason null; CHECKs copied from 0001 operations); `provider_calls` (operation_id null, operation, method, path_template, http_status null, outcome, debug_id null, duration_ms, transport_kind, request_redacted jsonb, response_redacted jsonb, environment; append-only); `webhook_events` (event_id unique, transmission_id unique, type, verified, outcome null, resource jsonb, received_at, applied_at null, environment); `refund_requests` (unit_id, capture_id, amount_minor null, currency, reason, requested_by, state, refund_id unique null); `ledger_entries` (unit_id, capture_id, kind CHECK, amount_minor, currency, refund_id null, ref_entry_id null, environment; unique (capture_id, kind, refund_id) NULLS NOT DISTINCT; append-only and truncate guard); `receipts` (order_id, version, body jsonb, sha256, environment; unique (order_id, version); immutable).
- `0005_access.sql`: `entitlements` (buyer_id, article_id, unit_id, option, policy jsonb, money_state CHECK, access_state CHECK, licence_state null CHECK, transition_log jsonb, environment; CHECK available implies money_state = 'captured'; CHECK licence not null iff money in captured, refunded, reversed; unique (unit_id, article_id)); `access_windows` (entitlement_id PK FK, state CHECK, started_at, base_ends_at, ends_at, paused_at, credit_ms >= 0); `access_events` (entitlement_id, kind CHECK, at, source, evidence jsonb, environment; append-only); `links` (entitlement_id, buyer_id, token_hash unique, expires_at, uses integer); unique (link_id, kind) on access_events where link_id present (store link_id inside a nullable column `link_id`).
- `0006_platform.sql`: `recovery_cases` (kind, state, order_id null, entitlement_id null, buyer_id null, opened_by, sla_due_at, credit_ms, buyer_message); `recovery_actions` (append-only); `alerts` (kind, order_id null, unit_id null, detail jsonb; unique copied from 0103); `api_idempotency` (key, actor_kind, actor_id, route, request_sha256, response jsonb; unique (actor_kind, actor_id, key)); `rate_buckets` (bucket_key PK, tokens, refilled_at); `audit_log` (append-only); `safety_switches` (name PK, on boolean, changed_by, changed_at, reason); `outbound_approvals` (approval_ref unique, scope, operations text[], max_amount_minor, max_calls_per_day, valid_until, approved_by; append-only). Seed rows: `safety_switches` all six names with `paypal_outbound` false; one `corridors` row `us-usd` enabled; two `access_policies` (`keep_retrieve` and `online_read`, version `1`, 432000000 ms).
- `supabase/0001_roles_rls.sql`: roles `ums_app`, `ums_worker` (no BYPASSRLS), `revoke all ... from anon, authenticated`, `ENABLE ROW LEVEL SECURITY` on every table, buyer and publisher policies via `current_setting('ums.actor_kind', true)` and `current_setting('ums.actor_id', true)` as listed in architecture 8.

## Acceptance tests
- `corepack pnpm vitest run --project unit packages/runtime packages/obs`: `fake clock moves only when told`; `crypto ids are 128-bit, prefixed, unique over 10k`; `redact removes every key and pattern above from a canary object` (P7, OBS-2); `logger output for a seeded token and email contains neither`.
- `corepack pnpm vitest run --project state packages/db`: `migrations apply on a fresh PGlite and again as a no-op`; `UPDATE and DELETE on ledger_entries, receipts, provider_calls, access_events, audit_log, outbound_approvals raise` (P12, A-21); `TRUNCATE refused without the reset setting`; `second open order for one buyer and hash violates the unique index`; `capture_id unique across units`; `ledger refuses a second (capture, refund, kind)`; `entitlement CHECK refuses available without captured`; `orders currency must equal the corridor currency`; `environment refuses 'live'` (P15); `tablesInDependencyOrder lists parents before children`; `pglite-disk survives close and reopen`.
- `RLS spike` (informational, not a gate): create role, `SET ROLE`, verify a policy denies a cross-buyer select on PGlite; record the result in `docs/READINESS.md`.

## Security and NFR gates
P12, P15, P16, OBS-1, OBS-2, PORT-1 (plain SQL, no extensions), REL-2 (all money state in the DB), SOP 3.

## Do not
Add `pg` or any other dependency; use `now()` or `DEFAULT` timestamps; write domain logic; touch other packages; connect to any network database; put credentials in tests.

Branch `feat/db-schema-runtime` Commit `feat(db): runtime ports, redaction, PGlite schema (SBX-A-12)`.
