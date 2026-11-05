// The one door from pages and route handlers to the engine (architecture 2.3 Z1). Re-exports the
// lazy accessors of the composition root; marks the module server-only for the bundler.
import 'server-only';
export {
  BOOT_REFUSAL_EXIT_CODE,
  apiKeyDeps,
  app,
  createApiV1,
  securityDeps,
} from '../../composition.server';
export type { ApiV1 } from '../../composition.server';
export type {
  App,
  ApprovalView,
  Engine,
  LibraryEntry,
  OfferPage,
  OpsSnapshot,
  OrderView,
  PackStep,
  RefundOverview,
  RefundUnitView,
} from '../../composition.server';
export { UNIT_STATUS_TEXT, orderMessage, salesTotals } from '../../composition.server';
// INT-OPS-B: TR0's in-process journal verifier, for traceVerifyDetail in composition/ops-controls.ts.
export { formatTraceFinding, verifyTrace } from '../../composition.server';
// INT-SEL: the transaction list and export reads for the seller composition module (read only).
export {
  TRACE_WORDS,
  TxnSearchError,
  exportName,
  exportTransactions,
  isPlainQuery,
  listTransactions,
  sellerLine,
  txnCsv,
} from '../../composition.server';
