// PUB-D state tests (docs/specs/pub-d-ops-publishers.md): the operator's publishers page data and the
// suspend route over the real engine and the dry-run order model. Suspending a publisher takes its offers
// off sale and ends its open quotes; an order already paid, its access and its refunds are untouched.
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Actor } from '@umsbx/contracts';
import { buy, count, errorOf } from './refund-support';
import { bootPayeeWorld } from './payee-support';
import type { PayeeWebWorld } from './payee-support';
import { call } from './support';
import type { Session } from './support';

vi.mock('server-only', () => ({}));

type Handler = (
  req: Request,
  ctx?: { params: Promise<Record<string, string>> },
) => Promise<Response>;

let w: PayeeWebWorld;
let route: typeof import('./app/api/ops/publishers/status/route');
const OP: Actor = { kind: 'operator', operator_id: 'opr_vikram', mfa: true };
const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8');

const post = (session: Session | null, body: unknown): Promise<Response> =>
  call(route.POST as Handler, {
    url: '/api/ops/publishers/status',
    method: 'POST',
    body,
    session,
  });

beforeAll(async () => {
  w = await bootPayeeWorld();
  route = await import('./app/api/ops/publishers/status/route');
});
afterAll(async () => {
  await w.app.close();
});

const resetBuckets = () => w.app.db.query('DELETE FROM rate_buckets');
const listed = async () => {
  const r = await w.app.engine.opsPublishers.list(OP);
  if (!r.ok) throw new Error(r.error.code);
  return r.value;
};

describe('the publishers list', () => {
  it('shows every seeded publisher with status, payee last 4 and the stored environment', async () => {
    const v = await listed();
    expect(v.environment).toBe('dryrun');
    const slugs = v.publishers.map((p) => p.slug).sort();
    expect(slugs).toEqual(['harbour-ledger', 'northfield-quarterly', 'quayside-gazette']);
    for (const p of v.publishers) {
      expect(p.status).toBe('active');
      if (p.payee_last4 !== null) expect(p.payee_last4).toHaveLength(4);
    }
  });

  it('shows what a paid order holds: units captured and the amount not refunded', async () => {
    const bought = await buy(w.refund, { offer: 'tide-tables', option: 'online_read' });
    const v = await listed();
    const h = v.publishers.find((p) => p.slug === 'harbour-ledger')!;
    const usd = h.by_currency.find((b) => b.currency === 'USD' && b.environment === 'dryrun')!;
    expect(usd.units_captured).toBeGreaterThanOrEqual(1);
    expect(usd.captured_not_refunded_minor).toBeGreaterThanOrEqual(bought.amount_minor);
    expect(h.offers_live).toBeGreaterThan(0);
  });

  it('refuses a publisher, a buyer and an operator without the second factor', async () => {
    const r = await w.app.engine.opsPublishers.list({
      kind: 'publisher',
      publisher_id: w.pubId['harbour-ledger'],
    });
    expect(r).toEqual({ ok: false, error: { code: 'not_operator' } });
    expect(await w.app.engine.opsPublishers.list(w.refund.actorA)).toEqual({
      ok: false,
      error: { code: 'not_operator' },
    });
    expect(
      await w.app.engine.opsPublishers.list({
        kind: 'operator',
        operator_id: 'opr_demo',
        mfa: false,
      }),
    ).toEqual({ ok: false, error: { code: 'mfa_required' } });
  });

  it('the whole list names no buyer and no whole merchant id', async () => {
    const text = JSON.stringify(await listed());
    const merchants = (
      await w.app.db.query<{ m: string }>(
        'SELECT paypal_merchant_id AS m FROM publishers WHERE paypal_merchant_id IS NOT NULL',
      )
    ).rows.map((r) => r.m);
    for (const m of merchants) expect(text).not.toContain(m);
    for (const s of ['buyer-a', 'buyer-b', 'persona:', 'ordref_', 'ord_'])
      expect(text).not.toContain(s);
  });
});

describe('suspend and reactivate through the route', () => {
  it('suspend takes the offers off sale, refuses a new quote, and keeps the order, access and ledger', async () => {
    await resetBuckets();
    const kept = await buy(w.refund, { offer: 'ferry-timetables', option: 'online_read' });
    const orders = await count(w.app, 'SELECT count(*) AS c FROM orders');
    const ledger = await count(w.app, 'SELECT count(*) AS c FROM ledger_entries');
    expect(
      (await w.app.engine.listOffers()).some((o) => o.publisher_slug === 'harbour-ledger'),
    ).toBe(true);
    const res = await post(w.refund.op, {
      publisher_id: w.pubId['harbour-ledger'],
      status: 'suspended',
      reason: 'Complaint under review',
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'suspended' });
    // off sale
    expect(
      (await w.app.engine.listOffers()).some((o) => o.publisher_slug === 'harbour-ledger'),
    ).toBe(false);
    const q = await w.app.engine.quote({
      offer: { publisher_slug: 'harbour-ledger', offer_code: 'knot-notebook' },
      actor: w.refund.actorB,
      source: 'direct',
    });
    expect(q.ok && q.value.kind === 'no_match' ? q.value.reason : null).toBe('not_authorised');
    // nothing that was paid changed
    expect(await count(w.app, 'SELECT count(*) AS c FROM orders')).toBe(orders);
    expect(await count(w.app, 'SELECT count(*) AS c FROM ledger_entries')).toBe(ledger);
    const lib = await w.app.engine.libraryItem({
      entitlement_id: kept.entitlement_id,
      actor: w.refund.actorA,
    });
    expect(lib?.can_open).toBe(true);
    // the publisher sees its own status
    const home = await w.app.engine.publisherHome({
      kind: 'publisher',
      publisher_id: w.pubId['harbour-ledger'],
    });
    expect(home?.status).toBe('suspended');
    expect(home?.offers_live).toBe(0);
  });

  it('a quote taken before the suspension can no longer be approved', async () => {
    await resetBuckets();
    await post(w.refund.op, {
      publisher_id: w.pubId['harbour-ledger'],
      status: 'active',
      reason: 'Cleared after review',
    });
    const q = await w.app.engine.quote({
      offer: { publisher_slug: 'harbour-ledger', offer_code: 'harbour-fees' },
      actor: w.refund.actorB,
      source: 'direct',
    });
    if (!q.ok || q.value.kind !== 'quote') throw new Error('no quote');
    await post(w.refund.op, {
      publisher_id: w.pubId['harbour-ledger'],
      status: 'suspended',
      reason: 'Second look needed',
    });
    const g = await w.app.engine.requestApproval({
      actor: w.refund.actorB,
      selection: { kind: 'quote', quote_id: q.value.quote_id },
      consent: { terms: true, identity_share: false },
    });
    expect(g.ok).toBe(false);
    expect(!g.ok ? g.error.code : '').toBe('quote_expired');
  });

  it('KNOWN GAP (follow-up, not fixed here): an approval made before the suspension can still be placed', async () => {
    await resetBuckets();
    await post(w.refund.op, {
      publisher_id: w.pubId['harbour-ledger'],
      status: 'active',
      reason: 'Cleared again',
    });
    const q = await w.app.engine.quote({
      offer: { publisher_slug: 'harbour-ledger', offer_code: 'dock-history' },
      actor: w.refund.actorB,
      source: 'direct',
    });
    if (!q.ok || q.value.kind !== 'quote') throw new Error('no quote');
    const g = await w.app.engine.requestApproval({
      actor: w.refund.actorB,
      selection: { kind: 'quote', quote_id: q.value.quote_id },
      consent: { terms: true, identity_share: false },
    });
    if (!g.ok) throw new Error(`no approval ${g.error.code}`);
    await post(w.refund.op, {
      publisher_id: w.pubId['harbour-ledger'],
      status: 'suspended',
      reason: 'Suspended after approval',
    });
    // domain/payments placeOrder works from the frozen snapshot and does not re-read the publisher status.
    const placed = await w.app.engine.payments.placeOrder({
      approval_id: g.value.approval_id,
      token: g.value.token,
      actor: w.refund.actorB,
    });
    expect(placed.ok).toBe(true);
  });

  it('reactivate puts the offers back on sale', async () => {
    await resetBuckets();
    const res = await post(w.refund.op, {
      publisher_id: w.pubId['harbour-ledger'],
      status: 'active',
      reason: 'Cleared for good',
    });
    expect(res.status).toBe(200);
    expect(
      (await w.app.engine.listOffers()).some((o) => o.publisher_slug === 'harbour-ledger'),
    ).toBe(true);
  });

  it('answers 409 for no change, 404 for an unknown publisher and 422 for a bad reason', async () => {
    await resetBuckets();
    const same = await post(w.refund.op, {
      publisher_id: w.pubId['harbour-ledger'],
      status: 'active',
      reason: 'No change please',
    });
    expect(same.status).toBe(409);
    expect((await errorOf(same)).code).toBe('unchanged');
    const none = await post(w.refund.op, {
      publisher_id: 'pub_nobody',
      status: 'suspended',
      reason: 'Unknown one',
    });
    expect(none.status).toBe(404);
    const bad = await post(w.refund.op, {
      publisher_id: w.pubId['harbour-ledger'],
      status: 'suspended',
      reason: 'x',
    });
    expect(bad.status).toBe(422);
  });
});

describe('the pages (source as text)', () => {
  const strip = (s: string): string => s.replace(/\/\/.*$/gm, '');
  it('the ops publishers page is operator only, reads only through the engine and has no inline style', () => {
    const page = strip(read('./app/ops/publishers/page.tsx'));
    expect(page).toMatch(/actor\?\.kind !== 'operator'/);
    expect(page).toContain("redirect('/signin?next=/ops/publishers')");
    expect(page).toMatch(/engine\.opsPublishers\.list\(actor\)/);
    expect(page).toContain("from '../../../lib/ops-publishers-copy'");
    expect(page).toContain('href="/ops/payee-requests"');
    expect(page).not.toMatch(/style=/);
    expect(page).not.toMatch(/merchant/i);
  });
  it('the status form sends only the id, the status and the reason', () => {
    const form = strip(read('./app/ops/publishers/StatusForm.tsx'));
    expect(form).toContain("'/api/ops/publishers/status'");
    expect(form).toMatch(/publisher_id/);
    expect(form).not.toMatch(/style=/);
  });
  it('/ops links to /ops/publishers and /ops/payee-requests from the copy module', () => {
    const ops = strip(read('./app/ops/page.tsx'));
    expect(ops).toContain('href="/ops/publishers"');
    expect(ops).toContain('href="/ops/payee-requests"');
    expect(ops).toContain("from '../../lib/ops-publishers-copy'");
  });
  it('the publisher home links to offers, sales, statement and payout account', () => {
    const page = strip(read('./app/publisher/page.tsx'));
    for (const href of [
      '/publisher/offers',
      '/publisher/sales',
      '/publisher/statement',
      '/publisher/payout-account',
    ])
      expect(page).toContain(href);
    expect(page).toContain("from '../../lib/publisher-copy'");
  });
});
