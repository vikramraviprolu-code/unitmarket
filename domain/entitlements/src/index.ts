// @umsbx/entitlements: per-item money, access and licence states (architecture 4.3).
export const PACKAGE_NAME = '@umsbx/entitlements' as const;
export { nextMoneyState } from './table';
export type { EntitlementStates, Transition, TransitionError } from './table';
export { applyMoneyEvent, createPendingEntitlements, getEntitlementForBuyer } from './entitlements';
export type { EntitlementView } from './entitlements';
