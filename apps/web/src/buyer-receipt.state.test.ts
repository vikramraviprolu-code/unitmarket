// UX-1A addendum, items 45 and 53 over the real engine and the dry-run order model: the buyer receipt
// names the article and the publisher from the catalogue, and /ops lists an order reference whole.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { bootRefundWorld, buy } from './refund-support';
import type { BoughtUnit, RefundWorld } from './refund-support';

vi.mock('server-only', () => ({}));

let w: RefundWorld;
let unit: BoughtUnit;

beforeAll(async () => {
  w = await bootRefundWorld();
  unit = await buy(w, { offer: 'knot-notebook', option: 'online_read' });
});
afterAll(async () => {
  await w.app.close();
});

describe('engine.buyerReceipt (item 45)', () => {
  it('gives each line the title and the publisher name stored in the catalogue', async () => {
    const r = await w.app.engine.buyerReceipt({ order_id: unit.order_id, actor: w.actorA });
    expect(r).not.toBeNull();
    const row = (
      await w.app.db.query<{ title: string; display_name: string }>(
        `SELECT a.title, p.display_name FROM articles a JOIN publishers p ON p.id = a.publisher_id
          WHERE a.id = $1`,
        [r!.lines[0]!.article_id],
      )
    ).rows[0]!;
    expect(r!.lines).toHaveLength(1);
    expect(r!.lines[0]!.title).toBe(row.title);
    expect(r!.lines[0]!.publisher).toBe(row.display_name);
    expect(r!.lines[0]!.title).not.toMatch(/^art_/);
    expect(r!.environment).toBe('dryrun');
  });

  it('is the same receipt as the domain one (same version, hash and total)', async () => {
    const buyer = await w.app.engine.buyerReceipt({ order_id: unit.order_id, actor: w.actorA });
    const domain = await w.app.engine.receipt({ order_id: unit.order_id, actor: w.actorA });
    expect(buyer!.sha256).toBe(domain!.sha256);
    expect(buyer!.version).toBe(domain!.version);
    expect(buyer!.snapshot.total_minor).toBe(domain!.snapshot.total_minor);
  });

  it('answers null to another buyer, to an operator and to an unknown order', async () => {
    expect(
      await w.app.engine.buyerReceipt({ order_id: unit.order_id, actor: w.actorB }),
    ).toBeNull();
    expect(
      await w.app.engine.buyerReceipt({
        order_id: unit.order_id,
        actor: { kind: 'operator', operator_id: 'opr_vikram', mfa: true },
      }),
    ).toBeNull();
    expect(await w.app.engine.buyerReceipt({ order_id: 'ord_nope', actor: w.actorA })).toBeNull();
  });
});

describe('ops order reference (item 53)', () => {
  it('lists the whole stored reference of the order', async () => {
    const snap = await w.app.engine.opsSnapshot({
      kind: 'operator',
      operator_id: 'opr_vikram',
      mfa: true,
    });
    const mine = snap!.orders.find((o) => o.order_ref === unit.order_ref);
    expect(mine).toBeDefined();
    expect(mine!.order_ref).toBe(unit.order_ref);
    expect(unit.order_ref.length).toBeGreaterThanOrEqual(20);
    expect(mine!.order_ref).not.toMatch(/…|\.\.\./);
  });
});
