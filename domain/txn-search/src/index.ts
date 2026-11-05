// @umsbx/txn-search (INT-SR0): the role rules, keyset cursor and SQL of the transaction lists. The filter
// contract (TxnQuery, STATUS_GROUPS, REFUSED_FIELDS) lives in @umsbx/contracts; the read view txn_rows and its
// indexes are migration 0024 in @umsbx/db. Read-only: nothing here writes, calls a provider or reads a secret.
export { TxnSearchError, decodeCursor, encodeCursor } from './cursor';
export type { TxnCursor, TxnSearchErrorCode, TxnSort } from './cursor';
export { scopeQuery } from './scope';
export type { ScopedQuery, TxnPrincipal, TxnScope } from './scope';
export { ALL_COLUMNS, DEFAULT_LIMIT, SELLER_COLUMNS, buildTxnSql, searchTransactions } from './sql';
export type { BuiltSql, SearchContext, TxnPage, TxnRow } from './sql';
// INT-SR1: paging rules, lines, CSV, saved views and quick-find.
export {
  EXPORT_CAP,
  LEGACY_CAP,
  buyerLine,
  checkScope,
  exportName,
  exportTransactions,
  isPlainQuery,
  listTransactions,
  opsLine,
  principalKey,
  queryHash,
  sellerLine,
  txnCsv,
} from './page';
export type { CsvKind, ListContext, ListResult } from './page';
export { VIEW_IDS, isViewId, savedView, savedViews, utcDay } from './views';
export type { ViewId } from './views';
export { FIND_GROUP_MAX, quickFind } from './find';
export type {
  FindBuyer,
  FindColumn,
  FindKey,
  FindOffer,
  FindOrder,
  FindResult,
  FindSeller,
} from './find';
// Test data for the INT-SR1 suites (plain SQL; no product code reads it).
export { VIEWS_EXPECTED, VIEWS_MEMBERS, seedViewsWorld } from '../fixtures/views-seed';
