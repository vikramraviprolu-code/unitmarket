// CO-5b (ASM-62) state tests: event time is monotonic per entitlement. A clock that steps back
// must never put a new event before an earlier one, because computeWindow sorts by `at`.
// Probe P1 from the CO-5 review: ready T0, delivery_failed T+10h, full refund T+48h, clock set back
// to T+30h, delivery_restored -> the revoked window gained 20 h of credit.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  grantCredit,
  markAccessReady,
  recordDeliveryEvent,
  revokeWindow,
  sweepWindows,
} from './index';
import { FIVE_DAYS_MS, HASH, makeWorld, START } from './world';
import type { World } from './world';

const H = 3_600_000;
const T0 = Date.parse(START);
let w: World;
beforeAll(async () => {
  w = await makeWorld('mono');
});
afterAll(async () => {
  await w.close();
});
beforeEach(async () => {
  await w.reset();
  w.clock.set(START);
});

const at = (ms: number) => new Date(T0 + ms).toISOString();
const evidence = { capture_id: 'CAP1', content_sha256: HASH, link_probe: 'ok' as const };
const ready = (id: string) =>
  w.db.transaction((tx) => markAccessReady(tx, w.deps, { entitlement_id: id, evidence }));
const revoke = (id: string, reason: 'refund' | 'reversal' = 'refund') =>
  w.db.transaction((tx) => revokeWindow(tx, w.deps, { entitlement_id: id, reason }));
const delivery = (
  id: string,
  kind: 'delivery_failed' | 'delivery_restored' | 'reader_beacon',
  source: 'system' | 'buyer' = 'system',
) =>
  recordDeliveryEvent(w.deps, {
    entitlement_id: id,
    kind,
    link_id: null,
    source,
    evidence: {},
  });
const winRow = async (id: string) =>
  (
    await w.db.query<{
      state: string;
      ends_at: Date | null;
      paused_at: Date | null;
      credit_ms: number;
      updated_at: Date;
    }>(
      'SELECT state, ends_at, paused_at, credit_ms, updated_at FROM access_windows WHERE entitlement_id = $1',
      [id],
    )
  ).rows[0]!;
const log = async (id: string) =>
  (
    await w.db.query<{ seq: number; kind: string; at: Date }>(
      'SELECT seq, kind, at FROM access_events WHERE entitlement_id = $1 ORDER BY seq',
      [id],
    )
  ).rows;
const access = async (id: string) =>
  (
    await w.db.query<{ access_state: string }>(
      'SELECT access_state FROM entitlements WHERE id = $1',
      [id],
    )
  ).rows[0]!.access_state;

describe('P1: a clock that steps back cannot reopen a revoked window', () => {
  it('delivery_restored recorded at T+30h after a full refund at T+48h earns no credit', async () => {
    const id = await w.rawEntitlement(1);
    await ready(id);
    w.clock.set(at(10 * H));
    await delivery(id, 'delivery_failed');
    w.clock.set(at(48 * H));
    await revoke(id);
    const before = await winRow(id);
    w.clock.set(at(30 * H));
    const r = await delivery(id, 'delivery_restored');
    expect(r).toMatchObject({ state: 'revoked', credit_ms: 0, paused_at: null });
    const after = await winRow(id);
    expect(after.state).toBe('revoked');
    expect(after.credit_ms).toBe(0);
    expect(after.ends_at!.getTime()).toBe(T0 + FIVE_DAYS_MS);
    expect(after.ends_at).toEqual(before.ends_at);
    expect(await access(id)).toBe('revoked');
  });

  it('even 1 ms of skew adds nothing (ceilToHour would add a whole hour)', async () => {
    const id = await w.rawEntitlement(1);
    await ready(id);
    w.clock.set(at(10 * H));
    await delivery(id, 'delivery_failed');
    w.clock.set(at(48 * H));
    await revoke(id);
    w.clock.set(at(48 * H - 1));
    await delivery(id, 'delivery_restored');
    expect((await winRow(id)).credit_ms).toBe(0);
    expect((await winRow(id)).ends_at!.getTime()).toBe(T0 + FIVE_DAYS_MS);
  });

  it('a reversal, then a stepped-back restoration: same result', async () => {
    const id = await w.rawEntitlement(1);
    await ready(id);
    w.clock.set(at(10 * H));
    await delivery(id, 'delivery_failed');
    w.clock.set(at(48 * H));
    await revoke(id, 'reversal');
    w.clock.set(at(11 * H));
    await delivery(id, 'delivery_restored');
    expect(await winRow(id)).toMatchObject({ state: 'revoked', credit_ms: 0 });
  });

  it('a stepped-back credit after the revoke is refused and writes nothing', async () => {
    const id = await w.rawEntitlement(1);
    await ready(id);
    w.clock.set(at(48 * H));
    await revoke(id);
    const n = (await log(id)).length;
    w.clock.set(at(30 * H));
    const r = await w.db.transaction((tx) =>
      grantCredit(tx, w.deps, {
        entitlement_id: id,
        credit_ms: H,
        case_id: 'c',
        by: { kind: 'system' },
      }),
    );
    expect(r).toEqual({ ok: false, error: { code: 'window_ended' } });
    expect(await log(id)).toHaveLength(n);
  });

  it('a stepped-back access_ready cannot revive a revoked window that never started', async () => {
    const id = await w.rawEntitlement(1);
    w.clock.set(at(48 * H));
    await revoke(id);
    w.clock.set(at(H));
    await ready(id);
    expect((await winRow(id)).state).toBe('revoked');
  });
});

describe('every new event is stamped at or after the last event', () => {
  it('stored `at` never decreases in insertion order, whatever the clock does', async () => {
    const id = await w.rawEntitlement(1);
    const steps: [number, () => Promise<unknown>][] = [
      [0, () => ready(id)],
      [10 * H, () => delivery(id, 'delivery_failed')],
      [4 * H, () => delivery(id, 'reader_beacon', 'buyer')],
      [20 * H, () => delivery(id, 'delivery_restored')],
      [2 * H, () => delivery(id, 'delivery_failed')],
      [48 * H, () => revoke(id)],
      [1 * H, () => delivery(id, 'delivery_restored')],
    ];
    for (const [t, run] of steps) {
      w.clock.set(at(t));
      await run();
    }
    const rows = await log(id);
    for (let n = 1; n < rows.length; n += 1) {
      expect(rows[n]!.at.getTime(), `event ${n} (${rows[n]!.kind})`).toBeGreaterThanOrEqual(
        rows[n - 1]!.at.getTime(),
      );
    }
  });

  it('a stepped-back restoration on a live paused window counts from the pause, never negative', async () => {
    const id = await w.rawEntitlement(1);
    await ready(id);
    w.clock.set(at(10 * H));
    await delivery(id, 'delivery_failed');
    w.clock.set(at(5 * H));
    const r = await delivery(id, 'delivery_restored');
    expect(r).toMatchObject({ state: 'running', credit_ms: 0 });
    expect((await winRow(id)).ends_at!.getTime()).toBe(T0 + FIVE_DAYS_MS);
  });

  it('the sweep keeps its explicit past `at`: window_ended is stored at ends_at, not at the last event', async () => {
    const id = await w.rawEntitlement(1);
    await ready(id);
    w.clock.set(at(FIVE_DAYS_MS - H));
    await delivery(id, 'reader_beacon', 'buyer');
    w.clock.set(at(FIVE_DAYS_MS + 3 * H));
    expect(await sweepWindows(w.deps, { max_items: 5 })).toEqual({ ended: 1 });
    const rows = await log(id);
    const ended = rows.find((r) => r.kind === 'window_ended')!;
    expect(ended.at.getTime()).toBe(T0 + FIVE_DAYS_MS);
    // Later events, even with the clock back, cannot move an ended window.
    w.clock.set(at(H));
    await delivery(id, 'delivery_failed');
    expect((await winRow(id)).state).toBe('ended');
  });
});

describe('same-instant ties are ordered by seq', () => {
  it('failure then restoration at one instant: no credit, window running', async () => {
    const id = await w.rawEntitlement(1);
    await ready(id);
    w.clock.set(at(10 * H));
    await delivery(id, 'delivery_failed');
    const r = await delivery(id, 'delivery_restored');
    expect(r).toMatchObject({ state: 'running', credit_ms: 0, paused_at: null });
  });

  it('restoration then failure at one instant: the window ends up paused', async () => {
    const id = await w.rawEntitlement(1);
    await ready(id);
    w.clock.set(at(10 * H));
    await delivery(id, 'delivery_restored');
    const r = await delivery(id, 'delivery_failed');
    expect(r).toMatchObject({ state: 'paused', credit_ms: 0 });
    expect((await winRow(id)).paused_at!.getTime()).toBe(T0 + 10 * H);
  });

  it('a revoke and a restoration at one instant: revoked either way, no credit', async () => {
    for (const revokeFirst of [true, false]) {
      await w.reset();
      w.clock.set(START);
      const id = await w.rawEntitlement(1);
      await ready(id);
      w.clock.set(at(H));
      await delivery(id, 'delivery_failed');
      w.clock.set(at(10 * H));
      if (revokeFirst) {
        await revoke(id);
        await delivery(id, 'delivery_restored');
      } else {
        await delivery(id, 'delivery_restored');
        await revoke(id);
      }
      const row = await winRow(id);
      expect(row.state, String(revokeFirst)).toBe('revoked');
      // Restored before the revoke at the same instant: 9 h of credit, kept in history.
      expect(row.credit_ms, String(revokeFirst)).toBe(revokeFirst ? 0 : 9 * H);
    }
  });
});

describe('a revoked window is not touched by later delivery events', () => {
  it('the window row (including updated_at) stays as it was when only evidence is stored', async () => {
    const id = await w.rawEntitlement(1);
    await ready(id);
    w.clock.set(at(48 * H));
    await revoke(id);
    const before = await winRow(id);
    w.clock.set(at(60 * H));
    const r = await delivery(id, 'delivery_failed');
    expect(r).toMatchObject({ state: 'revoked', inserted: true });
    expect(await winRow(id)).toEqual(before);
  });
});
