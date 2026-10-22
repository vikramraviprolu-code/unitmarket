// @umsbx/safety: kill switches and the outbound approval gate (architecture 7, lane 02).
export const PACKAGE_NAME = '@umsbx/safety' as const;
export { createSwitchReader, setSwitch, MAX_SWITCH_CACHE_MS } from './switches';
export { createOutboundGate } from './gate';
export type { GateConfig } from './gate';
export { checkOperatorTerminal, runApprove } from './cli-approve';
export type { ApprovalInput, ApproveError } from './cli-approve';
export { runStop } from './cli-stop';
export { aiEnabled, readSafetyStatus } from './status';
export type { SafetyStatus } from './status';
export { reservedToday } from './budget';
export type { SetSwitchError } from './switches';
export { MAX_APPROVAL_VALIDITY_MS } from './cli-approve';
