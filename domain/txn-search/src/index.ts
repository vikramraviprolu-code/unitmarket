// @umsbx/txn-search (INT-SR0): the role rules, keyset cursor and SQL of the transaction lists. The filter
// contract (TxnQuery, STATUS_GROUPS, REFUSED_FIELDS) lives in @umsbx/contracts; the read view txn_rows and its
// indexes are migration 0024 in @umsbx/db. Read-only: nothing here writes, calls a provider or reads a secret.
export { TxnSearchError, decodeCursor, encodeCursor } from './cursor';
export type { TxnCursor, TxnSearchErrorCode, TxnSort } from './cursor';
export { scopeQuery } from './scope';
export type { ScopedQuery, TxnPrincipal, TxnScope } from './scope';
export { ALL_COLUMNS, DEFAULT_LIMIT, SELLER_COLUMNS, buildTxnSql, searchTransactions } from './sql';
export type { BuiltSql, SearchContext, TxnPage, TxnRow } from './sql';
