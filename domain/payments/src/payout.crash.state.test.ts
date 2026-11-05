// POB-M1: crash safety and idempotency of the payout. `sending` is committed before the port is called; a payout found in
// `sending` is sent again with the same stored key and never replaced; a throwing or blocked send leaves it where it is;
// a refund booked while it is in flight is an adjustment, not a cancel. Real PGlite, a scripted payout port.
import { afterEach, describe, expect, it } from 'vitest';
import { PAYOUT_RETRY_AFTER_MS } from '@umsbx/contracts';
import { executeRefund, requestRefund, runPayoutPass } from './index';
import { OPERATOR, makeWorld, paid } from './ops/support';
import type { OpsWorld } from './ops/support';
import {
  itemsOf,
  ledgerKinds,
  pastWindow,
  payoutRows,
  recording,
  spyPort,
  unitIdOf,
} from './payout-support';

let w: OpsWorld;
afterEach(async () => {
  expect(w.paypal.violations).toEqual([]);
  await w.close();
});
const pass = (port: ReturnType<typeof spyPort> | null, deps = w.deps) =>
  runPayoutPass(deps, port, { max_items: 100 });
async function refund(deps: typeof w.deps, unit_id: string, minor: number | null) {
  const r = await requestRefund(deps, {
    unit_id,
    amount: minor === null ? null : { currency: 'USD', minor },
    reason: 'goodwill',
    actor: OPERATOR,
  });
  if (!r.ok) throw new Error(`refused: ${r.error.code}`);
  await executeRefund(deps, { refund_request_id: r.value.refund_request_id });
}

describe('sending is committed before the port is called', () => {
  it('the stored state is sending while the port works, and sent afterwards', async () => {
    w = await makeWorld();
    await paid(w);
    pastWindow(w);
    const port = spyPort(w);
    await pass(port);
    expect(port.stateAtCall).toEqual(['sending']);
    expect(port.inTx).toEqual([false]);
    expect((await payoutRows(w))[0]!.state).toBe('sent');
    const row = (await w.rows<{ sending_at: Date | null }>('SELECT sending_at FROM payouts'))[0]!;
    expect(row.sending_at).not.toBeNull();
  });
});

describe('a send that does not return', () => {
  it('crash after the provider got it, then a refund, then a restart: one payout, one executed send, the same key', async () => {
    w = await makeWorld();
    const a = await paid(w);
    const unit = await unitIdOf(w, a.order_id);
    pastWindow(w);
    const port = spyPort(w, 'throw_after_execute');
    const counts = await pass(port);
    expect(counts).toMatchObject({ created: 1, sent: 0, errored: 1 });
    // the process is gone; the payout is where the commit left it
    let rows = await payoutRows(w);
    expect(rows.map((p) => p.state)).toEqual(['sending']);
    const key = rows[0]!.idempotency_key;
    // a refund arrives while the money is in flight: it cannot cancel, so it is an adjustment
    await refund(w.deps, unit, 100);
    rows = await payoutRows(w);
    expect(rows.map((p) => p.state)).toEqual(['sending']);
    expect((await ledgerKinds(w, unit)).filter((k) => k.kind === 'payout_adjustment')).toEqual([
      { kind: 'payout_adjustment', amount_minor: 100, refund_id: expect.any(String) },
    ]);
    // restart: a new process on the same database
    const again = await pass(port, w.restart());
    expect(again).toMatchObject({ created: 0, sent: 1, errored: 0 });
    rows = await payoutRows(w);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ state: 'sent', amount_minor: 400, idempotency_key: key });
    expect(port.calls.map((c) => c.idempotency_key)).toEqual([key, key]);
    expect(port.executed).toHaveLength(1);
    expect(port.calls[1]!.amount.minor).toBe(400); // the amount that was committed, not a recomputed one
  });

  it('a throw before the provider got it is the same: still sending, resent with the same key', async () => {
    w = await makeWorld();
    await paid(w);
    pastWindow(w);
    const port = spyPort(w, 'throw_before_execute');
    expect(await pass(port)).toMatchObject({ created: 1, errored: 1 });
    expect((await payoutRows(w)).map((p) => p.state)).toEqual(['sending']);
    expect(port.executed).toHaveLength(0);
    expect(await pass(port)).toMatchObject({ created: 0, sent: 1 });
    expect(port.executed).toHaveLength(1);
    expect(new Set(port.calls.map((c) => c.idempotency_key)).size).toBe(1);
  });

  it('a blocked answer (switch off, lease lost) changes nothing and is tried again', async () => {
    w = await makeWorld();
    await paid(w);
    pastWindow(w);
    const port = spyPort(w, 'blocked');
    expect(await pass(port)).toMatchObject({ created: 1, sent: 0, blocked: 1 });
    expect((await payoutRows(w)).map((p) => [p.state, p.failure_reason])).toEqual([
      ['sending', null],
    ]);
    expect(await w.rows("SELECT 1 FROM alerts WHERE kind = 'payout_failed'")).toEqual([]);
    port.mode = 'accept';
    expect(await pass(port)).toMatchObject({ created: 0, sent: 1 });
    expect((await payoutRows(w)).map((p) => p.state)).toEqual(['sent']);
  });

  it('a payout in sending is never replaced by a second payout for the same unit', async () => {
    w = await makeWorld();
    await paid(w);
    pastWindow(w);
    const port = spyPort(w, 'throw_after_execute');
    await pass(port);
    for (let i = 0; i < 3; i += 1) await pass(port, w.restart());
    expect(await payoutRows(w)).toHaveLength(1);
    expect(port.executed).toHaveLength(1);
  });

  it('while sending, only a sent or confirmed or failed answer moves it on; the database refuses a cancel', async () => {
    w = await makeWorld();
    await paid(w);
    pastWindow(w);
    await pass(spyPort(w, 'throw_after_execute'));
    await expect(w.rows("UPDATE payouts SET state = 'cancelled'")).rejects.toThrow();
    await expect(w.rows("UPDATE payouts SET state = 'due'")).rejects.toThrow();
    expect((await payoutRows(w)).map((p) => p.state)).toEqual(['sending']);
  });
});

describe('a payout the provider refused', () => {
  it('goes failed with the reason, tells an operator, and holds its units for 24 hours', async () => {
    w = await makeWorld();
    const a = await paid(w);
    const unit = await unitIdOf(w, a.order_id);
    pastWindow(w);
    const port = spyPort(w, 'reject');
    expect(await pass(port)).toMatchObject({ created: 1, failed: 1, sent: 0 });
    const first = (await payoutRows(w))[0]!;
    expect(first).toMatchObject({ state: 'failed', failure_reason: 'payee_unreachable' });
    const alerts = await w.rows<{ unit_id: string; detail: { reason: string } }>(
      "SELECT unit_id, detail FROM alerts WHERE kind = 'payout_failed'",
    );
    expect(alerts).toEqual([
      {
        unit_id: unit,
        detail: {
          reason: `payout_failed_${first.id}`,
          payout_id: first.id,
          failure_reason: 'payee_unreachable',
        },
      },
    ]);
    port.mode = 'accept';
    w.tick(PAYOUT_RETRY_AFTER_MS - 1000);
    expect(await pass(port)).toMatchObject({ created: 0, sent: 0, expired: 0 });
    expect((await payoutRows(w)).map((p) => p.state)).toEqual(['failed']);
    expect(port.calls).toHaveLength(1);
  });

  it('after 24 hours it is cancelled with an audit row and the same pass pays the units again', async () => {
    w = await makeWorld();
    await paid(w);
    pastWindow(w);
    const port = spyPort(w, 'reject');
    await pass(port);
    const first = (await payoutRows(w))[0]!;
    port.mode = 'accept';
    w.tick(PAYOUT_RETRY_AFTER_MS);
    const rec = recording(w);
    expect(await pass(port, rec.deps)).toMatchObject({ expired: 1, created: 1, sent: 1 });
    const rows = await payoutRows(w);
    expect(rows.map((p) => [p.state, p.amount_minor])).toEqual([
      ['cancelled', 400],
      ['sent', 400],
    ]);
    expect(rows[0]!.id).toBe(first.id);
    expect(rows[0]!.failure_reason).toBe('payee_unreachable'); // the reason is kept
    expect(rows[1]!.id).not.toBe(first.id);
    expect(await itemsOf(w, first.id)).toEqual([expect.objectContaining({ live: false })]);
    const cancelled = rec.audits.find((x) => x.action === 'payout.cancelled')!;
    expect(cancelled.target).toBe(first.id);
    expect(cancelled.reason).toBe('retry_after_failure');
    expect(rec.audits.map((x) => x.action)).toEqual([
      'payout.cancelled',
      'payout.created',
      'payout.sent',
    ]);
  });

  it('a refund while the payout is failed cancels it, books no adjustment, and the smaller amount is paid after the hold', async () => {
    w = await makeWorld();
    const a = await paid(w);
    const unit = await unitIdOf(w, a.order_id);
    pastWindow(w);
    const port = spyPort(w, 'reject');
    await pass(port);
    port.mode = 'accept';
    w.tick(1000);
    await refund(w.deps, unit, 100);
    expect((await payoutRows(w)).map((p) => p.state)).toEqual(['cancelled']);
    expect(
      (await ledgerKinds(w, unit)).find((k) => k.kind === 'payout_adjustment'),
    ).toBeUndefined();
    // the cancel freed the unit at once: no need to wait for the hold
    expect(await pass(port)).toMatchObject({ created: 1, sent: 1 });
    expect((await payoutRows(w)).at(-1)).toMatchObject({ amount_minor: 300, state: 'sent' });
  });
});

describe('the payee', () => {
  it('a publisher whose payee is the shared owner account is not paid out, at creation', async () => {
    w = await makeWorld();
    await paid(w);
    pastWindow(w);
    await w.rows("UPDATE publishers SET payee_shared = true WHERE id = 'pub_1'");
    const port = spyPort(w);
    expect(await pass(port)).toMatchObject({ created: 0, sent: 0 });
    expect(await payoutRows(w)).toEqual([]);
    await w.rows("UPDATE publishers SET payee_shared = false WHERE id = 'pub_1'");
    expect(await pass(port)).toMatchObject({ created: 1, sent: 1 });
  });

  it('a publisher who is not active is not paid out, at creation', async () => {
    w = await makeWorld();
    await paid(w);
    pastWindow(w);
    await w.rows("UPDATE publishers SET status = 'suspended' WHERE id = 'pub_1'");
    expect(await pass(spyPort(w))).toMatchObject({ created: 0 });
    await w.rows("UPDATE publishers SET status = 'applied' WHERE id = 'pub_1'");
    expect(await pass(spyPort(w))).toMatchObject({ created: 0 });
  });

  it('a payout created while the publisher was fine is refused at send when they are not: the port is not called', async () => {
    w = await makeWorld();
    await paid(w);
    pastWindow(w);
    await pass(null);
    const port = spyPort(w);
    for (const sql of [
      "UPDATE publishers SET payee_shared = true WHERE id = 'pub_1'",
      "UPDATE publishers SET payee_shared = false, status = 'suspended' WHERE id = 'pub_1'",
      "UPDATE publishers SET status = 'active', paypal_merchant_id = 'MERCHNEW' WHERE id = 'pub_1'",
      "UPDATE publishers SET paypal_merchant_id = NULL WHERE id = 'pub_1'",
    ]) {
      await w.rows(sql);
      expect(await pass(port)).toMatchObject({ sent: 0, refused: 1 });
      expect(port.calls).toHaveLength(0);
      expect((await payoutRows(w)).map((p) => p.state)).toEqual(['due']);
    }
    await w.rows("UPDATE publishers SET paypal_merchant_id = 'MERCH1' WHERE id = 'pub_1'");
    expect(await pass(port)).toMatchObject({ sent: 1, refused: 0 });
    expect(port.calls[0]!.payee_merchant_id).toBe('MERCH1');
  });

  it('a payout already in sending is checked again before it is resent', async () => {
    w = await makeWorld();
    await paid(w);
    pastWindow(w);
    const port = spyPort(w, 'throw_after_execute');
    await pass(port);
    await w.rows("UPDATE publishers SET payee_shared = true WHERE id = 'pub_1'");
    expect(await pass(port, w.restart())).toMatchObject({ sent: 0, refused: 1 });
    expect(port.calls).toHaveLength(1);
    expect((await payoutRows(w)).map((p) => p.state)).toEqual(['sending']);
  });
});
