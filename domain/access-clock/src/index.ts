// @umsbx/access-clock: the five-day access window, its evidence log and lost-time restoration.
export const PACKAGE_NAME = '@umsbx/access-clock' as const;
export { ceilToHour, computeWindow, deriveAccessState, HOUR_MS, MAX_CREDIT_MS } from './compute';
export { markAccessReady, recordDeliveryEvent, revokeWindow } from './events';
export { grantCredit } from './credit';
export { sweepWindows } from './sweep';
