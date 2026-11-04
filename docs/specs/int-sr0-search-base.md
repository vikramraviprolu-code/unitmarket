# INT-SR0: search foundation

Task: One transaction filter contract with role rules, plus the indexes and the read view it runs on.
Package: `packages/contracts`, `packages/db` (migration), new `domain/txn-search` (`@umsbx/txn-search`). Builder: Sonnet 5.5 high. Reviewer: Opus 5.5 gate.
Items: SR0.1 to SR0.5, 12 points. Needs decision V5. Source: `/mnt/project-files/search-and-genai/transaction-search-and-genai.md` sections 4 and 6 (T0.1, T0.2, T1.1, T1.2, T1.3), with `pg_trgm` removed.

## Goal

`TxnQuery` (fields F1 to F13, sort, keyset cursor) parses from a URL with invalid values dropped, and `scopeQuery(principal, q)` returns a query that always pins buyer or seller and refuses operator-only fields with a typed 400 error. A migration adds the composite and partial indexes from section 6 of the search proposal (no extension, no trigram indexes) and the `txn_rows` view. On Postgres with 100,000 seeded lines, the operator list plans use the indexes and p95 stays under 50 ms.

## Rules

- `q` (item text) runs as `lower(title) LIKE '%' || lower($q) || '%'` with `$q` escaped for `%` and `_`, max 100 characters.
- Sellers: `buyer` field refused, `txn_rows` buyer columns never selected for seller scope.
- Status groups F4 map through the UI0 status dictionary (same words).

## Outputs

New: `packages/contracts/src/txn-query.ts`, `domain/txn-search/src/{scope,sql,cursor}.ts`, migration `00NN_txn_search.sql` (planned 0024), tests. Changed: contracts and db index exports only.

## Acceptance tests (commit 1: tests only, run red)

| Item | Test file | Command | Expected |
|---|---|---|---|
| SR0.1 | `packages/contracts/src/txn-query.golden.test.ts` | `pnpm test:golden -- txn-query` | 40 URL cases parse as expected; bad values dropped |
| SR0.2 | `domain/txn-search/src/scope.adversarial.test.ts` | `pnpm test:adversarial -- txn-search/scope` | Buyer with `buyer=other` gets 400; seller output never has buyer columns; injection strings in `q` return no extra rows |
| SR0.3, SR0.4 | `packages/db/src/migration-00NN.state.test.ts`, `domain/txn-search/src/view.state.test.ts` | `pnpm test:state -- txn` | Indexes exist; `txn_rows` returns one row per unit with refund, case, alert and agent columns |
| SR0.5 | `domain/txn-search/src/pg.plan.integration.test.ts` | `pnpm test:integration -- txn-search/pg.plan` | `EXPLAIN` shows index scans for buyer, seller, time and attention queries; p95 under 50 ms at 100,000 lines |

Mutation: `scope.ts` at least 80 percent.

## Do not

Add `pg_trgm` or any extension; change money tables; add a dependency.

Branch: `feat/int-sr0-search-base`. Commit: `feat(txn-search): TxnQuery, role rules, indexes and txn_rows view (INT-SR0)`.
