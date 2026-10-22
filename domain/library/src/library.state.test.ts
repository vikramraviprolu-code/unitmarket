import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { recordDeliveryEvent } from '@umsbx/access-clock';
import { openCase, resolve } from '@umsbx/recovery';
import { getLibrary } from './index';
import { HOUR, makeWorld } from './world';
import type { World } from './world';

const DAY = 24 * HOUR;
let w: World;
beforeAll(async () => {
  w = await makeWorld('lib');
});
afterAll(async () => {
  await w.close();
});
beforeEach(async () => {
  await w.reset();
  w.clock.set('2026-10-21T10:00:00.000Z');
});

const lib = (buyer_id = 'buy_1') => getLibrary(w.db, { buyer_id, now: w.clock.now() });
const textOf = async (entitlement_id: string) =>
  (await lib()).find((i) => i.entitlement_id === entitlement_id)?.status_text;

describe('status text follows window and money state', () => {
  it('counts the time left in days and hours while ready', async () => {
    const x = await w.item(1);
    expect(await textOf(x.entitlement_id)).toBe('Ready, 5 days left');
    w.clock.advance(60_000);
    expect(await textOf(x.entitlement_id)).toBe('Ready, 4 days 23 hours left');
    w.clock.advance(3 * DAY + 20 * HOUR);
    expect(await textOf(x.entitlement_id)).toBe('Ready, 1 day 3 hours left');
    w.clock.advance(DAY + 2 * HOUR);
    expect(await textOf(x.entitlement_id)).toBe('Ready, 1 hour left');
    w.clock.advance(HOUR + 60_000 * 10); // 49 minutes left
    expect(await textOf(x.entitlement_id)).toBe('Ready, less than 1 hour left');
  });

  it('says what is happening before and around payment', async () => {
    const pending = await w.item(1, { unit_status: 'pending' });
    const confirming = await w.item(2, { unit_status: 'expected' });
    const declined = await w.item(3, { unit_status: 'declined' });
    const notReady = await w.item(4, { ready: false });
    expect(await textOf(pending.entitlement_id)).toBe('Payment pending at PayPal');
    expect(await textOf(confirming.entitlement_id)).toBe('Confirming payment');
    expect(await textOf(declined.entitlement_id)).toBe('Not charged');
    expect(await textOf(notReady.entitlement_id)).toBe('Getting your copy ready');
  });

  it('pauses while delivery is being fixed', async () => {
    const x = await w.item(1);
    await recordDeliveryEvent(w.deps, {
      entitlement_id: x.entitlement_id,
      kind: 'delivery_failed',
      link_id: null,
      source: 'system',
      evidence: {},
    });
    const [item] = await lib();
    expect(item?.status_text).toBe('Paused: we are fixing delivery');
    expect(item?.window.state).toBe('paused');
    expect(item?.can_open).toBe(true);
  });

  it('keeps history after the window ends, worded by option', async () => {
    const keep = await w.item(1, { option: 'keep_retrieve' });
    const read = await w.item(2, { option: 'online_read' });
    w.clock.advance(5 * DAY + 1);
    // The sweep has not run: the stored window still says running, the text already says ended.
    expect(await textOf(keep.entitlement_id)).toBe('Retrieval closed, your copy is yours');
    expect(await textOf(read.entitlement_id)).toBe('Reading ended');
    const items = await lib();
    expect(items.every((i) => !i.can_open)).toBe(true);
  });

  it('shows refunded and reversed money', async () => {
    const refunded = await w.item(1, { unit_status: 'refunded' });
    const reversed = await w.item(2, { unit_status: 'reversed' });
    expect(await textOf(refunded.entitlement_id)).toBe('Refunded');
    expect(await textOf(reversed.entitlement_id)).toBe('Payment reversed');
    const item = (await lib()).find((i) => i.entitlement_id === refunded.entitlement_id);
    expect(item).toMatchObject({ access: 'revoked', can_open: false });
  });
});

describe('the library lists every purchase with its evidence', () => {
  it('lists ended and refunded items with receipts (A-19)', async () => {
    const ended = await w.item(1, { title: 'Ended one' });
    const refunded = await w.item(2, { unit_status: 'refunded', title: 'Refunded one' });
    const live = await w.item(3, { title: 'Live one', option: 'online_read' });
    for (const [order, versions] of [
      [ended.order_id, [1, 2]],
      [refunded.order_id, [1, 2, 3]],
    ] as const) {
      for (const version of versions) {
        await w.insert('receipts', {
          id: `rct_${order}_${version}`,
          order_id: order,
          version,
          body: JSON.stringify({ v: version }),
          sha256: String(version).repeat(64),
          environment: 'dryrun',
        });
      }
    }
    w.clock.advance(5 * DAY + HOUR);
    const items = await lib();
    expect(items).toHaveLength(3);
    const byId = (id: string) => items.find((i) => i.entitlement_id === id);
    expect(byId(ended.entitlement_id)).toMatchObject({
      title: 'Ended one',
      publisher: 'Pub One',
      option: 'keep_retrieve',
      access: 'ended',
      receipt_versions: [1, 2],
      can_open: false,
      open_case: null,
      environment: 'dryrun',
      article_id: ended.article_id,
    });
    expect(byId(refunded.entitlement_id)).toMatchObject({
      title: 'Refunded one',
      receipt_versions: [1, 2, 3],
      status_text: 'Refunded',
      access: 'revoked',
    });
    expect(byId(live.entitlement_id)).toMatchObject({
      option: 'online_read',
      receipt_versions: [],
      status_text: 'Reading ended',
    });
  });

  it('shows the open case beside its item and drops it once resolved', async () => {
    const x = await w.item(1);
    const other = await w.item(2);
    const c = await openCase(w.deps, {
      kind: 'delivery_failed',
      entitlement_id: x.entitlement_id,
      opened_by: 'buyer',
      actor: { kind: 'buyer', buyer_id: 'buy_1' },
    });
    if (!c.ok) throw new Error('open failed');
    const items = await lib();
    expect(items.find((i) => i.entitlement_id === x.entitlement_id)?.open_case).toEqual(c.value);
    expect(items.find((i) => i.entitlement_id === other.entitlement_id)?.open_case).toBeNull();
    // An order-level case shows on every item of that order.
    const o = await openCase(w.deps, {
      kind: 'frozen_order',
      order_id: other.order_id,
      opened_by: 'system',
      actor: { kind: 'system' },
    });
    if (!o.ok) throw new Error('open failed');
    expect(
      (await lib()).find((i) => i.entitlement_id === other.entitlement_id)?.open_case?.case_id,
    ).toBe(o.value.case_id);
    await resolve(w.deps, {
      case_id: c.value.case_id,
      action: 'close_no_fault',
      by: { kind: 'operator', operator_id: 'opr_1', mfa: true },
      reason: 'checked',
    });
    expect((await lib()).find((i) => i.entitlement_id === x.entitlement_id)?.open_case).toBeNull();
  });

  it('orders newest purchase first and gives an empty list to a buyer with none', async () => {
    const a = await w.item(1);
    w.clock.advance(HOUR);
    const b = await w.item(2);
    expect((await lib()).map((i) => i.entitlement_id)).toEqual([
      b.entitlement_id,
      a.entitlement_id,
    ]);
    expect(await lib('buy_2')).toEqual([]);
  });

  it('works without a supplied time by reading the database time', async () => {
    await w.item(1);
    const items = await getLibrary(w.db, { buyer_id: 'buy_1' });
    expect(items).toHaveLength(1);
  });
});
