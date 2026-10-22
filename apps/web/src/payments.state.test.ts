// Lane 15b state tests: the web app over the real payments engine, dry-run model transport. Money
// rules are the payments lanes' job; here we prove the composition wires them: place, checkout,
// pretend approval, return, the invariants, the recovery rules, the job loop and the ops snapshot.
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Actor } from '@umsbx/contracts';
import type { App } from '../composition.server';
import { bootTestApp, call, signIn } from './support';
import type { Session } from './support';

vi.mock('server-only', () => ({}));

let app: App;
let sessionRoute: typeof import('./app/api/session/route');
let quotes: typeof import('./app/api/quotes/route');
let approvals: typeof import('./app/api/approvals/route');
let orders: typeof import('./app/api/orders/route');
let checkoutRoute: typeof import('./app/api/orders/[ref]/checkout/route');
let A: Session;
let actor: Actor;
let n = 0;

beforeAll(async () => {
  app = await bootTestApp();
  sessionRoute = await import('./app/api/session/route');
  quotes = await import('./app/api/quotes/route');
  approvals = await import('./app/api/approvals/route');
  orders = await import('./app/api/orders/route');
  checkoutRoute = await import('./app/api/orders/[ref]/checkout/route');
  A = (await signIn(sessionRoute.POST, 'buyer-a'))!;
  const row = await app.db.query<{ id: string }>(
    `SELECT id FROM buyers WHERE auth_subject = 'persona:buyer-a'`,
  );
  actor = { kind: 'buyer', buyer_id: row.rows[0]!.id };
});
afterAll(async () => {
  await app.close();
});

async function approval(offer: string): Promise<{ approval_id: string; token: string }> {
  const page = await app.engine.offerPage({ publisher: 'harbour-ledger', offer });
  const option = page!.options[0]!.option;
  const q = (await (
    await call(quotes.POST, {
      url: '/api/quotes',
      method: 'POST',
      session: A,
      body: { publisher: 'harbour-ledger', offer, option },
    })
  ).json()) as { quote_id: string };
  const res = await call(approvals.POST, {
    url: '/api/approvals',
    method: 'POST',
    session: A,
    body: { quote_id: q.quote_id, consent: { terms: true, identity_share: false } },
  });
  expect(res.status).toBe(201);
  return (await res.json()) as { approval_id: string; token: string };
}

/** Quote, approve, place the order, create it at the pretend PayPal. Returns the order reference. */
async function placeAndCheckout(offer: string): Promise<{ order_ref: string; order_id: string }> {
  const a = await approval(offer);
  n += 1;
  const placed = await call(orders.POST, {
    url: '/api/orders',
    method: 'POST',
    session: A,
    headers: { 'idempotency-key': `pay-test-key-${String(n).padStart(4, '0')}` },
    body: a,
  });
  expect(placed.status).toBe(201);
  const order = (await placed.json()) as { order_ref: string; order_id: string };
  const co = await call(checkoutRoute.POST, {
    url: `/api/orders/${order.order_ref}/checkout`,
    method: 'POST',
    session: A,
    params: { ref: order.order_ref },
    body: {},
  });
  expect(co.status).toBe(200);
  return order;
}

async function payWith(
  offer: string,
  scenario: string,
): Promise<{ order_ref: string; order_id: string }> {
  const order = await placeAndCheckout(offer);
  expect(await app.engine.dryRunApprove({ order_ref: order.order_ref, actor, scenario })).toBe(
    true,
  );
  await app.engine.payments.onBuyerReturn({ order_ref: order.order_ref, actor, scenario });
  return order;
}

const offers = async (): Promise<string[]> =>
  (await app.engine.listOffers())
    .filter((o) => o.publisher_slug === 'harbour-ledger')
    .map((o) => o.offer_code);

describe('the real payments engine behind the facade', () => {
  it('a happy dry-run journey pays, unlocks the item and keeps all four invariants', async () => {
    const [offer] = await offers();
    const order = await payWith(offer!, 'happy');
    const view = await app.engine.orderView({ order_ref: order.order_ref, actor });
    expect(view?.status).toBe('paid');
    expect(view?.buyer_message).toBe('Paid. Your item is in your library.');
    const lib = await app.engine.library({ actor });
    expect(lib.some((l) => l.order_id === order.order_id && l.can_open)).toBe(true);
    const ops = await app.engine.opsSnapshot({
      kind: 'operator',
      operator_id: 'opr_demo',
      mfa: false,
    });
    expect(ops?.invariants.map((v) => v.id)).toEqual(['INV1', 'INV2', 'INV3', 'INV4']);
    expect(ops?.invariants.every((v) => v.ok)).toBe(true);
  });

  it('claim-only (202) says Confirming payment and does not unlock (A-11)', async () => {
    const offer = (await offers())[1] ?? (await offers())[0]!;
    const order = await payWith(offer, 'capture_202');
    const view = await app.engine.orderView({ order_ref: order.order_ref, actor });
    expect(view?.buyer_message).toBe('Confirming payment');
    expect(view?.items.every((i) => i.access !== 'available')).toBe(true);
  });

  it('pending at PayPal says so and does not unlock (A-16)', async () => {
    const offer = (await offers())[2] ?? (await offers())[0]!;
    const order = await payWith(offer, 'pending_receiving_pref');
    const view = await app.engine.orderView({ order_ref: order.order_ref, actor });
    expect(view?.buyer_message).toBe('Payment pending at PayPal');
    expect(view?.items.every((i) => i.access !== 'available')).toBe(true);
  });

  it('a mismatch freezes the order with no sale, and the recovery rules open a case (A-13)', async () => {
    const offer = (await offers())[3] ?? (await offers())[0]!;
    const order = await payWith(offer, 'mismatch_amount');
    const view = await app.engine.orderView({ order_ref: order.order_ref, actor });
    expect(view?.status).toBe('frozen');
    expect(view?.buyer_message).toContain('on hold');
    const sales = await app.db.query<{ c: string }>(
      `SELECT count(*) AS c FROM ledger_entries l JOIN order_units u ON u.id = l.unit_id
        WHERE u.order_id = $1`,
      [order.order_id],
    );
    expect(Number(sales.rows[0]?.c)).toBe(0);
    expect(view?.open_case).toBeNull();
    await app.engine.sweep();
    const after = await app.engine.orderView({ order_ref: order.order_ref, actor });
    expect(after?.open_case?.case_id).toMatch(/^cas_/);
  });

  it('a bad approval token is refused with 403 and writes no order', async () => {
    const a = await approval((await offers())[0]!);
    const before = await app.db.query<{ c: string }>('SELECT count(*) AS c FROM orders');
    n += 1;
    const res = await call(orders.POST, {
      url: '/api/orders',
      method: 'POST',
      session: A,
      headers: { 'idempotency-key': `pay-test-key-${String(n).padStart(4, '0')}` },
      body: { approval_id: a.approval_id, token: 'x'.repeat(40) },
    });
    expect(res.status).toBe(403);
    const after = await app.db.query<{ c: string }>('SELECT count(*) AS c FROM orders');
    expect(after.rows[0]?.c).toBe(before.rows[0]?.c);
  });

  it('the dry-run approval is refused for another buyer and for an unknown order', async () => {
    const other: Actor = { kind: 'buyer', buyer_id: 'buy_nobody' };
    expect(
      await app.engine.dryRunApprove({ order_ref: 'ord_nope', actor: other, scenario: 'happy' }),
    ).toBe(false);
  });
});

describe('scenarios', () => {
  it('every scenario on the dry-run page is a lane 03 fixture scenario', () => {
    const index = JSON.parse(
      readFileSync(new URL('../../../fixtures/paypal/index.json', import.meta.url), 'utf8'),
    ) as { files: { scenario: string }[] };
    const known = new Set(index.files.map((f) => f.scenario));
    expect(app.engine.dryRunScenarios().length).toBeGreaterThanOrEqual(6);
    for (const s of app.engine.dryRunScenarios()) expect(known.has(s.id), s.id).toBe(true);
  });
});

describe('ops snapshot, jobs and health', () => {
  it('shows the kill switch and the job loop beside the invariants', async () => {
    const snap = await app.engine.opsSnapshot({
      kind: 'operator',
      operator_id: 'opr_demo',
      mfa: false,
    });
    expect(snap?.kill_switch.outbound_on).toBe(false);
    expect(snap?.kill_switch.changed_by).toBe('seed');
    expect(snap?.invariants.length).toBe(4);
    expect(snap?.jobs.last_pass_at).toBeNull();
  });

  it('startJobs recovers, runs a pass, records it, and stops cleanly', async () => {
    const jobs = await app.startJobs();
    await vi.waitFor(async () => {
      expect((await app.engine.health()).last_pass_at).not.toBeNull();
    });
    await jobs.stop();
    const snap = await app.engine.opsSnapshot({
      kind: 'operator',
      operator_id: 'opr_demo',
      mfa: false,
    });
    expect(snap?.jobs.last_pass_at).not.toBeNull();
  });
});
