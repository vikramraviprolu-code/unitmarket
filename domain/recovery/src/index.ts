export const PACKAGE_NAME = '@umsbx/recovery' as const;

export { applyAutomaticRules, diagnose, listCasesForBuyer, openCase, resolve } from './cases';
export type { CaseError, RefundCanceller, RefundRequester, ResolveDeps } from './cases';
export type { ResolveAction } from './rules';
export { ALLOWED_CASE_ACTIONS, allowedActions, getCaseDetail, listCases } from './cases-api';
export type { CaseAction, CaseDetail, CaseQueue, CaseQueueRow, CaseQueueState } from './cases-api';
