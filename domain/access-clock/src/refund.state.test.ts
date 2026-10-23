// CO-5 (ASM-59) state tests: R3, R5 and R6 through the database writers (grantCredit,
// markAccessReady, revokeWindow, recordDeliveryEvent), with event order by (at, seq).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  computeWindow,
  grantCredit,
  markAccessReady,
  recordDeliveryEvent,
  revokeWindow,
  sweepWindows,
} from './index';
import { insertEvent, loadEvents, materialise, requireEntitlement } from './events';
import { FIVE_DAYS_MS, HASH, makeWorld, policyFor, START } from './world';
import type { World } from './world';

const H = 3_600_000;
const D = 24 * H;
const T0 = Date.parse(START);
let w: World;
beforeAll(async () => {
  w = await makeWorld('rfs');
});
afterAll(async () => {
  await w.close();
});
beforeEach(async () => {
  await w.reset();
  w.clock.set(START);
});

const evidence = { capture_id: 'CAP1', content_sha256: HASH, link_probe: 'ok' as const };
const ready = (id: string) =>
  w.db.transaction((tx) => markAccessReady(tx, w.deps, { entitlement_id: id, evidence }));
const revoke = (id: string, reason: 'refund' | 'reversal' = 'refund') =>
  w.db.transaction((tx) => revokeWindow(tx, w.deps, { entitlement_id: id, reason }));
const by = { kind: 'operator' as const, operator_id: 'opr_1', mfa: true };
const grant = (id: string, credit_ms: number) =>
  w.db.transaction((tx) =>
    grantCredit(tx, w.deps, { entitlement_id: id, credit_ms, case_id: 'cas_1', by }),
  );
const delivery = (id: string, kind: 'delivery_failed' | 'delivery_restored') =>
  recordDeliveryEvent(w.deps, {
    entitlement_id: id,
    kind,
    link_id: null,
    source: 'system',
    evidence: {},
  });
const winRow = async (id: string) =>
  (
    await w.db.query<{
      state: string;
      started_at: Date | null;
      base_ends_at: Date | null;
      ends_at: Date | null;
      paused_at: Date | null;
      credit_ms: number;
    }>(
      'SELECT state, started_at, base_ends_at, ends_at, paused_at, credit_ms FROM access_windows WHERE entitlement_id = $1',
      [id],
    )
  ).rows[0]!;
const events = async (id: string) =>
  (
    await w.db.query<{ seq: number; kind: string; at: Date }>(
      'SELECT seq, kind, at FROM access_events WHERE entitlement_id = $1 ORDER BY at, seq',
      [id],
    )
  ).rows;
const kinds = async (id: string) => (await events(id)).map((e) => e.kind);
const access = async (id: string) =>
  (
    await w.db.query<{ access_state: string }>(
      'SELECT access_state FROM entitlements WHERE id = $1',
      [id],
    )
  ).rows[0]!.access_state;
/** What an applied full refund leaves in the money row; applyMoneyEvent does this, then revokeWindow. */
const markRefunded = (id: string, money: 'refunded' | 'reversed' = 'refunded') =>
  w.db.query(
    `UPDATE entitlements SET money_state = $2, access_state = 'revoked', licence_state = 'terminated' WHERE id = $1`,
    [id, money],
  );

describe('R3: grantCredit on a revoked or ended window answers window_ended and writes nothing', () => {
  it('revoked window: window_ended, no event, window row unchanged', async () => {
    const id = await w.rawEntitlement(1);
    await ready(id);
    w.clock.advance(D);
    await revoke(id);
    const before = { win: await winRow(id), kinds: await kinds(id) };
    w.clock.advance(D);
    expect(await grant(id, 2 * H)).toEqual({ ok: false, error: { code: 'window_ended' } });
    expect(await kinds(id)).toEqual(before.kinds);
    expect(await kinds(id)).not.toContain('credit_granted');
    expect(await winRow(id)).toEqual(before.win);
    expect(await access(id)).toBe('revoked');
  });

  it('a window revoked before it ever started: window_ended too (revoked wins over not started)', async () => {
    const id = await w.rawEntitlement(1);
    await revoke(id);
    expect(await grant(id, H)).toEqual({ ok: false, error: { code: 'window_ended' } });
    expect(await kinds(id)).toEqual(['revoked']);
  });

  it('ended by time (before the sweep) and ended by the sweep: window_ended, nothing written', async () => {
    const id = await w.rawEntitlement(1);
    await ready(id);
    w.clock.advance(FIVE_DAYS_MS + H);
    expect(await grant(id, H)).toEqual({ ok: false, error: { code: 'window_ended' } });
    expect(await sweepWindows(w.deps, { max_items: 5 })).toEqual({ ended: 1 });
    expect(await grant(id, H)).toEqual({ ok: false, error: { code: 'window_ended' } });
    expect(await kinds(id)).toEqual(['access_ready', 'window_ended']);
  });

  it('a credit on a running window only raises ends_at, by exactly the credit', async () => {
    const id = await w.rawEntitlement(1);
    await ready(id);
    const before = (await winRow(id)).ends_at!.getTime();
    const r = await grant(id, 3 * H);
    expect(r.ok).toBe(true);
    const after = (await winRow(id)).ends_at!.getTime();
    expect(after).toBe(before + 3 * H);
    // A second, smaller credit still only adds.
    await grant(id, 1);
    expect((await winRow(id)).ends_at!.getTime()).toBe(after + 1);
  });

  it('a credit granted before the revoke stays in history after it', async () => {
    const id = await w.rawEntitlement(1);
    await ready(id);
    await grant(id, 2 * H);
    w.clock.advance(D);
    const r = await revoke(id);
    expect(r).toMatchObject({ state: 'revoked', credit_ms: 2 * H });
    expect(new Date(r.ends_at!).getTime()).toBe(T0 + FIVE_DAYS_MS + 2 * H);
    expect(await kinds(id)).toEqual(['access_ready', 'credit_granted', 'revoked']);
  });
});

describe('R5: a window starts after a partial refund, never after a full refund', () => {
  it('money captured (a partial refund leaves it captured): the window starts', async () => {
    const id = await w.rawEntitlement(1, { money_state: 'captured' });
    const r = await ready(id);
    expect(r).toMatchObject({ state: 'running', started_at: START });
    expect(await access(id)).toBe('available');
  });

  it('money refunded or reversed: refuses with money_not_captured and writes nothing', async () => {
    for (const money of ['refunded', 'reversed'] as const) {
      await w.reset();
      const id = await w.rawEntitlement(1, { money_state: money });
      await expect(ready(id), money).rejects.toThrow(/money_not_captured/);
      expect(await kinds(id)).toEqual([]);
      expect(await winRow(id)).toMatchObject({ state: 'not_started', started_at: null });
    }
  });

  it('every money state but captured refuses with money_not_captured', async () => {
    for (const money of ['pending', 'unknown', 'denied', 'refunded', 'reversed']) {
      await w.reset();
      const id = await w.rawEntitlement(1, { money_state: money });
      await expect(ready(id), money).rejects.toThrow(/money_not_captured/);
    }
  });

  it('a refund that arrives before the window starts blocks the start; the revoke stays', async () => {
    const id = await w.rawEntitlement(1);
    await markRefunded(id);
    await revoke(id);
    await expect(ready(id)).rejects.toThrow(/money_not_captured/);
    expect(await winRow(id)).toMatchObject({ state: 'revoked', started_at: null, ends_at: null });
    expect(await access(id)).toBe('revoked');
    expect(await kinds(id)).toEqual(['revoked']);
  });
});

describe('R6: a paused window that is revoked keeps its ends_at and earns no credit', () => {
  it('delivery_failed, revoke, then delivery_restored: no restoration credit, ends_at as before the pause', async () => {
    const id = await w.rawEntitlement(1);
    await ready(id);
    w.clock.advance(D);
    await delivery(id, 'delivery_failed');
    w.clock.advance(2 * D);
    await markRefunded(id);
    const revoked = await revoke(id);
    expect(revoked).toMatchObject({ state: 'revoked', credit_ms: 0, paused_at: null });
    w.clock.advance(D);
    const restored = await delivery(id, 'delivery_restored');
    expect(restored).toMatchObject({ state: 'revoked', credit_ms: 0 });
    const row = await winRow(id);
    expect(row.state).toBe('revoked');
    expect(row.credit_ms).toBe(0);
    expect(row.ends_at!.getTime()).toBe(T0 + FIVE_DAYS_MS);
    expect(row.base_ends_at!.getTime()).toBe(T0 + FIVE_DAYS_MS);
    expect(row.paused_at).toBeNull();
    expect(await access(id)).toBe('revoked');
    expect(await kinds(id)).toEqual([
      'access_ready',
      'delivery_failed',
      'revoked',
      'delivery_restored',
    ]);
  });

  it('a credit after a paused window is revoked is refused', async () => {
    const id = await w.rawEntitlement(1);
    await ready(id);
    await delivery(id, 'delivery_failed');
    await revoke(id);
    expect(await grant(id, H)).toEqual({ ok: false, error: { code: 'window_ended' } });
    expect((await winRow(id)).credit_ms).toBe(0);
  });
});

describe('event order is (at, seq)', () => {
  const rawEvent = async (id: string, kind: 'credit_granted' | 'revoked', atMs: number) => {
    await w.db.transaction(async (tx) => {
      await insertEvent(tx, w.deps, {
        entitlement_id: id,
        kind,
        link_id: null,
        source: kind === 'revoked' ? 'system' : 'operator',
        evidence: kind === 'revoked' ? { reason: 'refund' } : { credit_ms: 2 * H, case_id: 'c' },
        at: new Date(atMs),
      });
      await materialise(tx, w.deps, await requireEntitlement(tx, id));
    });
  };

  it('same instant: a credit inserted before the revoke counts, after the revoke does not', async () => {
    const at = T0 + D;
    const a = await w.rawEntitlement(1);
    await ready(a);
    w.clock.set(new Date(at).toISOString());
    await rawEvent(a, 'credit_granted', at);
    await rawEvent(a, 'revoked', at);
    expect(await winRow(a)).toMatchObject({ state: 'revoked', credit_ms: 2 * H });

    const b = await w.rawEntitlement(2);
    w.clock.set(START);
    await ready(b);
    w.clock.set(new Date(at).toISOString());
    await rawEvent(b, 'revoked', at);
    await rawEvent(b, 'credit_granted', at);
    expect(await winRow(b)).toMatchObject({ state: 'revoked', credit_ms: 0 });
  });

  it('loadEvents returns the log in (at, seq) order and the stored row equals computeWindow of it', async () => {
    const id = await w.rawEntitlement(1);
    await ready(id);
    w.clock.advance(H);
    await delivery(id, 'delivery_failed');
    w.clock.advance(H);
    await delivery(id, 'delivery_restored');
    await grant(id, H);
    w.clock.advance(H);
    await revoke(id);
    const log = await w.db.transaction((tx) => loadEvents(tx, id));
    expect(log.map((e) => e.kind)).toEqual(await kinds(id));
    const head = await w.db.transaction((tx) => requireEntitlement(tx, id));
    const expected = computeWindow(log, head.policy, new Date(w.clock.now()));
    const row = await winRow(id);
    expect(row.ends_at!.toISOString()).toBe(expected.ends_at);
    expect(row.credit_ms).toBe(expected.credit_ms);
    expect(row.state).toBe(expected.state);
    expect(policyFor('keep_retrieve').window_ms).toBe(FIVE_DAYS_MS);
  });
});
