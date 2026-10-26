// DP-2a (MVP-D, route D2): one PayPal order per publisher. Real PGlite, scripted PayPal. A pack is the
// approval of ofr_1 (publisher 1) and ofr_3 (publisher 2): two units, two PayPal orders. The rules
// under test are in docs/specs/mvp-d-dp2a-provider-orders.md and mvp-d-overview.md section 3.
import { afterEach, describe, expect, it } from 'vitest';
import { contentHash, makeToken } from '@umsbx/approval';
import { beginCheckout, checkInvariants, loadOrderView, onBuyerReturn, placeOrder } from './index';
import { captureOnce } from './capture';
import { loadOrder } from './store';
import {
  BUYER_A,
  approvePo,
  approved,
  awaiting,
  count,
  makeWorld,
  place,
  providerOrdersOf,
  reapply,
} from './support';
import type { Awaiting, World } from './support';

let w: World;
afterEach(async () => {
  expect(w.paypal.violations).toEqual([]);
  await w.close();
});

const PACK = { offers: ['ofr_1', 'ofr_3'] };
/** A snapshot as plain JSON, for the tests that forge one. */
type Snap = {
  settlement?: unknown;
  total_minor: number;
  publishers: { publisher_id: string; payee_merchant_id: string; amount_minor: number }[];
  items: Record<string, unknown>[];
};
const ret = (ref: string) => onBuyerReturn(w.deps, { order_ref: ref, actor: BUYER_A });
const orderRow = async (id: string) =>
  (
    await w.rows<{ status: string; mismatch: boolean }>(
      'SELECT status, mismatch FROM orders WHERE id = $1',
      [id],
    )
  )[0]!;
const states = async (order_id: string): Promise<string[]> =>
  (await providerOrdersOf(w, order_id)).map((p) => p.state);
const unitRows = (order_id: string) =>
  w.rows<{
    publisher_id: string;
    status: string;
    status_reason: string | null;
    capture_id: string | null;
    mismatch_reason: string | null;
  }>(
    'SELECT publisher_id, status, status_reason, capture_id, mismatch_reason FROM order_units WHERE order_id = $1 ORDER BY publisher_id',
    [order_id],
  );
const entRows = (order_id: string) =>
  w.rows<{ article_id: string; money_state: string; access_state: string }>(
    `SELECT e.article_id, e.money_state, e.access_state FROM entitlements e
       JOIN order_units u ON u.id = e.unit_id WHERE u.order_id = $1 ORDER BY e.article_id`,
    [order_id],
  );
const alerts = (kind: string) =>
  w.rows<{ reason: string }>(
    "SELECT detail ->> 'reason' AS reason FROM alerts WHERE kind = $1 ORDER BY created_at, id",
    [kind],
  );
const ops = (order_id: string, kind: string) =>
  w.rows<{
    request_id: string;
    state: string;
    first_sent_at: unknown;
    provider_order_ref: string | null;
  }>(
    `SELECT o.request_id, o.state, o.first_sent_at, o.provider_order_ref FROM operations o
       LEFT JOIN provider_orders p ON p.id = o.provider_order_ref
      WHERE o.order_id = $1 AND o.kind = $2 ORDER BY p.position, o.created_at, o.id`,
    [order_id, kind],
  );
const captureCalls = () => w.paypal.calls.filter((c) => c.op === 'capture');
const poIds = (a: Awaiting): string[] =>
  a.provider_orders.map((p) => p.provider_order_id as string);

describe('place: a pack of two publishers', () => {
  it('place: 2 provider orders, 2 units, 2 create ops', async () => {
    w = await makeWorld();
    const p = await place(w, PACK);
    const pos = await providerOrdersOf(w, p.order_id);
    expect(pos.map((x) => [x.position, x.po_ref, x.publisher_id, x.state])).toEqual([
      [1, `${p.order_ref}-p1`, 'pub_1', 'prepared'],
      [2, `${p.order_ref}-p2`, 'pub_2', 'prepared'],
    ]);
    expect(pos.every((x) => x.provider_order_id === null && x.approve_url === null)).toBe(true);
    const routes = await w.rows<{ route: string }>(
      'SELECT route FROM provider_orders WHERE order_id = $1',
      [p.order_id],
    );
    expect(routes.map((r) => r.route)).toEqual(['per_publisher', 'per_publisher']);

    // each unit sits on the provider order of its own publisher
    const units = await w.rows<{ publisher_id: string; po_publisher: string }>(
      `SELECT u.publisher_id, p.publisher_id AS po_publisher FROM order_units u
         JOIN provider_orders p ON p.id = u.provider_order_ref WHERE u.order_id = $1 ORDER BY u.publisher_id`,
      [p.order_id],
    );
    expect(units).toEqual([
      { publisher_id: 'pub_1', po_publisher: 'pub_1' },
      { publisher_id: 'pub_2', po_publisher: 'pub_2' },
    ]);

    // one create operation per provider order, keyed by its po_ref
    const creates = await ops(p.order_id, 'create');
    expect(creates.map((o) => [o.request_id, o.state])).toEqual([
      [`umsC-${p.order_ref}-p1`, 'prepared'],
      [`umsC-${p.order_ref}-p2`, 'prepared'],
    ]);
    expect(creates.every((o) => o.provider_order_ref !== null)).toBe(true);
    expect(new Set(creates.map((o) => o.provider_order_ref)).size).toBe(2);
    expect((await orderRow(p.order_id)).status).toBe('created');
    expect(await count(w, 'entitlements')).toBe(2);
  });

  it('single unchanged: one provider order, po_ref = order_ref, keys and rows as before', async () => {
    w = await makeWorld();
    const p = await place(w);
    const [po] = await w.rows<Record<string, unknown>>(
      'SELECT * FROM provider_orders WHERE order_id = $1',
      [p.order_id],
    );
    expect(po).toMatchObject({
      route: 'single',
      position: 1,
      po_ref: p.order_ref,
      publisher_id: null,
      state: 'prepared',
      first_approved_at: null,
    });
    const creates = await ops(p.order_id, 'create');
    expect(creates.map((o) => o.request_id)).toEqual([`umsC-${p.order_ref}`]);
    expect(creates[0]!.provider_order_ref).toBe(po!['id']);
  });

  it('single, end to end: the same PayPal calls and keys as before, no invoice_id, state captured', async () => {
    w = await makeWorld();
    const a = await approved(w);
    const created = w.paypal.orders.get(a.provider_order_id)!.req;
    expect(created.request_id).toBe(`umsC-${a.order_ref}`);
    expect(created).not.toHaveProperty('invoice_id'); // own id omitted: the adapter uses order_ref
    const r = await ret(a.order_ref);
    expect(r.ok && r.value.status).toBe('paid');
    expect(w.paypal.calls.map((c) => c.op)).toEqual(['create', 'get', 'capture', 'get']);
    expect(captureCalls().map((c) => c.request_id)).toEqual([`umsK-${a.order_ref}`]);
    expect(await states(a.order_id)).toEqual(['captured']);
    expect((await ops(a.order_id, 'capture'))[0]!.provider_order_ref).not.toBeNull();
    expect(r.ok && r.value.progress).toBeNull();
    expect(r.ok && r.value.provider_orders).toEqual([
      { position: 1, publisher_id: null, state: 'captured' },
    ]);
  });

  it('place refuses a snapshot of two publishers without a settlement, or of three: no order, no unit, approval not used', async () => {
    w = await makeWorld();
    const craft = async (
      mutate: (s: Snap) => Snap,
      n: number,
    ): Promise<{ approval_id: string; token: string }> => {
      const g = await w.approval(PACK);
      const snap = mutate(JSON.parse(JSON.stringify(g.snapshot)));
      const hash = contentHash(snap as never);
      const now = w.clock.now();
      const expires_at = new Date(now.getTime() + 15 * 60_000).toISOString();
      const approval_id = `apr_crafted${n}`;
      await w.rows(
        `INSERT INTO approvals (id, buyer_id, snapshot, content_hash, nonce, expires_at, used_at, environment, created_at, updated_at)
         VALUES ($1, 'buy_A', $2::jsonb, $3, $4, $5, NULL, 'dryrun', $6, $6)`,
        [approval_id, JSON.stringify(snap), hash, `nonce-c${n}`, expires_at, now.toISOString()],
      );
      const token = makeToken(w.deps.config.approval_secret.reveal(), {
        approval_id,
        nonce: `nonce-c${n}`,
        content_hash: hash,
        expires_at,
      });
      return { approval_id, token };
    };
    const noSettlement = await craft((s) => {
      delete s.settlement;
      return s;
    }, 1);
    const threePublishers = await craft((s) => {
      delete s.settlement;
      const extra = { ...s.publishers[1]!, publisher_id: 'pub_3', payee_merchant_id: 'MERCH3' };
      s.publishers.push(extra);
      s.items.push({
        ...s.items[1]!,
        article_id: 'art_9',
        publisher_id: 'pub_3',
        payee_merchant_id: 'MERCH3',
      });
      s.total_minor += extra.amount_minor;
      return s;
    }, 2);
    for (const a of [noSettlement, threePublishers]) {
      const r = await placeOrder(w.deps, { ...a, actor: BUYER_A });
      expect(r).toEqual({
        ok: false,
        error: { code: 'approval', error: { code: 'snapshot_tampered', http: 403 } },
      });
    }
    expect(await count(w, 'orders')).toBe(0);
    expect(await count(w, 'order_units')).toBe(0);
    expect(await count(w, 'provider_orders')).toBe(0);
    expect(await count(w, 'approvals', 'used_at IS NOT NULL')).toBe(0);
  });
});

describe('create (eager)', () => {
  it('two single-unit creates, distinct invoice ids, own id omitted', async () => {
    w = await makeWorld();
    const a = await awaiting(w, PACK);
    const creates = w.paypal.calls.filter((c) => c.op === 'create');
    expect(creates.map((c) => c.request_id)).toEqual([
      `umsC-${a.order_ref}-p1`,
      `umsC-${a.order_ref}-p2`,
    ]);
    const reqs = poIds(a).map((id) => w.paypal.orders.get(id)!.req);
    expect(reqs.map((r) => r.units.length)).toEqual([1, 1]); // never two units in one create
    expect(reqs.map((r) => r.invoice_id)).toEqual([`${a.order_ref}-p1`, `${a.order_ref}-p2`]);
    expect(reqs.map((r) => r.order_ref)).toEqual([a.order_ref, a.order_ref]); // custom_id
    expect(reqs.map((r) => r.units[0]!.payee_merchant_id)).toEqual(['MERCH1', 'MERCH2']);
    expect(reqs.map((r) => r.units[0]!.amount.minor)).toEqual([400, 400]);
    expect(await states(a.order_id)).toEqual(['awaiting_buyer', 'awaiting_buyer']);
    expect((await orderRow(a.order_id)).status).toBe('awaiting_buyer');
    expect((await ops(a.order_id, 'create')).map((o) => o.state)).toEqual([
      'confirmed',
      'confirmed',
    ]);
  });

  it('answers the position-1 approve URL with step 1 of 2, only when every provider order was created', async () => {
    w = await makeWorld();
    const p = await place(w, PACK);
    const c = await beginCheckout(w.deps, { order_id: p.order_id, actor: BUYER_A });
    const pos = await providerOrdersOf(w, p.order_id);
    expect(c).toEqual({
      ok: true,
      value: { approve_url: pos[0]!.approve_url, progress: { step: 1, of: 2 } },
    });
    expect(pos[0]!.approve_url).not.toBe(pos[1]!.approve_url);
  });

  it('repeat checkout: no third create', async () => {
    w = await makeWorld();
    const a = await awaiting(w, PACK);
    const again = await beginCheckout(w.deps, { order_id: a.order_id, actor: BUYER_A });
    expect(again).toEqual({
      ok: true,
      value: { approve_url: a.approve_url, progress: { step: 1, of: 2 } },
    });
    expect(w.paypal.count('create')).toBe(2);
  });

  it('create rejected on PO2: both failed, order failed (whole-order outcome)', async () => {
    w = await makeWorld();
    const p = await place(w, PACK);
    w.paypal.queue.create.push('real', {
      kind: 'rejected',
      http: 422,
      name: 'UNPROCESSABLE_ENTITY',
      issue: 'TRANSACTION_REFUSED',
      debug_id: 'D',
    });
    const c = await beginCheckout(w.deps, { order_id: p.order_id, actor: BUYER_A });
    expect(c).toEqual({ ok: false, error: { code: 'create_failed' } });
    expect(await states(p.order_id)).toEqual(['failed', 'failed']);
    expect(await orderRow(p.order_id)).toMatchObject({ status: 'failed', mismatch: false });
    expect((await unitRows(p.order_id)).map((u) => u.status)).toEqual(['declined', 'declined']);
    expect((await entRows(p.order_id)).map((e) => e.money_state)).toEqual(['denied', 'denied']);
    expect(await alerts('create_rejected')).toHaveLength(1);
    expect(w.paypal.count('create')).toBe(2);
    expect(w.paypal.count('capture')).toBe(0);
  });

  it('second create rejected: failed, nothing charged, the buyer is told so, no approve url', async () => {
    w = await makeWorld();
    const p = await place(w, PACK);
    w.paypal.queue.create.push('real', {
      kind: 'rejected',
      http: 400,
      name: 'INVALID_REQUEST',
      issue: null,
      debug_id: 'D',
    });
    await beginCheckout(w.deps, { order_id: p.order_id, actor: BUYER_A });
    const view = await loadOrderView(w.db, p.order_id);
    expect(view.status).toBe('failed');
    expect(view.approve_url).toBeNull();
    expect(view.buyer_message).toBe('Payment was not completed. You were not charged');
    expect((await ops(p.order_id, 'create')).map((o) => o.state)).toEqual(['confirmed', 'failed']);
  });

  it('DUPLICATE_INVOICE_ID at create on PO2: both frozen, order frozen, no approve url', async () => {
    w = await makeWorld();
    const p = await place(w, PACK);
    w.paypal.queue.create.push('real', {
      kind: 'rejected',
      http: 422,
      name: 'UNPROCESSABLE_ENTITY',
      issue: 'DUPLICATE_INVOICE_ID',
      debug_id: 'D',
    });
    const c = await beginCheckout(w.deps, { order_id: p.order_id, actor: BUYER_A });
    expect(c).toEqual({ ok: false, error: { code: 'create_failed' } });
    expect(await states(p.order_id)).toEqual(['frozen', 'frozen']);
    expect(await orderRow(p.order_id)).toMatchObject({ status: 'frozen', mismatch: true });
    expect((await loadOrderView(w.db, p.order_id)).approve_url).toBeNull();
    expect((await alerts('frozen_order')).map((a) => a.reason)).toContain('duplicate_invoice_id');
  });
});

describe('return: a trigger only', () => {
  it('return after PO1: no capture, step 2 of 2, the PO2 approve URL', async () => {
    w = await makeWorld();
    const a = await awaiting(w, PACK);
    approvePo(w, a, 1);
    const r = await ret(a.order_ref);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.status).toBe('awaiting_buyer');
    expect(r.value.progress).toEqual({ step: 2, of: 2 });
    expect(r.value.approve_url).toBe(a.provider_orders[1]!.approve_url);
    expect(w.paypal.count('capture')).toBe(0);
    expect(await states(a.order_id)).toEqual(['approved', 'awaiting_buyer']);
    const [first] = await w.rows<{ first_approved_at: unknown }>(
      'SELECT first_approved_at FROM provider_orders WHERE order_id = $1 AND position = 1',
      [a.order_id],
    );
    expect(first!.first_approved_at).not.toBeNull();
    // every awaiting PayPal order was read by its stored id
    expect(w.paypal.calls.filter((c) => c.op === 'get').map((c) => c.provider_order_id)).toEqual(
      poIds(a),
    );
  });

  it('OrderView: progress, provider_orders by position, publisher_id per item', async () => {
    w = await makeWorld();
    const a = await awaiting(w, PACK);
    const v = await loadOrderView(w.db, a.order_id);
    expect(v.progress).toEqual({ step: 1, of: 2 });
    expect(v.approve_url).toBe(a.provider_orders[0]!.approve_url);
    expect(v.provider_orders).toEqual([
      { position: 1, publisher_id: 'pub_1', state: 'awaiting_buyer' },
      { position: 2, publisher_id: 'pub_2', state: 'awaiting_buyer' },
    ]);
    expect(v.items.map((i) => [i.article_id, i.publisher_id])).toEqual([
      ['art_1', 'pub_1'],
      ['art_3', 'pub_2'],
    ]);
  });

  it('pack with nothing captured, PO1 reopened after payer_action: awaiting_buyer, buyer can approve again', async () => {
    w = await makeWorld();
    const a = await approved(w, PACK);
    w.paypal.queue.capture.push({
      kind: 'payer_action',
      redirect_url: 'https://www.sandbox.paypal.com/checkoutnow?token=AGAIN',
      debug_id: 'D',
    });
    const first = await ret(a.order_ref);
    expect(first.ok && first.value.status).toBe('awaiting_buyer');
    expect(first.ok && first.value.approve_url).toBe(
      'https://www.sandbox.paypal.com/checkoutnow?token=AGAIN',
    );
    expect(await states(a.order_id)).toEqual(['approved', 'approved']);
    expect((await orderRow(a.order_id)).status).toBe('awaiting_buyer');
    expect(captureCalls()).toHaveLength(1); // PO2 was not captured before PO1 was settled
    const second = await ret(a.order_ref);
    expect(second.ok && second.value.status).toBe('paid');
    expect(captureCalls().map((c) => c.request_id)).toEqual([
      `umsK-${a.order_ref}-p1`,
      `umsK-${a.order_ref}-p1-2`,
      `umsK-${a.order_ref}-p2`,
    ]);
  });

  it('single payer_action: awaiting_buyer, unchanged', async () => {
    w = await makeWorld();
    const a = await approved(w);
    w.paypal.queue.capture.push({
      kind: 'payer_action',
      redirect_url: 'https://www.sandbox.paypal.com/checkoutnow?token=AGAIN',
      debug_id: 'D',
    });
    const r = await ret(a.order_ref);
    expect(r.ok && r.value.status).toBe('awaiting_buyer');
    expect(r.ok && r.value.progress).toBeNull();
    expect(await states(a.order_id)).toEqual(['approved']);
    expect((await ops(a.order_id, 'capture'))[0]!.state).toBe('prepared');
    const second = await ret(a.order_ref);
    expect(second.ok && second.value.status).toBe('paid');
    expect(captureCalls().map((c) => c.request_id)).toEqual([
      `umsK-${a.order_ref}`,
      `umsK-${a.order_ref}-2`,
    ]);
  });
});

describe('the pass: one read-and-match of every PayPal order before the first capture', () => {
  it('pass mismatch on PO2: both frozen, nothing captured (whole-order outcome)', async () => {
    w = await makeWorld();
    const a = await approved(w, PACK);
    w.paypal.tamperBy.set(poIds(a)[1]!, { payee: 'SBXEVILPAYEE' });
    expect(await ret(a.order_ref)).toEqual({ ok: false, error: { code: 'frozen' } });
    expect(await states(a.order_id)).toEqual(['frozen', 'frozen']);
    expect(await orderRow(a.order_id)).toMatchObject({ status: 'frozen', mismatch: true });
    expect(w.paypal.count('capture')).toBe(0);
    expect(
      (await unitRows(a.order_id)).map((u) => [u.publisher_id, u.status, u.mismatch_reason]),
    ).toEqual([
      ['pub_1', 'expected', null],
      ['pub_2', 'mismatch', 'payee'],
    ]);
  });

  it('mismatch in the pass: order frozen, zero captures, nothing unlocked', async () => {
    w = await makeWorld();
    const a = await approved(w, PACK);
    w.paypal.tamperBy.set(poIds(a)[0]!, { amount_delta: 1 });
    expect(await ret(a.order_ref)).toEqual({ ok: false, error: { code: 'frozen' } });
    expect((await orderRow(a.order_id)).status).toBe('frozen');
    expect(w.paypal.count('capture')).toBe(0);
    expect((await entRows(a.order_id)).map((e) => e.access_state)).toEqual(['locked', 'locked']);
    expect(await count(w, 'ledger_entries')).toBe(0);
    // a later return never captures a frozen pack
    expect(await ret(a.order_ref)).toEqual({ ok: false, error: { code: 'frozen' } });
    expect(w.paypal.count('capture')).toBe(0);
  });

  it('readiness fails: both failed, order failed, zero captures', async () => {
    w = await makeWorld();
    const a = await approved(w, PACK);
    w.content.heads.delete('key-art_3');
    expect(await ret(a.order_ref)).toEqual({
      ok: false,
      error: { code: 'not_charged_content_unavailable' },
    });
    expect(await states(a.order_id)).toEqual(['failed', 'failed']);
    expect((await orderRow(a.order_id)).status).toBe('failed');
    expect(w.paypal.count('capture')).toBe(0);
    expect((await unitRows(a.order_id)).map((u) => u.status)).toEqual(['declined', 'declined']);
    expect((await entRows(a.order_id)).map((e) => e.money_state)).toEqual(['denied', 'denied']);
    expect(await alerts('content_unavailable')).toHaveLength(1);
  });

  async function lapsedPack(): Promise<Awaiting> {
    const a = await awaiting(w, PACK);
    approvePo(w, a, 2);
    expect((await ret(a.order_ref)).ok).toBe(true); // PO2 approved, PO1 not yet
    approvePo(w, a, 1);
    w.paypal.void(poIds(a)[1]!); // PO2 lapsed at PayPal before the pass
    return a;
  }
  it('PO2 lapsed in the pass: both abandoned (whole-order outcome)', async () => {
    w = await makeWorld();
    const a = await lapsedPack();
    const r = await ret(a.order_ref);
    expect(r.ok && r.value.status).toBe('abandoned');
    expect(await states(a.order_id)).toEqual(['abandoned', 'abandoned']);
    expect((await orderRow(a.order_id)).status).toBe('abandoned');
    expect(w.paypal.count('capture')).toBe(0);
  });
  it('PO2 VOIDED in the pass: abandoned, zero captures, no hold', async () => {
    w = await makeWorld();
    const a = await lapsedPack();
    const r = await ret(a.order_ref);
    expect(r.ok && r.value.buyer_message).toBe('Not charged'); // never "on hold"
    expect((await orderRow(a.order_id)).mismatch).toBe(false);
    expect(await count(w, 'alerts')).toBe(0);
    expect((await unitRows(a.order_id)).map((u) => u.status)).toEqual(['declined', 'declined']);
    expect((await entRows(a.order_id)).map((e) => e.money_state)).toEqual(['denied', 'denied']);
    expect(w.paypal.count('capture')).toBe(0);
  });

  it('readiness is checked for every item before the first capture, with one probe pass', async () => {
    w = await makeWorld();
    const a = await approved(w, PACK);
    w.content.heads.delete('key-art_1');
    const r = await ret(a.order_ref);
    expect(r.ok).toBe(false);
    expect(captureCalls()).toHaveLength(0);
  });
});

describe('pack window', () => {
  it('pack window abandon: both abandoned when it has run out and PO2 is not approved', async () => {
    w = await makeWorld();
    const a = await awaiting(w, PACK);
    approvePo(w, a, 1);
    await ret(a.order_ref);
    w.clock.advance(3_600_000 + 1);
    const r = await ret(a.order_ref);
    expect(r.ok && r.value.status).toBe('abandoned');
    expect(await states(a.order_id)).toEqual(['abandoned', 'abandoned']);
    expect(w.paypal.count('capture')).toBe(0);
    expect((await unitRows(a.order_id)).map((u) => u.status)).toEqual(['declined', 'declined']);
  });

  it('inside the window a missing approval only waits', async () => {
    w = await makeWorld();
    const a = await awaiting(w, PACK);
    approvePo(w, a, 1);
    await ret(a.order_ref);
    w.clock.advance(3_600_000 - 1);
    const r = await ret(a.order_ref);
    expect(r.ok && r.value.status).toBe('awaiting_buyer');
    expect(await states(a.order_id)).toEqual(['approved', 'awaiting_buyer']);
  });

  it('the window is configurable (pack_approval_window_ms)', async () => {
    w = await makeWorld();
    w.deps = { ...w.deps, config: { ...w.deps.config, pack_approval_window_ms: 1_000 } };
    const a = await awaiting(w, PACK);
    approvePo(w, a, 1);
    await ret(a.order_ref);
    w.clock.advance(1_001);
    const r = await ret(a.order_ref);
    expect(r.ok && r.value.status).toBe('abandoned');
  });

  it('window run out but all APPROVED: captured (P17)', async () => {
    w = await makeWorld();
    const a = await awaiting(w, PACK);
    approvePo(w, a, 1);
    await ret(a.order_ref);
    w.clock.advance(3_600_000 + 1);
    approvePo(w, a, 2);
    const r = await ret(a.order_ref);
    expect(r.ok && r.value.status).toBe('paid');
    expect(captureCalls()).toHaveLength(2);
  });
});

describe('capture and read-back per PayPal order', () => {
  it('D-01 two captures, two capture ids, two sales', async () => {
    w = await makeWorld();
    const a = await approved(w, PACK);
    const r = await ret(a.order_ref);
    expect(r.ok && r.value.status).toBe('paid');
    expect(captureCalls().map((c) => [c.provider_order_id, c.request_id])).toEqual([
      [poIds(a)[0], `umsK-${a.order_ref}-p1`],
      [poIds(a)[1], `umsK-${a.order_ref}-p2`],
    ]);
    const units = await unitRows(a.order_id);
    expect(units.map((u) => u.status)).toEqual(['captured_verified', 'captured_verified']);
    expect(new Set(units.map((u) => u.capture_id)).size).toBe(2);
    expect(await count(w, 'ledger_entries', "kind = 'sale'")).toBe(2);
    expect(await count(w, 'ledger_entries', "kind = 'paypal_fee'")).toBe(2);
    expect(await states(a.order_id)).toEqual(['captured', 'captured']);
    expect((await orderRow(a.order_id)).status).toBe('paid');
    expect((await entRows(a.order_id)).map((e) => e.access_state)).toEqual([
      'available',
      'available',
    ]);
    expect(await count(w, 'alerts')).toBe(0);
    // two capture operations, one per PayPal order, each on its own provider order
    const caps = await ops(a.order_id, 'capture');
    expect(caps.map((c) => c.state)).toEqual(['confirmed', 'confirmed']);
    expect(new Set(caps.map((c) => c.provider_order_ref)).size).toBe(2);
    expect((await checkInvariants(w.db)).filter((i) => !i.ok)).toEqual([]);
  });

  it('D-02 PO2 DECLINED: paid_partial, PO2 not charged, one partial alert', async () => {
    w = await makeWorld();
    const a = await approved(w, PACK);
    w.paypal.nextBy.set(poIds(a)[1]!, { status: 'DECLINED', fee: null });
    const r = await ret(a.order_ref);
    expect(r.ok && r.value.status).toBe('paid_partial');
    expect(await states(a.order_id)).toEqual(['captured', 'declined']);
    expect((await unitRows(a.order_id)).map((u) => u.status)).toEqual([
      'captured_verified',
      'declined',
    ]);
    expect((await entRows(a.order_id)).map((e) => e.money_state)).toEqual(['captured', 'denied']);
    expect(await alerts('partial_composite')).toEqual([{ reason: 'partial' }]);
    expect((await orderRow(a.order_id)).mismatch).toBe(false);
    expect(await count(w, 'ledger_entries', "kind = 'sale'")).toBe(1);
    // reading it again raises nothing new
    await reapply(w, a.order_id, 'poll', true, 2);
    expect(await alerts('partial_composite')).toHaveLength(1);
    expect((await orderRow(a.order_id)).status).toBe('paid_partial');
  });

  it('D-05 PO2 payee mismatch after capture: PO2 frozen, paid_partial with mismatch, new receipt version, no partial alert', async () => {
    w = await makeWorld();
    const a = await approved(w, PACK);
    w.paypal.tamperAfterCapture.set(poIds(a)[1]!, { payee: 'SBXEVILPAYEE' });
    const r = await ret(a.order_ref);
    expect(r.ok && r.value.status).toBe('paid_partial');
    expect(await states(a.order_id)).toEqual(['captured', 'frozen']);
    expect(await orderRow(a.order_id)).toMatchObject({ status: 'paid_partial', mismatch: true });
    expect((await alerts('frozen_order')).length).toBeGreaterThanOrEqual(1);
    expect(await alerts('partial_composite')).toEqual([]); // frozen is on hold, not "not charged"
    expect((await unitRows(a.order_id)).map((u) => u.status)).toEqual([
      'captured_verified',
      'mismatch',
    ]);
    expect(await count(w, 'ledger_entries', "kind = 'sale'")).toBe(1); // no ledger row without a verified capture
    expect((await entRows(a.order_id)).map((e) => e.access_state)).toEqual(['available', 'locked']);
    // the hold after money moved writes a new receipt version
    expect(await count(w, 'receipts')).toBe(2);
    expect(captureCalls()).toHaveLength(2);
  });

  it('PO2 capture answer lost: PO2 unresolved, order unresolved, PO2 locked, PO1 unaffected', async () => {
    w = await makeWorld();
    const a = await approved(w, PACK);
    w.paypal.nextBy.set(poIds(a)[1]!, { lose_response: true });
    const r = await ret(a.order_ref);
    expect(r.ok && r.value.status).toBe('unresolved');
    expect(await states(a.order_id)).toEqual(['captured', 'unresolved']);
    expect((await entRows(a.order_id)).map((e) => e.access_state)).toEqual(['available', 'locked']);
    expect(await count(w, 'ledger_entries', "kind = 'sale'")).toBe(1);
    const caps = await ops(a.order_id, 'capture');
    expect(caps.map((c) => c.state)).toEqual(['confirmed', 'unknown']);
    // PO1's read-back operation (umsB-<po_ref>) is settled; PO2's capture operation is the one polled.
    expect((await ops(a.order_id, 'readback')).map((o) => [o.request_id, o.state])).toEqual([
      [`umsB-${a.order_ref}-p1`, 'confirmed'],
    ]);
    // INV5 holds per PayPal order
    expect((await checkInvariants(w.db)).filter((i) => !i.ok)).toEqual([]);
    // a read that shows the capture settles PO2 and only PO2
    const done = await reapply(w, a.order_id, 'poll', true, 2);
    expect(done.order_status).toBe('paid');
    expect(await states(a.order_id)).toEqual(['captured', 'captured']);
  });

  it('INV5 per provider order: an unresolved PayPal order nobody polls is a violation', async () => {
    w = await makeWorld();
    const a = await approved(w, PACK);
    w.paypal.nextBy.set(poIds(a)[1]!, { lose_response: true });
    await ret(a.order_ref);
    // PO1's operations are all done; PO2's only open operations are the unknown capture and read-back.
    await w.rows(
      "UPDATE operations SET state = 'confirmed', lease_until = NULL, next_retry_at = NULL WHERE order_id = $1 AND state = 'unknown'",
      [a.order_id],
    );
    const inv5 = (await checkInvariants(w.db)).find((i) => i.id === 'INV5')!;
    expect(inv5.ok).toBe(false);
    expect(inv5.detail).toContain('unresolved');
  });

  it("kill switch on PO2's capture after PO1 captured: PO2 approved, order capture_requested, never awaiting_buyer", async () => {
    w = await makeWorld();
    const a = await approved(w, PACK);
    w.paypal.queue.capture.push('real', { kind: 'blocked', by: 'kill_switch' });
    const r = await ret(a.order_ref);
    expect(r.ok && r.value.status).toBe('capture_requested');
    expect(await states(a.order_id)).toEqual(['captured', 'approved']);
    expect((await orderRow(a.order_id)).status).toBe('capture_requested');
    const caps = await ops(a.order_id, 'capture');
    expect(caps.map((c) => c.state)).toEqual(['confirmed', 'prepared']);
    expect(caps[1]!.first_sent_at).toBeNull(); // the blocked call spent no attempt
    // a return later never moves the order back to the buyer
    await ret(a.order_ref);
    expect((await orderRow(a.order_id)).status).toBe('capture_requested');
  });

  it('payer_action on PO2: approve_url written on PO2 only, PO2 approved, the order not awaiting_buyer', async () => {
    w = await makeWorld();
    const a = await approved(w, PACK);
    const before = await providerOrdersOf(w, a.order_id);
    w.paypal.queue.capture.push('real', {
      kind: 'payer_action',
      redirect_url: 'https://www.sandbox.paypal.com/checkoutnow?token=PO2AGAIN',
      debug_id: 'D',
    });
    await ret(a.order_ref);
    const after = await providerOrdersOf(w, a.order_id);
    expect(after[0]!.approve_url).toBe(before[0]!.approve_url);
    expect(after[1]!.approve_url).toBe('https://www.sandbox.paypal.com/checkoutnow?token=PO2AGAIN');
    expect(after.map((p) => p.state)).toEqual(['captured', 'approved']);
    expect((await orderRow(a.order_id)).status).toBe('capture_requested');
  });

  it('after PO1 captured, a mismatch on the status read of PO2 holds PO2 only: no PO2 capture, no partial alert', async () => {
    w = await makeWorld();
    const a = await approved(w, PACK);
    // reads: pass PO1, pass PO2, (capture PO1), read-back PO1, then the status read of PO2 (the 4th)
    w.paypal.beforeGet = async () => {
      if (w.paypal.count('get') === 4)
        w.paypal.tamperBy.set(poIds(a)[1]!, { payee: 'SBXEVILPAYEE' });
    };
    const r = await ret(a.order_ref);
    expect(r.ok && r.value.status).toBe('paid_partial');
    expect(await states(a.order_id)).toEqual(['captured', 'frozen']);
    expect(captureCalls().map((c) => c.provider_order_id)).toEqual([poIds(a)[0]]);
    expect((await orderRow(a.order_id)).mismatch).toBe(true);
    expect(await alerts('partial_composite')).toEqual([]);
    expect((await unitRows(a.order_id)).map((u) => u.status)).toEqual([
      'captured_verified',
      'mismatch',
    ]);
    expect((await entRows(a.order_id)).map((e) => e.access_state)).toEqual(['available', 'locked']);
  });

  it('after PO1 captured, PO2 found VOIDED on its status read: left approved for the continuation, never "not charged" here', async () => {
    w = await makeWorld();
    const a = await approved(w, PACK);
    w.paypal.beforeGet = async () => {
      if (w.paypal.count('get') === 4) w.paypal.void(poIds(a)[1]!);
    };
    const r = await ret(a.order_ref);
    expect(r.ok && r.value.status).toBe('capture_requested');
    expect(await states(a.order_id)).toEqual(['captured', 'approved']);
    expect(captureCalls()).toHaveLength(1);
    expect(await alerts('partial_composite')).toEqual([]);
  });

  it('a second return never captures a PayPal order twice', async () => {
    w = await makeWorld();
    const a = await approved(w, PACK);
    await ret(a.order_ref);
    const before = w.paypal.calls.length;
    const again = await ret(a.order_ref);
    expect(again.ok && again.value.status).toBe('paid');
    expect(w.paypal.calls.length).toBe(before);
    expect(captureCalls()).toHaveLength(2);
  });

  it('happy composite at most 13 PayPal calls', async () => {
    w = await makeWorld();
    const a = await awaiting(w, PACK);
    approvePo(w, a, 1);
    await ret(a.order_ref);
    approvePo(w, a, 2);
    const r = await ret(a.order_ref);
    expect(r.ok && r.value.status).toBe('paid');
    // the fake has no token call: the real adapter adds one
    expect(w.paypal.calls.length + 1).toBeLessThanOrEqual(13);
    expect(w.paypal.count('create')).toBe(2);
    expect(w.paypal.count('capture')).toBe(2);
    expect(w.paypal.count('get')).toBe(7);
  });
});

describe('the return refuses what it must', () => {
  it('a malformed order reference names no order: not_found, no PayPal call', async () => {
    w = await makeWorld();
    for (const ref of ['', 'a\u0000b', ' x']) {
      expect(await ret(ref)).toEqual({ ok: false, error: { code: 'not_found' } });
    }
    expect(w.paypal.calls).toHaveLength(0);
  });

  it('an order flagged mismatch, or with a unit in mismatch, is frozen at the return: whole order, no read, no capture', async () => {
    for (const flag of [
      'UPDATE orders SET mismatch = true WHERE id = $1',
      "UPDATE order_units SET status = 'mismatch', mismatch_reason = 'amount' WHERE order_id = $1 AND publisher_id = 'pub_2'",
    ]) {
      w = await makeWorld();
      const a = await approved(w, PACK);
      await w.rows(flag, [a.order_id]);
      const before = w.paypal.calls.length;
      expect(await ret(a.order_ref)).toEqual({ ok: false, error: { code: 'frozen' } });
      expect(await states(a.order_id)).toEqual(['frozen', 'frozen']);
      expect((await alerts('frozen_order')).map((x) => x.reason)).toEqual([
        'return_on_flagged_order',
      ]);
      expect(w.paypal.calls.length).toBe(before);
      await w.close();
    }
    w = await makeWorld();
  });

  it('a PayPal order whose approval went away (back to CREATED) sends the buyer back: not_approved, that order awaiting_buyer, nothing captured', async () => {
    w = await makeWorld();
    const a = await approved(w, PACK);
    w.paypal.orders.get(poIds(a)[1]!)!.status = 'CREATED';
    expect(await ret(a.order_ref)).toEqual({ ok: false, error: { code: 'not_approved' } });
    expect(await states(a.order_id)).toEqual(['approved', 'awaiting_buyer']);
    expect((await orderRow(a.order_id)).status).toBe('awaiting_buyer');
    expect(w.paypal.count('capture')).toBe(0);
    // the buyer approves again and the pack goes through
    w.paypal.approve(poIds(a)[1]!);
    const again = await ret(a.order_ref);
    expect(again.ok && again.value.status).toBe('paid');
  });

  it('a PayPal order that cannot be read in the pass leaves everything as it was: not_approved, nothing captured, nothing abandoned', async () => {
    w = await makeWorld();
    const a = await approved(w, PACK);
    w.paypal.queue.get.push({ kind: 'timeout' });
    expect(await ret(a.order_ref)).toEqual({ ok: false, error: { code: 'not_approved' } });
    expect(await states(a.order_id)).toEqual(['approved', 'approved']);
    expect(w.paypal.count('capture')).toBe(0);
  });

  it('window run out and PO2 unreadable: nothing is abandoned on an answer that proves nothing', async () => {
    w = await makeWorld();
    const a = await awaiting(w, PACK);
    approvePo(w, a, 1);
    await ret(a.order_ref);
    w.clock.advance(3_600_001);
    w.paypal.queue.get.push({ kind: 'timeout' }, 'real');
    const r = await ret(a.order_ref);
    expect(r.ok && r.value.status).toBe('awaiting_buyer');
    expect(await states(a.order_id)).toEqual(['approved', 'awaiting_buyer']);
  });

  it('window run out and the kill switch blocks a read: payments_paused, nothing abandoned', async () => {
    w = await makeWorld();
    const a = await awaiting(w, PACK);
    approvePo(w, a, 1);
    await ret(a.order_ref);
    w.clock.advance(3_600_001);
    w.paypal.queue.get.push('real', { kind: 'blocked', by: 'kill_switch' });
    expect(await ret(a.order_ref)).toEqual({ ok: false, error: { code: 'payments_paused' } });
    expect(await states(a.order_id)).toEqual(['approved', 'awaiting_buyer']);
  });
});

describe('capture answers of one PayPal order of a pack', () => {
  it("PO1 refused with a 400: PO1 is closed as not charged on the read, the alert is PO1's, PO2 is still captured", async () => {
    w = await makeWorld();
    const a = await approved(w, PACK);
    w.paypal.queue.capture.push({
      kind: 'rejected',
      http: 400,
      name: 'INVALID_REQUEST',
      issue: null,
      debug_id: 'D',
    });
    const r = await ret(a.order_ref);
    expect(r.ok && r.value.status).toBe('paid_partial');
    expect(await states(a.order_id)).toEqual(['declined', 'captured']);
    expect((await ops(a.order_id, 'capture')).map((o) => o.state)).toEqual(['failed', 'confirmed']);
    expect(
      await w.rows<{ failure_reason: string }>(
        "SELECT failure_reason FROM operations WHERE order_id = $1 AND kind = 'capture' AND state = 'failed'",
        [a.order_id],
      ),
    ).toEqual([{ failure_reason: 'invalid_request' }]);
    expect((await alerts('payment_unresolved')).map((x) => x.reason)).toEqual([
      'capture_invalid_request_p1',
    ]);
    expect(await alerts('partial_composite')).toEqual([{ reason: 'partial' }]);
    // a declined PayPal order is never captured again
    await ret(a.order_ref);
    expect(captureCalls()).toHaveLength(2);
  });

  it('DUPLICATE_INVOICE_ID on the capture of PO2 after PO1 captured: PO2 frozen only, the alert names PO2', async () => {
    w = await makeWorld();
    const a = await approved(w, PACK);
    w.paypal.queue.capture.push('real', {
      kind: 'rejected',
      http: 422,
      name: 'UNPROCESSABLE_ENTITY',
      issue: 'DUPLICATE_INVOICE_ID',
      debug_id: 'D',
    });
    const r = await ret(a.order_ref);
    expect(r.ok && r.value.status).toBe('paid_partial');
    expect(await states(a.order_id)).toEqual(['captured', 'frozen']);
    expect(await orderRow(a.order_id)).toMatchObject({ status: 'paid_partial', mismatch: true });
    expect((await alerts('frozen_order')).map((x) => x.reason)).toEqual([
      'duplicate_invoice_id_p2',
    ]);
    expect(await alerts('partial_composite')).toEqual([]);
  });

  it('captureOnce without a PayPal order named finds it by the PayPal id it is given', async () => {
    w = await makeWorld();
    const a = await approved(w, PACK);
    const order = (await loadOrder(w.db, a.order_id))!;
    expect(await captureOnce(w.deps, order, poIds(a)[1]!, null)).toEqual({ kind: 'claim' });
    expect(captureCalls().map((c) => c.provider_order_id)).toEqual([poIds(a)[1]]);
    expect(await states(a.order_id)).toEqual(['approved', 'capture_claimed']);
    await expect(captureOnce(w.deps, order, 'SBXNOSUCHORDER', null)).rejects.toThrow();
  });

  it('an answer that arrives after the PayPal order was declined meanwhile closes the operation as declined and leaves the order alone', async () => {
    w = await makeWorld();
    const a = await approved(w, PACK);
    const real = w.paypal.captureOrder.bind(w.paypal);
    w.paypal.captureOrder = async (r) => {
      if (r.provider_order_id === poIds(a)[1]) {
        await w.rows(
          "UPDATE provider_orders SET state = 'declined' WHERE order_id = $1 AND position = 2",
          [a.order_id],
        );
      }
      return real(r);
    };
    w.paypal.nextBy.set(poIds(a)[1]!, { lose_response: true });
    await ret(a.order_ref);
    const caps = await w.rows<{ state: string; failure_reason: string | null }>(
      `SELECT o.state, o.failure_reason FROM operations o JOIN provider_orders p ON p.id = o.provider_order_ref
        WHERE o.kind = 'capture' AND p.position = 2`,
    );
    expect(caps).toEqual([{ state: 'failed', failure_reason: 'declined' }]);
    expect((await states(a.order_id))[1]).toBe('declined');
  });
});
