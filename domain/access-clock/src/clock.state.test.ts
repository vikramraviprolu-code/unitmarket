// State tests for the access clock against a real (PGlite) database.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  computeWindow, grantCredit, markAccessReady, recordDeliveryEvent, revokeWindow, sweepWindows,
} from './index';
import { FIVE_DAYS_MS, HASH, makeWorld, policyFor, START } from './world';
import type { World } from './world';

const H = 3_600_000;
const D = 24 * H;
const T0 = Date.parse(START);
let w: World;
beforeAll(async () => {
  w = await makeWorld('clk');
});
afterAll(async () => {
  await w.close();
});
beforeEach(async () => {
  await w.reset();
  w.clock.set(START);
});

const evidence = { capture_id: 'CAP1', content_sha256: HASH, link_probe: 'ok' as const };
const ready = (id: string) => w.db.transaction((tx) => markAccessReady(tx, w.deps, { entitlement_id: id, evidence }));
const win = async (id: string) =>
  (await w.db.query<{ state: string; started_at: Date | null; ends_at: Date | null; paused_at: Date | null; credit_ms: number }>(
    'SELECT state, started_at, ends_at, paused_at, credit_ms FROM access_windows WHERE entitlement_id = $1', [id])).rows[0]!;
const access = async (id: string) =>
  (await w.db.query<{ access_state: string }>('SELECT access_state FROM entitlements WHERE id = $1', [id])).rows[0]!.access_state;
const kinds = async (id: string) =>
  (await w.db.query<{ kind: string }>('SELECT kind FROM access_events WHERE entitlement_id = $1 ORDER BY at, ctid', [id])).rows.map((r) => r.kind);
const delivery = (id: string, kind: Parameters<typeof recordDeliveryEvent>[1]['kind'], link_id: string | null = null, source: 'system' | 'buyer' = 'system') =>
  recordDeliveryEvent(w.deps, { entitlement_id: id, kind, link_id, source, evidence: {} });
const ms = (d: Date | null) => (d === null ? null : d.getTime());

describe('markAccessReady', () => {
  it('markAccessReady refused unless money captured', async () => {
    for (const money of ['pending', 'denied', 'unknown', 'refunded', 'reversed']) {
      await w.reset();
      const id = await w.rawEntitlement(1, { money_state: money });
      await expect(ready(id), money).rejects.toThrow(/captured/);
      expect(await win(id)).toMatchObject({ state: 'not_started', started_at: null });
      expect(await kinds(id)).toEqual([]);
      expect(await access(id)).toBe('locked');
    }
  });

  it('starts the five-day window, records the evidence and makes access available', async () => {
    const id = await w.rawEntitlement(1);
    const window = await ready(id);
    expect(window).toEqual({
      state: 'running', started_at: START, base_ends_at: new Date(T0 + FIVE_DAYS_MS).toISOString(),
      ends_at: new Date(T0 + FIVE_DAYS_MS).toISOString(), paused_at: null, credit_ms: 0,
    });
    expect(await access(id)).toBe('available');
    const e = await w.db.query<{ kind: string; source: string; evidence: Record<string, unknown> }>(
      'SELECT kind, source, evidence FROM access_events WHERE entitlement_id = $1', [id]);
    expect(e.rows).toEqual([{ kind: 'access_ready', source: 'system', evidence }]);
    expect(ms((await win(id)).ends_at)).toBe(T0 + FIVE_DAYS_MS);
  });

  it('a second call keeps the first start (never restarts the clock)', async () => {
    const id = await w.rawEntitlement(1);
    const first = await ready(id);
    w.clock.advance(2 * D);
    const second = await ready(id);
    expect(second).toEqual(first);
    expect(await kinds(id)).toEqual(['access_ready']);
  });

  it('is refused for an unknown entitlement', async () => {
    await expect(ready('ent_nope')).rejects.toThrow(/unknown/);
  });
});

describe('re-issued links (A-18)', () => {
  it('re-issued link 4 days later keeps the same ends_at', async () => {
    const id = await w.rawEntitlement(1);
    await w.rawLink('lnk_1', id);
    await w.rawLink('lnk_2', id);
    const first = await ready(id);
    await delivery(id, 'link_issued', 'lnk_1');
    w.clock.advance(4 * D);
    const after = await delivery(id, 'link_issued', 'lnk_2');
    expect(after.ends_at).toBe(first.ends_at);
    expect(after.state).toBe('running');
    expect(ms((await win(id)).ends_at)).toBe(T0 + FIVE_DAYS_MS);
    expect(await kinds(id)).toEqual(['access_ready', 'link_issued', 'link_issued']);
  });

  it('the same delivery event for the same link twice is recorded once', async () => {
    const id = await w.rawEntitlement(1);
    await w.rawLink('lnk_1', id);
    await ready(id);
    await delivery(id, 'download_completed', 'lnk_1');
    await delivery(id, 'download_completed', 'lnk_1');
    expect((await kinds(id)).filter((k) => k === 'download_completed')).toHaveLength(1);
  });
});

describe('lost time', () => {
  it('a 6 h outage adds 6 h to the stored window', async () => {
    const id = await w.rawEntitlement(1);
    await ready(id);
    w.clock.advance(D);
    expect((await delivery(id, 'delivery_failed')).state).toBe('paused');
    expect(await access(id)).toBe('available');
    w.clock.advance(6 * H);
    const r = await delivery(id, 'delivery_restored');
    expect(r).toMatchObject({ state: 'running', credit_ms: 6 * H, paused_at: null });
    expect(ms((await win(id)).ends_at)).toBe(T0 + FIVE_DAYS_MS + 6 * H);
  });

  it('a paused window is not ended by the sweep, however late', async () => {
    const id = await w.rawEntitlement(1);
    await ready(id);
    w.clock.advance(D);
    await delivery(id, 'delivery_failed');
    w.clock.advance(30 * D);
    expect(await sweepWindows(w.deps, { max_items: 10 })).toEqual({ ended: 0 });
    expect((await win(id)).state).toBe('paused');
    expect(await access(id)).toBe('available');
  });

  it('buyer-sourced signals do not change the window', async () => {
    const id = await w.rawEntitlement(1);
    await ready(id);
    w.clock.advance(D);
    expect((await delivery(id, 'delivery_failed', null, 'buyer')).state).toBe('running');
    expect((await delivery(id, 'reader_beacon', null, 'buyer')).state).toBe('running');
    await delivery(id, 'delivery_failed');
    w.clock.advance(2 * H);
    expect((await delivery(id, 'delivery_restored', null, 'buyer')).state).toBe('paused');
    expect((await delivery(id, 'reader_beacon', null, 'buyer')).state).toBe('paused');
  });

  it('refuses an unknown entitlement', async () => {
    await expect(delivery('ent_nope', 'delivery_failed')).rejects.toThrow(/unknown/);
  });
});

describe('grantCredit', () => {
  const by = { kind: 'operator' as const, operator_id: 'opr_1', mfa: true };
  const grant = (id: string, credit_ms: number) =>
    w.db.transaction((tx) => grantCredit(tx, w.deps, { entitlement_id: id, credit_ms, case_id: 'cas_1', by }));

  it('adds the credit and keeps the case id as evidence', async () => {
    const id = await w.rawEntitlement(1);
    await ready(id);
    const r = await grant(id, 2 * H);
    expect(r.ok && r.value).toMatchObject({ state: 'running', credit_ms: 2 * H });
    expect(ms((await win(id)).ends_at)).toBe(T0 + FIVE_DAYS_MS + 2 * H);
    const e = await w.db.query<{ source: string; evidence: Record<string, unknown> }>(
      "SELECT source, evidence FROM access_events WHERE kind = 'credit_granted'");
    expect(e.rows[0]).toMatchObject({ source: 'operator', evidence: { credit_ms: 2 * H, case_id: 'cas_1' } });
  });

  it('refuses a non-positive credit and a window that has not started', async () => {
    const id = await w.rawEntitlement(1);
    expect(await grant(id, 1)).toEqual({ ok: false, error: { code: 'window_not_started' } });
    await ready(id);
    for (const bad of [0, -1, -H, 0.5, Number.NaN]) {
      expect(await grant(id, bad), String(bad)).toEqual({ ok: false, error: { code: 'credit_must_be_positive' } });
    }
    expect(await kinds(id)).toEqual(['access_ready']);
  });

  it('a buyer cannot grant a credit', async () => {
    const id = await w.rawEntitlement(1);
    await ready(id);
    await expect(
      w.db.transaction((tx) => grantCredit(tx, w.deps, { entitlement_id: id, credit_ms: H, case_id: 'cas_1', by: { kind: 'buyer', buyer_id: 'buy_1' } })),
    ).rejects.toThrow(/actor/);
    expect((await win(id)).credit_ms).toBe(0);
  });
});

describe('revokeWindow', () => {
  it('revokes the window and the access, once', async () => {
    const id = await w.rawEntitlement(1);
    await ready(id);
    w.clock.advance(D);
    const r = await w.db.transaction((tx) => revokeWindow(tx, w.deps, { entitlement_id: id, reason: 'refund' }));
    expect(r.state).toBe('revoked');
    expect(await access(id)).toBe('revoked');
    const again = await w.db.transaction((tx) => revokeWindow(tx, w.deps, { entitlement_id: id, reason: 'reversal' }));
    expect(again).toEqual(r);
    expect((await kinds(id)).filter((k) => k === 'revoked')).toHaveLength(1);
  });
  it('a revoked window cannot be restarted or extended', async () => {
    const id = await w.rawEntitlement(1);
    await ready(id);
    await w.db.transaction((tx) => revokeWindow(tx, w.deps, { entitlement_id: id, reason: 'refund' }));
    const r = await ready(id);
    expect(r.state).toBe('revoked');
    expect((await delivery(id, 'delivery_failed')).state).toBe('revoked');
  });
});

describe('sweepWindows', () => {
  it('sweep ends windows at ends_at and records window_ended once', async () => {
    const id = await w.rawEntitlement(1);
    await ready(id);
    w.clock.advance(FIVE_DAYS_MS - 1);
    expect(await sweepWindows(w.deps, { max_items: 10 })).toEqual({ ended: 0 });
    expect((await win(id)).state).toBe('running');
    w.clock.advance(1);
    expect(await sweepWindows(w.deps, { max_items: 10 })).toEqual({ ended: 1 });
    expect(await sweepWindows(w.deps, { max_items: 10 })).toEqual({ ended: 0 });
    expect((await win(id)).state).toBe('ended');
    expect(await access(id)).toBe('ended');
    expect(await kinds(id)).toEqual(['access_ready', 'window_ended']);
    const at = await w.db.query<{ at: Date }>("SELECT at FROM access_events WHERE kind = 'window_ended'");
    expect(at.rows[0]!.at.getTime()).toBe(T0 + FIVE_DAYS_MS);
  });

  it('honours credit: a credited window ends later', async () => {
    const id = await w.rawEntitlement(1);
    await ready(id);
    await w.db.transaction((tx) => grantCredit(tx, w.deps, { entitlement_id: id, credit_ms: 6 * H, case_id: 'cas_1', by: { kind: 'system' } }));
    w.clock.advance(FIVE_DAYS_MS);
    expect(await sweepWindows(w.deps, { max_items: 10 })).toEqual({ ended: 0 });
    w.clock.advance(6 * H);
    expect(await sweepWindows(w.deps, { max_items: 10 })).toEqual({ ended: 1 });
  });

  it('stops at max_items and the next call finishes the rest', async () => {
    const ids = [];
    for (let n = 1; n <= 3; n++) {
      const id = await w.rawEntitlement(n);
      await ready(id);
      ids.push(id);
    }
    w.clock.advance(FIVE_DAYS_MS);
    expect(await sweepWindows(w.deps, { max_items: 2 })).toEqual({ ended: 2 });
    expect(await sweepWindows(w.deps, { max_items: 2 })).toEqual({ ended: 1 });
    expect(await sweepWindows(w.deps, { max_items: 2 })).toEqual({ ended: 0 });
  });

  it('skips revoked windows', async () => {
    const id = await w.rawEntitlement(1);
    await ready(id);
    await w.db.transaction((tx) => revokeWindow(tx, w.deps, { entitlement_id: id, reason: 'refund' }));
    w.clock.advance(FIVE_DAYS_MS * 2);
    expect(await sweepWindows(w.deps, { max_items: 10 })).toEqual({ ended: 0 });
    expect(await kinds(id)).toEqual(['access_ready', 'revoked']);
  });

  it('an event that finds the window already past its end still gets a window_ended record from the sweep', async () => {
    const id = await w.rawEntitlement(1);
    await ready(id);
    w.clock.advance(FIVE_DAYS_MS + D);
    await delivery(id, 'link_issued');
    expect((await win(id)).state).toBe('ended');
    expect(await sweepWindows(w.deps, { max_items: 10 })).toEqual({ ended: 1 });
    expect(await sweepWindows(w.deps, { max_items: 10 })).toEqual({ ended: 0 });
  });
});

describe('materialised row equals recomputed', () => {
  it('after every step of a mixed scenario', async () => {
    const id = await w.rawEntitlement(1);
    const check = async () => {
      const rows = await w.db.query<{ kind: string; at: Date; source: 'system' | 'buyer' | 'operator'; evidence: Record<string, string | number | boolean | null> }>(
        'SELECT kind, at, source, evidence FROM access_events WHERE entitlement_id = $1 ORDER BY at, ctid', [id]);
      const events = rows.rows.map((r) => ({ entitlement_id: id, kind: r.kind as never, at: r.at.toISOString(), source: r.source, evidence: r.evidence }));
      const expected = computeWindow(events, policyFor('keep_retrieve'), w.clock.now());
      const row = await win(id);
      expect({
        state: row.state, started_at: row.started_at?.toISOString() ?? null, ends_at: row.ends_at?.toISOString() ?? null,
        paused_at: row.paused_at?.toISOString() ?? null, credit_ms: row.credit_ms,
      }).toEqual({ state: expected.state, started_at: expected.started_at, ends_at: expected.ends_at, paused_at: expected.paused_at, credit_ms: expected.credit_ms });
    };
    await check();
    await ready(id); await check();
    w.clock.advance(D); await delivery(id, 'delivery_failed'); await check();
    w.clock.advance(5 * H + 10 * 60_000); await delivery(id, 'delivery_restored'); await check();
    await w.db.transaction((tx) => grantCredit(tx, w.deps, { entitlement_id: id, credit_ms: H, case_id: 'c', by: { kind: 'system' } })); await check();
    w.clock.advance(5 * D); await sweepWindows(w.deps, { max_items: 5 }); await check();
  });
});
