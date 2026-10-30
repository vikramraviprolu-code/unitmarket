// ORDER-A (docs/specs/order-a-cancel-resume.md): the buyer's Cancel order route and the resume path, over
// the real engine on the dry-run model. The money rules are the payments lanes' job (cancel.state.test.ts
// in domain/payments); here we prove the route wiring, its answers and that the order page offers the two
// actions only for an unpaid order of the viewer.
import { readFileSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Actor } from '@umsbx/contracts';
import type { App } from '../composition.server';
import { bootTestApp, call, signIn } from './support';
import type { Session } from './support';

vi.mock('server-only', () => ({}));

let app: App;
let cancelRoute: typeof import('./app/api/orders/[ref]/cancel/route');
let checkoutRoute: typeof import('./app/api/orders/[ref]/checkout/route');
let A: Session;
let B: Session;
let actorA: Actor;

beforeAll(async () => {
  app = await bootTestApp();
  const sessionRoute = await import('./app/api/session/route');
  cancelRoute = await import('./app/api/orders/[ref]/cancel/route');
  checkoutRoute = await import('./app/api/orders/[ref]/checkout/route');
  A = (await signIn(sessionRoute.POST, 'buyer-a'))!;
  B = (await signIn(sessionRoute.POST, 'buyer-b'))!;
  const row = await app.db.query<{ id: string }>(
    `SELECT id FROM buyers WHERE auth_subject = 'persona:buyer-a'`,
  );
  actorA = { kind: 'buyer', buyer_id: row.rows[0]!.id };
});
afterAll(async () => {
  await app.close();
});

// Each test opens its own order; whatever it leaves open is cancelled through the route, so the next test
// can buy the same offer again (one open order per buyer and offer).
afterEach(async () => {
  const open = await app.db.query<{ order_ref: string }>(
    `SELECT order_ref FROM orders WHERE status = 'awaiting_buyer'`,
  );
  for (const r of open.rows) await post(cancelRoute, r.order_ref, A);
});

const offers = async (): Promise<string[]> =>
  (await app.engine.listOffers())
    .filter((o) => o.publisher_slug === 'harbour-ledger')
    .map((o) => o.offer_code);

async function openOrder(offer: string): Promise<{ order_ref: string; order_id: string }> {
  const page = await app.engine.offerPage({ publisher: 'harbour-ledger', offer });
  const q = await app.engine.quote({
    offer: { publisher_slug: 'harbour-ledger', offer_code: offer },
    actor: actorA,
    source: 'direct',
    option: page!.options[0]!.option,
  });
  if (!q.ok || q.value.kind !== 'quote') throw new Error('no quote');
  const g = await app.engine.requestApproval({
    actor: actorA,
    selection: { kind: 'quote', quote_id: q.value.quote_id },
    consent: { terms: true, identity_share: false },
  });
  if (!g.ok) throw new Error(`no approval: ${g.error.code}`);
  const placed = await app.engine.payments.placeOrder({
    approval_id: g.value.approval_id,
    token: g.value.token,
    actor: actorA,
  });
  if (!placed.ok) throw new Error('place failed');
  const co = await app.engine.payments.beginCheckout({
    order_id: placed.value.order_id,
    actor: actorA,
  });
  if (!co.ok) throw new Error('checkout failed');
  return placed.value;
}
const post = (
  route: { POST: Parameters<typeof call>[0] },
  ref: string,
  session: Session | null,
  body: unknown = {},
  csrf = true,
) =>
  call(route.POST, {
    url: `/api/orders/${ref}/cancel`,
    method: 'POST',
    session,
    params: { ref },
    body,
    csrf,
  });

describe('POST /api/orders/[ref]/cancel', () => {
  it('the route is declared for a signed-in buyer with csrf and a rate limit', () => {
    expect(cancelRoute.routeMeta).toMatchObject({
      path: '/api/orders/[ref]/cancel',
      method: 'POST',
      auth: 'buyer',
      csrf: true,
    });
    expect(cancelRoute.routeMeta.rate.limit).toBeGreaterThan(0);
  });

  it('needs a session (401) and a csrf token (403)', async () => {
    const o = await openOrder((await offers())[0]!);
    expect((await post(cancelRoute, o.order_ref, null)).status).toBe(401);
    expect((await post(cancelRoute, o.order_ref, A, {}, false)).status).toBe(403);
    expect((await app.engine.orderView({ order_ref: o.order_ref, actor: actorA }))?.status).toBe(
      'awaiting_buyer',
    );
  });

  it('refuses a body with extra fields (400), changing nothing', async () => {
    const o = await openOrder((await offers())[0]!);
    expect((await post(cancelRoute, o.order_ref, A, { force: true })).status).toBe(400);
    expect((await app.engine.orderView({ order_ref: o.order_ref, actor: actorA }))?.status).toBe(
      'awaiting_buyer',
    );
  });

  it("another buyer's cancel and a guessed ref both answer 404 with the same body, and change nothing", async () => {
    const o = await openOrder((await offers())[0]!);
    const other = await post(cancelRoute, o.order_ref, B);
    const guess = await post(cancelRoute, 'ord_guessedref0000', B);
    expect(other.status).toBe(404);
    expect(guess.status).toBe(404);
    expect(await other.json()).toEqual(await guess.json());
    expect((await app.engine.orderView({ order_ref: o.order_ref, actor: actorA }))?.status).toBe(
      'awaiting_buyer',
    );
  });

  it('cancels an unpaid order (200), a second cancel is the same answer with already true, and the checkout cannot be resumed', async () => {
    const o = await openOrder((await offers())[0]!);
    const mine = o.order_ref;
    const first = await post(cancelRoute, mine, A);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ order_ref: mine, status: 'abandoned', already: false });
    expect((await app.engine.orderView({ order_ref: mine, actor: actorA }))?.status).toBe(
      'abandoned',
    );
    const second = await post(cancelRoute, mine, A);
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ order_ref: mine, status: 'abandoned', already: true });
    const resume = await call(checkoutRoute.POST, {
      url: `/api/orders/${mine}/checkout`,
      method: 'POST',
      session: A,
      params: { ref: mine },
      body: {},
    });
    expect(resume.status).toBe(409);
  });

  it('a paid order answers 409 and stays paid', async () => {
    const offs = await offers();
    const o = await openOrder(offs[1] ?? offs[0]!);
    expect(
      await app.engine.dryRunApprove({ order_ref: o.order_ref, actor: actorA, scenario: 'happy' }),
    ).toBe(true);
    await app.engine.payments.onBuyerReturn({
      order_ref: o.order_ref,
      actor: actorA,
      scenario: 'happy',
    });
    const r = await post(cancelRoute, o.order_ref, A);
    expect(r.status).toBe(409);
    expect((await app.engine.orderView({ order_ref: o.order_ref, actor: actorA }))?.status).toBe(
      'paid',
    );
    const ops = await app.engine.opsSnapshot({
      kind: 'operator',
      operator_id: 'opr_demo',
      mfa: false,
    });
    expect(ops?.invariants.every((v) => v.ok)).toBe(true);
  });
});

describe('resume: POST /api/orders/[ref]/checkout on an unpaid order', () => {
  it('answers the stored approve link again and creates no second PayPal order', async () => {
    const offs = await offers();
    const o = await openOrder(offs[0]!);
    const before = (await app.db.query<{ c: string }>('SELECT count(*) AS c FROM provider_orders'))
      .rows[0]!.c;
    const ask = () =>
      call(checkoutRoute.POST, {
        url: `/api/orders/${o.order_ref}/checkout`,
        method: 'POST',
        session: A,
        params: { ref: o.order_ref },
        body: {},
      });
    const one = (await (await ask()).json()) as { approve_url: string };
    const two = (await (await ask()).json()) as { approve_url: string };
    expect(two.approve_url).toBe(one.approve_url);
    expect(
      (await app.db.query<{ c: string }>('SELECT count(*) AS c FROM provider_orders')).rows[0]!.c,
    ).toBe(before);
  });
});

describe('the order page offers the two actions only through OrderActions', () => {
  const read = (rel: string): string =>
    readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\/\/.*$/gm, '');
  const status = read('./app/orders/[ref]/OrderStatus.tsx');
  const actions = read('./app/orders/[ref]/OrderActions.tsx');

  it('OrderStatus renders OrderActions only behind orderActions(view), and nowhere else', () => {
    expect(status).toMatch(/orderActions\(view\)/);
    const used = [...status.matchAll(/<OrderActions\b/g)];
    expect(used.length).toBe(1);
    expect(status).toMatch(
      /\{(?:acts|actions)\.(?:resume|cancel)[^}]*\?\s*\(?\s*<OrderActions|\{(?:acts|actions)\.(?:resume|cancel)\s*(?:\|\||&&)[^}]*<OrderActions/s,
    );
  });

  it("OrderActions posts only to this order's checkout and cancel, from stored data, and builds no other link", () => {
    const posts = [...actions.matchAll(/postJson[^(]*\(\s*([^,]+),/g)].map((m) => m[1]!.trim());
    expect(posts.length).toBe(2);
    for (const p of posts)
      expect(p).toMatch(
        /\/api\/orders\/\$\{encodeURIComponent\([a-z.]*order_ref\)\}\/(?:checkout|cancel)/,
      );
    expect(actions).not.toMatch(/<a\s|<Link\b|href=/);
    expect(actions).not.toMatch(/dangerouslySetInnerHTML|style=\{/);
  });

  it('the cancel is a button with existing classes, and the page says what it does in plain words', () => {
    expect(actions).toMatch(/<button[^>]*className="btn"[^>]*>/);
    expect(actions).toMatch(/btn btn-primary/);
    expect(actions).not.toMatch(/[‒-―]|<em>|<i>|font-style/);
  });
});
