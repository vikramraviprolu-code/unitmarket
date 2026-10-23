// Adapted from AIC_Hackathon_UnitMarket packages/core/entitlements/table.ts at
// a36ddc03fd0b962000f686291c145b50ee337f90. Owned by SBX.
// The 42-cell money transition table (architecture 4.3; 36 cells plus the CO-5 column) and its effects. Pure: no database, no
// clock. Differences from the simulation: access names are locked/available/ended/revoked; capture
// grants the licence but leaves access locked until the access clock starts (markAccessReady);
// refund or reversal revokes access from every access state; `reversed` is fed only by
// `reversal_verified`, which payments sends after a confirmed reversal. `partial_refund_verified`
// (CO-5, ASM-59) is an allowed no-op in every row: a partial refund leaves money, access and
// licence as they are, so the buyer keeps what was not refunded; only a full refund revokes.
import type {
  AccessState,
  EntitlementMoneyEvent,
  LicenceState,
  MoneyState,
  Result,
} from '@umsbx/contracts';
import { err, ok } from '@umsbx/contracts';

export interface EntitlementStates {
  money: MoneyState;
  access: AccessState;
  licence: LicenceState | null;
}
export type TransitionError = {
  code: 'forbidden_transition';
  from: MoneyState;
  event: EntitlementMoneyEvent;
};
export interface Transition {
  record: 'money' | 'access' | 'licence';
  from: string | null;
  to: string;
  at: string;
}

// A cell is the new money state, '=' for an allowed no-op, or 'x' for a refused event.
type Cell = MoneyState | '=' | 'x';
const TABLE: Readonly<Record<MoneyState, Readonly<Record<EntitlementMoneyEvent, Cell>>>> = {
  pending: {
    capture_verified: 'captured',
    pending: '=',
    declined: 'denied',
    unknown: 'unknown',
    refund_verified: 'x',
    reversal_verified: 'x',
    partial_refund_verified: '=',
  },
  unknown: {
    capture_verified: 'captured',
    pending: 'x',
    declined: 'denied',
    unknown: '=',
    refund_verified: 'x',
    reversal_verified: 'x',
    partial_refund_verified: '=',
  },
  captured: {
    capture_verified: '=',
    pending: 'x',
    declined: 'x',
    unknown: 'x',
    refund_verified: 'refunded',
    reversal_verified: 'reversed',
    partial_refund_verified: '=',
  },
  denied: {
    capture_verified: 'x',
    pending: 'x',
    declined: '=',
    unknown: 'x',
    refund_verified: 'x',
    reversal_verified: 'x',
    partial_refund_verified: '=',
  },
  refunded: {
    capture_verified: 'x',
    pending: 'x',
    declined: 'x',
    unknown: 'x',
    refund_verified: '=',
    reversal_verified: 'x',
    partial_refund_verified: '=',
  },
  reversed: {
    capture_verified: 'x',
    pending: 'x',
    declined: 'x',
    unknown: 'x',
    refund_verified: 'x',
    reversal_verified: '=',
    partial_refund_verified: '=',
  },
};

export function nextMoneyState(from: MoneyState, e: EntitlementMoneyEvent): MoneyState | '=' | 'x' {
  return TABLE[from][e];
}

/** changed false means an allowed no-op (the same state again). */
export function nextStates(
  current: EntitlementStates,
  event: EntitlementMoneyEvent,
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
