// CO-2 integration: delivery -> verdict -> handleWebhook -> read-back due -> a poller pass reads
// PayPal -> order paid, with the money invariants (INV1..INV6) checked after every step. The verifier
// (CO-1) is not in this tree: the verdicts are recorded fixtures in golden/webhook-verdicts.recorded.json,
// shaped as the verifier returns them (WebhookVerdictSchema), with the ids swapped for the ones of the
// test's own order. PayPal is the scripted fake; the only reads are the poller's.
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { WebhookVerdictSchema } from '@umsbx/contracts';
import type { ProviderEvent, SqlExecutor, WebhookVerdict } from '@umsbx/contracts';
import {
  checkInvariants,
  executeRefund,
  handleWebhook,
  onBuyerReturn,
  requestRefund,
  runDue,
} from './index';
import {
  BUYER_A,
  OPERATOR,
  alertKinds,
  approved,
  count,
  lostResponse,
  makeWorld,
  ops,
  paid,
} from './ops/support';
import type { OpsWorld } from './ops/support';

type Recorded = Record<string, unknown>;
const { meta, verdicts: recorded } = JSON.parse(
  readFileSync(new URL('./golden/webhook-verdicts.recorded.json', import.meta.url), 'utf8'),
) as { meta: { source: string }; verdicts: Record<string, Recorded> };

let w: OpsWorld;
let live = false;
afterEach(async () => {
  if (!live) return;
  live = false;
  expect(w.paypal.violations).toEqual([]);
  await w.close();
});
const H = 3_600_000;
let n = 0;

/** A recorded verdict, parsed as the contract says, with this test's ids swapped in. */
function verdict(name: string, ids: Partial<ProviderEvent> = {}): WebhookVerdict {
  const raw = recorded[name];
  if (raw === undefined) throw new Error(`no recorded verdict ${name}`);
  const parsed = WebhookVerdictSchema.parse(raw);
  if (parsed.kind !== 'verified') return parsed;
  n += 1;
  return WebhookVerdictSchema.parse({
    kind: 'verified',
    event: {
      ...parsed.event,
      event_id: `${parsed.event.event_id}-${n}`,
      transmission_id: `${parsed.event.transmission_id}-${n}`,
      ...ids,
    },
  });
}
async function world(): Promise<void> {
  w = await makeWorld();
  live = true;
  let k = 0;
  w.deps = {
    ...w.deps,
    audit: {
      record: async (tx: SqlExecutor, e) => {
        k += 1;
        await tx.query(
          `INSERT INTO audit_log (id, actor_kind, actor_id, action, target, reason, detail, created_at, updated_at)
           VALUES ($1, $2, NULL, $3, $4, $5, $6::jsonb, $7, $7)`,
          [
            `aud_i${k}`,
            e.actor.kind,
            e.action,
            e.target,
            e.reason,
            JSON.stringify(e.detail),
            w.clock.now().toISOString(),
          ],
        );
      },
    },
  };
}
const inv = async (step: string): Promise<void> => {
  const bad = (await checkInvariants(w.deps.db)).filter((i) => !i.ok);
  expect(bad, `invariants after ${step}`).toEqual([]);
};
/** One delivery; PayPal must not be called by it. */
async function deliver(step: string, v: WebhookVerdict, transmission_id = 'tx-int') {
  const calls = w.paypal.calls.length;
  const r = await handleWebhook(w.deps, {
    verdict: v,
    transmission_id: v.kind === 'verified' ? v.event.transmission_id : transmission_id,
    received_at: w.clock.now().toISOString(),
  });
  expect(w.paypal.calls.length, `${step}: no PayPal call`).toBe(calls);
  await inv(step);
  return r;
}
const orderRow = async (order_id: string) =>
  (await w.rows<{ status: string }>('SELECT status FROM orders WHERE id = $1', [order_id]))[0]!;
const unitRow = async (order_id: string) =>
  (
    await w.rows<{ id: string; status: string; capture_id: string | null }>(
      'SELECT id, status, capture_id FROM order_units WHERE order_id = $1',
      [order_id],
    )
  )[0]!;
const readbackOf = async (order_id: string) =>
  (await ops(w, order_id)).find((o) => o.kind === 'readback')!;

describe('recorded verdict fixture', () => {
  it('is labelled synthetic and every verdict parses with the contract', () => {
    expect(meta.source).toBe('synthetic');
    for (const [name, v] of Object.entries(recorded)) {
      expect(WebhookVerdictSchema.safeParse(v).success, name).toBe(true);
    }
  });
});

describe('delivery to paid, invariants after each step', () => {
  it('a genuine COMPLETED makes the read-back due; the poller pass pays the order', async () => {
    await world();
    await inv('start');
    const a = await approved(w);
    w.paypal.queue.get.push('real', { kind: 'timeout' } as never); // the buyer return cannot read yet
    const back = await onBuyerReturn(w.deps, { order_ref: a.order_ref, actor: BUYER_A });
    expect(back.ok && back.value.status).toBe('unresolved');
    await inv('buyer return with a lost read');
    const unit = await unitRow(a.order_id);

    // 1. delivery -> verdict -> handleWebhook
    const v = verdict('capture_completed', {
      capture_id: unit.capture_id,
      provider_order_id: a.provider_order_id,
    });
    // The read-back poll is an hour away, so the event has to bring it forward.
    w.tick(2 * H);
    await w.rows(
      "UPDATE operations SET next_retry_at = $2 WHERE order_id = $1 AND kind = 'readback'",
      [a.order_id, new Date(w.clock.now().getTime() + H).toISOString()],
    );
    expect(await deliver('COMPLETED delivered', v)).toEqual({ http: 200, outcome: 'enqueued' });

    // 2. the operation is due now, and nothing was decided by the webhook
    const op = await readbackOf(a.order_id);
    expect(op.state).toBe('unknown');
    expect(op.next_retry_at!.toISOString()).toBe(w.clock.now().toISOString());
    expect((await orderRow(a.order_id)).status).toBe('unresolved');
    expect((await unitRow(a.order_id)).status).toBe('expected');
    expect(await count(w, 'ledger_entries')).toBe(0);

    // 3. a poller pass reads PayPal and decides
    const gets = w.paypal.count('get');
    await runDue(w.deps, { max_items: 10 });
    expect(w.paypal.count('get')).toBe(gets + 1);
    await inv('poller pass');
    expect((await orderRow(a.order_id)).status).toBe('paid');
    expect((await unitRow(a.order_id)).status).toBe('captured_verified');
    expect(await count(w, 'ledger_entries', "kind = 'sale'")).toBe(1);
    expect((await readbackOf(a.order_id)).state).toBe('confirmed');

    // 4. PayPal redelivers the same webhook: nothing moves, no new read
    const again = await deliver('replay', v);
    expect(again).toEqual({ http: 200, outcome: 'duplicate' });
    await runDue(w.deps, { max_items: 10 });
    expect(w.paypal.count('get')).toBe(gets + 1);
    await inv('replay then poller pass');
    expect(await count(w, 'ledger_entries', "kind = 'sale'")).toBe(1);
  });

  it('a COMPLETED for an already paid order costs one read and changes nothing', async () => {
    await world();
    const a = await paid(w);
    const unit = await unitRow(a.order_id);
    const before = await w.rows('SELECT money_state, access_state FROM entitlements');
    const sales = await count(w, 'ledger_entries');
    expect(
      await deliver(
        'COMPLETED on paid',
        verdict('capture_completed', { capture_id: unit.capture_id }),
      ),
    ).toEqual({ http: 200, outcome: 'enqueued' });
    const gets = w.paypal.count('get');
    await runDue(w.deps, { max_items: 10 });
    expect(w.paypal.count('get')).toBe(gets + 1);
    await inv('poller pass');
    expect(await w.rows('SELECT money_state, access_state FROM entitlements')).toEqual(before);
    expect(await count(w, 'ledger_entries')).toBe(sales);
  });

  it('REFUNDED (capture and refund id, as the verifier reports it) keeps access revoked', async () => {
    await world();
    const a = await paid(w);
    const unit = await unitRow(a.order_id);
    const r = await requestRefund(w.deps, {
      unit_id: unit.id,
      amount: null,
      reason: 'goodwill',
      actor: OPERATOR,
    });
    if (!r.ok) throw new Error('refund refused');
    await executeRefund(w.deps, { refund_request_id: r.value.refund_request_id });
    await inv('refund executed');
    const refund_id = (
      await w.rows<{ refund_id: string }>(
        'SELECT refund_id FROM refund_requests WHERE unit_id = $1',
        [unit.id],
      )
    )[0]!.refund_id;
    const entitlements = await w.rows('SELECT money_state, access_state FROM entitlements');
    const ledger = await count(w, 'ledger_entries');

    expect(
      await deliver(
        'REFUNDED',
        verdict('capture_refunded', { capture_id: unit.capture_id, refund_id }),
      ),
    ).toEqual({ http: 200, outcome: 'enqueued' });
    w.tick(60_000);
    await runDue(w.deps, { max_items: 10 });
    await inv('poller pass after REFUNDED');
    expect(await w.rows('SELECT money_state, access_state FROM entitlements')).toEqual(
      entitlements,
    );
    expect(await count(w, 'ledger_entries')).toBe(ledger);
    expect((await unitRow(a.order_id)).status).toBe('refunded');
  });

  it('REVERSED is only a hint: the poller pass decides, and only read evidence marks the unit', async () => {
    await world();
    const a = await paid(w);
    const unit = await unitRow(a.order_id);
    expect(
      await deliver('REVERSED', verdict('capture_reversed', { capture_id: unit.capture_id })),
    ).toEqual({ http: 200, outcome: 'enqueued' });
    expect((await unitRow(a.order_id)).status).toBe('captured_verified');
    expect(await alertKinds(w, a.order_id)).toEqual(['reversal']);
    await runDue(w.deps, { max_items: 10 });
    await inv('poller pass after REVERSED');
    expect((await unitRow(a.order_id)).status).toBe('captured_verified');
    expect(await count(w, 'ledger_entries', "kind = 'reversal'")).toBe(0);

    // PayPal now shows the capture as declined: the next read marks it, still never reversed.
    w.forceStatus(unit.capture_id!, 'DECLINED');
    await deliver('REVERSED again', verdict('capture_reversed', { capture_id: unit.capture_id }));
    w.tick(60_000);
    await runDue(w.deps, { max_items: 10 });
    await inv('poller pass after DECLINED read');
    expect((await unitRow(a.order_id)).status).toBe('reversal_suspected');
    expect(await count(w, 'ledger_entries', "kind = 'reversal'")).toBe(0);
  });

  it('a capture whose answer was lost (no capture id stored): COMPLETED wakes the read-back by order id, the poller pays', async () => {
    await world();
    const a = await lostResponse(w);
    expect((await unitRow(a.order_id)).capture_id).toBeNull();
    await inv('capture answer lost');
    const fakeCapture = [...w.paypal.orders.values()][0]!.capture!.capture_id;
    w.tick(2 * H);
    expect(
      await deliver(
        'COMPLETED, capture id unknown',
        verdict('capture_completed', {
          capture_id: fakeCapture,
          provider_order_id: a.provider_order_id,
        }),
      ),
    ).toEqual({ http: 200, outcome: 'enqueued' });
    expect((await orderRow(a.order_id)).status).toBe('unresolved');
    expect((await readbackOf(a.order_id)).state).toBe('unknown');
    await runDue(w.deps, { max_items: 10 });
    await inv('poller pass');
    expect((await orderRow(a.order_id)).status).toBe('paid');
    expect(await count(w, 'ledger_entries', "kind = 'sale'")).toBe(1);
  });

  it('ids the contract allows but intake refuses (NUL, lone surrogate) are rejected before any lookup', async () => {
    await world();
    const a = await paid(w);
    const unit = await unitRow(a.order_id);
    const poison = verdict('capture_completed', { capture_id: unit.capture_id });
    if (poison.kind !== 'verified') throw new Error('fixture');
    const bad: WebhookVerdict = {
      kind: 'verified',
      event: { ...poison.event, event_id: 'a\u0000b' },
    };
    expect(await deliver('NUL in event id', bad, 'tx-nul')).toEqual({
      http: 400,
      outcome: 'rejected',
    });
    expect(await count(w, 'webhook_events')).toBe(0);
    expect(await count(w, 'audit_log', "action = 'webhook.rejected'")).toBe(1);
  });

  it('CHECKOUT.ORDER.APPROVED wakes an order waiting for its buyer; the read does not capture', async () => {
    await world();
    const a = await approved(w);
    expect(
      await deliver(
        'ORDER.APPROVED',
        verdict('order_approved', { provider_order_id: a.provider_order_id }),
      ),
    ).toEqual({ http: 200, outcome: 'enqueued' });
    await runDue(w.deps, { max_items: 10 });
    await inv('poller pass after ORDER.APPROVED');
    expect(w.paypal.count('capture')).toBe(0);
    expect((await orderRow(a.order_id)).status).not.toBe('paid');
    expect(await count(w, 'ledger_entries')).toBe(0);
  });
});

describe('verdicts that decide nothing', () => {
  it('unknown ids, forged, unparseable and unverifiable deliveries change no money row', async () => {
    await world();
    const a = await paid(w);
    const unit = await unitRow(a.order_id);
    const money = async () => ({
      units: await w.rows('SELECT status, refunded_minor FROM order_units ORDER BY id'),
      ent: await w.rows('SELECT money_state, access_state FROM entitlements ORDER BY id'),
      ledger: await count(w, 'ledger_entries'),
      ops: await count(w, 'operations'),
    });
    const before = await money();
    expect(await deliver('other event', verdict('other_event'))).toEqual({
      http: 200,
      outcome: 'no_op',
    });
    expect(
      await deliver(
        'capture of another shop',
        verdict('capture_completed', { capture_id: 'SBXCAP9' }),
      ),
    ).toEqual({ http: 200, outcome: 'no_op' });
    expect(await deliver('forged', verdict('forged'), 'tx-forged')).toEqual({
      http: 400,
      outcome: 'rejected',
    });
    expect(await deliver('unparseable', verdict('unparseable'), 'tx-bad')).toEqual({
      http: 400,
      outcome: 'rejected',
    });
    expect(await deliver('no webhook id', verdict('no_webhook_id'), 'tx-nowh')).toEqual({
      http: 503,
      outcome: 'unverifiable',
    });
    expect(await money()).toEqual(before);
    expect(await count(w, 'audit_log', "action LIKE 'webhook.%'")).toBe(3);
    expect(await count(w, 'webhook_events')).toBe(2);
    expect(unit.capture_id).not.toBeNull();
  });

  it('switch off: 503 and nothing stored; on again, the same delivery is accepted', async () => {
    await world();
    const a = await paid(w);
    const unit = await unitRow(a.order_id);
    const v = verdict('capture_completed', { capture_id: unit.capture_id });
    w.switches.webhook_enabled = false;
    expect(await deliver('switch off', v)).toEqual({ http: 503, outcome: 'disabled' });
    expect(await count(w, 'webhook_events')).toBe(0);
    w.switches.webhook_enabled = true;
    expect(await deliver('switch on', v)).toEqual({ http: 200, outcome: 'enqueued' });
    expect(await count(w, 'webhook_events')).toBe(1);
  });
});
