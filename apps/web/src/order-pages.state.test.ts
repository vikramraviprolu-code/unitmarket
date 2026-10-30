// DP-5b (M2, L3): the cancel page keeps its promises (static, scoped, with a way forward) and the
// disabled pack button points at its hint. Rendered or read as the page is; no server, no PayPal.
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { App } from '../composition.server';
import { HARBOUR_TIDE, bootPackApp, buyer, startPack } from './composite-support';
import { CANCEL_BODY, CANCEL_BODY_NO_REF, CANCEL_WINDOW_LINE } from './lib/composite-copy';
import { orderActions } from './lib/order-actions';

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8');

describe('the cancel page (M2, H1)', () => {
  // The page is a .tsx file the unit runner does not compile (the browser run in e2e renders it); its
  // source is read here. What it shows for a ref is decided by lib/cancel-view.ts (own unit test) and
  // the copy is pinned by the golden test.
  const src = read('./app/checkout/cancel/page.tsx');
  const code = src.replace(/\/\/.*$/gm, '');

  it('renders the body, the window sentence and the link from the view of the ref', () => {
    expect(code).toContain('{CANCEL_HEADING}');
    expect(code).toMatch(/cancelView\(/);
    expect(code).toMatch(/data-testid="cancel-body"[^>]*>\{[a-z.]*body\}/);
    expect(code).toMatch(/data-testid="cancel-window"[^>]*>\{[a-z.]*window_line\}/);
    expect(code).toMatch(/data-testid="cancel-back"/);
    expect(code).toMatch(/href=\{[a-z.]*back_href\}/);
    expect(code).toContain('{CANCEL_BACK_LINK}');
  });

  it('reads ref from the search params and only builds a link from the validated view', () => {
    expect(code).toMatch(/searchParams/);
    expect(code).toMatch(/q\[['"]ref['"]\]|\.ref\b/);
    // no href is built from the raw param in the page
    expect(code).not.toMatch(/checkout\/return/);
    expect(code).not.toMatch(/href=\{`/);
  });

  it('is free of API calls, database access and state changes: no server, composition or db import', () => {
    for (const m of code.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
      expect(m[1], m[0]).not.toMatch(/server|composition|@umsbx\/db|access|session/);
    }
    expect(code).not.toMatch(/getApp|app\(\)|fetch\(|cookies|headers|redirect|notFound|useEffect/);
    expect(code).not.toMatch(/'use client'/);
    const view = read('./lib/cancel-view.ts').replace(/\/\/.*$/gm, '');
    for (const m of view.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
      expect(m[1], m[0]).not.toMatch(/server|composition|@umsbx\/db|access|session/);
    }
  });

  it('claims "nothing was charged" for this payment only, and names no window length', () => {
    for (const t of [CANCEL_BODY, CANCEL_BODY_NO_REF]) {
      expect(t).toContain('Nothing was charged for this payment.');
      expect(t).not.toMatch(/Nothing was charged\./);
    }
    const all = `${CANCEL_BODY} ${CANCEL_BODY_NO_REF} ${CANCEL_WINDOW_LINE}`;
    expect(all).not.toMatch(/\d+\s*(minutes|hours|min)\b/i);
    expect(all).not.toMatch(/the other payment from the order page/);
    // No promise to approve: the order page has no approve action for a single-publisher order (see
    // the test below). The link sentence says only that the buyer can see where the order stands.
    expect(CANCEL_WINDOW_LINE).not.toMatch(/approve|window is still open/i);
    expect(src).not.toMatch(/\d+\s*(minutes|hours|min)\b/i);
  });

  it('still leads somewhere: a link to the library', () => {
    expect(src).toMatch(/href="\/library"/);
  });
});

describe('the pack button hint (L3)', () => {
  const src = read('./app/discover/DiscoverForm.tsx');

  it('the disabled "Buy selected together" button is described by its hint', () => {
    const end = src.indexOf('{BUY_SELECTED}');
    const button = src.slice(src.lastIndexOf('<button', end), end);
    expect(button).toContain('disabled={picked.length < 2}');
    expect(button).toMatch(/aria-describedby=/);
    expect(button).toContain('pack-hint');
    // the hint is the element that carries that id, and it is the sentence shown beside the button
    expect(src).toMatch(
      /id="pack-hint"[^>]*>\s*Select two or more articles to buy them together\./,
    );
  });
});

// WHY the cancel page's sentence makes no promise to approve (DP-5b, round 2). The cancel page links to
// /checkout/return, which calls onBuyerReturn and, when no payment is ready to show as a next step,
// sends the buyer to the order page. For a SINGLE-publisher order that is awaiting the buyer, the
// order page shows the status and lines only: it has no approve action and no approve link. A line
// "you can approve this payment from your order" would be false there. The sentence says only that the
// buyer can go back to see where the order stands. This test pins that fact; it changes no behaviour.
vi.mock('server-only', () => ({}));

describe('a single-publisher order awaiting the buyer offers no approve action on the order page', () => {
  let app: App;
  beforeAll(async () => {
    app = await bootPackApp();
  });
  afterAll(async () => {
    await app.close();
  });

  it('the return shows no next payment, and neither the order view nor the order page carries an approve action', async () => {
    const A = await buyer(app, 'a');
    const started = await startPack(app, A, [HARBOUR_TIDE]);
    expect(started.checkout.progress).toBeNull(); // one PayPal order: not a pack
    // What /checkout/return does for the buyer coming back from the cancel page: onBuyerReturn.
    const r = await app.engine.payments.onBuyerReturn({
      order_ref: started.order_ref,
      actor: A,
      scenario: null,
    });
    // No "Step N of M" page (that needs `next`): the return page falls through to the order page.
    expect(r.ok && r.value.next !== null).toBe(false);
    // The order page is built from this view and from OrderStatus.tsx.
    const v = (await app.engine.orderView({ order_ref: started.order_ref, actor: A }))!;
    expect(v.status).toBe('awaiting_buyer');
    expect(Object.keys(v)).not.toContain('approve_url');
    expect(JSON.stringify(v)).not.toMatch(/approve_url|checkoutnow|dry-run/i);
    const page = read('./app/orders/[ref]/OrderStatus.tsx').replace(/\/\/.*$/gm, '');
    const hrefs = [...page.matchAll(/href=(?:\{[^}]*\}|"[^"]*")/g)].map((m) => m[0]);
    expect(hrefs.length).toBeGreaterThan(0);
    for (const h of hrefs) expect(h, h).not.toMatch(/approve|checkout|dry-run|return/i);
    expect(page).not.toMatch(/<form|<button|approve_url|onClick/);
  });

  // ORDER-A (docs/specs/order-a-cancel-resume.md) amends the pin above NARROWLY. OrderStatus.tsx itself still
  // has no form, button, approve link or onClick (asserted above, unchanged). The one thing it may now do is
  // render <OrderActions> for an order that waits for its buyer. The order view is null for anyone but the
  // owner, so the viewer is always the owner. The actions come from orderActions(view), which is true for
  // awaiting_buyer alone: here for a real awaiting order; lib/order-actions.test.ts lists all ten statuses.
  it("offers resume and cancel for the viewer's awaiting order only (every other status shows none: lib/order-actions.test.ts)", async () => {
    const A = await buyer(app, 'a');
    const started = await startPack(app, A, [HARBOUR_TIDE]);
    const waiting = (await app.engine.orderView({ order_ref: started.order_ref, actor: A }))!;
    expect(waiting.status).toBe('awaiting_buyer');
    expect(orderActions(waiting)).toEqual({ resume: true, cancel: true });
    // the other buyer cannot even see the order, so the page cannot render actions for it
    const B = await buyer(app, 'b');
    expect(await app.engine.orderView({ order_ref: started.order_ref, actor: B })).toBeNull();
    const page = read('./app/orders/[ref]/OrderStatus.tsx').replace(/\/\/.*$/gm, '');
    expect([...page.matchAll(/<OrderActions\b/g)].length).toBe(1);
    expect(page).toMatch(/orderActions\(view\)/);
  });
});
