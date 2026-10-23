// CO-5 (ASM-59) adversarial: a credit and a full refund racing through applyMoneyEvent, and hostile
// replays of money events after a revoke.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { grantCredit, markAccessReady } from '@umsbx/access-clock';
import { applyMoneyEvent } from './index';
import { HASH, makeWorld, START } from './world';
import type { World } from './world';

const H = 3_600_000;
const D = 24 * H;
let w: World;
beforeAll(async () => {
  w = await makeWorld('rfv');
});
afterAll(async () => {
  await w.close();
});
beforeEach(async () => {
  await w.reset();
  w.clock.set(START);
});

const ready = (id: string) =>
  w.db.transaction((tx) =>
    markAccessReady(tx, w.deps, {
      entitlement_id: id,
      evidence: { capture_id: 'CAP1', content_sha256: HASH, link_probe: 'ok' },
    }),
  );
const money = (
  id: string,
  event: 'refund_verified' | 'reversal_verified' | 'partial_refund_verified' | 'capture_verified',
) => w.db.transaction((tx) => applyMoneyEvent(tx, w.deps, { entitlement_id: id, event }));
const credit = (id: string) =>
  w.db.transaction((tx) =>
    grantCredit(tx, w.deps, {
      entitlement_id: id,
      credit_ms: 2 * H,
      case_id: 'cas_1',
      by: { kind: 'system' },
    }),
  );
const log = async (id: string) =>
  (
    await w.db.query<{ kind: string }>(
      'SELECT kind FROM access_events WHERE entitlement_id = $1 ORDER BY at, seq',
      [id],
    )
  ).rows.map((r) => r.kind);
const state = async (id: string) =>
  (
    await w.db.query<{
      access_state: string;
      money_state: string;
      wstate: string;
      credit_ms: number;
    }>(
      `SELECT e.access_state, e.money_state, w.state AS wstate, w.credit_ms
       FROM entitlements e JOIN access_windows w ON w.entitlement_id = e.id WHERE e.id = $1`,
      [id],
    )
  ).rows[0]!;

describe('a credit and a full refund for one item racing', () => {
  it.each([
    ['credit first', true],
    ['refund first', false],
  ])('%s: ends revoked with no credit after the revoke', async (_name, creditFirst) => {
    const id = await w.rawEntitlement(1);
    await ready(id);
    w.clock.advance(D);
    const jobs = creditFirst
      ? [credit(id), money(id, 'refund_verified')]
      : [money(id, 'refund_verified'), credit(id)];
    await Promise.all(jobs);
    const events = await log(id);
    const cut = events.indexOf('revoked');
    expect(cut).toBeGreaterThan(0);
    expect(events.slice(cut + 1)).toEqual([]);
    expect(events.filter((k) => k === 'revoked')).toHaveLength(1);
    expect(await state(id)).toMatchObject({
      access_state: 'revoked',
      money_state: 'refunded',
      wstate: 'revoked',
      credit_ms: creditFirst ? 2 * H : 0,
    });
  });

  it('a reversal and a refund racing end in one revoke; the second answer is a no-op or a refusal, never a second event', async () => {
    const id = await w.rawEntitlement(1);
    await ready(id);
    const [a, b] = await Promise.all([
      money(id, 'refund_verified'),
      money(id, 'reversal_verified'),
    ]);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(false);
    expect((await log(id)).filter((k) => k === 'revoked')).toHaveLength(1);
    expect((await state(id)).access_state).toBe('revoked');
  });
});

describe('hostile replays after a revoke', () => {
  it('capture_verified, partial_refund_verified and refund_verified replayed keep access revoked', async () => {
    const id = await w.rawEntitlement(1);
    await ready(id);
    await money(id, 'refund_verified');
    const before = await state(id);
    const events = await log(id);
    expect((await money(id, 'capture_verified')).ok).toBe(false);
    expect((await money(id, 'partial_refund_verified')).ok).toBe(true);
    expect((await money(id, 'refund_verified')).ok).toBe(true);
    expect(await state(id)).toEqual(before);
    expect(await log(id)).toEqual(events);
  });

  it('a partial refund for an unknown or malformed entitlement id is refused like any other event', async () => {
    for (const bad of ['ent_missing', 'ent_\u0000', '']) {
      expect(await money(bad, 'partial_refund_verified'), JSON.stringify(bad)).toEqual({
        ok: false,
        error: { code: 'unknown_entitlement' },
      });
    }
  });
});
