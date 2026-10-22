// @umsbx/runtime: real clock, crypto ids, and their test doubles. The only package that may
// read real time or draw randomness.
export const PACKAGE_NAME = '@umsbx/runtime' as const;
export { systemClock } from './system-clock';
export { cryptoIds } from './crypto-ids';
export { fakeClock } from './fake-clock';
export { seededIds } from './seeded-ids';
