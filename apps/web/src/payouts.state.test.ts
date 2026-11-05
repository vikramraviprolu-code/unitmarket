// POB-M1: the payout through the composition root. A paid order is paid out after its window, in dry run, by
// Engine.runPayouts; the paypal_outbound switch decides whether the pass gets a port; the operator reads the payouts;
// the publisher statement carries the money block. Offline: the only port is the dry run, nothing leaves the process.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Actor } from '@umsbx/contracts';
import type { App } from '../composition.server';
import { bootTestApp } from './support';

vi.mock('server-only', () => ({}));
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const NOW = Date.parse('2026-11-05T12:00:00.000Z');
const DAY = 86_400_000;
let app: App;
let actor: Actor;
let actorB: Actor;
beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  app = await bootTestApp();
  const a = await app.db.query<{ id: string }>(
    `SELECT id FROM buyers WHERE auth_subject = 'persona:buyer-a'`,
  );
  actor = { kind: 'buyer', buyer_id: a.rows[0]!.id };
  const b = await app.db.query<{ id: string }>(
    `SELECT id FROM buyers WHERE auth_subject = 'persona:buyer-b'`,
  );
  actorB = { kind: 'buyer', buyer_id: b.rows[0]!.id };
});
afterAll(async () => {
  await app.close();
  vi.useRealTimers();
});
beforeEach(() => {
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.setSystemTime(NOW);
});

const OPERATOR: Actor = { kind: 'operator', operator_id: 'opr_demo', mfa: false };

async function pay(offer: string, who: Actor): Promise<{ order_id: string; order_ref: string }> {
  const page = await app.engine.offerPage({ publisher: 'harbour-ledger', offer });
  const q = await app.engine.quote({
    offer: { publisher_slug: 'harbour-ledger', offer_code: offer },
    actor: who,
    source: 'direct',
    option: page!.options[0]!.option,
  });
  if (!q.ok || q.value.kind !== 'quote') throw new Error(`no quote for ${offer}`);
  const g = await app.engine.requestApproval({
    actor: who,
    selection: { kind: 'quote', quote_id: q.value.quote_id },
    consent: { terms: true, identity_share: false },
  });
  if (!g.ok) throw new Error(`no approval: ${g.error.code}`);
  const placed = await app.engine.payments.placeOrder({
    approval_id: g.value.approval_id,
    token: g.value.token,
    actor: who,
  });
  if (!placed.ok) throw new Error(`place: ${JSON.stringify(placed.error)}`);
  const co = await app.engine.payments.beginCheckout({
    order_id: placed.value.order_id,
    actor: who,
  });
  if (!co.ok) throw new Error(`checkout: ${co.error.code}`);
  expect(
    await app.engine.dryRunApprove({
      order_ref: placed.value.order_ref,
      actor: who,
      scenario: 'happy',
    }),
  ).toBe(true);
  await app.engine.payments.onBuyerReturn({
    order_ref: placed.value.order_ref,
    actor: who,
    scenario: 'happy',
  });
  return placed.value;
}
const offerCodes = async (): Promise<string[]> =>
  (await app.engine.listOffers())
    .filter((o) => o.publisher_slug === 'harbour-ledger')
    .map((o) => o.offer_code);
const payouts = () =>
  app.db.query<{
    state: string;
    amount_minor: number;
    environment: string;
    provider_ref: string | null;
    payee_merchant_id: string;
  }>(
    'SELECT state, amount_minor::int AS amount_minor, environment, provider_ref, payee_merchant_id FROM payouts ORDER BY created_at, id',
  );

describe('Engine.runPayouts', () => {
  it('pays a sale out after its window, once, in dry run', async () => {
    const [offer] = await offerCodes();
    const order = await pay(offer!, actor);
    expect(await app.engine.runPayouts()).toMatchObject({ created: 0, sent: 0 });
    vi.setSystemTime(NOW + 3 * DAY);
    expect(await app.engine.runPayouts()).toMatchObject({ created: 0, sent: 0 });
    vi.setSystemTime(NOW + 6 * DAY);
    const first = await app.engine.runPayouts();
    expect(first).toMatchObject({ created: 1, sent: 1 });
    const rows = (await payouts()).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ environment: 'dryrun', state: 'confirmed' });
    expect(rows[0]!.provider_ref).toMatch(/^DRYRUN-umsP-pay_/);
    expect(rows[0]!.payee_merchant_id).toMatch(/^DRYRUN/); // the synthetic dry run payee, never a real account
    expect(await app.engine.runPayouts()).toMatchObject({ created: 0, sent: 0 });
    expect((await payouts()).rows).toHaveLength(1);
    expect(order.order_id).toBeTruthy();
  });

  it('with the outbound switch off the payouts are created due and nothing is sent; on again, they go', async () => {
    const codes = await offerCodes();
    await pay(codes[1] ?? codes[0]!, actorB);
    await app.db.query(`UPDATE safety_switches SET "on" = false WHERE name = 'paypal_outbound'`);
    vi.setSystemTime(NOW + 12 * DAY);
    const off = await app.engine.runPayouts();
    expect(off).toMatchObject({ created: 1, sent: 0 });
    const due = (await payouts()).rows.filter((r) => r.state === 'due');
    expect(due).toHaveLength(1);
    await app.db.query(`UPDATE safety_switches SET "on" = true WHERE name = 'paypal_outbound'`);
    expect(await app.engine.runPayouts()).toMatchObject({ created: 0, sent: 1 });
    expect((await payouts()).rows.filter((r) => r.state === 'due')).toHaveLength(0);
  });
});

describe('Engine.opsPayouts', () => {
  it('lists the payouts and counts them by state for an operator, and gives nothing to anyone else', async () => {
    const view = await app.engine.opsPayouts(OPERATOR);
    expect(view).not.toBeNull();
    expect(view!.environment).toBe('dryrun');
    expect(view!.rows.length).toBeGreaterThan(0);
    expect(Object.keys(view!.counts).sort()).toEqual([
      'cancelled',
      'confirmed',
      'due',
      'failed',
      'sending',
      'sent',
    ]);
    const total = Object.values(view!.counts).reduce((s, n) => s + n, 0);
    expect(total).toBe((await payouts()).rows.length);
    expect(view!.rows[0]).toMatchObject({
      currency: 'USD',
      environment: 'dryrun',
    });
    expect(view!.rows[0]!.publisher_name).toBeTruthy();
    expect(JSON.stringify(view)).not.toMatch(/DRYRUN[A-Z0-9]{5,}/); // no payee id on the page
    expect(await app.engine.opsPayouts(actor)).toBeNull();
    expect(await app.engine.opsPayouts({ kind: 'publisher', publisher_id: 'pub_x' })).toBeNull();
    expect(await app.engine.opsPayouts({ kind: 'system' })).toBeNull();
  });
});

describe('the publisher statement', () => {
  it('shows the money block with the paid out figure after a payout', async () => {
    const pubId = (
      await app.db.query<{ id: string }>("SELECT id FROM publishers WHERE slug = 'harbour-ledger'")
    ).rows[0]!.id;
    const st = await app.engine.publisherStatement({ kind: 'publisher', publisher_id: pubId });
    const usd = st!.blocks.find((b) => b.currency === 'USD' && b.environment === 'dryrun')!;
    expect(usd.money).not.toBeNull();
    expect(usd.money!.owed_minor).toBeGreaterThan(0);
    expect(usd.money!.paid_out_minor).toBeGreaterThan(0);
    expect(usd.money!.adjustment_minor).toBe(0);
  });
});
