// MVP-C offline acceptance C-06 and C-07 (mvp-plan MVP-C table; nfr.md P9). The operator signs in
// through the session route with a TOTP code, refunds through POST /api/refunds, and the buyer's
// library, link and receipt routes show what was stored. PayPal is a fake Wire playing the dry-run
// order model behind the approved sandbox transport (scope mvp_c_refunds); no byte leaves the process.
// The real halves (a refund executed at PayPal and read back) are owner-window rows.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { signIn } from '../../apps/web/src/support';
import type { Session } from '../../apps/web/src/support';
import { bootRig, buy, libraryOf, openLink, postRefund, receiptOf, orderStatus } from './c-support';
import type { CRig } from './c-support';

vi.mock('server-only', () => ({}));

describe('C-06 and C-07 refunds (operator route, offline)', () => {
  let rig: CRig;
  let op: Session;
  let buyerB: Session;
  beforeAll(async () => {
    rig = await bootRig();
    op = await rig.operator('vikram');
    buyerB = (await signIn(rig.routes.session.POST, 'buyer-b'))!;
  }, 60_000);
  afterAll(async () => {
    await rig?.close();
  });

  const refundCalls = (): number => rig.ops().filter((o) => o === 'refund_capture').length;
  const unit = async (unit_id: string) =>
    (
      await rig.app.db.query<{ status: string; refunded_minor: string | number }>(
        'SELECT status, refunded_minor FROM order_units WHERE id = $1',
        [unit_id],
      )
    ).rows[0]!;
  const refundRequests = (unit_id: string) =>
    rig.app.db.query<{ id: string; state: string; refund_id: string | null; amount_minor: string }>(
      'SELECT id, state, refund_id, amount_minor FROM refund_requests WHERE unit_id = $1 ORDER BY created_at, id',
      [unit_id],
    );
  const ledgerRefunds = (unit_id: string) =>
    rig.app.db.query<{ refund_id: string; amount_minor: string }>(
      `SELECT refund_id, amount_minor FROM ledger_entries WHERE unit_id = $1 AND kind = 'refund' ORDER BY created_at, id`,
      [unit_id],
    );

  describe('C-06 refund_full_and_partial', () => {
    it('C-06 a partial refund then the remainder: two refund rows, two ledger entries keyed by refund id, read back as REFUNDED', async () => {
      const u = await buy(rig, { offer: 'knot-notebook', option: 'online_read' }); // 4.50
      expect(u.amount_minor).toBe(450);

      const part = await postRefund(rig, op, {
        unit_id: u.unit_id,
        amount_minor: 150,
        reason: 'C-06 part of the article was missing',
      });
      expect(part.status).toBe(200);
      expect(await part.json()).toMatchObject({
        state: 'completed',
        amount_minor: 150,
        refunded_minor: 150,
        remaining_minor: 300,
        unit_status: 'partially_refunded',
      });
      expect((await unit(u.unit_id)).status).toBe('partially_refunded');

      const rest = await postRefund(rig, op, {
        unit_id: u.unit_id,
        amount_minor: null,
        reason: 'C-06 refund the rest',
      });
      expect(rest.status).toBe(200);
      expect(await rest.json()).toMatchObject({
        state: 'completed',
        amount_minor: 300,
        refunded_minor: 450,
        remaining_minor: 0,
        unit_status: 'refunded',
      });

      // two refund rows, each with its own PayPal refund id
      const reqs = (await refundRequests(u.unit_id)).rows;
      expect(reqs.map((r) => [r.state, Number(r.amount_minor)])).toEqual([
        ['completed', 150],
        ['completed', 300],
      ]);
      const ids = reqs.map((r) => r.refund_id);
      expect(ids.every((id) => typeof id === 'string' && id.length > 0)).toBe(true);
      expect(new Set(ids).size).toBe(2);
      // two ledger entries, keyed by those refund ids
      const ledger = (await ledgerRefunds(u.unit_id)).rows;
      expect(ledger.map((l) => [l.refund_id, Number(l.amount_minor)])).toEqual([
        [ids[0], 150],
        [ids[1], 300],
      ]);
      // the read-back: each refund was read (get_refund) and the order was read after the last one
      expect(rig.ops().filter((o) => o === 'get_refund').length).toBeGreaterThanOrEqual(2);
      const lastRead = await rig.app.db.query<{ response_redacted: unknown }>(
        `SELECT response_redacted FROM provider_calls WHERE operation = 'get_order' ORDER BY created_at DESC, id DESC LIMIT 1`,
      );
      expect(JSON.stringify(lastRead.rows[0]?.response_redacted)).toContain('REFUNDED');
      expect(Number((await unit(u.unit_id)).refunded_minor)).toBe(450);
      // the model (PayPal) agrees with the ledger
      expect(refundCalls()).toBeGreaterThanOrEqual(2);
    });

    it('C-06 a double click gives one refund: the same key twice at once, then a second click with another key', async () => {
      const u = await buy(rig, { offer: 'ferry-timetables', option: 'online_read' }); // 1.25
      const body = { unit_id: u.unit_id, amount_minor: 125, reason: 'C-06 double click' };
      const callsBefore = refundCalls();
      const [a, b] = await Promise.all([
        postRefund(rig, op, body, 'cog-double-click-1'),
        postRefund(rig, op, body, 'cog-double-click-1'),
      ]);
      // one click is served; the other gets the stored answer or is told the first is still running
      const statuses = [a.status, b.status].sort();
      expect(statuses[0]).toBe(200);
      expect([200, 409]).toContain(statuses[1]);
      for (const r of [a, b])
        if (r.status === 409)
          expect(((await r.json()) as { error: { code: string } }).error.code).toBe('in_progress');
      expect((await refundRequests(u.unit_id)).rows).toHaveLength(1);
      expect(refundCalls() - callsBefore).toBe(1);
      expect((await ledgerRefunds(u.unit_id)).rows).toHaveLength(1);
      // a second click a moment later with a new key finds nothing left to refund
      const third = await postRefund(rig, op, body, 'cog-double-click-2');
      expect(third.status).toBe(409);
      expect((await refundRequests(u.unit_id)).rows).toHaveLength(1);
      expect(refundCalls() - callsBefore).toBe(1);
      expect(Number((await unit(u.unit_id)).refunded_minor)).toBe(125);
    });

    it('C-06 two clicks at once with different keys never refund more than was paid', async () => {
      const u = await buy(rig, { offer: 'harbour-fees', option: 'online_read' }); // 2.50
      const body = { unit_id: u.unit_id, amount_minor: null, reason: 'C-06 racing clicks' };
      const callsBefore = refundCalls();
      const res = await Promise.all([
        postRefund(rig, op, body, 'cog-race-key-1'),
        postRefund(rig, op, body, 'cog-race-key-2'),
      ]);
      expect(res.filter((r) => r.status === 200)).toHaveLength(1);
      expect(res.filter((r) => r.status === 409)).toHaveLength(1);
      expect(refundCalls() - callsBefore).toBe(1);
      const total = (await ledgerRefunds(u.unit_id)).rows.reduce(
        (n, l) => n + Number(l.amount_minor),
        0,
      );
      expect(total).toBe(250);
      expect((await unit(u.unit_id)).status).toBe('refunded');
    });

    it('C-06 an over-refund is refused locally: 409, no request row, no PayPal call', async () => {
      const u = await buy(rig, { offer: 'tide-tables', option: 'keep_retrieve' }); // price from the offer
      const callsBefore = refundCalls();
      const res = await postRefund(rig, op, {
        unit_id: u.unit_id,
        amount_minor: u.amount_minor + 1,
        reason: 'C-06 one cent too many',
      });
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('over_refund');
      expect((await refundRequests(u.unit_id)).rows).toHaveLength(0);
      expect(refundCalls()).toBe(callsBefore);
      expect((await ledgerRefunds(u.unit_id)).rows).toHaveLength(0);
      expect((await unit(u.unit_id)).status).toBe('captured_verified');
      // and after the exact amount, any further amount is refused too
      expect(
        (
          await postRefund(rig, op, {
            unit_id: u.unit_id,
            amount_minor: u.amount_minor,
            reason: 'C-06 the exact amount',
          })
        ).status,
      ).toBe(200);
      const more = await postRefund(rig, op, {
        unit_id: u.unit_id,
        amount_minor: 1,
        reason: 'C-06 one more cent',
      });
      expect(more.status).toBe(409);
      expect(refundCalls() - callsBefore).toBe(1);
    });
  });

  describe('C-07 refund_revokes', () => {
    it('C-07 a verified full refund revokes the online item; the receipt becomes version 2 and shows the refund', async () => {
      const u = await buy(rig, { offer: 'knot-notebook', option: 'online_read', who: 'B' }); // 4.50
      const before = (await libraryOf(rig, buyerB)).find(
        (i) => i.entitlement_id === u.entitlement_id,
      )!;
      expect(before.can_open).toBe(true);
      expect((await openLink(rig, buyerB, u.entitlement_id)).status).toBe(200);
      expect((await receiptOf(rig, buyerB, u.order_id)).body.version).toBe(1);

      const res = await postRefund(rig, op, {
        unit_id: u.unit_id,
        amount_minor: 450,
        reason: 'C-07 full refund of an online item',
      });
      expect(res.status).toBe(200);
      expect((await unit(u.unit_id)).status).toBe('refunded');

      const after = (await libraryOf(rig, buyerB)).find(
        (i) => i.entitlement_id === u.entitlement_id,
      )!;
      expect(after.can_open).toBe(false);
      expect(after.access).toBe('revoked');
      expect(after.refunded).toBe(true);
      expect(after.status_text).toBe('Refunded: access has ended');
      expect((await openLink(rig, buyerB, u.entitlement_id)).status).toBeGreaterThanOrEqual(400);
      const receipt = await receiptOf(rig, buyerB, u.order_id);
      expect(receipt.status).toBe(200);
      expect(receipt.body.version).toBe(2);
      expect(receipt.body.refunds.map((r) => r.amount.minor)).toEqual([450]);
      const ledgerSum = (await ledgerRefunds(u.unit_id)).rows.map((l) => Number(l.amount_minor));
      expect(ledgerSum).toEqual([450]);
      expect(await orderStatus(rig, u.order_id)).toBe('paid');
    });

    it('C-07 a verified full refund of a keep item stops the links and says the downloaded copy cannot be recalled', async () => {
      const u = await buy(rig, { offer: 'harbour-fees', option: 'keep_retrieve', who: 'B' }); // 3.00
      expect((await openLink(rig, buyerB, u.entitlement_id)).status).toBe(200);
      const res = await postRefund(rig, op, {
        unit_id: u.unit_id,
        amount_minor: 300,
        reason: 'C-07 full refund of a keep item',
      });
      expect(res.status).toBe(200);
      const item = (await libraryOf(rig, buyerB)).find(
        (i) => i.entitlement_id === u.entitlement_id,
      )!;
      expect(item.can_open).toBe(false);
      expect(item.status_text).toBe(
        'Refunded: links have stopped. The copy you downloaded cannot be recalled.',
      );
      expect((await openLink(rig, buyerB, u.entitlement_id)).status).toBeGreaterThanOrEqual(400);
      // a link issued before the refund no longer opens the content either
      const receipt = await receiptOf(rig, buyerB, u.order_id);
      expect(receipt.body.version).toBe(2);
      expect(receipt.body.refunds.map((r) => r.amount.minor)).toEqual([300]);
    });

    it('C-07 a partial refund keeps access and still moves the receipt to a new version', async () => {
      const u = await buy(rig, { offer: 'ferry-timetables', option: 'online_read', who: 'B' }); // 1.25
      expect(
        (
          await postRefund(rig, op, {
            unit_id: u.unit_id,
            amount_minor: 100,
            reason: 'C-07 goodwill part refund',
          })
        ).status,
      ).toBe(200);
      const item = (await libraryOf(rig, buyerB)).find(
        (i) => i.entitlement_id === u.entitlement_id,
      )!;
      expect(item.can_open).toBe(true);
      expect(item.access).toBe('available');
      expect((await receiptOf(rig, buyerB, u.order_id)).body.version).toBe(2);
    });
  });
});
