// DP-5 (MVP-D) state tests: the composite pack through the web composition. One approval with two
// blocks, two PayPal approvals with progress, per-item lines from stored data, the boot seeding of
// the second publisher, and the owner's wording rules (D-051). Dry-run model only; no PayPal.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Actor } from '@umsbx/contracts';
import type { App } from '../composition.server';
import { bootTestApp, call, signIn } from './support';
import type { Session } from './support';
import {
  HARBOUR_FEES,
  HARBOUR_FERRY,
  HARBOUR_KNOTS,
  HARBOUR_TIDE,
  NORTH_ALLOTMENT,
  OTHER_ID,
  OWNER_ID,
  QUAY_MARKET,
  QUAY_WALK,
  approvalFor,
  approveStep,
  bootPackApp,
  buyer,
  orderText,
  proposalFor,
  runPack,
  startPack,
} from './composite-support';
import { stepDeadline, stepHeading, windowMinutes } from './lib/composite-copy';

vi.mock('server-only', () => ({}));

const READY = 'Ready in your library';
const HOLD = 'On hold while we check it';
const NOT_CHARGED = 'Not charged: PayPal declined this payment';

let app: App;
let A: Actor;
let B: Actor;
let sessionRoute: typeof import('./app/api/session/route');
let ordersRoute: typeof import('./app/api/orders/route');
let checkoutRoute: typeof import('./app/api/orders/[ref]/checkout/route');
let approvalsRoute: typeof import('./app/api/approvals/route');
let SA: Session;

beforeAll(async () => {
  app = await bootPackApp();
  A = await buyer(app, 'a');
  B = await buyer(app, 'b');
  sessionRoute = await import('./app/api/session/route');
  ordersRoute = await import('./app/api/orders/route');
  checkoutRoute = await import('./app/api/orders/[ref]/checkout/route');
  approvalsRoute = await import('./app/api/approvals/route');
  SA = (await signIn(sessionRoute.POST, 'buyer-a'))!;
});
afterAll(async () => {
  await app.close();
});

const count = async (a: App, sql: string, params: unknown[] = []): Promise<number> =>
  Number((await a.db.query<{ c: string | number }>(sql, params)).rows[0]!.c);

describe('one approval for a pack', () => {
  it('pack of Harbour and Quayside reaches one approval with two blocks and "2 payments"', async () => {
    const g = await approvalFor(app, A, [HARBOUR_TIDE, QUAY_MARKET]);
    expect(g.ok).toBe(true);
    if (!g.ok) return;
    const v = await app.engine.approvalView({ approval_id: g.value.approval_id, actor: A });
    expect(v?.settlement).toEqual({ payments: 2 });
    expect(v?.blocks.map((b) => b.publisher).sort()).toEqual([
      'Harbour Ledger Review (fictional)',
      'Quayside Gazette (fictional)',
    ]);
    for (const b of v!.blocks) {
      expect(b.items.length).toBe(1);
      expect(b.subtotal_minor).toBe(b.items[0]!.amount_minor);
    }
    expect(v!.blocks.reduce((n, b) => n + b.subtotal_minor, 0)).toBe(v!.total_minor);
  });

  it('a one-publisher approval has one block and no settlement', async () => {
    const g = await approvalFor(app, B, [HARBOUR_TIDE, HARBOUR_FERRY]);
    expect(g.ok).toBe(true);
    if (!g.ok) return;
    const v = await app.engine.approvalView({ approval_id: g.value.approval_id, actor: B });
    expect(v?.settlement).toBeNull();
    expect(v?.blocks.length).toBe(1);
    expect(v?.blocks[0]!.items.length).toBe(2);
  });

  it('Harbour plus Northfield: mixed_currency message, no approval', async () => {
    const before = await count(app, 'SELECT count(*) AS c FROM approvals');
    const p = await proposalFor(app, A, [HARBOUR_TIDE, NORTH_ALLOTMENT]);
    const res = await call(approvalsRoute.POST, {
      url: '/api/approvals',
      method: 'POST',
      session: SA,
      body: {
        proposal_id: p.proposal_id,
        offer_ids: p.offer_ids,
        consent: { terms: true, identity_share: false },
      },
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('mixed_currency');
    expect(body.error.message).toMatch(/different currencies/);
    expect(await count(app, 'SELECT count(*) AS c FROM approvals')).toBe(before);
  });
});

describe('happy journey: Harbour tide tables and Quayside market hall (buyer A)', () => {
  let order_ref = '';
  let order_id = '';

  it('checkout returns step 1 of 2', async () => {
    const g = await approvalFor(app, A, [HARBOUR_TIDE, QUAY_MARKET]);
    if (!g.ok) throw new Error('approval');
    const placed = await call(ordersRoute.POST, {
      url: '/api/orders',
      method: 'POST',
      session: SA,
      headers: { 'idempotency-key': 'pack-test-key-0001' },
      body: { approval_id: g.value.approval_id, token: g.value.token },
    });
    expect(placed.status).toBe(201);
    const o = (await placed.json()) as { order_ref: string; order_id: string };
    order_ref = o.order_ref;
    order_id = o.order_id;
    const co = await call(checkoutRoute.POST, {
      url: `/api/orders/${order_ref}/checkout`,
      method: 'POST',
      session: SA,
      params: { ref: order_ref },
      body: {},
    });
    expect(co.status).toBe(200);
    const body = (await co.json()) as { approve_url: string; progress: unknown };
    expect(body.progress).toEqual({ step: 1, of: 2 });
    expect(body.approve_url).toMatch(/^https:\/\/[^/]+\/checkoutnow\?token=SBXMODELORD/);
    const steps = await app.engine.checkoutSteps({ order_ref, actor: A });
    expect(steps?.map((s) => s.position)).toEqual([1, 2]);
  });

  it('return after the first dry-run approval renders step 2 of 2 with the second stored URL', async () => {
    const steps = (await app.engine.checkoutSteps({ order_ref, actor: A }))!;
    const r = await approveStep(app, A, order_ref, 1, 'happy');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.status).toBe('awaiting_buyer');
    const next = r.value.next;
    expect(next).not.toBeNull();
    expect(next?.step).toBe(2);
    expect(next?.of).toBe(2);
    expect(next?.publisher).toBe(steps[1]!.publisher);
    const stored = await app.db.query<{ approve_url: string }>(
      'SELECT approve_url FROM provider_orders WHERE order_id = $1 AND position = 2',
      [order_id],
    );
    expect(next?.approve_url).toBe(stored.rows[0]!.approve_url);
    expect(stepHeading(2, 2, next!.publisher)).toBe(
      `Step 2 of 2: approve your payment to ${steps[1]!.publisher} at PayPal`,
    );
    expect(stepDeadline(app.engine.packWindowMinutes())).toContain('within 60 minutes');
    // Nothing is captured after only one approval.
    expect(
      await count(
        app,
        `SELECT count(*) AS c FROM order_units WHERE order_id = $1 AND capture_id IS NOT NULL`,
        [order_id],
      ),
    ).toBe(0);
  });

  it('both approved: order page lists two ready items', async () => {
    const r = await approveStep(app, A, order_ref, 2, 'happy');
    expect(r.ok).toBe(true);
    const v = await app.engine.orderView({ order_ref, actor: A });
    expect(v?.status).toBe('paid');
    expect(v?.items.map((i) => i.line)).toEqual([READY, READY]);
    expect(v?.buyer_message).not.toMatch(/not charged/i);
    const lib = await app.engine.library({ actor: A });
    expect(lib.filter((l) => l.order_id === order_id && l.can_open).length).toBe(2);
  });
});

describe('partial and held packs', () => {
  it('happy then declined: one ready, one "Not charged"', async () => {
    const run = await runPack(app, A, [QUAY_WALK, HARBOUR_FERRY], ['happy', 'declined']);
    const text = await orderText(app, A, run.order_ref);
    const lines = text.slice(1).sort();
    expect(lines).toEqual([NOT_CHARGED, READY].sort());
    const v = await app.engine.orderView({ order_ref: run.order_ref, actor: A });
    expect(v?.status).toBe('paid_partial');
    // Verb agrees with the number of titles (D-051): one title is ready, one was not charged.
    expect(v?.buyer_message).toMatch(/ is ready/);
    expect(v?.buyer_message).not.toMatch(/ are ready/);
  });

  it('PO2 payee mismatch scenario: "On hold while we check it", never "Not charged"', async () => {
    const run = await runPack(app, B, [QUAY_MARKET, HARBOUR_KNOTS], ['happy', 'mismatch_payee']);
    const text = await orderText(app, B, run.order_ref);
    expect(text.slice(1).every((l) => l === HOLD)).toBe(true);
    expect(text.join('\n')).not.toMatch(/not charged/i);
    const v = await app.engine.orderView({ order_ref: run.order_ref, actor: B });
    expect(v?.status).toBe('frozen');
  });

  it('captured PayPal order frozen after its capture: "On hold while we check it", never "Payment confirmed"', async () => {
    const run = await runPack(app, B, [QUAY_WALK, HARBOUR_TIDE], ['happy', 'happy']);
    expect((await app.engine.orderView({ order_ref: run.order_ref, actor: B }))?.status).toBe(
      'paid',
    );
    await app.db.query(
      `UPDATE provider_orders SET state = 'frozen' WHERE order_id = $1 AND position = 2`,
      [run.order_id],
    );
    const v = await app.engine.orderView({ order_ref: run.order_ref, actor: B });
    const lines = v!.items.map((i) => i.line);
    expect(lines.filter((l) => l === HOLD).length).toBe(1);
    expect(lines.filter((l) => l === READY).length).toBe(1);
    const all = [v!.buyer_message, ...lines].join('\n');
    expect(all).not.toMatch(/Payment confirmed|Confirming payment|^Paid\./m);
    expect(all).not.toMatch(/not charged/i);
    expect(v!.buyer_message).toMatch(/on hold/i);
  });

  it('the single-publisher order keeps its old words for a frozen PayPal order too', async () => {
    const o = await startPack(app, A, [HARBOUR_FEES]);
    expect(o.checkout.progress).toBeNull();
    await app.engine.dryRunApprove({ order_ref: o.order_ref, actor: A, scenario: 'happy' });
    await app.engine.payments.onBuyerReturn({
      order_ref: o.order_ref,
      actor: A,
      scenario: 'happy',
    });
    await app.db.query(`UPDATE provider_orders SET state = 'frozen' WHERE order_id = $1`, [
      o.order_id,
    ]);
    const v = await app.engine.orderView({ order_ref: o.order_ref, actor: A });
    expect(v?.buyer_message).toMatch(/on hold/i);
    expect(v?.buyer_message).not.toMatch(/^Paid\./);
  });
});

describe('the step page follows the configured window', () => {
  it('step page text follows a 30 minute window', async () => {
    const a30 = await bootPackApp({}, { test_domain: { pack_approval_window_ms: 1_800_000 } });
    try {
      const actor = await buyer(a30, 'a');
      const o = await startPack(a30, actor, [HARBOUR_TIDE, QUAY_MARKET]);
      const r = await approveStep(a30, actor, o.order_ref, 1, 'happy');
      expect(r.ok && r.value.next?.step).toBe(2);
      expect(a30.engine.packWindowMinutes()).toBe(30);
      expect(stepDeadline(a30.engine.packWindowMinutes())).toBe(
        'If you do not approve within 30 minutes, the whole order may be cancelled and nothing is charged.',
      );
    } finally {
      await a30.close();
    }
  });
  it('the default is 60 minutes and the minutes are rounded down', () => {
    expect(app.engine.packWindowMinutes()).toBe(60);
    expect(windowMinutes(3_600_000)).toBe(60);
    expect(windowMinutes(2_700_000 + 59_999)).toBe(45);
    expect(windowMinutes(5_400_000)).toBe(90);
  });
});

describe('boot seeding of the second publisher', () => {
  const names = async (a: App): Promise<string[]> =>
    (
      await a.db.query<{ slug: string }>(
        `SELECT slug FROM publishers WHERE slug = 'quayside-gazette'`,
      )
    ).rows.map((r) => r.slug);
  const sandbox = (dir: string, own: string): Record<string, string> => ({
    UMS_MODE: 'sandbox',
    UMS_OUTBOUND_APPROVAL_REF: 'DL-2026-10-25-test',
    PAYPAL_CLIENT_ID: 'synthetic-client-id-for-tests',
    PAYPAL_CLIENT_SECRET: 'synthetic-client-secret-for-tests-xyz',
    UMS_OWN_MERCHANT_ID: own,
    UMS_DB: 'pglite-disk',
    UMS_PGLITE_DIR: dir,
  });
  const pubs = async (a: App) =>
    (
      await a.db.query<{
        slug: string;
        paypal_merchant_id: string | null;
        payee_shared: boolean;
        payee_verified_at: unknown;
      }>(
        'SELECT slug, paypal_merchant_id, payee_shared, payee_verified_at FROM publishers ORDER BY slug',
      )
    ).rows;
  const audits = (a: App) =>
    count(a, `SELECT count(*) AS c FROM audit_log WHERE action LIKE 'seed.payee%'`);

  it('seedSupplement on an existing disk adds Quayside once', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dp5-disk-'));
    try {
      const env = { UMS_DB: 'pglite-disk', UMS_PGLITE_DIR: join(dir, 'db') };
      const old = await bootPackApp(env, { test_seed: { supplement: false } });
      expect(await names(old)).toEqual([]);
      await old.close();
      const again = await bootPackApp(env);
      expect(await names(again)).toEqual(['quayside-gazette']);
      expect(
        await count(
          again,
          `SELECT count(*) AS c FROM offers o JOIN publishers p ON p.id = o.publisher_id WHERE p.slug = 'quayside-gazette'`,
        ),
      ).toBe(2);
      const harbourBefore = await count(
        again,
        `SELECT count(*) AS c FROM offers o JOIN publishers p ON p.id = o.publisher_id WHERE p.slug = 'harbour-ledger'`,
      );
      await again.close();
      const third = await bootPackApp(env);
      expect(await names(third)).toEqual(['quayside-gazette']);
      expect(
        await count(
          third,
          `SELECT count(*) AS c FROM articles a JOIN publishers p ON p.id = a.publisher_id WHERE p.slug = 'quayside-gazette'`,
        ),
      ).toBe(2);
      expect(
        await count(
          third,
          `SELECT count(*) AS c FROM offers o JOIN publishers p ON p.id = o.publisher_id WHERE p.slug = 'harbour-ledger'`,
        ),
      ).toBe(harbourBefore);
      // Offline: every publisher has its own fake payee.
      const rows = await pubs(third);
      expect(new Set(rows.map((r) => r.paypal_merchant_id)).size).toBe(rows.length);
      expect(rows.every((r) => !r.payee_shared)).toBe(true);
      await third.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('sandbox seeding on an MVP-C-shaped disk (Harbour holds the owner id, unflagged): Harbour flagged, Quayside set, two audit rows, no 23505', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dp5-sbx-'));
    try {
      const env = sandbox(join(dir, 'db'), OWNER_ID);
      const old = await bootPackApp(env, { test_seed: { supplement: false, payees: false } });
      const before = await pubs(old);
      expect(before.map((p) => [p.slug, p.paypal_merchant_id, p.payee_shared])).toContainEqual([
        'harbour-ledger',
        OWNER_ID,
        false,
      ]);
      await old.close();
      const lines: string[] = [];
      const now = await bootPackApp(env, { log_sink: (l) => lines.push(l) });
      const rows = await pubs(now);
      const harbour = rows.find((r) => r.slug === 'harbour-ledger')!;
      const quay = rows.find((r) => r.slug === 'quayside-gazette')!;
      expect(harbour.payee_shared).toBe(true);
      expect(harbour.paypal_merchant_id).toBe(OWNER_ID);
      expect(quay.payee_shared).toBe(true);
      expect(quay.paypal_merchant_id).toBe(OWNER_ID);
      expect(quay.payee_verified_at).not.toBeNull();
      expect(await audits(now)).toBe(2);
      const ops = await now.engine.opsSnapshot({
        kind: 'operator',
        operator_id: 'opr_demo',
        mfa: false,
      });
      expect(ops?.shared_payee).toEqual({ publishers: 2, last4: OWNER_ID.slice(-4) });
      await now.close();
      // Second boot changes nothing.
      const second = await bootPackApp(env);
      expect(await pubs(second)).toEqual(rows);
      expect(await audits(second)).toBe(2);
      await second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('Harbour with a different stored id: nothing set, one refusal line', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dp5-sbx2-'));
    try {
      const old = await bootPackApp(sandbox(join(dir, 'db'), OTHER_ID), {
        test_seed: { supplement: false, payees: false },
      });
      await old.close();
      const lines: string[] = [];
      const now = await bootPackApp(sandbox(join(dir, 'db'), OWNER_ID), {
        log_sink: (l) => lines.push(l),
      });
      const rows = await pubs(now);
      expect(rows.find((r) => r.slug === 'harbour-ledger')).toMatchObject({
        paypal_merchant_id: OTHER_ID,
        payee_shared: false,
      });
      expect(rows.find((r) => r.slug === 'quayside-gazette')).toMatchObject({
        paypal_merchant_id: null,
        payee_shared: false,
      });
      expect(await audits(now)).toBe(0);
      expect(lines.filter((l) => l.includes('seed.payee_refused')).length).toBe(1);
      expect(lines.join('\n')).not.toContain(OWNER_ID);
      expect(lines.join('\n')).not.toContain(OTHER_ID);
      await now.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a stored id is never overwritten', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dp5-sbx3-'));
    try {
      const env = sandbox(join(dir, 'db'), OWNER_ID);
      const old = await bootPackApp(env, { test_seed: { payees: false } });
      // Quayside already holds another id (not the owner's): a later boot must leave it alone.
      await old.db.query(
        `UPDATE publishers SET paypal_merchant_id = $1 WHERE slug = 'quayside-gazette'`,
        [OTHER_ID],
      );
      await old.close();
      const now = await bootPackApp(env);
      const rows = await pubs(now);
      expect(rows.find((r) => r.slug === 'quayside-gazette')).toMatchObject({
        paypal_merchant_id: OTHER_ID,
        payee_shared: false,
      });
      expect(rows.find((r) => r.slug === 'harbour-ledger')!.paypal_merchant_id).toBe(OWNER_ID);
      await now.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('plain app boot helper stays usable', () => {
  it('bootTestApp still boots offline and lists the Quayside offers', async () => {
    const a = await bootTestApp();
    try {
      const slugs = new Set((await a.engine.listOffers()).map((o) => o.publisher_slug));
      expect(slugs.has('quayside-gazette')).toBe(true);
      expect(slugs.has('harbour-ledger')).toBe(true);
    } finally {
      await a.close();
    }
  });
});
