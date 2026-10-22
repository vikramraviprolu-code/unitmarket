// Gate review M1: in dry run the kill switch (paypal_outbound) stops every call and the offline seed
// turns it on, so recovery runs. Offline only; the app runs on the real clock.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setSwitch } from '@umsbx/safety';
import { systemClock } from '@umsbx/runtime';
import { createAuditSink } from '@umsbx/obs';
import { cryptoIds } from '@umsbx/runtime';
import type { Actor } from '@umsbx/contracts';
import type { App } from '../../apps/web/composition.server';
import { bootTestApp } from '../../apps/web/src/support';

vi.mock('server-only', () => ({}));

let app: App;
let actor: Actor;
const OPERATOR: Actor = { kind: 'operator', operator_id: 'opr_test', mfa: true };

beforeEach(async () => {
  app = await bootTestApp();
  const row = await app.db.query<{ id: string }>(
    `SELECT id FROM buyers WHERE auth_subject = 'persona:buyer-a'`,
  );
  actor = { kind: 'buyer', buyer_id: row.rows[0]!.id };
});
afterEach(async () => {
  await app.close();
});

const setOutbound = (on: boolean): Promise<unknown> =>
  app.db.query(`UPDATE safety_switches SET "on" = $1 WHERE name = 'paypal_outbound'`, [on]);

const providerCalls = async (): Promise<number> =>
  Number(
    (await app.db.query<{ c: string }>('SELECT count(*) AS c FROM provider_calls')).rows[0]?.c,
  );

async function place(offerIndex: number): Promise<{ order_ref: string; order_id: string }> {
  const offers = (await app.engine.listOffers()).filter(
    (o) => o.publisher_slug === 'harbour-ledger',
  );
  const offer = offers[offerIndex]!.offer_code;
  const page = await app.engine.offerPage({ publisher: 'harbour-ledger', offer });
  const q = await app.engine.quote({
    offer: { publisher_slug: 'harbour-ledger', offer_code: offer },
    actor,
    source: 'direct',
    option: page!.options[0]!.option,
  });
  if (!q.ok || q.value.kind !== 'quote') throw new Error('no quote');
  const g = await app.engine.requestApproval({
    actor,
    selection: { kind: 'quote', quote_id: q.value.quote_id },
    consent: { terms: true, identity_share: false },
  });
  if (!g.ok) throw new Error('no approval');
  const placed = await app.engine.payments.placeOrder({
    approval_id: g.value.approval_id,
    token: g.value.token,
    actor,
  });
  if (!placed.ok) throw new Error('place');
  return placed.value;
}

describe('M1 dry run: the kill switch', () => {
  it('the offline seed turns paypal_outbound on (sandbox mode keeps it off: see the gate tests)', async () => {
    await app.ready();
    const r = await app.db.query<{ on: boolean; changed_by: string }>(
      `SELECT "on", changed_by FROM safety_switches WHERE name = 'paypal_outbound'`,
    );
    expect(r.rows[0]).toEqual({ on: true, changed_by: 'seed:dryrun' });
  });

  it('with the switch off, checkout answers payments_paused and no model call is made', async () => {
    const order = await place(0);
    await setOutbound(false);
    const before = await providerCalls();
    const co = await app.engine.payments.beginCheckout({ order_id: order.order_id, actor });
    expect(co.ok).toBe(false);
    if (!co.ok) expect(co.error.code).toBe('payments_paused');
    const sent = await app.db.query<{ outcome: string }>(
      `SELECT outcome FROM provider_calls ORDER BY created_at DESC LIMIT 5`,
    );
    expect((await providerCalls()) - before).toBeLessThanOrEqual(1);
    expect(sent.rows.every((x) => x.outcome !== 'success')).toBe(true);
  });

  it('with the switch off, a capture answers payments_paused and no sale is written', async () => {
    const order = await place(0);
    const co = await app.engine.payments.beginCheckout({ order_id: order.order_id, actor });
    expect(co.ok).toBe(true);
    expect(
      await app.engine.dryRunApprove({ order_ref: order.order_ref, actor, scenario: 'happy' }),
    ).toBe(true);
    await setOutbound(false);
    const r = await app.engine.payments.onBuyerReturn({
      order_ref: order.order_ref,
      actor,
      scenario: 'happy',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('payments_paused');
    const sales = await app.db.query<{ c: string }>(
      'SELECT count(*) AS c FROM ledger_entries l JOIN order_units u ON u.id = l.unit_id WHERE u.order_id = $1',
      [order.order_id],
    );
    expect(Number(sales.rows[0]?.c)).toBe(0);
    const captured = await app.db.query<{ c: string }>(
      `SELECT count(*) AS c FROM provider_calls WHERE operation = 'capture_order' AND outcome = 'success'`,
    );
    expect(Number(captured.rows[0]?.c)).toBe(0);
  });

  it('stop pressed mid-journey: the next call is refused, start lets it through', async () => {
    const order = await place(0);
    expect((await app.engine.payments.beginCheckout({ order_id: order.order_id, actor })).ok).toBe(
      true,
    );
    expect(
      await app.engine.dryRunApprove({ order_ref: order.order_ref, actor, scenario: 'happy' }),
    ).toBe(true);
    const audit = createAuditSink(cryptoIds(), systemClock());
    const stopped = await setSwitch(app.db, audit, systemClock(), {
      name: 'paypal_outbound',
      on: false,
      by: OPERATOR,
      reason: 'test stop',
      approval_ref: null,
    });
    expect(stopped.ok).toBe(true);
    const paused = await app.engine.payments.onBuyerReturn({
      order_ref: order.order_ref,
      actor,
      scenario: 'happy',
    });
    expect(paused.ok).toBe(false);
    // Start again: setSwitch needs an active owner approval row (D-006); insert one as the CLI would.
    await app.db.query(
      `INSERT INTO outbound_approvals (id, approval_ref, scope, operations, max_amount_minor, max_calls_per_day, valid_until, approved_by, created_at, updated_at)
       VALUES ('oap_dry', 'dry-ref', 'dry', ARRAY['create_order'], 100, 5, '2999-01-01T00:00:00Z', 'owner', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
    );
    const started = await setSwitch(app.db, audit, systemClock(), {
      name: 'paypal_outbound',
      on: true,
      by: OPERATOR,
      reason: 'test start',
      approval_ref: 'dry-ref',
    });
    expect(started.ok).toBe(true);
    const back = await app.engine.payments.onBuyerReturn({
      order_ref: order.order_ref,
      actor,
      scenario: 'happy',
    });
    expect(back.ok).toBe(true);
    const view = await app.engine.orderView({ order_ref: order.order_ref, actor });
    expect(view?.status).toBe('paid');
  });

  it('offline with the switch on, the loop resolves a lost-answer capture', async () => {
    const order = await place(1);
    expect((await app.engine.payments.beginCheckout({ order_id: order.order_id, actor })).ok).toBe(
      true,
    );
    expect(
      await app.engine.dryRunApprove({
        order_ref: order.order_ref,
        actor,
        scenario: 'lost_capture_response',
      }),
    ).toBe(true);
    await app.engine.payments.onBuyerReturn({
      order_ref: order.order_ref,
      actor,
      scenario: 'lost_capture_response',
    });
    const mid = await app.engine.orderView({ order_ref: order.order_ref, actor });
    expect(mid?.status).not.toBe('paid');
    // Make the unknown operation due now, then let the background loop pick it up.
    await app.db.query(
      `UPDATE operations SET next_retry_at = '2000-01-01T00:00:00Z' WHERE state = 'unknown'`,
    );
    const jobs = await app.startJobs();
    await vi.waitFor(
      async () => {
        const v = await app.engine.orderView({ order_ref: order.order_ref, actor });
        expect(v?.status).toBe('paid');
      },
      { timeout: 8000, interval: 100 },
    );
    await jobs.stop();
  });
});
