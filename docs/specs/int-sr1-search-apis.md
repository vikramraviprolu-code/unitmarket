# INT-SR1: search APIs

Task: Put `TxnQuery` on the buyer, seller and operator lists, add operator transactions and quick-find, CSV of a filter, and library paging.
Package: `apps/web` routes and the tab composition modules, `domain/txn-search`. Builder: Sonnet 5.5 high. Reviewer: Opus 5.5 gate.
Items: SR1.1 to SR1.7, 17 points. Needs SR0. Source: search proposal T2.1 to T2.6, T5.1, section 5.

## Goal

`GET /api/v1/orders` and `GET /api/v1/seller/sales` accept `TxnQuery` (old calls answer as before) with real keyset paging; `GET /api/v1/ops/transactions` serves operators with four saved views (Needs attention, Refunds today, Agent purchases, Sandbox only); `GET /api/v1/ops/find?q=` classifies the input (exact reference, then `@` email, then a case-insensitive name or title match) and returns results grouped by type; every list exports the current filter as CSV up to 5,000 rows; `GET /api/v1/library` pages and filters.

## Outputs

New routes `apps/web/src/app/api/v1/ops/transactions/route.ts`, `.../ops/find/route.ts`, `.../orders/export.csv/route.ts`, `.../seller/sales/export.csv/route.ts`, `.../ops/transactions/export.csv/route.ts`; `domain/txn-search/src/{find,csv,views}.ts`; contracts additions in `txn-query.ts`. Changed: the existing orders, seller sales and library route handlers; OpenAPI; route inventory.

## Acceptance tests (commit 1: tests only, run red)

| Item | Test file | Command | Expected |
|---|---|---|---|
| SR1.1, SR1.2, SR1.6 | `apps/web/src/v1-search-lists.contract.test.ts` | `pnpm test:contract -- v1-search-lists` | Old calls byte-identical; filters narrow; `next_cursor` pages through 120 seeded sales in 5 pages |
| SR1.3 | `apps/web/src/v1-ops-transactions.state.test.ts` | `pnpm test:state -- ops-transactions` | Four saved views return the expected seeded orders; `ops:read` required |
| SR1.4 | `domain/txn-search/src/find.test.ts` | `pnpm test -- txn-search/find` | Order ref, short ref, provider id, capture id, refund id, email and name each land in the right group |
| SR1.5 | `apps/web/src/v1-export.state.test.ts` | `pnpm test:state -- v1-export` | CSV matches the filtered list; cap 5,000; seller CSV has no buyer column |
| SR1.7 | `apps/web/src/v1-search.adversarial.test.ts` | `pnpm test:adversarial -- v1-search` | Cross-tenant leak, injection in `q`, tampered cursor, operator field with a buyer key, CSV formula injection (`=`, `+`, `-`, `@` prefixes escaped) all refused or neutralised |

Mutation: transactions route handler and `find.ts` at least 80 percent.

Branch: `feat/int-sr1-search-apis`. Commit: `feat(web): TxnQuery on lists, ops transactions, quick-find and CSV (INT-SR1)`.
