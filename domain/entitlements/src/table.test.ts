// Adapted from AIC_Hackathon_UnitMarket packages/core/entitlements/table.test.ts and boundary.ts at
// a36ddc03fd0b962000f686291c145b50ee337f90. Owned by SBX. The expected side is written by hand from
// architecture 4.3, not computed by table.ts. SBX difference: access_state names are
// locked/available/ended/revoked; capture alone does not make access available (the access clock
// does, in markAccessReady); refund or reversal revokes from every access state.
import { describe, expect, it } from 'vitest';
import type { AccessState, MoneyEvent, MoneyState } from '@umsbx/contracts';
import { nextMoneyState, nextStates, transitionsBetween } from './table';
import type { EntitlementStates } from './table';

const EVENTS: MoneyEvent[] = [
  'capture_verified',
  'pending',
  'declined',
  'unknown',
  'refund_verified',
  'reversal_verified',
];
const MONEY: MoneyState[] = ['pending', 'unknown', 'captured', 'denied', 'refunded', 'reversed'];

type Cell = MoneyState | '=' | 'x';
// Rows: from money state. Columns in EVENTS order.
const EXPECTED: Record<MoneyState, Cell[]> = {
  pending: ['captured', '=', 'denied', 'unknown', 'x', 'x'],
  unknown: ['captured', 'x', 'denied', '=', 'x', 'x'],
  captured: ['=', 'x', 'x', 'x', 'refunded', 'reversed'],
  denied: ['x', 'x', '=', 'x', 'x', 'x'],
  refunded: ['x', 'x', 'x', 'x', '=', 'x'],
  reversed: ['x', 'x', 'x', 'x', 'x', '='],
};

const FROM: Record<MoneyState, EntitlementStates> = {
  pending: { money: 'pending', access: 'locked', licence: null },
  unknown: { money: 'unknown', access: 'locked', licence: null },
  captured: { money: 'captured', access: 'available', licence: 'granted' },
  denied: { money: 'denied', access: 'locked', licence: null },
  refunded: { money: 'refunded', access: 'revoked', licence: 'terminated' },
  reversed: { money: 'reversed', access: 'revoked', licence: 'terminated' },
};
const NOW = '2026-10-21T09:00:00.000Z';

describe('transition table', () => {
  it('covers all 36 money cells', () => {
    const cases = MONEY.flatMap((m) => EVENTS.map((e, i) => ({ m, e, cell: EXPECTED[m][i]! })));
    expect(cases).toHaveLength(36);
    for (const c of cases) {
      expect(nextMoneyState(c.m, c.e), `${c.m} + ${c.e}`).toBe(c.cell);
    }
  });

  it('every cell through nextStates: refused, no-op or changed', () => {
    for (const m of MONEY) {
      EVENTS.forEach((e, i) => {
        const cell = EXPECTED[m][i]!;
        const r = nextStates(FROM[m], e);
        if (cell === 'x') {
          expect(r, `${m} + ${e}`).toEqual({
            ok: false,
            error: { code: 'forbidden_transition', from: m, event: e },
          });
        } else if (cell === '=') {
          expect(r, `${m} + ${e}`).toEqual({
            ok: true,
            value: { states: FROM[m], changed: false },
          });
        } else {
          expect(r.ok && r.value.changed, `${m} + ${e}`).toBe(true);
          expect(r.ok && r.value.states.money, `${m} + ${e}`).toBe(cell);
        }
      });
    }
  });

  it('capture grants the licence and leaves access locked until the clock starts', () => {
    const r = nextStates(FROM.pending, 'capture_verified');
    expect(r).toEqual({
      ok: true,
      value: { states: { money: 'captured', access: 'locked', licence: 'granted' }, changed: true },
    });
  });

  it('refund and reversal revoke access from every access state and terminate the licence', () => {
    const accesses: AccessState[] = ['locked', 'available', 'ended', 'revoked'];
    for (const event of ['refund_verified', 'reversal_verified'] as const) {
      for (const access of accesses) {
        const from: EntitlementStates = { money: 'captured', access, licence: 'granted' };
        const r = nextStates(from, event);
        expect(r.ok && r.value.states).toEqual({
          money: event === 'refund_verified' ? 'refunded' : 'reversed',
          access: 'revoked',
          licence: 'terminated',
        });
        expect(r.ok && r.value.changed).toBe(true);
      }
    }
  });

  it('denied, unknown and pending change money only', () => {
    for (const event of ['declined', 'unknown'] as const) {
      const r = nextStates(FROM.pending, event);
      expect(r.ok && r.value.states.access).toBe('locked');
      expect(r.ok && r.value.states.licence).toBeNull();
    }
  });

  it('a captured no-op keeps its access and licence', () => {
    const ended: EntitlementStates = { money: 'captured', access: 'ended', licence: 'granted' };
    expect(nextStates(ended, 'capture_verified')).toEqual({
      ok: true,
      value: { states: ended, changed: false },
    });
  });

  it('does not modify its input', () => {
    const before = structuredClone(FROM.captured);
    nextStates(FROM.captured, 'refund_verified');
    expect(FROM.captured).toEqual(before);
  });

  it('transition log order is money, access, licence', () => {
    const cap = nextStates(FROM.pending, 'capture_verified');
    expect(cap.ok).toBe(true);
    if (!cap.ok) return;
    expect(transitionsBetween(FROM.pending, cap.value.states, NOW)).toEqual([
      { record: 'money', from: 'pending', to: 'captured', at: NOW },
      { record: 'licence', from: null, to: 'granted', at: NOW },
    ]);
    const refund = nextStates(FROM.captured, 'refund_verified');
    expect(refund.ok).toBe(true);
    if (!refund.ok) return;
    expect(transitionsBetween(FROM.captured, refund.value.states, NOW)).toEqual([
      { record: 'money', from: 'captured', to: 'refunded', at: NOW },
      { record: 'access', from: 'available', to: 'revoked', at: NOW },
      { record: 'licence', from: 'granted', to: 'terminated', at: NOW },
    ]);
  });
});
