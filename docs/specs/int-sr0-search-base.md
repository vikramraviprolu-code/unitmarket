# INT-SR0: search foundation, round 2 (passed 11 of 12, with fixes R2-1 and R2-2)

Task: One transaction filter contract with role rules, plus the indexes and the read view it runs on.
Package: `packages/contracts` (`txn-query.ts`), `packages/db` (migration), new `domain/txn-search` (`@umsbx/txn-search`). Builder: Sonnet 5.5 high. Reviewer: Opus 5.5 gate.
Items: SR0.1 to SR0.5, 12 points. Decision V5 (decision-log row, next free id at merge, planned D-095). Source: search proposal sections 4 and 6, without `pg_trgm`. Round 2 answers `sr0-scorecard.md` findings 1 to 10. TR0 merges first.

## Goal

`TxnQuery` (F1 to F13, sort, keyset cursor) parses from a URL string map, and invalid values are dropped. `scopeQuery(principal, raw, parsed)` checks the role on the **raw keys** first. It returns a query that always pins the buyer or the seller, or throws a typed 400 `field_not_allowed`. `STATUS_GROUPS` and `statusGroupOf` define the six status words in one place. A migration adds the indexes listed below (no extension) and the `txn_rows` view. On real Postgres with 100,000 seeded lines, the four list shapes use their index and p95 stays under 50 ms.

## Contract (`packages/contracts/src/txn-query.ts`)

- Fields as in proposal 4.3. Arrays are comma lists (`status=paid,refunded`). `limit` is 1 to 100. `q` is at most 100 characters; a longer `q` is dropped.
- **F7 `buyer`** means a buyer id, or a `buyers.display_name` match (operator session only). No email exists to search (migration 0016).
- **Status groups (finding 1).** `STATUS_GROUPS` maps each group to `orders.status` and `order_units.status` values. `statusGroupOf(row, now)` gives one word per line by precedence: attention, refunded, part_refunded, paid, failed, in_progress. `now` comes from the injected Clock (S6). UI0 reads these words from contracts.

| Group | Rule on a `txn_rows` line |
|---|---|
| attention | order `unresolved` or `frozen`; or unit `mismatch` or `reversal_suspected`; or unit `pending` with `unit_updated_at < now - 1 hour` |
| refunded | unit `refunded` or `reversed` |
| part_refunded | unit `partially_refunded` |
| paid | unit `captured_verified` |
| failed | order `failed` or `abandoned`; or unit `declined` |
| in_progress | everything else (order `created`, `awaiting_buyer`, `capture_requested`, `capture_claimed`, `paid_partial` with unit `expected`; unit `pending` under 1 hour) |

## Role rules (`domain/txn-search/src/scope.ts`)

The check runs on the raw key set before values are parsed, so a bad value never hides a refusal (finding 5b).

| Principal | Pinned | Refused with 400 `field_not_allowed` (any value) |
|---|---|---|
| buyer session | `buyer_id = self` | `buyer`, `environment`, `flags` |
| agent key | `buyer_id = its buyer`, same as buyer (today's v1 answer shows the buyer's orders to its agent key) | `buyer`, `environment`, `flags` |
| publisher session | `publisher_id = self` | `buyer`, `seller` (other or self), `agent_key`, `environment`, `flags` |
| api_client, owner buyer or publisher | as that owner | as that owner |
| api_client, owner operator (`mfa: false`) | nothing | none, but `buyer` and `seller` accept opaque ids only (no name match) |
| operator session | nothing | none |

A buyer's `agent_key` is ANDed with the buyer pin, so another buyer's key gives zero rows. Sellers never get buyer columns: `sql.ts` selects from `SELLER_COLUMNS`, which leaves out `buyer_id`, `buyer_display_name`, `agent_key_id` and `mandate_id`.

**Text match.** `q` runs as `EXISTS (entitlements e JOIN articles a ... WHERE lower(a.title) LIKE '%' || $q || '%' ESCAPE '\')`. `$q` is lower-cased, then `\` is escaped first, then `%` and `_`. Parameters are always bound; nothing is concatenated into SQL.

## Cursor (`domain/txn-search/src/cursor.ts`, finding 4)

The cursor is base64url JSON `{v:'t1', s:<sort>, k:<sort value>, id:<unit_id>, h:<opaque string>}`. It never carries a buyer, seller or other scope value. `h` is filled by the caller (SR1 puts the query and principal hash there). A malformed or tampered cursor, a cursor whose `s` differs from the current sort, or an `h` mismatch throws 400 `bad_cursor`; none of these drops to page 1.

## View `txn_rows` (finding 6)

There is one row per `order_units` row. The view is created `WITH (security_invoker = true)`, which a state test checks on PGlite and Postgres (finding 10). App-level scope stays the main control.

| Column | Computed |
|---|---|
| `unit_id`, `order_id`, `order_ref`, `order_ref6` | ids; `order_ref6 = right(order_ref, 6)` |
| `order_status`, `order_mismatch`, `unit_status`, `unit_updated_at` | from `orders` and `order_units` |
| `created_at`, `captured_verified_at` | `orders.created_at`, `order_units.captured_verified_at` |
| `currency`, `amount_minor`, `order_total_minor`, `refunded_minor`, `environment` | from `orders` and `order_units` |
| `publisher_id`, `seller_name`, `seller_slug` | `publishers` |
| `provider_order_id` | `provider_orders` on `provider_orders.id = order_units.provider_order_ref` (a single-route order has `publisher_id` NULL there, so the join never uses it) |
| `capture_id` | `order_units.capture_id` |
| `buyer_id`, `buyer_display_name` | `orders.buyer_id`, `buyers.display_name` (left out of the seller projection) |
| `titles` | `array_agg(articles.title ORDER BY articles.title)` over `entitlements` for the unit |
| `refund_state`, `refund_id`, `refund_amount_minor` | the latest `refund_requests` for the unit by `(created_at, id)` |
| `case_state`, `case_kind` | the latest `recovery_cases` for the order by `(created_at, id)` |
| `alert_count` | `count(*)` of `alerts` for the order |
| `has_unknown_op` | `EXISTS` an `operations` row for the order with `state = 'unknown'` |
| `channel`, `agent_key_id`, `mandate_id` | `agent` when a `mandate_reservations` row has this `order_id` (then `mandates.agent_key_id`, `mandates.id`); else `human` and nulls |

`ref` matches `order_ref`, `order_ref6`, `provider_order_id`, `capture_id`, or an `EXISTS` on `refund_requests.refund_id` or `receipts.id` for the order.

## Indexes (finding 9, exact list)

```sql
CREATE INDEX orders_buyer_time    ON orders (buyer_id, created_at DESC, id DESC);
CREATE INDEX orders_time          ON orders (created_at DESC, id DESC);
CREATE INDEX orders_attention     ON orders (created_at DESC) WHERE status IN ('unresolved', 'frozen');
CREATE INDEX order_units_pub_time ON order_units (publisher_id, created_at DESC, id DESC);
CREATE INDEX order_units_problem  ON order_units (updated_at DESC) WHERE status IN ('pending', 'mismatch', 'reversal_suspected');
CREATE INDEX refund_requests_unit ON refund_requests (unit_id, created_at DESC, id DESC);
CREATE INDEX recovery_cases_order ON recovery_cases (order_id, created_at DESC, id DESC);
CREATE INDEX ledger_entries_unit  ON ledger_entries (unit_id);
CREATE INDEX entitlements_buyer   ON entitlements (buyer_id, created_at DESC);
CREATE INDEX alerts_order         ON alerts (order_id);
```

Not added, because they exist already: `order_units (order_id)` (`UNIQUE (order_id, reference_id)`, 0004:140), `entitlements (unit_id)` (`UNIQUE (unit_id, article_id)`, 0005:17), `provider_orders (order_id)` (`UNIQUE (order_id, position)`, 0011:53) and the mandate link (`mandate_reservations_order_idx`, 0021:52). `sort=amount` and `sort=status` have no index. They are always bounded by F1 (operator default 30 days) and are not in the plan test.

## Outputs (only these files)

New:
- `packages/contracts/src/txn-query.ts`
- `domain/txn-search/{package.json,tsconfig.json}` and `domain/txn-search/src/{index,scope,sql,cursor}.ts`
- `packages/db/migrations/common/00NN_txn_search.sql` (next free at merge, planned 0024)
- the tests below

Changed:
- `packages/contracts/src/index.ts`
- `eslint.config.mjs` (add `'txn-search'` to `DOMAIN`, line 94)
- `pnpm-lock.yaml` (workspace package)
- `docs/decision-log.md` (V5 row)

There is no db index-file change (`migrate.ts:11` reads the directory). If code is adapted from the simulation's `order-query.ts`, it carries the rule 6 provenance header.

## Acceptance tests (commit 1: tests only, run red)

| Item | Test file | Command | Expected |
|---|---|---|---|
| SR0.1 | `packages/contracts/src/txn-query.golden.test.ts` | `pnpm vitest run packages/contracts/src/txn-query.golden.test.ts` | 40 URL cases parse as expected, bad values dropped; the `STATUS_GROUPS` table and `statusGroupOf` precedence match the table above, including pending at 59 and 61 minutes with an injected `now` |
| SR0.1 | `domain/txn-search/src/cursor.test.ts` | `pnpm vitest run domain/txn-search/src/cursor.test.ts` | Round trip for `newest`, `amount` and `status`; malformed, tampered, other-sort and `h`-mismatch cursors each throw `bad_cursor`; the decoded cursor has only `v, s, k, id, h` |
| SR0.2 | `domain/txn-search/src/scope.adversarial.test.ts` | `pnpm vitest run domain/txn-search/src/scope.adversarial.test.ts` | Every row of the role table holds, for each principal kind in `principal.ts`: buyer `buyer=other` gives 400; seller `buyer=`, `seller=other`, `seller=self` and `agent_key` give 400; buyer or seller `environment=bogus` and `flags=bogus` give 400 (raw-key check); an operator key's `buyer=<name>` matches nothing; a buyer's foreign `agent_key` gives zero rows; seller rows have no buyer column; `q` of `\`, `%`, `_` and `' OR 1=1 --` returns only literal matches |
| SR0.3, SR0.4 | `packages/db/src/migration-00NN.state.test.ts`, `domain/txn-search/src/view.state.test.ts` | `pnpm vitest run packages/db/src/migration-00NN.state.test.ts domain/txn-search/src/view.state.test.ts` | The 10 indexes exist and no duplicate was added; `txn_rows` has one row per unit; `provider_order_id` is filled for a single-route order and for each line of a split order, and `ref=<provider id>` finds both; a unit with two articles has two titles; the latest refund and case win by `(created_at, id)`; `alert_count`, `channel` and `agent_key_id` are right for a seeded agent buy; `security_invoker` is set |
| SR0.5 | `domain/txn-search/src/pg.plan.integration.test.ts` | `UMS_TEST_PG_BIN=$(pg_config --bindir) pnpm vitest run domain/txn-search/src/pg.plan.integration.test.ts` | **A skip is a fail.** The seed inserts 100,000 lines with `generate_series` inside an approved `seed` trace context, with corridor, currency and approval rows inserted first so the 0004 guards pass; then `ANALYZE`. For the buyer newest page, seller newest page, operator 30-day page and operator Needs attention page, `EXPLAIN` shows `Index Scan`, `Index Only Scan` or `Bitmap Index Scan` on `orders_buyer_time`, `order_units_pub_time`, `orders_time`, and `orders_attention` or `order_units_problem`. p95 is under 50 ms (5 warm-ups, then 50 runs per shape); the output shows the run counts |

Mutation: `pnpm mutation --require-targets --targets domain/txn-search/src/scope.ts,domain/txn-search/src/cursor.ts --test-cmd "pnpm vitest run domain/txn-search packages/contracts/src/txn-query.golden.test.ts" --threshold 80`.

## Safety

Read-only lane: no network path, no PayPal call, no change to `packages/transport` or `endpoints.ts`, no secret. The gate runs `pnpm check:no-live-host`, `pnpm check:secrets-names`, `pnpm check:isolation` and `pnpm trace:verify` (after the seed, INV-T2 empty).

## Do not

Add `pg_trgm` or any extension; change money tables or their triggers; add a dependency; import `apps/web` from domain or contracts.

Branch: `feat/int-sr0-search-base`. Commit: `feat(txn-search): TxnQuery, role rules, indexes and txn_rows view (INT-SR0)`.
