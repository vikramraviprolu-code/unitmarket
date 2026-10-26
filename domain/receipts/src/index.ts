// @umsbx/receipts: immutable versioned receipts with the snapshot, capture ids, access windows
// and delivery evidence (lane 08).
export const PACKAGE_NAME = '@umsbx/receipts' as const;
export { buildReceiptBody, paymentOutcome, receiptBodyHash, sanitiseDebugId } from './body';
export type { BodyError, PaymentOutcome, ReceiptBody } from './body';
export { getReceiptForBuyer, issueReceiptIfChanged } from './receipts';
export { receiptLabel, renderReceiptHtml } from './html';
