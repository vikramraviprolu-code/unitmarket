// CO-5 (ASM-59): the refund and credit rules R1 to R6 as pure table cases. The expected side is
// written by hand from docs/specs/access-clock-refund-interplay.md, not computed by compute.ts.
//   R1 partial refund leaves the window unchanged        R4 a pending refund changes nothing
//   R2 full refund or reversal revokes from any state    R5 a window starts after a partial refund,
//   R3 no credit after a revoke or an end                   never after a full refund
//   R6 paused then revoked: ends_at kept, no credit
import { describe, expect, it } from 'vitest';
import type { AccessEvent, AccessEventKind, AccessPolicy, MoneyState } from '@umsbx/contracts';
import { computeWindow, deriveAccessState } from './compute';

const T0 = Date.parse('2026-10-21T10:00:00.000Z');
const H = 3_600_000;
const D = 24 * H;
const FIVE = 432_000_000;
const policy: AccessPolicy = {
  id: 'pol_1',
  version: 'v1',
  option: 'keep_retrieve',
  window_ms: FIVE,
  start_rule: 'payment_verified_and_delivery_ready',
};
const iso = (ms: number) => new Date(ms).toISOString();
function ev(kind: AccessEventKind, atMs: number, over: Partial<AccessEvent> = {}): AccessEvent {
  return { entitlement_id: 'ent_1', kind, at: iso(atMs), source: 'system', evidence: {}, ...over };
}
const credit = (atMs: number, ms: number) =>
  ev('credit_granted', atMs, { source: 'operator', evidence: { credit_ms: ms, case_id: 'cas_1' } });
const revoked = (atMs: number, reason: 'refund' | 'reversal' = 'refund') =>
  ev('revoked', atMs, { evidence: { reason } });
const win = (events: AccessEvent[], nowMs: number) =>
  computeWindow(events, policy, new Date(nowMs));

interface Row {
  rule: string;
  title: string;
  money: MoneyState;
  events: AccessEvent[];
  now: number;
  state: string;
  ends_at: string | null;
  credit_ms: number;
  paused_at: string | null;
  access: string;
}
// One row per cell of the R1 to R6 table. A partial refund and a pending refund write no access
// event at all, so they show as the absence of an event in the log.
const ROWS: Row[] = [
  {
    rule: 'R1',
    title: 'partial refund after a credit: window and ends_at unchanged',
    money: 'captured',
    events: [ev('access_ready', T0), credit(T0 + D, 2 * H)],
    now: T0 + 2 * D,
    state: 'running',
    ends_at: iso(T0 + FIVE + 2 * H),
    credit_ms: 2 * H,
    paused_at: null,
    access: 'available',
  },
  {
    rule: 'R1',
    title: 'partial refund while paused: still paused, same ends_at',
    money: 'captured',
    events: [ev('access_ready', T0), ev('delivery_failed', T0 + D)],
    now: T0 + 2 * D,
    state: 'paused',
    ends_at: iso(T0 + FIVE),
    credit_ms: 0,
    paused_at: iso(T0 + D),
    access: 'available',
  },
  {
    rule: 'R2',
    title: 'full refund revokes a running window',
    money: 'refunded',
    events: [ev('access_ready', T0), revoked(T0 + D)],
    now: T0 + 2 * D,
    state: 'revoked',
    ends_at: iso(T0 + FIVE),
    credit_ms: 0,
    paused_at: null,
    access: 'revoked',
  },
  {
    rule: 'R2',
    title: 'reversal revokes a paused window',
    money: 'reversed',
    events: [
      ev('access_ready', T0),
      ev('delivery_failed', T0 + D),
      revoked(T0 + 2 * D, 'reversal'),
    ],
    now: T0 + 3 * D,
    state: 'revoked',
    ends_at: iso(T0 + FIVE),
    credit_ms: 0,
    paused_at: null,
    access: 'revoked',
  },
  {
    rule: 'R2',
    title: 'full refund revokes a window that never started',
    money: 'refunded',
    events: [revoked(T0 + D)],
    now: T0 + 2 * D,
    state: 'revoked',
    ends_at: null,
    credit_ms: 0,
    paused_at: null,
    access: 'revoked',
  },
  {
    rule: 'R2',
    title: 'full refund revokes an ended window',
    money: 'refunded',
    events: [ev('access_ready', T0), ev('window_ended', T0 + FIVE), revoked(T0 + FIVE + D)],
    now: T0 + FIVE + 2 * D,
    state: 'revoked',
    ends_at: iso(T0 + FIVE),
    credit_ms: 0,
    paused_at: null,
    access: 'revoked',
  },
  {
    rule: 'R2',
    title: 'a revoke after the end time but before the sweep still revokes',
    money: 'refunded',
    events: [ev('access_ready', T0), revoked(T0 + FIVE + H)],
    now: T0 + FIVE + 2 * H,
    state: 'revoked',
    ends_at: iso(T0 + FIVE),
    credit_ms: 0,
    paused_at: null,
    access: 'revoked',
  },
  {
    rule: 'R3',
    title: 'a credit after the revoke adds nothing',
    money: 'refunded',
    events: [ev('access_ready', T0), revoked(T0 + D), credit(T0 + 2 * D, 4 * H)],
    now: T0 + 3 * D,
    state: 'revoked',
    ends_at: iso(T0 + FIVE),
    credit_ms: 0,
    paused_at: null,
    access: 'revoked',
  },
  {
    rule: 'R3',
    title: 'a credit before the revoke is kept in history',
    money: 'refunded',
    events: [ev('access_ready', T0), credit(T0 + D, 4 * H), revoked(T0 + 2 * D)],
    now: T0 + 3 * D,
    state: 'revoked',
    ends_at: iso(T0 + FIVE + 4 * H),
    credit_ms: 4 * H,
    paused_at: null,
    access: 'revoked',
  },
  {
    rule: 'R3',
    title: 'a credit after the end adds nothing',
    money: 'captured',
    events: [ev('access_ready', T0), credit(T0 + FIVE + D, 4 * H)],
    now: T0 + FIVE + 2 * D,
    state: 'ended',
    ends_at: iso(T0 + FIVE),
    credit_ms: 0,
    paused_at: null,
    access: 'ended',
  },
  {
    rule: 'R4',
    title: 'a pending refund writes no event: no pause, no credit',
    money: 'captured',
    events: [ev('access_ready', T0)],
    now: T0 + D,
    state: 'running',
    ends_at: iso(T0 + FIVE),
    credit_ms: 0,
    paused_at: null,
    access: 'available',
  },
  {
    rule: 'R5',
    title: 'a not-started window starts after a partial refund (money stays captured)',
    money: 'captured',
    events: [ev('access_ready', T0 + D)],
    now: T0 + 2 * D,
    state: 'running',
    ends_at: iso(T0 + D + FIVE),
    credit_ms: 0,
    paused_at: null,
    access: 'available',
  },
  {
    rule: 'R5',
    title: 'after a full refund a window that never started stays not started: access revoked',
    money: 'refunded',
    events: [],
    now: T0 + 2 * D,
    state: 'not_started',
    ends_at: null,
    credit_ms: 0,
    paused_at: null,
    access: 'revoked',
  },
  {
    rule: 'R6',
    title: 'paused then revoked: the pre-pause ends_at stays, the pause earns no credit',
    money: 'refunded',
    events: [
      ev('access_ready', T0),
      ev('delivery_failed', T0 + D),
      revoked(T0 + 3 * D),
      ev('delivery_restored', T0 + 4 * D),
    ],
    now: T0 + 5 * D,
    state: 'revoked',
    ends_at: iso(T0 + FIVE),
    credit_ms: 0,
    paused_at: null,
    access: 'revoked',
  },
  {
    rule: 'R6',
    title: 'credit earned before the pause stays in ends_at when the paused window is revoked',
    money: 'refunded',
    events: [
      ev('access_ready', T0),
      credit(T0 + H, 3 * H),
      ev('delivery_failed', T0 + D),
      revoked(T0 + 2 * D),
      credit(T0 + 3 * D, 5 * H),
    ],
    now: T0 + 4 * D,
    state: 'revoked',
    ends_at: iso(T0 + FIVE + 3 * H),
    credit_ms: 3 * H,
    paused_at: null,
    access: 'revoked',
  },
];

describe('R1 to R6 window table', () => {
  it.each(ROWS)('$rule: $title', (row) => {
    const w = win(row.events, row.now);
    expect(w.state).toBe(row.state);
    expect(w.ends_at).toBe(row.ends_at);
    expect(w.credit_ms).toBe(row.credit_ms);
    expect(w.paused_at).toBe(row.paused_at);
    expect(deriveAccessState(row.money, w)).toBe(row.access);
  });

  it('names every rule R1 to R6', () => {
    expect([...new Set(ROWS.map((r) => r.rule))]).toEqual(['R1', 'R2', 'R3', 'R4', 'R5', 'R6']);
  });
});

describe('R1: a partial refund moves nothing', () => {
  it('the same log gives the same window before and after a partial refund (it adds no event)', () => {
    const log = [ev('access_ready', T0), ev('delivery_failed', T0 + D), credit(T0 + D + H, H)];
    expect(win(log, T0 + 2 * D)).toEqual(win([...log], T0 + 2 * D));
    expect(deriveAccessState('captured', win(log, T0 + 2 * D))).toBe('available');
  });
});

describe('R2: computeWindow stops at the first revoke', () => {
  it('a replayed revoked event is a no-op', () => {
    const once = [ev('access_ready', T0), revoked(T0 + D)];
    const twice = [...once, revoked(T0 + 2 * D, 'reversal'), revoked(T0 + 2 * D)];
    expect(win(twice, T0 + 3 * D)).toEqual(win(once, T0 + 3 * D));
  });

  it('nothing after the revoke moves the window, whatever its kind', () => {
    const kinds: AccessEventKind[] = [
      'access_ready',
      'link_issued',
      'download_completed',
      'download_aborted',
      'reader_rendered',
      'reader_beacon',
      'delivery_failed',
      'delivery_restored',
      'window_ended',
    ];
    const base = [ev('access_ready', T0), ev('delivery_failed', T0 + D), revoked(T0 + 2 * D)];
    const frozen = win(base, T0 + 10 * D);
    for (const kind of kinds) {
      expect(win([...base, ev(kind, T0 + 3 * D)], T0 + 10 * D), kind).toEqual(frozen);
    }
    expect(win([...base, credit(T0 + 3 * D, H)], T0 + 10 * D)).toEqual(frozen);
  });

  it('a revoke recorded by the buyer is ignored (only the system revokes)', () => {
    const forged = ev('revoked', T0 + D, { source: 'buyer', evidence: { reason: 'refund' } });
    expect(win([ev('access_ready', T0), forged], T0 + 2 * D).state).toBe('running');
  });

  it('the order of equal-time events follows the log order: credit then revoke keeps the credit', () => {
    const at = T0 + D;
    const creditFirst = win([ev('access_ready', T0), credit(at, H), revoked(at)], at + H);
    const revokeFirst = win([ev('access_ready', T0), revoked(at), credit(at, H)], at + H);
    expect(creditFirst).toMatchObject({ state: 'revoked', credit_ms: H });
    expect(revokeFirst).toMatchObject({ state: 'revoked', credit_ms: 0 });
  });
});

describe('R3: credit never reduces ends_at', () => {
  it('ends_at never decreases as credits and pauses arrive, until a revoke', () => {
    const steps: AccessEvent[] = [
      ev('access_ready', T0),
      credit(T0 + H, H),
      ev('delivery_failed', T0 + 2 * H),
      credit(T0 + 3 * H, 7 * H),
      ev('delivery_restored', T0 + 4 * H),
      credit(T0 + 5 * H, 1),
      ev('window_ended', T0 + 6 * H),
    ];
    let prev = 0;
    for (let n = 1; n <= steps.length; n += 1) {
      const e = win(steps.slice(0, n), T0 + 6 * H).ends_at;
      const cur = Date.parse(e ?? '1970-01-01T00:00:00.000Z');
      expect(cur, `after step ${n}`).toBeGreaterThanOrEqual(prev);
      prev = cur;
    }
  });

  it('a non-positive, fractional or missing credit amount adds nothing', () => {
    const bad = [0, -H, 0.5, Number.NaN, null, 'x'];
    for (const c of bad) {
      const e = ev('credit_granted', T0 + H, { source: 'operator', evidence: { credit_ms: c } });
      expect(win([ev('access_ready', T0), e], T0 + 2 * H).credit_ms, String(c)).toBe(0);
    }
  });
});

describe('R4: only a verified full refund or reversal revokes', () => {
  it('no access event kind other than revoked ever ends a window early', () => {
    const kinds: AccessEventKind[] = [
      'link_issued',
      'download_completed',
      'download_aborted',
      'reader_rendered',
      'reader_beacon',
      'delivery_restored',
      'credit_granted',
    ];
    for (const kind of kinds) {
      const w = win([ev('access_ready', T0), ev(kind, T0 + D)], T0 + 2 * D);
      expect(w.state, kind).toBe('running');
    }
  });
});

describe('R5: access follows money for a window that has not started', () => {
  it('deriveAccessState: captured and not started is locked; refunded and reversed are revoked', () => {
    const none = win([], T0);
    expect(deriveAccessState('captured', none)).toBe('locked');
    expect(deriveAccessState('refunded', none)).toBe('revoked');
    expect(deriveAccessState('reversed', none)).toBe('revoked');
  });

  it('available never appears for refunded or reversed money, in any window state', () => {
    const logs: AccessEvent[][] = [
      [],
      [ev('access_ready', T0)],
      [ev('access_ready', T0), ev('delivery_failed', T0 + H)],
      [ev('access_ready', T0), revoked(T0 + H)],
    ];
    for (const money of ['refunded', 'reversed'] as const) {
      for (const log of logs) {
        expect(deriveAccessState(money, win(log, T0 + 2 * H)), money).toBe('revoked');
      }
    }
  });
});

describe('window_ended only ends a running window', () => {
  it('a stale window_ended does not end a paused window or start a window that never started', () => {
    const paused = win(
      [ev('access_ready', T0), ev('delivery_failed', T0 + D), ev('window_ended', T0 + 2 * D)],
      T0 + 3 * D,
    );
    expect(paused).toMatchObject({ state: 'paused', paused_at: iso(T0 + D) });
    const none = win([ev('window_ended', T0)], T0 + D);
    expect(none).toMatchObject({ state: 'not_started', started_at: null, ends_at: null });
    // The paused window still earns its restoration credit afterwards.
    const restored = win(
      [
        ev('access_ready', T0),
        ev('delivery_failed', T0 + D),
        ev('window_ended', T0 + 2 * D),
        ev('delivery_restored', T0 + 2 * D + H),
      ],
      T0 + 3 * D,
    );
    expect(restored).toMatchObject({ state: 'running', credit_ms: D + H });
  });
});
