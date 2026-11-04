// @umsbx/mandates: agent spending caps (API-B, G1). A buyer gives an agent key a cap in money, in a number of
// purchases, or both; reserve books one purchase against it atomically; commit and release settle it; the
// last committed purchase writes mandate.exhausted once.
export const PACKAGE_NAME = '@umsbx/mandates' as const;
export { ASK_BUYER_TEXT, MAX_AMOUNT_MINOR, evaluate, remainingOf } from './budget';
export type { MandateRow, RefusalReason, Verdict } from './budget';
export { attachOrder, commit, release, reserve, settleHeld } from './reserve';
export type { MandateDeps, ReserveError, ReserveInput } from './reserve';
export { MAX_MANDATE_DAYS, checkBudget, createMandate, getMandate, revokeMandate } from './store';
export type { BudgetResult, CreateError, CreateMandateInput, MandateView } from './store';
