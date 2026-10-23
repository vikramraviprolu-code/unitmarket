// CO-5 (ASM-59) adversarial: a credit and a full refund for one item racing, replayed revokes,
// forged signals after a revoke.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { grantCredit, markAccessReady, recordDeliveryEvent, revokeWindow } from './index';
import { insertEvent, materialise, requireEntitlement } from './events';
import { HASH, makeWorld, START } from './world';
import type { World } from './world';

const H = 3_600_000;
const D = 24 * H;
let w: World;
beforeAll(async () => {
  w = await makeWorld('rfa');
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
const by = { kind: 'operator' as const, operator_id: 'opr_1', mfa: true };
const grant = (id: string, credit_ms = 2 * H) =>
  w.db.transaction((tx) =>
    grantCredit(tx, w.deps, { entitlement_id: id, credit_ms, case_id: 'cas_1', by }),
  );
const revoke = (id: string) =>
  w.db.transaction((tx) => revokeWindow(tx, w.deps, { entitlement_id: id, reason: 'refund' }));
const log = async (id: string) =>
  (
    await w.db.query<{ seq: number; kind: string }>(
      'SELECT seq, kind FROM access_events WHERE entitlement_id = $1 ORDER BY at, seq',
      [id],
    )
  ).rows.map((r) => r.kind);
const row = async (id: string) =>
  (
    await w.db.query<{ state: string; credit_ms: number; ends_at: Date | null }>(
      'SELECT state, credit_ms, ends_at FROM access_windows WHERE entitlement_id = $1',
      [id],
    )
  ).rows[0]!;
const access = async (id: string) =>
  (
    await w.db.query<{ access_state: string }>(
      'SELECT access_state FROM entitlements WHERE id = $1',
      [id],
    )
  ).rows[0]!.access_state;

describe('a credit and a full refund racing for one item', () => {
  it('credit first: revoked, the credit stays in history, nothing after the revoke', async () => {
    const id = await w.rawEntitlement(1);
    await ready(id);
    w.clock.advance(D);
    const [c, r] = await Promise.all([grant(id), revoke(id)]);
    expect(c.ok).toBe(true);
    expect(r.state).toBe('revoked');
    expect(await log(id)).toEqual(['access_ready', 'credit_granted', 'revoked']);
    expect(await row(id)).toMatchObject({ state: 'revoked', credit_ms: 2 * H });
    expect(await access(id)).toBe('revoked');
  });

  it('refund first: revoked, the credit answers window_ended and writes no event', async () => {
    const id = await w.rawEntitlement(1);
    await ready(id);
    w.clock.advance(D);
    const [r, c] = await Promise.all([revoke(id), grant(id)]);
    expect(r.state).toBe('revoked');
    expect(c).toEqual({ ok: false, error: { code: 'window_ended' } });
    expect(await log(id)).toEqual(['access_ready', 'revoked']);
    expect(await row(id)).toMatchObject({ state: 'revoked', credit_ms: 0 });
    expect(await access(id)).toBe('revoked');
  });

  it('many credits racing one refund: every credit event comes before the revoke', async () => {
    const id = await w.rawEntitlement(1);
    await ready(id);
    w.clock.advance(D);
    const jobs: Promise<unknown>[] = [];
    for (let n = 0; n < 6; n += 1) {
      if (n === 3) jobs.push(revoke(id));
      jobs.push(grant(id, H));
    }
    await Promise.all(jobs);
    const events = await log(id);
    const at = events.indexOf('revoked');
    expect(at).toBeGreaterThan(0);
    expect(events.slice(at + 1)).toEqual([]);
    expect(events.filter((k) => k === 'revoked')).toHaveLength(1);
    expect(await access(id)).toBe('revoked');
  });
});

describe('a replayed revoked event is a no-op', () => {
  it('revokeWindow twice and in parallel writes one revoked event and one result', async () => {
    const id = await w.rawEntitlement(1);
    await ready(id);
    const [a, b] = await Promise.all([revoke(id), revoke(id)]);
    expect(a).toEqual(b);
    expect((await log(id)).filter((k) => k === 'revoked')).toHaveLength(1);
    const again = await revoke(id);
    expect(again).toEqual(a);
  });

  it('a duplicate revoked row written behind the API changes nothing in the window', async () => {
    const id = await w.rawEntitlement(1);
    await ready(id);
    w.clock.advance(D);
    const first = await revoke(id);
    const before = await row(id);
    w.clock.advance(D);
    await w.db.transaction(async (tx) => {
      await insertEvent(tx, w.deps, {
        entitlement_id: id,
        kind: 'revoked',
        link_id: null,
        source: 'system',
        evidence: { reason: 'reversal' },
      });
      return materialise(tx, w.deps, await requireEntitlement(tx, id));
    });
    const after = await row(id);
    expect(after).toEqual(before);
    expect(first.state).toBe('revoked');
    expect(await access(id)).toBe('revoked');
  });
});

describe('forged or late signals after a revoke', () => {
  it('buyer beacons, restorations and an operator credit written behind the API cannot revive the window', async () => {
    const id = await w.rawEntitlement(1);
    await ready(id);
    await recordDeliveryEvent(w.deps, {
      entitlement_id: id,
      kind: 'delivery_failed',
      link_id: null,
      source: 'system',
      evidence: {},
    });
    w.clock.advance(D);
    await revoke(id);
    const before = await row(id);
    w.clock.advance(D);
    for (const kind of ['delivery_restored', 'reader_rendered', 'download_completed'] as const) {
      await recordDeliveryEvent(w.deps, {
        entitlement_id: id,
        kind,
        link_id: null,
        source: kind === 'reader_rendered' ? 'buyer' : 'system',
        evidence: {},
      });
    }
    await w.db.transaction(async (tx) => {
      await insertEvent(tx, w.deps, {
        entitlement_id: id,
        kind: 'credit_granted',
        link_id: null,
        source: 'operator',
        evidence: { credit_ms: 9 * H, case_id: 'c' },
      });
      await insertEvent(tx, w.deps, {
        entitlement_id: id,
        kind: 'access_ready',
        link_id: null,
        source: 'system',
        evidence: {},
      });
      return materialise(tx, w.deps, await requireEntitlement(tx, id));
    });
    expect(await row(id)).toEqual(before);
    expect(await access(id)).toBe('revoked');
  });

  it('a buyer can never grant credit, before or after a revoke', async () => {
    const id = await w.rawEntitlement(1);
    await ready(id);
    await revoke(id);
    await expect(
      w.db.transaction((tx) =>
        grantCredit(tx, w.deps, {
          entitlement_id: id,
          credit_ms: H,
          case_id: 'c',
          by: { kind: 'buyer', buyer_id: 'buy_1' },
        }),
      ),
    ).rejects.toThrow(/actor/);
    expect(await log(id)).toEqual(['access_ready', 'revoked']);
  });

  it('credit amounts that are not positive safe integers are refused on a revoked window too, writing nothing', async () => {
    const id = await w.rawEntitlement(1);
    await ready(id);
    await revoke(id);
    for (const bad of [0, -H, 0.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2]) {
      const r = await grant(id, bad);
      expect(r.ok, String(bad)).toBe(false);
    }
    expect(await log(id)).toEqual(['access_ready', 'revoked']);
  });
});
