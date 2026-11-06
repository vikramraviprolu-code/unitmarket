// POB-W (D-089): the publisher journey J1 to J14 walked end to end on one offline app, with no browser. A fake
// clock, a scripted web (AppOptions.test_import_fetcher, no socket), the dry run payment model and the in-process
// database. Steps share state in order: the walk is sequential on purpose. Every step asserts the real
// observable result of the engine method for that step. Where a lane has a gap the step is left to fail with the
// assertion the spec needs; nothing here stubs around product code. Passwords, codes and addresses are fictional.
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Actor } from '@umsbx/contracts';
import { createApp, installApp, searchOffers } from '../composition.server';
import type { App, OfferPage } from '../composition.server';
import {
  SHOP,
  SHOP_HOST,
  SOURCE_URL,
  fakeWeb,
  homeWithToken,
  shopPages,
} from './web-import-support';
import type { FakeWeb } from './web-import-support';
import { testEnv } from './support';

vi.mock('server-only', () => ({}));
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const NOW = Date.parse('2026-11-05T12:00:00.000Z');
const DAY = 86_400_000;
const OPERATOR: Actor = { kind: 'operator', operator_id: 'opr_vikram', mfa: true };
const PW = 'violet lamps hum softly';
const USERNAME = 'lantern.press';
const PAYPAL_EMAIL = 'payments@lantern-press.example';
const CODE = /^[0-9A-HJKMNP-TV-Z]{12}$/;

const data = (name: string): string =>
  readFileSync(new URL(`../../../domain/catalogue/test-data/${name}`, import.meta.url), 'utf8');

let app: App;
let web: FakeWeb;

// The walk's shared state, filled step by step.
const w = {
  reference: '',
  publisher_id: '',
  slug: '',
  code: '',
  publisher: { kind: 'publisher', publisher_id: '' } as Actor,
  batch_id: '',
  published: [] as { title: string; seller_minor: number }[],
  offer: null as OfferPage | null,
  buyer: { kind: 'buyer', buyer_id: '' } as Actor,
  sale: null as {
    unit_id: string;
    order_id: string;
    amount_minor: number;
    currency: string;
  } | null,
  seller_minor: 0,
  fee_minor: 0,
};

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  web = fakeWeb(shopPages(data));
  app = createApp(await testEnv(), { switch_cache_ms: 0, test_import_fetcher: web });
  installApp(app);
  await app.ready();
  const b = await app.db.query<{ id: string }>(
    `SELECT id FROM buyers WHERE auth_subject = 'persona:buyer-a'`,
  );
  w.buyer = { kind: 'buyer', buyer_id: b.rows[0]!.id };
});
afterAll(async () => {
  await app.close();
  vi.useRealTimers();
});

const q = async <T>(sql: string, p: unknown[] = []): Promise<T[]> =>
  (await app.db.query<T>(sql, p)).rows;
const must = <T, E>(r: { ok: true; value: T } | { ok: false; error: E }): T => {
  if (!r.ok) throw new Error(`refused: ${JSON.stringify(r.error)}`);
  return r.value;
};

/** A buyer's whole payment of one offer over the dry run order model. Returns the unit. */
async function buy(offer: OfferPage, who: Actor): Promise<NonNullable<typeof w.sale>> {
  const option = offer.options[0]!;
  const quote = await app.engine.quote({
    offer: { publisher_slug: offer.publisher_slug, offer_code: offer.offer_code },
    actor: who,
    source: 'direct',
    option: option.option,
  });
  if (!quote.ok || quote.value.kind !== 'quote')
    throw new Error(`no quote: ${JSON.stringify(quote)}`);
  const approval = await app.engine.requestApproval({
    actor: who,
    selection: { kind: 'quote', quote_id: quote.value.quote_id },
    consent: { terms: true, identity_share: false },
  });
  if (!approval.ok) throw new Error(`no approval: ${approval.error.code}`);
  const placed = await app.engine.payments.placeOrder({
    approval_id: approval.value.approval_id,
    token: approval.value.token,
    actor: who,
  });
  if (!placed.ok) throw new Error(`place: ${JSON.stringify(placed.error)}`);
  const co = await app.engine.payments.beginCheckout({
    order_id: placed.value.order_id,
    actor: who,
  });
  if (!co.ok) throw new Error(`checkout: ${co.error.code}`);
  const approved = await app.engine.dryRunApprove({
    order_ref: placed.value.order_ref,
    actor: who,
    scenario: 'happy',
  });
  if (!approved) throw new Error('dry run approve refused');
  await app.engine.payments.onBuyerReturn({
    order_ref: placed.value.order_ref,
    actor: who,
    scenario: 'happy',
  });
  const u = (
    await q<{ id: string; amount_minor: string | number; currency: string }>(
      `SELECT u.id, u.amount_minor, o.currency FROM order_units u JOIN orders o ON o.id = u.order_id
        WHERE u.order_id = $1`,
      [placed.value.order_id],
    )
  )[0]!;
  return {
    unit_id: u.id,
    order_id: placed.value.order_id,
    amount_minor: Number(u.amount_minor),
    currency: u.currency,
  };
}

const ledger = (unit_id: string) =>
  q<{ kind: string; amount_minor: string | number }>(
    'SELECT kind, amount_minor FROM ledger_entries WHERE unit_id = $1 ORDER BY created_at, id',
    [unit_id],
  );
const sumOf = (rows: { kind: string; amount_minor: string | number }[], kind: string): number =>
  rows.filter((r) => r.kind === kind).reduce((s, r) => s + Number(r.amount_minor), 0);

describe('publisher journey J1 to J14 (dry run)', () => {
  it('J1 apply: a publisher applies on the public form and an operator sees the applicant waiting', async () => {
    const res = await app.engine.applyToPublish({
      display_name: 'Lantern Press',
      country: 'US',
      note: 'We publish short harbour guides and prints.',
      trap: '',
      ip_hash: 'pob-w-ip-hash-1',
      ip_known: true,
    });
    if (!res.ok) throw new Error(`apply refused: ${res.code}`);
    w.reference = res.reference;
    expect(await app.engine.applicationStatus({ ref: w.reference })).toBe('pending');
    const list = must(await app.engine.opsApplicants.list(OPERATOR));
    const mine = list.applicants.find((a) => a.display_name === 'Lantern Press');
    expect(mine).toBeDefined();
    expect(mine).toMatchObject({ state: 'pending', country: 'US', source: 'public' });
    w.publisher_id = mine!.publisher_id;
    w.slug = mine!.slug;
    w.publisher = { kind: 'publisher', publisher_id: w.publisher_id };
  });

  it('J2 approve: the operator approves and is shown a one time invite code, once', async () => {
    const decided = must(
      await app.engine.opsApplicants.decide({
        actor: OPERATOR,
        publisher_id: w.publisher_id,
        decision: 'approve',
        reason: 'Checked the shop in a call',
      }),
    );
    expect(decided.state).toBe('active');
    expect(decided.invite?.code).toMatch(CODE);
    expect(Date.parse(decided.invite!.expires_at)).toBe(NOW + 7 * DAY);
    w.code = decided.invite!.code;
    expect(await app.engine.applicationStatus({ ref: w.reference })).toBe('approved');
    // no second read shows the code: the access list, the stored invite and the audit log hold only a hash
    const access = must(await app.engine.opsPublisherAccess.list(OPERATOR));
    expect(access.rows.find((r) => r.publisher_id === w.publisher_id)?.invite).toBe('live');
    expect(JSON.stringify(access)).not.toContain(w.code);
    expect(JSON.stringify(await q('SELECT * FROM publisher_invites'))).not.toContain(w.code);
    expect(JSON.stringify(await q('SELECT * FROM audit_log'))).not.toContain(w.code);
    // deciding again is refused and shows no code
    const again = await app.engine.opsApplicants.decide({
      actor: OPERATOR,
      publisher_id: w.publisher_id,
      decision: 'approve',
      reason: 'Checked the shop in a call',
    });
    expect(again.ok).toBe(false);
    expect(JSON.stringify(again)).not.toContain(w.code);
  });

  it('J3 claim: the code, a username and a password make the account; the code works once', async () => {
    const claimed = await app.engine.publisherAccounts.claim({
      code: w.code,
      username: USERNAME,
      password: PW,
      ip_hash: 'pob-w-ip-hash-2',
      ip_known: true,
      previous: null,
    });
    expect(claimed.ok).toBe(true);
    const rows = await q<{ username: string }>(
      'SELECT username FROM publisher_accounts WHERE publisher_id = $1',
      [w.publisher_id],
    );
    expect(rows).toEqual([{ username: USERNAME }]);
    const reused = await app.engine.publisherAccounts.claim({
      code: w.code,
      username: 'second.try',
      password: PW,
      ip_hash: 'pob-w-ip-hash-3',
      ip_known: true,
      previous: null,
    });
    expect(reused).toEqual({ ok: false, code: 'invalid_code' });
  });

  it('J4 sign in: the username and password resolve to the publisher; a wrong password does not', async () => {
    const bad = await app.engine.publisherAccounts.signIn({
      username: USERNAME,
      password: 'wrong horse battery staple',
      previous: null,
    });
    expect(bad).toBeNull();
    const ok = await app.engine.publisherAccounts.signIn({
      username: USERNAME,
      password: PW,
      previous: null,
    });
    expect(ok).not.toBeNull();
    expect(ok!.actor).toEqual({ kind: 'publisher', publisher_id: w.publisher_id });
    expect(ok!.cookie).toBeTruthy();
    expect(ok!.csrf_token).toBeTruthy();
  });

  it('J5 terms: the publisher accepts the publisher terms with a real action', async () => {
    const before = await app.engine.publisherAccounts.view(w.publisher);
    expect(before).toMatchObject({ username: USERNAME, agreement: null });
    const accepted = must(await app.engine.publisherAccounts.acceptTerms(w.publisher));
    expect(accepted.terms_version).toBe(before!.terms_version);
    const after = await app.engine.publisherAccounts.view(w.publisher);
    expect(after!.agreement).toMatchObject({
      publisher_id: w.publisher_id,
      method: 'publisher_accepted',
      terms_version: before!.terms_version,
      accepted_by_label: USERNAME,
    });
    expect(await app.engine.publisherAgreement(w.publisher)).toMatchObject({
      method: 'publisher_accepted',
    });
  });

  it('J6 link PayPal: the publisher links their own address and an operator verifies it', async () => {
    const requested = must(
      await app.engine.publisherAccounts.requestLink({ actor: w.publisher, email: PAYPAL_EMAIL }),
    );
    expect(requested.state).toBe('requested');
    expect((await app.engine.publisherAccounts.view(w.publisher))!.link).toMatchObject({
      email: PAYPAL_EMAIL,
      state: 'requested',
    });
    // a wrong retype is refused, the right one verifies
    const wrong = await app.engine.opsPublisherAccess.decideLink({
      actor: OPERATOR,
      publisher_id: w.publisher_id,
      email_retyped: 'someone.else@lantern-press.example',
      reason: 'Checked the address with the publisher',
    });
    expect(wrong.ok).toBe(false);
    const verified = must(
      await app.engine.opsPublisherAccess.decideLink({
        actor: OPERATOR,
        publisher_id: w.publisher_id,
        email_retyped: PAYPAL_EMAIL,
        reason: 'Checked the address with the publisher',
      }),
    );
    expect(verified.state).toBe('verified');
    const link = (await app.engine.publisherAccounts.view(w.publisher))!.link;
    expect(link).toMatchObject({ email: PAYPAL_EMAIL, state: 'verified' });
    expect(link!.verified_at).not.toBeNull();
  });

  it('J7 add a web source: the publisher proves the domain through the scripted web and starts an import', async () => {
    const asked = must(
      await app.engine.webImport.addDomain({ actor: w.publisher, host: SHOP_HOST }),
    );
    expect(asked).toMatchObject({ host: SHOP_HOST, state: 'pending' });
    expect(asked.token).toMatch(/^umv-[0-9a-f]{32}$/);
    // not verified yet: the token is not on the page
    const early = await app.engine.webImport.checkDomain({ actor: w.publisher, host: SHOP_HOST });
    expect(early.ok).toBe(false);
    web.pages[`${SHOP}/`] = { body: homeWithToken(asked.token!) };
    const checked = must(
      await app.engine.webImport.checkDomain({ actor: w.publisher, host: SHOP_HOST }),
    );
    expect(checked).toEqual({ host: SHOP_HOST, state: 'verified' });
    const begun = must(
      await app.engine.webImport.begin({ actor: w.publisher, source_url: SOURCE_URL }),
    );
    w.batch_id = begun.batch_id;
    expect(await app.engine.webImport.runPending()).toEqual({ ran: 1 });
    // only the verified host was ever asked
    for (const c of web.calls) expect(c.allow).toEqual([SHOP_HOST]);
  });

  it('J8 review: items, pictures and prices appear in a staging list; the publisher picks and edits', async () => {
    const view = await app.engine.webImport.review({ actor: w.publisher, batch_id: w.batch_id });
    expect(view).not.toBeNull();
    expect(view!.environment).toBe('dryrun');
    expect(view!.batch).toMatchObject({ state: 'done' });
    const staged = view!.items.filter((i) => i.state === 'staged');
    expect(staged.length).toBeGreaterThanOrEqual(2);
    const tides = staged.find((i) => i.source_key.endsWith('/a/tides'))!;
    const chart = staged.find((i) => i.source_key.endsWith('/p/chart'))!;
    expect(tides.price_minor).toBe(150);
    expect(chart.price_minor).toBe(450);
    // edit one price and hide one item in a single step each
    const edited = must(
      await app.engine.webImport.edit({
        actor: w.publisher,
        item_id: chart.id,
        title: 'Harbour chart print',
        price_minor: 500,
      }),
    );
    expect(edited.item).toMatchObject({ price_minor: 500, title: 'Harbour chart print' });
    const hidden = must(
      await app.engine.webImport.edit({ actor: w.publisher, item_id: tides.id, hidden: true }),
    );
    expect(hidden.item.state).toBe('hidden');
    w.published = [{ title: 'Harbour chart print', seller_minor: 500 }];
  });

  it('J9 publish: chosen items become articles and offers; the buyer price is the publisher price plus the fee', async () => {
    const chart = (await app.engine.webImport.review({
      actor: w.publisher,
      batch_id: w.batch_id,
    }))!.items.find((i) => i.source_key.endsWith('/p/chart'))!;
    // the fee in force (10 percent, seeded by the fee lane) is what the buyer price must carry
    const policy = await app.engine.feePolicy();
    const parts = policy.feeFor(500, 'USD');
    w.seller_minor = parts.seller_minor;
    w.fee_minor = parts.fee_minor;
    // act first, so a failing price assertion below does not hide the later steps of the walk
    const out = must(
      await app.engine.webImport.publish({
        actor: w.publisher,
        batch_id: w.batch_id,
        attestation: true,
        item_ids: [chart.id],
      }),
    );
    expect(out).toMatchObject({ published: 1, failed: 0, bad_price: 0 });
    const offers = (await app.engine.listOffers()).filter((o) => o.publisher_slug === w.slug);
    expect(offers).toHaveLength(1);
    w.offer = offers[0]!;
    expect(w.offer.title).toBe('Harbour chart print');
    expect(policy.fee_bps).toBe(1000);
    expect(parts).toMatchObject({ seller_minor: 500, fee_minor: 50, buyer_minor: 550 });
    // the review shows the buyer price through the fee in force, and the listed price IS that buyer price
    expect(chart.fee_minor).toBe(parts.fee_minor);
    expect(chart.buyer_price_minor).toBe(parts.buyer_minor);
    expect(w.offer.options.map((o) => o.price_minor)).toContain(parts.buyer_minor);
  });

  it('J10 buy: a buyer finds the item in browse and search, approves and pays in dry run', async () => {
    const offers = (await app.engine.listOffers()).filter((o) => o.on_sale);
    expect(offers.some((o) => o.offer_id === w.offer!.offer_id)).toBe(true);
    const found = searchOffers(
      offers.map((o) => ({
        offer_id: o.offer_id,
        title: o.title,
        abstract: o.abstract,
        publisher_slug: o.publisher_slug,
        min_price_minor: Math.min(...o.options.map((x) => x.price_minor)),
        status: 'authorised',
      })),
      { q: 'harbour chart' },
    );
    expect(found.map((f) => f.offer_id)).toContain(w.offer!.offer_id);
    w.sale = await buy(w.offer!, w.buyer);
    expect(w.sale.amount_minor).toBe(w.seller_minor + w.fee_minor);
    const unit = await q<{ status: string }>('SELECT status FROM order_units WHERE id = $1', [
      w.sale.unit_id,
    ]);
    expect(unit[0]!.status).toMatch(/paid|captured|active|granted/);
  });

  it('J11 collect: the ledger records the sale, the fee and the amount owed to the publisher', async () => {
    const rows = await ledger(w.sale!.unit_id);
    expect(sumOf(rows, 'sale')).toBe(w.seller_minor + w.fee_minor);
    expect(sumOf(rows, 'fee')).toBe(w.fee_minor);
    expect(sumOf(rows, 'payable')).toBe(w.seller_minor);
    expect(sumOf(rows, 'sale')).toBe(sumOf(rows, 'fee') + sumOf(rows, 'payable'));
    const snap = await app.engine.opsSnapshot(OPERATOR);
    expect((snap?.invariants ?? []).filter((v) => !v.ok)).toEqual([]);
  });

  it('J12 pay out: after the window a payout to the linked PayPal is created, once, in dry run', async () => {
    expect(await app.engine.runPayouts()).toMatchObject({ created: 0, sent: 0 });
    vi.setSystemTime(NOW + 3 * DAY);
    expect(await app.engine.runPayouts()).toMatchObject({ created: 0, sent: 0 });
    vi.setSystemTime(NOW + 9 * DAY);
    const counts = await app.engine.runPayouts();
    expect(counts).toMatchObject({ created: 1, sent: 1 });
    const payouts = await q<{
      state: string;
      amount_minor: string | number;
      environment: string;
      currency: string;
      payee_merchant_id: string;
      provider_ref: string | null;
    }>(
      `SELECT state, amount_minor, environment, currency, payee_merchant_id, provider_ref
         FROM payouts WHERE publisher_id = $1`,
      [w.publisher_id],
    );
    expect(payouts).toHaveLength(1);
    expect(payouts[0]).toMatchObject({
      environment: 'dryrun',
      state: 'confirmed',
      currency: 'USD',
    });
    expect(Number(payouts[0]!.amount_minor)).toBe(w.seller_minor);
    expect(payouts[0]!.provider_ref).toMatch(/^DRYRUN-/);
    // the payee is the publisher's verified PayPal link, not a stub merchant id
    expect(payouts[0]!.payee_merchant_id).toBe(PAYPAL_EMAIL);
    expect(await app.engine.runPayouts()).toMatchObject({ created: 0, sent: 0 });
  });

  it('J13 statement: the publisher sees the sale, the fee, what is owed and what was paid out', async () => {
    const st = await app.engine.publisherStatement(w.publisher);
    const block = st!.blocks.find((b) => b.currency === 'USD' && b.environment === 'dryrun')!;
    expect(block).toBeDefined();
    expect(block.sales_minor).toBe(w.seller_minor + w.fee_minor);
    expect(block.units_sold).toBe(1);
    expect(block.money).toEqual({
      fee_minor: w.fee_minor,
      owed_minor: w.seller_minor,
      paid_out_minor: w.seller_minor,
      adjustment_minor: 0,
      net_minor: 0,
    });
    const sales = await app.engine.publisherSales(w.publisher);
    expect(sales).toHaveLength(1);
    expect(sales![0]!.amount_minor).toBe(w.seller_minor + w.fee_minor);
  });

  it('J14 refund: a refund inside the window stops the payout and the ledger stays consistent', async () => {
    // a second sale, bought after the first payout, refunded in full inside its own window
    const other = await q<{ id: string }>(
      `SELECT id FROM buyers WHERE auth_subject = 'persona:buyer-b'`,
    );
    const second = await buy(w.offer!, { kind: 'buyer', buyer_id: other[0]!.id });
    const refunded = await app.engine.refund.request({
      actor: OPERATOR,
      unit_id: second.unit_id,
      amount_minor: null,
      reason: 'Buyer asked inside the window',
    });
    expect(refunded.ok).toBe(true);
    const before = await q<{ n: string }>(
      'SELECT count(*) AS n FROM payouts WHERE publisher_id = $1',
      [w.publisher_id],
    );
    // the window of the second sale ends; nothing is due for it
    vi.setSystemTime(NOW + 30 * DAY);
    await app.engine.sweep();
    const after = await app.engine.runPayouts();
    expect(after).toMatchObject({ created: 0, sent: 0 });
    const now = await q<{ n: string }>(
      'SELECT count(*) AS n FROM payouts WHERE publisher_id = $1',
      [w.publisher_id],
    );
    expect(now[0]!.n).toBe(before[0]!.n);
    const rows = await ledger(second.unit_id);
    expect(sumOf(rows, 'refund')).toBe(second.amount_minor);
    const st = await app.engine.publisherStatement(w.publisher);
    const money = st!.blocks.find(
      (b) => b.currency === 'USD' && b.environment === 'dryrun',
    )!.money!;
    expect(money.owed_minor).toBe(w.seller_minor); // only the first, paid out sale is owed
    expect(money.paid_out_minor).toBe(w.seller_minor);
    expect(money.adjustment_minor).toBe(0);
    const snap = await app.engine.opsSnapshot(OPERATOR);
    expect((snap?.invariants ?? []).filter((v) => !v.ok)).toEqual([]);
  });
});
