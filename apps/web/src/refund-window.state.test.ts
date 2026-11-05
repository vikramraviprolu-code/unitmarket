// BR-4 state tests: the operator refund route and the buyer's refund-window reader over the real payments
// engine and the dry-run order model. A sale whose access and capture are in the past (the stored facts
// are moved back, since the app has one real clock) is past its frozen window: the route refuses with 409
// refund_window_closed and stores nothing; with an override_reason the refund goes through and one
// refund_outside_window audit row is written. The operator's money page and the buyer's pages read the
// deadline from one place (engine.refundWindow, loadRefundOverview).
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { bootRefundWorld, buy, count, errorOf, postRefund, refundRows } from './refund-support';
import type { BoughtUnit, RefundWorld } from './refund-support';

vi.mock('server-only', () => ({}));

const DAY = 86_400_000;
let w: RefundWorld;
const u: Record<string, BoughtUnit> = {};

beforeAll(async () => {
  w = await bootRefundWorld();
  u['fresh'] = await buy(w, { offer: 'knot-notebook', option: 'online_read' });
  u['old'] = await buy(w, { offer: 'tide-tables', option: 'online_read' });
  u['override'] = await buy(w, { offer: 'ferry-timetables', option: 'online_read' });
  u['v1'] = await buy(w, { offer: 'harbour-fees', option: 'online_read' });
  u['other'] = await buy(w, { offer: 'knot-notebook', option: 'online_read', who: 'B' });
  for (const k of ['old', 'override', 'v1']) await age(u[k]!, 30);
  // a sale approved before the terms were recorded
  await w.app.db.exec('ALTER TABLE approvals DISABLE TRIGGER approvals_guard');
  await w.app.db.query(
    `UPDATE approvals SET snapshot = (snapshot - 'terms') || '{"snapshot_version":"1"}'::jsonb
      WHERE id = (SELECT approval_id FROM orders WHERE id = $1)`,
    [u['v1']!.order_id],
  );
  await w.app.db.exec('ALTER TABLE approvals ENABLE TRIGGER approvals_guard');
});
afterAll(async () => {
  await w.app.close();
});

async function age(unit: BoughtUnit, days: number): Promise<void> {
  const then = new Date(w.app.security.clock.now().getTime() - days * DAY).toISOString();
  await w.app.db.query('UPDATE order_units SET captured_verified_at = $2 WHERE id = $1', [
    unit.unit_id,
    then,
  ]);
  await w.app.db.query('UPDATE access_windows SET started_at = $2 WHERE entitlement_id = $1', [
    unit.entitlement_id,
    then,
  ]);
}
const body = (unit: BoughtUnit, extra: Record<string, unknown> = {}) => ({
  unit_id: unit.unit_id,
  amount_minor: null,
  reason: 'Customer asked for a refund',
  ...extra,
});

describe('POST /api/refunds against the frozen window', () => {
  it('a sale inside its window refunds as before, with no override', async () => {
    const res = await postRefund(w, w.op, body(u['fresh']!));
    expect(res.status).toBe(200);
    expect(
      await count(
        w.app,
        "SELECT count(*) AS c FROM audit_log WHERE action = 'refund_outside_window'",
      ),
    ).toBe(0);
  });

  it('a sale past its window is refused with 409 refund_window_closed and stores nothing', async () => {
    const res = await postRefund(w, w.op, body(u['old']!));
    expect(res.status).toBe(409);
    const e = await errorOf(res);
    expect(e.code).toBe('refund_window_closed');
    expect(e.message).toMatch(/Nothing was refunded/);
    expect(await refundRows(w.app, u['old']!.unit_id)).toBe(0);
  });

  it('an override_reason lets it through and writes one refund_outside_window audit row', async () => {
    const res = await postRefund(
      w,
      w.op,
      body(u['override']!, { override_reason: 'Late goodwill, outage ticket 4411' }),
    );
    expect(res.status).toBe(200);
    expect(await refundRows(w.app, u['override']!.unit_id)).toBe(1);
    expect(
      await count(
        w.app,
        "SELECT count(*) AS c FROM audit_log WHERE action = 'refund_outside_window'",
      ),
    ).toBe(1);
  });

  it('an override_reason that is too short, too long, or not text is refused as invalid input', async () => {
    for (const bad of ['ab', 'x'.repeat(201), 12, null, ['abc']]) {
      const res = await postRefund(w, w.op, body(u['old']!, { override_reason: bad }));
      expect(res.status, JSON.stringify(bad)).toBe(422);
    }
    expect(await refundRows(w.app, u['old']!.unit_id)).toBe(0);
  });

  it('an unknown extra field is still refused', async () => {
    const res = await postRefund(w, w.op, body(u['old']!, { at: '2026-11-01T00:00:00.000Z' }));
    expect(res.status).toBe(422);
  });

  it('a sale approved before the terms were recorded has no deadline', async () => {
    const res = await postRefund(w, w.op, body(u['v1']!));
    expect(res.status).toBe(200);
  });
});

describe('the deadline the pages read', () => {
  it('the operator overview marks a fresh unit open and an old one ended, each with its deadline', async () => {
    const o = (await w.app.engine.opsSnapshot({
      kind: 'operator',
      operator_id: 'opr_vikram',
      mfa: true,
    }))!.refunds!;
    const by = (id: string) => o.units.find((x) => x.unit_id === id);
    const old = by(u['old']!.unit_id)!;
    expect(old.refund_window.state).toBe('ended');
    expect(old.refund_window).toHaveProperty('deadline');
    const other = by(u['other']!.unit_id)!;
    expect(other.refund_window.state).toBe('open');
  });

  it('the buyer reads open for a fresh item, ended for an old one, none for version 1', async () => {
    const open = await w.app.engine.refundWindow({
      actor: w.actorB,
      entitlement_id: u['other']!.entitlement_id,
    });
    expect(open?.state).toBe('open');
    const ended = await w.app.engine.refundWindow({
      actor: w.actorA,
      entitlement_id: u['old']!.entitlement_id,
    });
    expect(ended?.state).toBe('ended');
    const none = await w.app.engine.refundWindow({
      actor: w.actorA,
      entitlement_id: u['v1']!.entitlement_id,
    });
    expect(none).toEqual({ state: 'none' });
  });

  it('reads the same by order id', async () => {
    const r = await w.app.engine.refundWindow({ actor: w.actorA, order_id: u['old']!.order_id });
    expect(r?.state).toBe('ended');
  });

  it("answers null for another buyer's item and for an operator", async () => {
    expect(
      await w.app.engine.refundWindow({
        actor: w.actorB,
        entitlement_id: u['old']!.entitlement_id,
      }),
    ).toBeNull();
    expect(
      await w.app.engine.refundWindow({
        actor: { kind: 'operator', operator_id: 'opr_vikram', mfa: true },
        entitlement_id: u['old']!.entitlement_id,
      }),
    ).toBeNull();
  });
});
