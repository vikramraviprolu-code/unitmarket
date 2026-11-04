// MC2-L6 (D-083) adversarial: the stored pending reason is outside data. Whatever it holds (markup, a
// 10 000 character string, the known reason with a suffix, control characters, an object key name), no
// screen model and no route answer shows it. The known reason with nothing added still maps to the label.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { hashPasscode } from '@umsbx/security';
import type { Actor } from '@umsbx/contracts';
import { call } from './support';
import { bootRefundWorld, buy } from './refund-support';
import type { BoughtUnit, RefundWorld } from './refund-support';
import { AWAITING_SELLER_LABEL } from './lib/pending-copy';

vi.mock('server-only', () => ({}));

const PUBLISHER_PASSCODE = 'publisher passcode for tests only';
const PSALT = 'ffeeddccbbaa99887766554433221100';
const KNOWN = 'RECEIVING_PREFERENCE_MANDATES_MANUAL_ACTION';

let w: RefundWorld;
let seller: Actor;
let operator: Actor;
let unit: BoughtUnit;
let orderRoute: typeof import('./app/api/orders/[ref]/route');

beforeAll(async () => {
  w = await bootRefundWorld({
    UMS_PUBLISHER_PASSCODE_HASH: await hashPasscode(PUBLISHER_PASSCODE, PSALT),
  });
  const s = await w.app.engine.signIn({
    persona: 'publisher-harbour-ledger',
    passcode: PUBLISHER_PASSCODE,
  });
  seller = s!.actor;
  operator = { kind: 'operator', operator_id: 'opr_vikram', mfa: true };
  unit = await buy(w, {
    offer: 'tide-tables',
    option: 'online_read',
    scenario: 'pending_receiving_pref',
  });
  orderRoute = await import('./app/api/orders/[ref]/route');
});
afterAll(async () => {
  await w.app.close();
});

const HOSTILE: Array<[string, string | null]> = [
  ['markup', '<img src=x onerror=alert(1)><script>alert(1)</script>'],
  ['10k characters', 'Z'.repeat(10_000)],
  ['10k of markup', '<b>'.repeat(3_400)],
  ['known reason with a suffix', `${KNOWN}<script>x</script>`],
  ['known reason in lower case', KNOWN.toLowerCase()],
  ['control characters', 'A‮B​C\r\nD\t'],
  ['an object key name', '__proto__'],
  ['null', null],
  ['empty', ''],
];

async function everything(): Promise<string[]> {
  const order = await call(orderRoute.GET, {
    url: `/api/orders/${unit.order_ref}`,
    session: w.A,
    params: { ref: unit.order_ref },
  });
  const lib = await call(w.library.GET, { url: '/api/library', session: w.A });
  const item = await w.app.engine.libraryItem({
    entitlement_id: unit.entitlement_id,
    actor: w.actorA,
  });
  const ops = await w.app.engine.opsPublishers.list(operator);
  return [
    await order.text(),
    await lib.text(),
    JSON.stringify(item),
    JSON.stringify(await w.app.engine.orderView({ order_ref: unit.order_ref, actor: w.actorA })),
    JSON.stringify(await w.app.engine.publisherPending(seller)),
    JSON.stringify(ops.ok ? ops.value : null),
  ];
}

describe('a hostile stored pending reason is never rendered', () => {
  it.each(HOSTILE)('%s', async (_name, reason) => {
    await w.app.db.query('UPDATE order_units SET status_reason = $2 WHERE id = $1', [
      unit.unit_id,
      reason,
    ]);
    for (const body of await everything()) {
      expect(body).not.toContain('<script');
      expect(body).not.toContain('<img');
      expect(body).not.toContain('<b>');
      expect(body).not.toContain('ZZZZZZZZ');
      expect(body).not.toContain('__proto__');
      expect(body).not.toContain('onerror');
      expect(body).not.toContain('\u202e');
      expect(body).not.toContain('\u200b');
      expect(body).not.toContain(KNOWN);
      expect(body).not.toContain(KNOWN.toLowerCase());
      expect(body.length).toBeLessThan(20_000);
    }
    const v = await w.app.engine.orderView({ order_ref: unit.order_ref, actor: w.actorA });
    expect(v!.buyer_message).toBe('Payment pending at PayPal');
    const rows = (await w.app.engine.publisherPending(seller))!;
    const mine = rows.find((r) => r.order_ref6 === unit.order_ref.slice(-6))!;
    expect(mine.label).toBe('Payment pending at PayPal');
    expect(mine.kind).toBe('payment_pending');
  });

  it('the known reason, exactly, still maps to the label (and only then)', async () => {
    await w.app.db.query('UPDATE order_units SET status_reason = $2 WHERE id = $1', [
      unit.unit_id,
      KNOWN,
    ]);
    const rows = (await w.app.engine.publisherPending(seller))!;
    const mine = rows.find((r) => r.order_ref6 === unit.order_ref.slice(-6))!;
    expect(mine.label).toBe(AWAITING_SELLER_LABEL);
    for (const body of await everything()) expect(body).not.toContain(KNOWN);
  });

  it('the raw reason stays out of the buyer order route even for another buyer', async () => {
    const res = await call(orderRoute.GET, {
      url: `/api/orders/${unit.order_ref}`,
      session: w.B,
      params: { ref: unit.order_ref },
    });
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain(KNOWN);
  });
});
