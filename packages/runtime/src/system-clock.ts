import type { Clock } from './temp-contracts-f1';

// The one real clock. Every other package receives a Clock by injection (lint rule S6).
export function systemClock(): Clock {
  return { now: () => new Date() };
}
