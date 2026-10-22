// Pure tests for the five-day access clock (architecture 4.4) and its properties.
import { describe, expect, it } from 'vitest';
import type { AccessEvent, AccessEventKind, AccessPolicy, MoneyState } from '@umsbx/contracts';
import { ceilToHour, computeWindow, deriveAccessState } from './compute';

const T0 = Date.parse('2026-10-21T10:00:00.000Z');
const H = 3_600_000;
const D = 24 * H;
const FIVE = 432_000_000;
const policy: AccessPolicy = {
  id: 'pol_1', version: 'v1', option: 'keep_retrieve', window_ms: FIVE, start_rule: 'payment_verified_and_delivery_ready',
};
const iso = (ms: number) => new Date(ms).toISOString();
function ev(kind: AccessEventKind, atMs: number, over: Partial<AccessEvent> = {}): AccessEvent {
  return { entitlement_id: 'ent_1', kind, at: iso(atMs), source: 'system', evidence: {}, ...over };
}
const credit = (atMs: number, ms: number) => ev('credit_granted', atMs, { source: 'operator', evidence: { credit_ms: ms, case_id: 'cas_1' } });
const ready = ev('access_ready', T0);

describe('ceilToHour', () => {
  it('rounds up to whole hours and keeps zero', () => {
    expect(ceilToHour(0)).toBe(0);
    expect(ceilToHour(1)).toBe(H);
    expect(ceilToHour(H)).toBe(H);
    expect(ceilToHour(H + 1)).toBe(2 * H);
    expect(ceilToHour(5 * H + 10 * 60_000)).toBe(6 * H);
  });
});

describe('computeWindow', () => {
  it('is not_started without access_ready', () => {
    expect(computeWindow([], policy, new Date(T0))).toEqual({
      state: 'not_started', started_at: null, base_ends_at: null, ends_at: null, paused_at: null, credit_ms: 0,
    });
    expect(computeWindow([ev('delivery_failed', T0)], policy, new Date(T0)).state).toBe('not_started');
  });

  it('window ends exactly 432000000 ms after access_ready', () => {
    const at = (offset: number) => computeWindow([ready], policy, new Date(T0 + offset));
    expect(at(0)).toEqual({
      state: 'running', started_at: iso(T0), base_ends_at: iso(T0 + FIVE), ends_at: iso(T0 + FIVE), paused_at: null, credit_ms: 0,
    });
    expect(at(FIVE - 1).state).toBe('running');
    expect(at(FIVE).state).toBe('ended');
    expect(at(FIVE).ends_at).toBe(iso(T0 + FIVE));
    expect(at(FIVE + 10 * D).state).toBe('ended');
  });

  it('uses the policy window, not a constant', () => {
    const w = computeWindow([ready], { ...policy, window_ms: 1000 }, new Date(T0 + 999));
    expect(w.ends_at).toBe(iso(T0 + 1000));
  });

  it('6 h outage adds 6 h; 5 h 10 min outage adds 6 h (round up to hour)', () => {
    const run = (outage: number) =>
      computeWindow([ready, ev('delivery_failed', T0 + D), ev('delivery_restored', T0 + D + outage)], policy, new Date(T0 + 2 * D));
    const six = run(6 * H);
    expect(six).toMatchObject({ state: 'running', credit_ms: 6 * H, paused_at: null, ends_at: iso(T0 + FIVE + 6 * H), base_ends_at: iso(T0 + FIVE) });
    const odd = run(5 * H + 10 * 60_000);
    expect(odd.credit_ms).toBe(6 * H);
    expect(odd.ends_at).toBe(iso(T0 + FIVE + 6 * H));
  });

  it('a successful download_completed or reader_rendered by the system also resumes', () => {
    for (const kind of ['download_completed', 'reader_rendered'] as const) {
      const w = computeWindow([ready, ev('delivery_failed', T0 + D), ev(kind, T0 + D + 2 * H)], policy, new Date(T0 + 2 * D));
      expect(w, kind).toMatchObject({ state: 'running', credit_ms: 2 * H });
    }
  });

  it('paused window never ends', () => {
    const events = [ready, ev('delivery_failed', T0 + D)];
    for (const later of [FIVE, FIVE + 1, 100 * D, 10_000 * D]) {
      const w = computeWindow(events, policy, new Date(T0 + later));
      expect(w).toMatchObject({ state: 'paused', paused_at: iso(T0 + D), ends_at: iso(T0 + FIVE) });
    }
  });

  it('events that do not matter leave the window unchanged', () => {
    const base = computeWindow([ready], policy, new Date(T0 + D));
    for (const kind of ['link_issued', 'download_completed', 'download_aborted', 'reader_rendered', 'reader_beacon', 'delivery_restored'] as const) {
      expect(computeWindow([ready, ev(kind, T0 + 1000)], policy, new Date(T0 + D)), kind).toEqual(base);
    }
    // a second access_ready never restarts the clock
    expect(computeWindow([ready, ev('access_ready', T0 + 3 * D)], policy, new Date(T0 + D))).toEqual(base);
  });

  it('beacon changes nothing', () => {
    const paused = computeWindow([ready, ev('delivery_failed', T0 + D)], policy, new Date(T0 + 2 * D));
    for (const source of ['buyer', 'system'] as const) {
      const beacon = ev('reader_beacon', T0 + D + H, { source });
      expect(computeWindow([ready, ev('delivery_failed', T0 + D), beacon], policy, new Date(T0 + 2 * D))).toEqual(paused);
      expect(computeWindow([ready, beacon], policy, new Date(T0 + 2 * D))).toEqual(computeWindow([ready], policy, new Date(T0 + 2 * D)));
    }
  });

  it('a buyer-sourced event never changes the window', () => {
    const running = computeWindow([ready], policy, new Date(T0 + 2 * D));
    expect(computeWindow([ready, ev('delivery_failed', T0 + D, { source: 'buyer' })], policy, new Date(T0 + 2 * D))).toEqual(running);
    const failed = ev('delivery_failed', T0 + D);
    const paused = computeWindow([ready, failed], policy, new Date(T0 + 2 * D));
    for (const kind of ['delivery_restored', 'download_completed', 'reader_rendered'] as const) {
      expect(computeWindow([ready, failed, ev(kind, T0 + D + H, { source: 'buyer' })], policy, new Date(T0 + 2 * D)), kind).toEqual(paused);
    }
    expect(computeWindow([ready, { ...credit(T0 + D, H), source: 'buyer' }], policy, new Date(T0 + 2 * D))).toEqual(running);
  });

  it('credit extends the end; credit never reduces ends_at', () => {
    const base = computeWindow([ready], policy, new Date(T0 + D));
    const plus = computeWindow([ready, credit(T0 + D, 2 * H)], policy, new Date(T0 + D));
    expect(plus).toMatchObject({ credit_ms: 2 * H, ends_at: iso(T0 + FIVE + 2 * H) });
    for (const bad of [0, -1, -5 * H, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(computeWindow([ready, credit(T0 + D, bad)], policy, new Date(T0 + D)), String(bad)).toEqual(base);
    }
    expect(computeWindow([ready, ev('credit_granted', T0 + D, { evidence: { case_id: 'x' } })], policy, new Date(T0 + D))).toEqual(base);
    expect(computeWindow([ready, ev('credit_granted', T0 + D, { evidence: { credit_ms: '3600000' } })], policy, new Date(T0 + D))).toEqual(base);
  });

  it('credit before the end is honoured; credit at or after the end is not', () => {
    expect(computeWindow([ready, credit(T0 + FIVE - 1, H)], policy, new Date(T0 + FIVE)).state).toBe('running');
    const late = computeWindow([ready, credit(T0 + FIVE, H)], policy, new Date(T0 + FIVE + 1));
    expect(late).toMatchObject({ state: 'ended', credit_ms: 0, ends_at: iso(T0 + FIVE) });
  });

  it('credit while paused keeps it paused and extends the end', () => {
    const w = computeWindow([ready, ev('delivery_failed', T0 + D), credit(T0 + D + H, 3 * H)], policy, new Date(T0 + 3 * D));
    expect(w).toMatchObject({ state: 'paused', credit_ms: 3 * H, ends_at: iso(T0 + FIVE + 3 * H) });
  });

  it('credit total is capped at the 32-bit column limit', () => {
    const w = computeWindow([ready, credit(T0 + 1, 2_000_000_000), credit(T0 + 2, 2_000_000_000)], policy, new Date(T0 + 3));
    expect(w.credit_ms).toBe(2_147_483_647);
  });

  it('an event after the end finds the window ended', () => {
    const w = computeWindow([ready, ev('delivery_failed', T0 + FIVE + D)], policy, new Date(T0 + FIVE + 2 * D));
    expect(w).toMatchObject({ state: 'ended', paused_at: null, ends_at: iso(T0 + FIVE) });
  });

  it('window_ended ends a running window and is a no-op on a paused one', () => {
    expect(computeWindow([ready, ev('window_ended', T0 + FIVE)], policy, new Date(T0 + FIVE)).state).toBe('ended');
    expect(computeWindow([ready, ev('delivery_failed', T0 + D), ev('window_ended', T0 + FIVE)], policy, new Date(T0 + FIVE)).state).toBe('paused');
  });

  it('revoked is terminal and keeps the end', () => {
    const events = [ready, ev('revoked', T0 + D, { evidence: { reason: 'refund' } }), ev('delivery_restored', T0 + D + 1), credit(T0 + D + 2, H), ev('access_ready', T0 + D + 3)];
    const w = computeWindow(events, policy, new Date(T0 + 100 * D));
    expect(w).toMatchObject({ state: 'revoked', ends_at: iso(T0 + FIVE), credit_ms: 0, paused_at: null });
    // revoke after ended is still revoked
    expect(computeWindow([ready, ev('revoked', T0 + FIVE + D)], policy, new Date(T0 + FIVE + 2 * D)).state).toBe('revoked');
    // revoke before start
    expect(computeWindow([ev('revoked', T0)], policy, new Date(T0)).state).toBe('revoked');
  });

  it('sorts by time then keeps input order for equal times', () => {
    const a = computeWindow([ev('delivery_restored', T0 + D + H), ev('delivery_failed', T0 + D), ready], policy, new Date(T0 + 2 * D));
    expect(a).toMatchObject({ state: 'running', credit_ms: H });
    // same instant: insertion order decides (fail then restore => resumed with zero credit)
    const b = computeWindow([ready, ev('delivery_failed', T0 + D), ev('delivery_restored', T0 + D)], policy, new Date(T0 + 2 * D));
    expect(b).toMatchObject({ state: 'running', credit_ms: 0 });
    const c = computeWindow([ready, ev('delivery_restored', T0 + D), ev('delivery_failed', T0 + D)], policy, new Date(T0 + 2 * D));
    expect(c.state).toBe('paused');
  });

  it('does not modify its input', () => {
    const events = [ev('delivery_restored', T0 + D + H), ev('delivery_failed', T0 + D), ready];
    const copy = structuredClone(events);
    computeWindow(events, policy, new Date(T0));
    expect(events).toEqual(copy);
  });

  it('a second failure while paused keeps the first pause time', () => {
    const w = computeWindow([ready, ev('delivery_failed', T0 + D), ev('delivery_failed', T0 + D + 5 * H), ev('delivery_restored', T0 + D + 7 * H)], policy, new Date(T0 + 2 * D));
    expect(w.credit_ms).toBe(7 * H);
  });
});

describe('deriveAccessState', () => {
  const win = (state: ReturnType<typeof computeWindow>['state']) => ({ state, started_at: null, base_ends_at: null, ends_at: null, paused_at: null, credit_ms: 0 });
  it('maps money and window to access', () => {
    expect(deriveAccessState('captured', win('running'))).toBe('available');
    expect(deriveAccessState('captured', win('paused'))).toBe('available');
    expect(deriveAccessState('captured', win('not_started'))).toBe('locked');
    expect(deriveAccessState('captured', win('ended'))).toBe('ended');
    expect(deriveAccessState('captured', win('revoked'))).toBe('revoked');
    expect(deriveAccessState('refunded', win('running'))).toBe('revoked');
    expect(deriveAccessState('reversed', win('ended'))).toBe('revoked');
    for (const m of ['pending', 'denied', 'unknown'] as const) {
      expect(deriveAccessState(m, win('running'))).toBe('locked');
    }
  });
});

// ---- property tests -------------------------------------------------------------------------
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const KINDS: AccessEventKind[] = [
  'access_ready', 'link_issued', 'download_completed', 'download_aborted', 'reader_rendered', 'reader_beacon',
  'delivery_failed', 'delivery_restored', 'credit_granted', 'window_ended', 'revoked',
];
const SOURCES = ['system', 'buyer', 'operator'] as const;
const MONEY: MoneyState[] = ['pending', 'captured', 'denied', 'refunded', 'reversed', 'unknown'];

function randomSequence(next: () => number): AccessEvent[] {
  const n = 1 + Math.floor(next() * 12);
  let t = T0;
  const out: AccessEvent[] = [];
  for (let i = 0; i < n; i++) {
    t += Math.floor(next() * 2 * D);
    const kind = next() < 0.2 ? 'access_ready' : KINDS[Math.floor(next() * KINDS.length)]!;
    const source = SOURCES[Math.floor(next() * 3)]!;
    const evidence = kind === 'credit_granted' ? { credit_ms: Math.floor(next() * 12 * H) - H, case_id: 'cas_1' } : {};
    out.push(ev(kind, kind === 'revoked' && next() < 0.8 ? t + 40 * D : t, { source, evidence }));
  }
  return out;
}

describe('properties (2000 random event sequences)', () => {
  it('ends_at never decreases', () => {
    const next = rng(20261021);
    for (let i = 0; i < 2000; i++) {
      const events = randomSequence(next);
      let prevEnd: number | null = null;
      for (let k = 1; k <= events.length; k++) {
        const prefix = events.slice(0, k);
        const now = new Date(Date.parse(events[k - 1]!.at) + Math.floor(next() * 3 * D));
        const w = computeWindow(prefix, policy, now);
        if (w.ends_at !== null) {
          const end = Date.parse(w.ends_at);
          if (prevEnd !== null) expect(end, `seq ${i} prefix ${k}`).toBeGreaterThanOrEqual(prevEnd);
          prevEnd = end;
        } else {
          expect(prevEnd, `seq ${i} prefix ${k}`).toBeNull();
        }
        expect(w.credit_ms).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('ends_at is the same at every later now (time only moves the state, never the end)', () => {
    const next = rng(77);
    for (let i = 0; i < 2000; i++) {
      const events = randomSequence(next);
      const at = (d: number) => computeWindow(events, policy, new Date(T0 + d));
      const a = at(0);
      const b = at(200 * D);
      expect(b.ends_at, `seq ${i}`).toBe(a.ends_at);
      expect(b.credit_ms).toBe(a.credit_ms);
    }
  });

  it('available implies money captured', () => {
    const next = rng(5);
    for (let i = 0; i < 2000; i++) {
      const events = randomSequence(next);
      const now = new Date(T0 + Math.floor(next() * 30 * D));
      const w = computeWindow(events, policy, now);
      const money = MONEY[Math.floor(next() * MONEY.length)]!;
      const access = deriveAccessState(money, w);
      if (access === 'available') expect(money, `seq ${i}`).toBe('captured');
      if (money === 'refunded' || money === 'reversed') expect(access).toBe('revoked');
    }
  });

  it('paused_at is set exactly while paused', () => {
    const next = rng(9);
    for (let i = 0; i < 2000; i++) {
      const events = randomSequence(next);
      const w = computeWindow(events, policy, new Date(T0 + 300 * D));
      if (w.state === 'paused') expect(w.paused_at).not.toBeNull();
      else expect(w.paused_at).toBeNull();
      if (w.state === 'not_started') expect(w.started_at).toBeNull();
      if (['running', 'paused', 'ended'].includes(w.state)) expect(w.started_at).not.toBeNull();
    }
  });
});
