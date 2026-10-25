// CO-8 golden (docs/specs/web-refund-states.md): the words a buyer is shown for each refund and
// pending state, and the words the operator is given for every refusal. The buyer lines come from the
// real engine over the dry-run model (stored state in, text out); the operator lines come from the
// refusal table. The reviewed file is golden/refund-copy.golden.txt. A change to it is a change to what
// people are told about money.
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  COMPLETED_FULL,
  COMPLETED_PARTIAL,
  PENDING_MESSAGE,
  REFUSALS,
  UNKNOWN_MESSAGE,
  cancelRefusal,
} from './server/refund';
import { bootRefundWorld, buy, postRefund } from './refund-support';
import type { RefundWorld } from './refund-support';

vi.mock('server-only', () => ({}));

let w: RefundWorld;
beforeAll(async () => {
  w = await bootRefundWorld();
});
afterAll(async () => {
  await w.app.close();
});

describe('refund and pending copy (golden)', () => {
  it('matches golden/refund-copy.golden.txt', async () => {
    const statusOf = async (u: { entitlement_id: string }) =>
      (await w.app.engine.libraryItem({ entitlement_id: u.entitlement_id, actor: w.actorA }))!;

    const statusOfB = async (u: { entitlement_id: string }) =>
      (await w.app.engine.libraryItem({ entitlement_id: u.entitlement_id, actor: w.actorB }))!;

    const online = await buy(w, { offer: 'knot-notebook', option: 'online_read' });
    await postRefund(w, w.op, {
      unit_id: online.unit_id,
      amount_minor: 450,
      reason: 'Golden full refund',
    });
    const keep = await buy(w, { offer: 'harbour-fees', option: 'keep_retrieve' });
    await postRefund(w, w.op, {
      unit_id: keep.unit_id,
      amount_minor: 300,
      reason: 'Golden full refund',
    });
    const part = await buy(w, { offer: 'ferry-timetables', option: 'online_read' });
    await postRefund(w, w.op, {
      unit_id: part.unit_id,
      amount_minor: 100,
      reason: 'Golden partial refund',
    });
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
    const orderMsg = async (u: { order_ref: string }, actor: typeof w.actorA) =>
      (await w.app.engine.orderView({ order_ref: u.order_ref, actor }))!.buyer_message;

    const lines = [
      `library, online item refunded: ${(await statusOf(online)).status_text}`,
      `library, keep item refunded: ${(await statusOf(keep)).status_text}`,
      `library, partially refunded: ${(await statusOf(part)).status_text}`,
      `library, partially refunded, note: ${(await statusOf(part)).refund_note}`,
      `library, payment pending: ${(await statusOf(pending)).status_text}`,
      `library, confirming payment: ${(await statusOfB(confirming)).status_text}`,
      `order page, payment pending: ${await orderMsg(pending, w.actorA)}`,
      `order page, confirming payment: ${await orderMsg(confirming, w.actorB)}`,
      ...Object.entries(REFUSALS).map(
        ([k, r]) => `operator, ${k}: ${r.http} ${r.code}: ${r.message}`,
      ),
      `operator, cancel wrong_state: ${cancelRefusal('wrong_state').http} ${cancelRefusal('wrong_state').message}`,
      `operator, cancel not_found: ${cancelRefusal('not_found').http} ${cancelRefusal('not_found').message}`,
      `operator, done in part: ${COMPLETED_PARTIAL('USD 1.50', 'USD 3.00')}`,
      `operator, done in full: ${COMPLETED_FULL('USD 4.50')}`,
      `operator, pending at PayPal: ${PENDING_MESSAGE}`,
      `operator, not confirmed yet: ${UNKNOWN_MESSAGE}`,
    ];
    const expected = readFileSync(
      new URL('./golden/refund-copy.golden.txt', import.meta.url),
      'utf8',
    )
      .split('\n')
      .filter((l) => l !== '' && !l.startsWith('#'));
    expect(lines).toEqual(expected);
  });
});
