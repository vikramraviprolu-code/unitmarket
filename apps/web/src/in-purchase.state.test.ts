// COR-IN (docs/specs/db-in-usd-corridor.md): a buyer outside India buys from an India publisher in US dollars,
// through the real engine and the dry-run order model. The quote, the approval, the order, the payment and the
// ledger stay in USD in the in-usd corridor; access opens; the order carries the stored environment "dryrun",
// which the page copy shows as "Dry run". A buyer in India is refused. Dry run: this proves the modelled path, not
// PayPal compatibility. The merchant id is a fictional test value.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Actor } from '@umsbx/contracts';
import { bootRefundWorld } from './refund-support';
import type { RefundWorld } from './refund-support';
import { siteDescription, siteFooter } from './ui/env-copy';

vi.mock('server-only', () => ({}));

let w: RefundWorld;
beforeAll(async () => {
  w = await bootRefundWorld();
  // The seeded Quayside Gazette becomes an India publisher with a verified payee (its USD offers are unchanged).
  await w.app.db.query(
    `UPDATE publishers SET country = 'IN', paypal_merchant_id = 'MERCHINTEST1', payee_verified_at = now()
      WHERE slug = 'quayside-gazette'`,
  );
  await w.app.db.query(
    `INSERT INTO buyers (id, display_name, auth_subject, country, created_at, updated_at)
     VALUES ('buy_in_1', 'Buyer in India', 'test:in-1', 'IN', now(), now())`,
  );
});
afterAll(async () => {
  await w.app.close();
});

const OFFER = { publisher_slug: 'quayside-gazette', offer_code: 'quay-walk' };

describe('a US buyer buys from an India publisher in USD', () => {
  it('stays in USD and in-usd from quote to ledger, opens access, and says Dry run', async () => {
    const { app, actorA: actor } = w;
    const q = await app.engine.quote({
      offer: OFFER,
      actor,
      source: 'direct',
      option: 'online_read',
    });
    if (!q.ok || q.value.kind !== 'quote') throw new Error(`no quote: ${JSON.stringify(q)}`);
    expect(q.value).toMatchObject({ corridor_id: 'in-usd', price: { currency: 'USD', minor: 90 } });
    const g = await app.engine.requestApproval({
      actor,
      selection: { kind: 'quote', quote_id: q.value.quote_id },
      consent: { terms: true, identity_share: false },
    });
    if (!g.ok) throw new Error(`no approval: ${g.error.code}`);
    const placed = await app.engine.payments.placeOrder({
      approval_id: g.value.approval_id,
      token: g.value.token,
      actor,
    });
    if (!placed.ok) throw new Error(`place: ${JSON.stringify(placed.error)}`);
    const co = await app.engine.payments.beginCheckout({ order_id: placed.value.order_id, actor });
    if (!co.ok) throw new Error(`checkout: ${co.error.code}`);
    expect(
      await app.engine.dryRunApprove({
        order_ref: placed.value.order_ref,
        actor,
        scenario: 'happy',
      }),
    ).toBeTruthy();
    await app.engine.payments.onBuyerReturn({
      order_ref: placed.value.order_ref,
      actor,
      scenario: 'happy',
    });

    const order = (
      await app.db.query<{
        corridor_id: string;
        currency: string;
        status: string;
        environment: string;
      }>('SELECT corridor_id, currency, status, environment FROM orders WHERE id = $1', [
        placed.value.order_id,
      ])
    ).rows[0]!;
    expect(order).toEqual({
      corridor_id: 'in-usd',
      currency: 'USD',
      status: 'paid',
      environment: 'dryrun',
    });
    // the label comes from the stored environment of the order
    const env = order.environment as 'dryrun' | 'sandbox';
    expect(siteDescription(env)).toMatch(/^Buy just the article you need\. Dry run:/);
    expect(siteFooter(env)).toMatch(/^Dry run for testing\./);

    const ledger = await app.db.query<{
      kind: string;
      currency: string;
      amount_minor: string | number;
    }>(
      `SELECT l.kind, l.currency, l.amount_minor FROM ledger_entries l
         JOIN order_units u ON u.id = l.unit_id WHERE u.order_id = $1 ORDER BY l.kind`,
      [placed.value.order_id],
    );
    expect(ledger.rows.length).toBeGreaterThan(0);
    expect([...new Set(ledger.rows.map((r) => r.currency))]).toEqual(['USD']);
    expect(ledger.rows.filter((r) => r.kind === 'sale').map((r) => Number(r.amount_minor))).toEqual(
      [90],
    );

    // access opens: the entitlement of the paid unit is available and the money is captured
    const ent = await app.db.query<{ access_state: string; money_state: string }>(
      `SELECT e.access_state, e.money_state FROM entitlements e
         JOIN order_units u ON u.id = e.unit_id WHERE u.order_id = $1`,
      [placed.value.order_id],
    );
    expect(ent.rows).toEqual([{ access_state: 'available', money_state: 'captured' }]);
  });

  it('a buyer in India is not quoted an India publisher offer', async () => {
    const actor: Actor = { kind: 'buyer', buyer_id: 'buy_in_1' };
    const q = await w.app.engine.quote({
      offer: OFFER,
      actor,
      source: 'direct',
      option: 'online_read',
    });
    expect(q.ok && q.value).toEqual({ kind: 'no_match', reason: 'corridor_unsupported' });
  });
});
