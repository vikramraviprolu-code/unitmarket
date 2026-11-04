// MC2-L5 (D-084 item 4): what the buyer approves, what PayPal is asked for and every stored amount stay in the
// seller's currency, whatever the screen showed. A DE buyer is shown a converted USD price; the approval, the
// order, the order units, the ledger and the PayPal request body still say USD and the seller's minor units.
// A figure sent in the request (a displayed amount, a currency, a total) is refused or changes nothing. A rate
// that moves after the page was shown changes nothing that is stored.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { call } from './support';
import { bootDisplayWorld } from './buyer-display-support';
import type { DisplayWorld } from './buyer-display-support';
import { buyerDisplay } from './server/buyer-display';

vi.mock('server-only', () => ({}));

let w: DisplayWorld;
beforeAll(async () => {
  w = await bootDisplayWorld();
});
afterAll(async () => {
  await w.close();
});

const count = async (sql: string, p: unknown[] = []): Promise<number> =>
  Number((await w.app.db.query<{ c: string | number }>(sql, p)).rows[0]!.c);

async function approvalFor(buyer: Awaited<ReturnType<DisplayWorld['buyer']>>) {
  const q = await w.app.engine.quote({
    offer: { publisher_slug: 'harbour-ledger', offer_code: 'tide-tables' },
    actor: buyer.actor,
    source: 'direct',
    option: 'online_read',
  });
  if (!q.ok || q.value.kind !== 'quote') throw new Error('no quote');
  const g = await w.app.engine.requestApproval({
    actor: buyer.actor,
    selection: { kind: 'quote', quote_id: q.value.quote_id },
    consent: { terms: true, identity_share: false },
  });
  if (!g.ok) throw new Error(`no approval: ${g.error.code}`);
  return { quote: q.value, approval: g.value };
}

describe('an order made from a converted display is in the seller currency', () => {
  it('the screen says about euros; the approval, order, units, ledger and PayPal body say USD 0.40', async () => {
    const b = await w.buyer('DE');
    const d = await buyerDisplay(w.app.engine, b.actor, { currencies: ['USD'] });
    expect(d.view({ currency: 'USD', minor: 40 }).lead).toBe('about €0.33');

    const { quote, approval } = await approvalFor(b);
    expect(quote.price).toEqual({ currency: 'USD', minor: 40 });

    const snap = (
      await w.app.db.query<{ snapshot: unknown; currency?: string }>(
        'SELECT snapshot FROM approvals WHERE id = $1',
        [approval.approval_id],
      )
    ).rows[0]!.snapshot;
    const text = JSON.stringify(snap);
    expect(text).toContain('"USD"');
    expect(text).toContain('40');
    expect(text).not.toMatch(/EUR|GBP|about|display|converted/);

    const placed = await w.app.engine.payments.placeOrder({
      approval_id: approval.approval_id,
      token: approval.token,
      actor: b.actor,
    });
    if (!placed.ok) throw new Error(`place: ${JSON.stringify(placed.error)}`);
    const co = await w.app.engine.payments.beginCheckout({
      order_id: placed.value.order_id,
      actor: b.actor,
    });
    if (!co.ok) throw new Error(`checkout: ${co.error.code}`);
    await w.app.engine.dryRunApprove({
      order_ref: placed.value.order_ref,
      actor: b.actor,
      scenario: 'happy',
    });
    await w.app.engine.payments.onBuyerReturn({
      order_ref: placed.value.order_ref,
      actor: b.actor,
      scenario: 'happy',
    });

    const order = (
      await w.app.db.query<{ currency: string; total_minor: string | number; status: string }>(
        'SELECT currency, total_minor, status FROM orders WHERE id = $1',
        [placed.value.order_id],
      )
    ).rows[0]!;
    expect([order.currency, Number(order.total_minor), order.status]).toEqual(['USD', 40, 'paid']);
    const units = await w.app.db.query<{ amount_minor: string | number }>(
      'SELECT amount_minor FROM order_units WHERE order_id = $1',
      [placed.value.order_id],
    );
    expect(units.rows.map((u) => Number(u.amount_minor))).toEqual([40]);
    const ledger = await w.app.db.query<{ currency: string; amount_minor: string | number }>(
      `SELECT l.currency, l.amount_minor FROM ledger_entries l
         JOIN order_units u ON u.id = l.unit_id WHERE u.order_id = $1`,
      [placed.value.order_id],
    );
    expect([...new Set(ledger.rows.map((r) => r.currency))]).toEqual(['USD']);
    expect(ledger.rows.map((r) => Number(r.amount_minor))).not.toContain(33);

    // the PayPal request body that was built: USD 0.40, never euros
    const calls = await w.app.db.query<{ request_redacted: unknown }>(
      `SELECT request_redacted FROM provider_calls WHERE operation = 'create_order' ORDER BY created_at DESC LIMIT 1`,
    );
    const body = JSON.stringify(calls.rows[0]!.request_redacted);
    expect(body).toContain('USD');
    expect(body).toContain('0.40');
    expect(body).not.toMatch(/EUR|GBP|0\.33/);
  });

  it('the approval page data is the seller amount; the converted line is only an addition', async () => {
    const b = await w.buyer('DE');
    const { approval } = await approvalFor(b);
    const view = await w.app.engine.approvalView({
      approval_id: approval.approval_id,
      actor: b.actor,
    });
    expect([view!.currency, view!.total_minor]).toEqual(['USD', 40]);
    expect(view!.items.map((i) => i.amount_minor)).toEqual([40]);
    expect(JSON.stringify(view)).not.toMatch(/EUR|about|display/);
  });
});

describe('tampering with the displayed figure in a request changes nothing', () => {
  it('orders: a displayed amount, a currency or a total in the body is refused and no order is made', async () => {
    const orders = await import('./app/api/orders/route');
    const b = await w.buyer('DE');
    const { approval } = await approvalFor(b);
    const before = await count('SELECT count(*) AS c FROM orders');
    for (const extra of [
      { display_minor: 1, display_currency: 'EUR' },
      { amount_minor: 33, currency: 'EUR' },
      { total_minor: 33 },
      { display: { lead: 'about €0.01', seller: '$0.40', binding: null } },
    ]) {
      const r = await call(orders.POST, {
        url: '/api/orders',
        method: 'POST',
        session: b.session,
        headers: { 'idempotency-key': `k-${Object.keys(extra)[0]!}` },
        body: { approval_id: approval.approval_id, token: approval.token, ...extra },
      });
      expect(r.status, JSON.stringify(extra)).toBe(400);
    }
    expect(await count('SELECT count(*) AS c FROM orders')).toBe(before);
    // the honest request still works, and the order is the seller's
    const ok = await call(orders.POST, {
      url: '/api/orders',
      method: 'POST',
      session: b.session,
      headers: { 'idempotency-key': 'k-honest' },
      body: { approval_id: approval.approval_id, token: approval.token },
    });
    expect(ok.status).toBe(201);
    const ref = ((await ok.json()) as { order_ref: string }).order_ref;
    const row = (
      await w.app.db.query<{ currency: string; total_minor: string | number }>(
        'SELECT currency, total_minor FROM orders WHERE order_ref = $1',
        [ref],
      )
    ).rows[0]!;
    expect([row.currency, Number(row.total_minor)]).toEqual(['USD', 40]);
  });

  it('quotes and approvals: a displayed figure in the body is refused', async () => {
    const quotes = await import('./app/api/quotes/route');
    const approvals = await import('./app/api/approvals/route');
    const b = await w.buyer('DE');
    const base = { publisher: 'harbour-ledger', offer: 'tide-tables', option: 'online_read' };
    for (const extra of [
      { display: { lead: 'about €0.01' } },
      { price: { currency: 'EUR', minor: 1 } },
    ]) {
      const r = await call(quotes.POST, {
        url: '/api/quotes',
        method: 'POST',
        session: b.session,
        body: { ...base, ...extra },
      });
      expect(r.status, JSON.stringify(extra)).toBe(400);
    }
    const { quote } = await approvalFor(b);
    const before = await count('SELECT count(*) AS c FROM approvals');
    const r = await call(approvals.POST, {
      url: '/api/approvals',
      method: 'POST',
      session: b.session,
      body: {
        quote_id: quote.quote_id,
        consent: { terms: true, identity_share: false },
        display_minor: 1,
        display_currency: 'EUR',
      },
    });
    expect(r.status).toBe(400);
    expect(await count('SELECT count(*) AS c FROM approvals')).toBe(before);
  });

  it('a rate that moves after the page was shown changes no stored amount', async () => {
    const b = await w.buyer('DE');
    const d = await buyerDisplay(w.app.engine, b.actor, { currencies: ['USD'] });
    expect(d.view({ currency: 'USD', minor: 40 }).lead).toBe('about €0.33');
    const { approval } = await approvalFor(b);
    // the next day the rate is very different (1 EUR = 4 USD); the stored approval and the order do not move
    await w.app.db.query(
      `INSERT INTO fx_rates (date, base, quote, rate, source, fetched_at)
       SELECT (now() AT TIME ZONE 'UTC')::date + 1, 'EUR', q, r, 'ecb', now()
         FROM (VALUES ('USD', 4.0), ('GBP', 0.5)) AS t(q, r)`,
    );
    const d2 = await buyerDisplay(w.app.engine, b.actor, { currencies: ['USD'], refresh: false });
    expect(d2.view({ currency: 'USD', minor: 40 }).lead).toBe('about €0.10');
    const placed = await w.app.engine.payments.placeOrder({
      approval_id: approval.approval_id,
      token: approval.token,
      actor: b.actor,
    });
    if (!placed.ok) throw new Error('place');
    const o = (
      await w.app.db.query<{ currency: string; total_minor: string | number }>(
        'SELECT currency, total_minor FROM orders WHERE id = $1',
        [placed.value.order_id],
      )
    ).rows[0]!;
    expect([o.currency, Number(o.total_minor)]).toEqual(['USD', 40]);
  });
});
