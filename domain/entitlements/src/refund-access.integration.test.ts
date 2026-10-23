// CO-5 (ASM-59) integration: one buyer journey through the real entitlement and access-clock code
// and a real (PGlite) database: capture, window start, delivery failure and restoration, credit,
// a partial refund (the buyer keeps what was not refunded), then the full refund (access ends).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  grantCredit,
  markAccessReady,
  recordDeliveryEvent,
  sweepWindows,
} from '@umsbx/access-clock';
import type { AccessPolicy } from '@umsbx/contracts';
import { applyMoneyEvent, createPendingEntitlements, getEntitlementForBuyer } from './index';
import { FIVE_DAYS_MS, HASH, makeWorld, policyFor, START } from './world';
import type { World } from './world';

const H = 3_600_000;
const D = 24 * H;
const T0 = Date.parse(START);
let w: World;
beforeAll(async () => {
  w = await makeWorld('rfi');
});
afterAll(async () => {
  await w.close();
});
beforeEach(async () => {
  await w.reset();
  w.clock.set(START);
});

async function create(n: number): Promise<string> {
  const { article_id, unit_id } = await w.supply(n);
  const policy: AccessPolicy = policyFor('keep_retrieve');
  const [id] = await createPendingEntitlements(w.db, w.deps, {
    buyer_id: 'buy_1',
    unit_id,
    items: [{ article_id, option: 'keep_retrieve', policy }],
  });
  return id!;
}
const money = (id: string, event: Parameters<typeof applyMoneyEvent>[2]['event']) =>
  w.db.transaction((tx) => applyMoneyEvent(tx, w.deps, { entitlement_id: id, event }));
const view = (id: string) =>
  getEntitlementForBuyer(w.db, { entitlement_id: id, buyer_id: 'buy_1' });
const delivery = (id: string, kind: 'delivery_failed' | 'delivery_restored') =>
  recordDeliveryEvent(w.deps, {
    entitlement_id: id,
    kind,
    link_id: null,
    source: 'system',
    evidence: {},
  });

describe('refund and access journey', () => {
  it('partial refund keeps the window; the full refund ends it; later events change nothing', async () => {
    const id = await create(1);
    expect((await view(id))?.access).toBe('locked');

    await money(id, 'capture_verified');
    expect((await view(id))?.access).toBe('locked'); // captured but the clock has not started
    await w.db.transaction((tx) =>
      markAccessReady(tx, w.deps, {
        entitlement_id: id,
        evidence: { capture_id: 'CAP1', content_sha256: HASH, link_probe: 'ok' },
      }),
    );
    expect((await view(id))?.access).toBe('available');

    // Day 1: delivery fails; day 1 + 5 h: restored; the 5 lost hours come back.
    w.clock.advance(D);
    await delivery(id, 'delivery_failed');
    w.clock.advance(5 * H);
    await delivery(id, 'delivery_restored');
    const afterLoss = await view(id);
    expect(afterLoss?.window).toMatchObject({ state: 'running', credit_ms: 5 * H });

    // Day 2: a partial refund is verified. Nothing moves.
    w.clock.advance(D);
    const partial = await money(id, 'partial_refund_verified');
    expect(partial).toEqual({
      ok: true,
      value: { changed: false, money: 'captured', access: 'available' },
    });
    const afterPartial = await view(id);
    expect(afterPartial).toEqual(afterLoss);
    expect(new Date(afterPartial!.window.ends_at!).getTime()).toBe(T0 + FIVE_DAYS_MS + 5 * H);

    // The operator still credits time after the partial refund: ends_at moves forward only.
    const credited = await w.db.transaction((tx) =>
      grantCredit(tx, w.deps, {
        entitlement_id: id,
        credit_ms: 2 * H,
        case_id: 'cas_1',
        by: { kind: 'system' },
      }),
    );
    expect(credited.ok && credited.value.credit_ms).toBe(7 * H);

    // Day 3: the rest is refunded. Access ends, the licence ends, the window is history.
    w.clock.advance(D);
    expect(await money(id, 'refund_verified')).toEqual({
      ok: true,
      value: { changed: true, money: 'refunded', access: 'revoked' },
    });
    const revoked = await view(id);
    expect(revoked).toMatchObject({ money: 'refunded', access: 'revoked', licence: 'terminated' });
    expect(revoked?.window.state).toBe('revoked');
    expect(new Date(revoked!.window.ends_at!).getTime()).toBe(T0 + FIVE_DAYS_MS + 7 * H);

    // After the revoke: no credit, no restoration, no sweep, no partial refund changes the view.
    w.clock.advance(D);
    expect(
      await w.db.transaction((tx) =>
        grantCredit(tx, w.deps, {
          entitlement_id: id,
          credit_ms: H,
          case_id: 'cas_2',
          by: { kind: 'system' },
        }),
      ),
    ).toEqual({ ok: false, error: { code: 'window_ended' } });
    await delivery(id, 'delivery_failed');
    await delivery(id, 'delivery_restored');
    expect(await sweepWindows(w.deps, { max_items: 10 })).toEqual({ ended: 0 });
    await money(id, 'partial_refund_verified');
    expect(await view(id)).toEqual(revoked);
  });

  it('a partial refund before the window starts still lets it start; a full refund does not', async () => {
    const a = await create(1);
    const b = await create(2);
    for (const id of [a, b]) await money(id, 'capture_verified');
    await money(a, 'partial_refund_verified');
    await money(b, 'refund_verified');
    const start = (id: string) =>
      w.db.transaction((tx) =>
        markAccessReady(tx, w.deps, {
          entitlement_id: id,
          evidence: { capture_id: 'CAP1', content_sha256: HASH, link_probe: 'ok' },
        }),
      );
    expect(await start(a)).toMatchObject({ state: 'running' });
    expect((await view(a))?.access).toBe('available');
    await expect(start(b)).rejects.toThrow(/money_not_captured/);
    expect(await view(b)).toMatchObject({ access: 'revoked', licence: 'terminated' });
    expect((await view(b))?.window.state).toBe('revoked');
  });

  it('a pending refund (money event "pending") pauses nothing and credits nothing', async () => {
    const id = await create(1);
    await money(id, 'capture_verified');
    await w.db.transaction((tx) =>
      markAccessReady(tx, w.deps, {
        entitlement_id: id,
        evidence: { capture_id: 'CAP1', content_sha256: HASH, link_probe: 'ok' },
      }),
    );
    const before = await view(id);
    w.clock.advance(D);
    expect((await money(id, 'pending')).ok).toBe(false);
    expect(await view(id)).toEqual(before);
  });
});
