// MC2-L6 (D-083): a capture PayPal holds for the seller to accept. A buyer pays over the dry-run model with
// the `pending_receiving_pref` scenario. The buyer's order page and library say "Awaiting seller
// acceptance" and stay locked; the seller console lists the unit with its currency and the two D-083
// choices; the operator's exposure counts it. Any other pending reason keeps the generic words. Nothing
// here changes a money state: the unit is `pending`, the entitlement `locked`, no ledger row exists.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { hashPasscode } from '@umsbx/security';
import type { Actor } from '@umsbx/contracts';
import { bootRefundWorld, buy } from './refund-support';
import type { BoughtUnit, RefundWorld } from './refund-support';
import {
  AWAITING_SELLER_BUYER_TEXT,
  AWAITING_SELLER_LABEL,
  pendingSellerView,
} from './lib/pending-copy';

vi.mock('server-only', () => ({}));

const PUBLISHER_PASSCODE = 'publisher passcode for tests only';
const PSALT = 'ffeeddccbbaa99887766554433221100';
const RAW = 'RECEIVING_PREFERENCE_MANDATES_MANUAL_ACTION';

let w: RefundWorld;
let seller: Actor;
let otherSeller: Actor;
let operator: Actor;
let awaiting: BoughtUnit;
let generic: BoughtUnit;

async function publisher(persona: string): Promise<Actor> {
  const s = await w.app.engine.signIn({ persona, passcode: PUBLISHER_PASSCODE });
  if (s === null) throw new Error(`no sign in for ${persona}`);
  return s.actor;
}

beforeAll(async () => {
  w = await bootRefundWorld({
    UMS_PUBLISHER_PASSCODE_HASH: await hashPasscode(PUBLISHER_PASSCODE, PSALT),
  });
  seller = await publisher('publisher-harbour-ledger');
  otherSeller = await publisher('publisher-quayside-gazette');
  operator = { kind: 'operator', operator_id: 'opr_vikram', mfa: true };
  awaiting = await buy(w, {
    offer: 'tide-tables',
    option: 'online_read',
    scenario: 'pending_receiving_pref',
  });
  generic = await buy(w, {
    offer: 'ferry-timetables',
    option: 'online_read',
    scenario: 'pending_then_completed',
    who: 'B',
  });
});
afterAll(async () => {
  await w.app.close();
});

const orderOf = async (u: BoughtUnit, actor: Actor) =>
  (await w.app.engine.orderView({ order_ref: u.order_ref, actor }))!;
const libraryItem = async (u: BoughtUnit, actor: Actor) =>
  (await w.app.engine.libraryItem({ entitlement_id: u.entitlement_id, actor }))!;

describe('buyer, order page and library', () => {
  it('stores the unit as pending with the PayPal reason and keeps the item locked', async () => {
    const r = await w.app.db.query<{ status: string; status_reason: string }>(
      'SELECT status, status_reason FROM order_units WHERE id = $1',
      [awaiting.unit_id],
    );
    expect(r.rows[0]).toEqual({ status: 'pending', status_reason: RAW });
    const v = await orderOf(awaiting, w.actorA);
    expect(v.items.every((i) => i.access === 'locked')).toBe(true);
    const ledger = await w.app.db.query<{ c: string }>(
      'SELECT count(*) AS c FROM ledger_entries WHERE unit_id = $1',
      [awaiting.unit_id],
    );
    expect(Number(ledger.rows[0]!.c)).toBe(0);
  });

  it('the order page says Awaiting seller acceptance and never the raw reason', async () => {
    const v = await orderOf(awaiting, w.actorA);
    expect(v.buyer_message).toBe(AWAITING_SELLER_BUYER_TEXT);
    expect(v.buyer_message.startsWith(AWAITING_SELLER_LABEL)).toBe(true);
    expect(JSON.stringify(v)).not.toContain(RAW);
    expect(v.status).toBe('unresolved');
  });

  it('the library item says the same and stays locked', async () => {
    const item = await libraryItem(awaiting, w.actorA);
    expect(item.status_text).toBe(AWAITING_SELLER_BUYER_TEXT);
    expect(item.can_open).toBe(false);
    expect(item.access).not.toBe('available');
    expect(JSON.stringify(item)).not.toContain(RAW);
    const list = await w.app.engine.library({ actor: w.actorA });
    expect(list.find((i) => i.entitlement_id === awaiting.entitlement_id)?.status_text).toBe(
      AWAITING_SELLER_BUYER_TEXT,
    );
  });

  it('any other pending reason keeps the generic words', async () => {
    const r = await w.app.db.query<{ status_reason: string }>(
      'SELECT status_reason FROM order_units WHERE id = $1',
      [generic.unit_id],
    );
    expect(r.rows[0]!.status_reason).not.toBe(RAW);
    expect((await orderOf(generic, w.actorB)).buyer_message).toBe('Payment pending at PayPal');
    expect((await libraryItem(generic, w.actorB)).status_text).toBe('Payment pending at PayPal');
  });
});

describe('seller console', () => {
  it('lists the pending units of the signed-in seller with the label, currency and amount', async () => {
    const rows = (await w.app.engine.publisherPending(seller))!;
    const mine = rows.filter((r) => r.kind === 'awaiting_seller_acceptance');
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({
      label: AWAITING_SELLER_LABEL,
      currency: awaiting.currency,
      amount_minor: awaiting.amount_minor,
      environment: 'dryrun',
    });
    expect(mine[0]!.order_ref6).toBe(awaiting.order_ref.slice(-6));
    const generics = rows.filter((r) => r.kind === 'payment_pending');
    expect(generics.map((r) => r.label)).toEqual(['Payment pending at PayPal']);
    expect(JSON.stringify(rows)).not.toContain(RAW);
  });

  it('the view has the count and amount per currency and the two choices, with no automatic action', async () => {
    const view = pendingSellerView((await w.app.engine.publisherPending(seller))!);
    expect(view.groups).toHaveLength(1);
    expect(view.groups[0]!.currency).toBe(awaiting.currency);
    expect(view.groups[0]!.count).toBe(2);
    expect(view.panel!.choices.map((c) => c.id)).toEqual(['wait', 'other_currency']);
    expect(view.panel!.choices[1]!.href).toBe('/publisher/offers/new');
  });

  it('shows another seller nothing, and a buyer or operator no seller console', async () => {
    expect(await w.app.engine.publisherPending(otherSeller)).toEqual([]);
    expect(await w.app.engine.publisherPending(w.actorA)).toBeNull();
    expect(await w.app.engine.publisherPending(operator)).toBeNull();
  });

  it('does not move the unit into the counted sales or the statement', async () => {
    const sales = (await w.app.engine.publisherSales(seller))!;
    expect(sales.filter((s) => s.status === 'pending').length).toBeGreaterThan(0);
    const unit = await w.app.db.query<{ status: string }>(
      'SELECT status FROM order_units WHERE id = $1',
      [awaiting.unit_id],
    );
    expect(unit.rows[0]!.status).toBe('pending');
  });
});

describe('operator exposure', () => {
  it('counts the units awaiting acceptance per publisher, currency and environment', async () => {
    const r = await w.app.engine.opsPublishers.list(operator);
    if (!r.ok) throw new Error('no list');
    const mine = r.value.awaiting.filter((a) => a.currency === awaiting.currency);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({
      count: 1,
      minor: awaiting.amount_minor,
      environment: 'dryrun',
    });
    expect(JSON.stringify(r.value.awaiting)).not.toContain(RAW);
  });
});
