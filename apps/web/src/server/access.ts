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
export type { ApiV1, ExposureRow } from '../../composition.server';
export type {
  AlertDetail,
  AlertList,
  App,
  ApprovalView,
  CaseDetail,
  CaseQueue,
  NeedsYouRow,
  Engine,
  LibraryEntry,
  OfferPage,
  OpsSnapshot,
  OrderView,
  PackStep,
  RefundOverview,
  RefundUnitView,
} from '../../composition.server';
export { UNIT_STATUS_TEXT, csvLine, orderMessage, salesTotals } from '../../composition.server';
// INT-OPS-B: TR0's in-process journal verifier, for traceVerifyDetail in composition/ops-controls.ts.
export { formatTraceFinding, verifyTrace } from '../../composition.server';
// INT-BUY: SR1's buyer read and export, and TR1's journal sentences, for the buyer composition module.
// INT-SEL: the transaction list and export reads for the seller composition module (read only).
export {
  TRACE_WORDS,
  TxnSearchError,
  buyerLine,
  exportName,
  exportTransactions,
  isPlainQuery,
  listTransactions,
  sellerLine,
  txnCsv,
} from '../../composition.server';
// INT-GA: the assist code and AL's catalogue, for the assist composition module (src/composition/assist.ts).
export {
  ALERT_KINDS,
  assistQuery,
  explainOrder,
  orderFixIds,
  scopeQuery,
  severityOf,
  takeToken,
} from '../../composition.server';
export type { AssistAnswer, AssistRole, ExplainAnswer } from '../../composition.server';
