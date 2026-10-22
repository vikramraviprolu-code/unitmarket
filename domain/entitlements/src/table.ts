// Adapted from AIC_Hackathon_UnitMarket packages/core/entitlements/table.ts at
// a36ddc03fd0b962000f686291c145b50ee337f90. Owned by SBX.
// The 36-cell money transition table (architecture 4.3) and its effects. Pure: no database, no
// clock. Differences from the simulation: access names are locked/available/ended/revoked; capture
// grants the licence but leaves access locked until the access clock starts (markAccessReady);
// refund or reversal revokes access from every access state; `reversed` is fed only by
// `reversal_verified`, which payments sends after a confirmed reversal.
import type { AccessState, LicenceState, MoneyEvent, MoneyState, Result } from '@umsbx/contracts';
import { err, ok } from '@umsbx/contracts';

export interface EntitlementStates {
  money: MoneyState;
  access: AccessState;
  licence: LicenceState | null;
}
export type TransitionError = { code: 'forbidden_transition'; from: MoneyState; event: MoneyEvent };
export interface Transition {
  record: 'money' | 'access' | 'licence';
  from: string | null;
  to: string;
  at: string;
}

// A cell is the new money state, '=' for an allowed no-op, or 'x' for a refused event.
type Cell = MoneyState | '=' | 'x';
const TABLE: Readonly<Record<MoneyState, Readonly<Record<MoneyEvent, Cell>>>> = {
  pending: {
    capture_verified: 'captured',
    pending: '=',
    declined: 'denied',
    unknown: 'unknown',
    refund_verified: 'x',
    reversal_verified: 'x',
  },
  unknown: {
    capture_verified: 'captured',
    pending: 'x',
    declined: 'denied',
    unknown: '=',
    refund_verified: 'x',
    reversal_verified: 'x',
  },
  captured: {
    capture_verified: '=',
    pending: 'x',
    declined: 'x',
    unknown: 'x',
    refund_verified: 'refunded',
    reversal_verified: 'reversed',
  },
  denied: {
    capture_verified: 'x',
    pending: 'x',
    declined: '=',
    unknown: 'x',
    refund_verified: 'x',
    reversal_verified: 'x',
  },
  refunded: {
    capture_verified: 'x',
    pending: 'x',
    declined: 'x',
    unknown: 'x',
    refund_verified: '=',
    reversal_verified: 'x',
  },
  reversed: {
    capture_verified: 'x',
    pending: 'x',
    declined: 'x',
    unknown: 'x',
    refund_verified: 'x',
    reversal_verified: '=',
  },
};

export function nextMoneyState(from: MoneyState, e: MoneyEvent): MoneyState | '=' | 'x' {
  return TABLE[from][e];
}

/** changed false means an allowed no-op (the same state again). */
export function nextStates(
  current: EntitlementStates,
  event: MoneyEvent,
): Result<{ states: EntitlementStates; changed: boolean }, TransitionError> {
  const cell = nextMoneyState(current.money, event);
  if (cell === 'x') return err({ code: 'forbidden_transition', from: current.money, event });
  if (cell === '=') return ok({ states: { ...current }, changed: false });
  if (cell === 'captured') {
    return ok({
      states: { money: 'captured', access: current.access, licence: current.licence ?? 'granted' },
      changed: true,
    });
  }
  if (cell === 'refunded' || cell === 'reversed') {
    return ok({ states: { money: cell, access: 'revoked', licence: 'terminated' }, changed: true });
  }
  // denied, unknown: money only.
  return ok({ states: { ...current, money: cell }, changed: true });
}

/** Log entries for a change, in the order money, access, licence. */
export function transitionsBetween(
  before: EntitlementStates,
  after: EntitlementStates,
  at: string,
): Transition[] {
  const log: Transition[] = [];
  if (before.money !== after.money)
    log.push({ record: 'money', from: before.money, to: after.money, at });
  if (before.access !== after.access)
    log.push({ record: 'access', from: before.access, to: after.access, at });
  if (before.licence !== after.licence && after.licence !== null) {
    log.push({ record: 'licence', from: before.licence, to: after.licence, at });
  }
  return log;
}
