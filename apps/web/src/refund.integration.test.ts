// CO-8 integration (docs/specs/web-refund-states.md): the offline journey through the routes. A buyer
// pays over the dry-run order model; the operator, with the second factor, refunds part of it and then
// the rest. After every step the buyer's library and receipt show the stored state, access follows the
// money (a partial refund keeps access, a full one ends it), and INV1 to INV4 hold. The dry-run order
// model answers refund_capture and get_refund and lists the refunds on GET order.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { call } from './support';
import {
  bootRefundWorld,
  buy,
  invariants,
  ledgerRefunds,
  postRefund,
  providerCalls,
  unitStatus,
} from './refund-support';
import type { RefundWorld } from './refund-support';

vi.mock('server-only', () => ({}));

let w: RefundWorld;
beforeAll(async () => {
  w = await bootRefundWorld();
});
afterAll(async () => {
  await w.app.close();
});

const libraryOf = async (s: typeof w.A) => {
  const res = await call(w.library.GET, { url: '/api/library', session: s });
  return (
    (await res.json()) as {
      items: Array<{
        entitlement_id: string;
        status_text: string;
        can_open: boolean;
        access: string;
        refund_note: string | null;
        refunded: boolean;
        receipt_versions: number[];
        environment: string;
      }>;
    }
  ).items;
};
const receiptOf = async (order_id: string, s: typeof w.A) => {
  const res = await call(w.receipts.GET, {
    url: `/api/receipts/${order_id}`,
    session: s,
    params: { order: order_id },
  });
  return {
    status: res.status,
    body: (await res.json()) as {
      version: number;
      environment: string;
      refunds: Array<{ refund_id: string; amount: { minor: number; currency: string } }>;
    },
  };
};
const expectInvariants = async () => {
  const inv = await invariants(w);
  for (const id of ['INV1', 'INV2', 'INV3', 'INV4'])
    expect(
      inv.find(([i]) => i === id),
      id,
    ).toEqual([id, true]);
  expect(inv.every(([, ok]) => ok)).toBe(true);
};

describe('online item: buy, partial refund, the rest', () => {
  it('walks the whole journey and the buyer sees the stored state after every step', async () => {
    const unit = await buy(w, { offer: 'knot-notebook', option: 'online_read' }); // 4.50
    await expectInvariants();

    // after the purchase
    let item = (await libraryOf(w.A)).find((i) => i.entitlement_id === unit.entitlement_id)!;
    expect(item.status_text).toMatch(/^Ready, /);
    expect(item.can_open).toBe(true);
    expect(item.refund_note).toBeNull();
    expect(item.environment).toBe('dryrun');
    let receipt = await receiptOf(unit.order_id, w.A);
    expect(receipt.body.version).toBe(1);
    expect(receipt.body.refunds).toHaveLength(0);

    // partial refund of 1.50
    const part = await postRefund(w, w.op, {
      unit_id: unit.unit_id,
      amount_minor: 150,
      reason: 'Part of the article was missing',
    });
    expect(part.status).toBe(200);
    const partBody = (await part.json()) as Record<string, unknown>;
    expect(partBody).toMatchObject({
      state: 'completed',
      amount_minor: 150,
      refunded_minor: 150,
      remaining_minor: 300,
      unit_status: 'partially_refunded',
    });
    expect(await unitStatus(w.app, unit.unit_id)).toBe('partially_refunded');
    expect(await ledgerRefunds(w.app, unit.unit_id)).toBe(150);
    item = (await libraryOf(w.A)).find((i) => i.entitlement_id === unit.entitlement_id)!;
    expect(item.status_text).toBe('Partially refunded: your access continues');
    expect(item.refunded).toBe(false);
    expect(item.can_open).toBe(true);
    expect(item.access).toBe('available');
    expect(item.refund_note).toMatch(/every item in the order continues/i);
    receipt = await receiptOf(unit.order_id, w.A);
    expect(receipt.body.version).toBe(2);
    expect(receipt.body.refunds.map((r) => r.amount.minor)).toEqual([150]);
    await expectInvariants();

    // the buyer can still open it
    const link = await call(w.link.POST, {
      url: `/api/library/${unit.entitlement_id}/link`,
      method: 'POST',
      body: {},
      session: w.A,
      params: { id: unit.entitlement_id },
    });
    expect(link.status).toBe(200);

    // the rest (no amount): 3.00
    const rest = await postRefund(w, w.op, {
      unit_id: unit.unit_id,
      amount_minor: null,
      reason: 'Refund the rest, customer unhappy',
    });
    expect(rest.status).toBe(200);
    expect(await rest.json()).toMatchObject({
      state: 'completed',
      amount_minor: 300,
      refunded_minor: 450,
      remaining_minor: 0,
      unit_status: 'refunded',
    });
    expect(await unitStatus(w.app, unit.unit_id)).toBe('refunded');
    expect(await ledgerRefunds(w.app, unit.unit_id)).toBe(450);
    item = (await libraryOf(w.A)).find((i) => i.entitlement_id === unit.entitlement_id)!;
    expect(item.status_text).toBe('Refunded: access has ended');
    expect(item.refunded).toBe(true);
    expect(item.can_open).toBe(false);
    expect(item.access).toBe('revoked');
    receipt = await receiptOf(unit.order_id, w.A);
    expect(receipt.body.version).toBe(3);
    expect(receipt.body.refunds.map((r) => r.amount.minor)).toEqual([150, 300]);
    expect(receipt.body.environment).toBe('dryrun');
    await expectInvariants();

    // the item cannot be opened any more
    const closed = await call(w.link.POST, {
      url: `/api/library/${unit.entitlement_id}/link`,
      method: 'POST',
      body: {},
      session: w.A,
      params: { id: unit.entitlement_id },
    });
    expect(closed.status).toBeGreaterThanOrEqual(400);
    expect(closed.status).toBeLessThan(500);

    // nothing is left to refund
    const more = await postRefund(w, w.op, {
      unit_id: unit.unit_id,
      amount_minor: 1,
      reason: 'One more try',
    });
    expect(more.status).toBe(409);
    expect(await ledgerRefunds(w.app, unit.unit_id)).toBe(450);

    // the dry-run model took the refunds and lists them on GET order
    expect(await providerCalls(w.app, 'refund_capture')).toBe(2);
    expect(await providerCalls(w.app, 'get_refund')).toBeGreaterThanOrEqual(2);
    const read = await w.app.db.query<{ response_redacted: unknown }>(
      "SELECT response_redacted FROM provider_calls WHERE operation = 'get_order' ORDER BY created_at DESC, id DESC LIMIT 1",
    );
    const text = JSON.stringify(read.rows[0]?.response_redacted);
    expect(text).toContain('REFUNDED');
    expect(text).toContain('refunds');
  });

  it('a job-loop pass after the refunds books nothing twice', async () => {
    const before = (
      await w.app.db.query<{ c: string }>(
        "SELECT count(*) AS c FROM ledger_entries WHERE kind = 'refund'",
      )
    ).rows[0]!.c;
    const jobs = await w.app.startJobs();
    await vi.waitFor(async () => {
      expect((await w.app.engine.health()).last_pass_at).not.toBeNull();
    });
    await jobs.stop();
    const after = (
      await w.app.db.query<{ c: string }>(
        "SELECT count(*) AS c FROM ledger_entries WHERE kind = 'refund'",
      )
    ).rows[0]!.c;
    expect(after).toBe(before);
    await expectInvariants();
  });
});

describe('download-and-keep item: a full refund', () => {
  it('stops the links and says the downloaded copy cannot be recalled', async () => {
    const unit = await buy(w, { offer: 'harbour-fees', option: 'keep_retrieve' }); // 3.00
    const res = await postRefund(w, w.op, {
      unit_id: unit.unit_id,
      amount_minor: 300,
      reason: 'Wrong file delivered',
    });
    expect(res.status).toBe(200);
    expect(await unitStatus(w.app, unit.unit_id)).toBe('refunded');
    const item = (await libraryOf(w.A)).find((i) => i.entitlement_id === unit.entitlement_id)!;
    expect(item.status_text).toBe(
      'Refunded: links have stopped. The copy you downloaded cannot be recalled.',
    );
    expect(item.can_open).toBe(false);
    const link = await call(w.link.POST, {
      url: `/api/library/${unit.entitlement_id}/link`,
      method: 'POST',
      body: {},
      session: w.A,
      params: { id: unit.entitlement_id },
    });
    expect(link.status).toBeGreaterThanOrEqual(400);
    await expectInvariants();
  });
});

describe('a partial refund of a keep item', () => {
  it('keeps access and says so; the receipt shows the refund line and version 2', async () => {
    const unit = await buy(w, { offer: 'ferry-timetables', option: 'keep_retrieve' }); // 1.25
    const res = await postRefund(w, w.op, {
      unit_id: unit.unit_id,
      amount_minor: 100,
      reason: 'Goodwill after a slow download',
    });
    expect(res.status).toBe(200);
    const item = (await libraryOf(w.A)).find((i) => i.entitlement_id === unit.entitlement_id)!;
    expect(item.status_text).toBe('Partially refunded: your access continues');
    expect(item.can_open).toBe(true);
    expect((await receiptOf(unit.order_id, w.A)).body.version).toBe(2);
  });
});

describe('pending states from stored data', () => {
  it('pending at PayPal and confirming payment come from the stored order, with no refund copy', async () => {
    const pending = await buy(w, {
      offer: 'tide-tables',
      option: 'online_read',
      scenario: 'pending_receiving_pref',
    });
    const confirming = await buy(w, {
      offer: 'tide-tables',
      option: 'online_read',
      scenario: 'capture_202',
      who: 'B',
    });
    const view = async (u: { order_ref: string }, actor: typeof w.actorA) =>
      (await w.app.engine.orderView({ order_ref: u.order_ref, actor }))!;
    expect((await view(pending, w.actorA)).buyer_message).toBe('Payment pending at PayPal');
    expect((await view(confirming, w.actorB)).buyer_message).toBe('Confirming payment');
    expect((await view(pending, w.actorA)).refund_line).toBeNull();
    const mine = await libraryOf(w.A);
    const theirs = await libraryOf(w.B);
    expect(mine.find((i) => i.entitlement_id === pending.entitlement_id)?.status_text).toBe(
      'Payment pending at PayPal',
    );
    expect(theirs.find((i) => i.entitlement_id === confirming.entitlement_id)?.status_text).toBe(
      'Confirming payment',
    );
    // nothing can be refunded before it is captured
    const res = await postRefund(w, w.op, {
      unit_id: pending.unit_id,
      amount_minor: 10,
      reason: 'Too early to refund',
    });
    expect(res.status).toBe(409);
  });
});

describe('the other buyer', () => {
  it('sees nothing of the first buyer’s refunds: library, receipt and order', async () => {
    const [row] = (
      await w.app.db.query<{ id: string; order_id: string; order_ref: string }>(
        `SELECT e.id, u.order_id, o.order_ref FROM entitlements e
           JOIN order_units u ON u.id = e.unit_id JOIN orders o ON o.id = u.order_id
          WHERE u.status = 'partially_refunded' AND e.buyer_id = $1 LIMIT 1`,
        [(w.actorA as { buyer_id: string }).buyer_id],
      )
    ).rows;
    expect(row).toBeDefined();
    const theirs = await libraryOf(w.B);
    expect(theirs.some((i) => i.entitlement_id === row!.id)).toBe(false);
    expect((await receiptOf(row!.order_id, w.B)).status).toBe(404);
    // the owner does see it, so a null for B is the rule and not a missing order
    expect(
      await w.app.engine.orderView({ order_ref: row!.order_ref, actor: w.actorA }),
    ).not.toBeNull();
    expect(await w.app.engine.orderView({ order_ref: row!.order_ref, actor: w.actorB })).toBeNull();
  });
});
