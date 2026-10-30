// FIX-FLOW D4 and D5 (docs/specs/fix-flow-gate12.md): an order the buyer left unpaid is called "not paid
// yet" in the library and on the order page, never "Confirming payment"; a search blocked by it says so.
// Offline app (PGlite, dry-run transport). Nothing here touches the money path: it reads views only.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Actor } from '@umsbx/contracts';
import type { App } from '../composition.server';
import {
  HARBOUR_FERRY,
  HARBOUR_TIDE,
  QUAY_MARKET,
  QUAY_WALK,
  bootPackApp,
  buyer,
  runPack,
  startPack,
} from './composite-support';
import {
  NOT_PAID_YET,
  OPEN_ORDER_BODY,
  OPEN_ORDER_HEADING,
  UNPAID_ORDER_BODY,
  UNPAID_ORDER_HEADING,
  discoverNoMatchView,
} from './lib/buyer-copy';

vi.mock('server-only', () => ({}));

let app: App;
let A: Actor;
let B: Actor;
beforeAll(async () => {
  app = await bootPackApp();
  A = await buyer(app, 'a');
  B = await buyer(app, 'b');
});
afterAll(async () => {
  await app.close();
});

describe('an order left at the pay page', () => {
  it('a pack: the order page and every library item say not paid yet', async () => {
    const s = await startPack(app, A, [HARBOUR_TIDE, QUAY_MARKET]);
    const v = (await app.engine.orderView({ order_ref: s.order_ref, actor: A }))!;
    expect(v.status).toBe('awaiting_buyer');
    expect(v.buyer_message).toBe(NOT_PAID_YET);
    const lib = await app.engine.library({ actor: A });
    expect(lib.length).toBe(2);
    for (const i of lib) {
      expect(i.status_text).toBe(NOT_PAID_YET);
      expect(i.status_text).not.toMatch(/Confirming payment/);
      expect(i.can_open).toBe(false);
    }
  });

  it('one article: the same words', async () => {
    const s = await startPack(app, B, [HARBOUR_FERRY]);
    const v = (await app.engine.orderView({ order_ref: s.order_ref, actor: B }))!;
    expect(v.buyer_message).toBe(NOT_PAID_YET);
    const lib = await app.engine.library({ actor: B });
    expect(lib.map((i) => i.status_text)).toEqual([NOT_PAID_YET]);
  });

  it('a paid order keeps its own words', async () => {
    const r = await runPack(app, B, [QUAY_WALK], ['happy']);
    const v = (await app.engine.orderView({ order_ref: r.order_ref, actor: B }))!;
    expect(v.buyer_message).toBe('Paid. Your item is in your library.');
    const lib = await app.engine.library({ actor: B });
    const paid = lib.find((i) => i.order_id === r.order_id)!;
    expect(paid.status_text).toMatch(/^Ready/);
  });

  // GATEFIX2: the open order used to answer already_owned, which said "in your library" for an unpaid order.
  it('the cause of the false no match: the open order blocks a new quote, and says it is an unpaid order', async () => {
    const q = await app.engine.quote({
      offer: { publisher_slug: HARBOUR_TIDE[0], offer_code: HARBOUR_TIDE[1] },
      actor: A,
      source: 'discovery',
    });
    expect(q.ok && q.value.kind === 'no_match' && q.value.reason).toBe('unpaid_order');
  });
});

describe('the no match view of /discover', () => {
  it('already_owned alone: the open order notice, no "nothing fits" claim, a link to the library', () => {
    const v = discoverNoMatchView(['already_owned']);
    expect(v.open_order).toEqual({
      heading: OPEN_ORDER_HEADING,
      body: OPEN_ORDER_BODY,
      href: '/library',
    });
    expect(v.nothing_fits).toBe(false);
  });
  it('unpaid_order alone: the unpaid order notice, no library claim, a link to the library', () => {
    const v = discoverNoMatchView(['unpaid_order']);
    expect(v.open_order).toEqual({
      heading: UNPAID_ORDER_HEADING,
      body: UNPAID_ORDER_BODY,
      href: '/library',
    });
    expect(v.open_order?.body).not.toMatch(/in your library/);
    expect(v.nothing_fits).toBe(false);
  });
  it('already_owned with another reason: both are said', () => {
    const v = discoverNoMatchView(['above_ceiling', 'already_owned']);
    expect(v.open_order).not.toBeNull();
    expect(v.nothing_fits).toBe(true);
  });
  it('no reason, or other reasons: the usual no match only', () => {
    for (const r of [[], ['above_ceiling']]) {
      const v = discoverNoMatchView(r);
      expect(v.open_order).toBeNull();
      expect(v.nothing_fits).toBe(true);
    }
  });
  it('the words carry no dash', () => {
    for (const s of [
      NOT_PAID_YET,
      OPEN_ORDER_HEADING,
      OPEN_ORDER_BODY,
      UNPAID_ORDER_HEADING,
      UNPAID_ORDER_BODY,
    ])
      expect(s).not.toMatch(/[‒-―−]| - |--/);
  });
});
