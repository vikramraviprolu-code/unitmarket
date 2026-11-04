// @umsbx/payments: place order, buyer return, gated capture, read-back match and apply (lane 05a).
// Lane 05b adds the reconciler, due work, startup recovery, offline refunds and invariants beside them.
export const PACKAGE_NAME = '@umsbx/payments' as const;

export { requestIdFor, readbackKeyFor, MAX_REQUEST_ID_LENGTH } from './keys';
export { placeOrder } from './place';
export { beginCheckout } from './checkout';
export { cancelOrder } from './cancel';
export type { CancelError, CancelOk } from './cancel';
export { onBuyerReturn, loadOrderView } from './return';
export { matchReadback } from './match';
export {
  PENDING_REASON_LABEL,
  SELLER_ACCEPTANCE_REASON,
  pendingReasonKind,
  pendingReasonLabel,
} from './pending-reason';
export type { PendingReasonKind } from './pending-reason';
export { deriveOrderStatus, expectedFor, poRefFor } from './composite';
export type { Derived, PoFacts, ProviderOrderState } from './composite';
export type { MatchInput } from './match';
export { applyReadback, readApplyGates, ensureReadbackOp } from './apply';
export { raiseAlert } from './alerts';
export type { AlertKind } from './alerts';
export type { ApplyGates, ApplyReport, OrderView, PlaceError, ReadinessEvidence } from './types';
export { reconcileOrder } from './reconcile';
export { nextDueAt, nextPollAt, runDue } from './due';
export { recoverOnStartup } from './recover';
export { cancelRefundRequest, executeRefund, requestRefund, suspectReversal } from './refunds';
export type { OpsAlertKind } from './refunds';
export { checkInvariants } from './invariants';
export { handleWebhook } from './webhooks';
export type { WebhookInput, WebhookResponse } from './webhooks';
