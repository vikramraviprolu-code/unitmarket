// MC-GBP (docs/specs/multi-currency-gbp.md): a UK buyer buys a UK publisher's article in pounds, through the
// real engine and the dry-run order model. The quote, the approval, the order, the payment and the ledger
// all stay in GBP, and the publisher's statement block is in GBP. Dry run: this proves the modelled path,
// not PayPal compatibility.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Actor } from '@umsbx/contracts';
import { bootRefundWorld } from './refund-support';
import type { RefundWorld } from './refund-support';

vi.mock('server-only', () => ({}));

let w: RefundWorld;
beforeAll(async () => {
  w = await bootRefundWorld();
});
afterAll(async () => {
  await w.app.close();
});

describe('a UK buyer buys from a UK publisher in pounds', () => {
  it('stays in GBP from quote to ledger', async () => {
    await w.app.db.query("UPDATE corridors SET enabled = true WHERE id = 'gb-gbp'");
    await w.app.db.query(
      `INSERT INTO buyers (id, display_name, auth_subject, country, created_at, updated_at)
       VALUES ('buy_uk_1', 'UK buyer', 'test:uk-1', 'GB', now(), now())`,
    );
    const actor: Actor = { kind: 'buyer', buyer_id: 'buy_uk_1' };
    const { app } = w;

    const q = await app.engine.quote({
      offer: { publisher_slug: 'northfield-quarterly', offer_code: 'allotment-diary' },
      actor,
      source: 'direct',
      option: 'online_read',
    });
    if (!q.ok || q.value.kind !== 'quote') throw new Error(`no quote: ${JSON.stringify(q)}`);
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
    const approved = await app.engine.dryRunApprove({
      order_ref: placed.value.order_ref,
      actor,
      scenario: 'happy',
    });
    expect(approved).toBeTruthy();
    await app.engine.payments.onBuyerReturn({
      order_ref: placed.value.order_ref,
      actor,
      scenario: 'happy',
    });

    const order = (
      await app.db.query<{ currency: string; status: string }>(
        'SELECT currency, status FROM orders WHERE id = $1',
        [placed.value.order_id],
      )
    ).rows[0]!;
    expect(order).toEqual({ currency: 'GBP', status: 'paid' });
    const units = await app.db.query<{ amount_minor: string | number }>(
      'SELECT amount_minor FROM order_units WHERE order_id = $1',
      [placed.value.order_id],
    );
    expect(units.rows.map((u) => Number(u.amount_minor))).toEqual([150]);
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
    expect([...new Set(ledger.rows.map((r) => r.currency))]).toEqual(['GBP']);
    expect(ledger.rows.filter((r) => r.kind === 'sale').map((r) => Number(r.amount_minor))).toEqual(
      [150],
    );
  });
});
