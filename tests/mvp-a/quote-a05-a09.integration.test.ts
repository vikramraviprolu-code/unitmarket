// MVP-A acceptance A-05 to A-09: quote within the buyer's ceiling, no universal floor, permissioned
// renegotiation, frozen approval snapshot, mixed currency refused. Expected results are the text of
// docs/design/mvp-plan.md. Offline only; a fake clock drives the 15 minute windows.
import { requestApproval } from '@umsbx/approval';
import { placeOrder } from '@umsbx/payments';
import { startFromOffer } from '@umsbx/offer-entry';
import { describe, expect, it } from 'vitest';
import {
  BUYER_A,
  BUYER_B,
  CONSENT,
  HARBOUR,
  approvalFor,
  makeWorld,
  offerRef,
  one,
  quoteFor,
} from './world';

const MIN15 = 15 * 60_000;

describe('A-05 offer_quote_within_ceiling', () => {
  it('an authorised offer under the ceiling gives a scoped quote valid 15 minutes', async () => {
    const w = await makeWorld();
    const now = w.td.clock.now().getTime();
    const q = await quoteFor(w, BUYER_A, 'tide-tables', { ceiling_minor: 500 });
    expect(q.kind).toBe('quote');
    expect(q.price).toEqual({ currency: 'USD', minor: 40 });
    expect(Date.parse(q.expires_at) - now).toBe(MIN15);
  });

  it('a ceiling below the price is no_match above_ceiling and no other offer is proposed', async () => {
    const w = await makeWorld();
    const r = await startFromOffer(w.deps, {
      offer: offerRef(HARBOUR, 'ferry-timetables'),
      actor: BUYER_A,
      source: 'direct',
      option: 'keep_retrieve',
      ceiling_minor: 100,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toEqual({ kind: 'no_match', reason: 'above_ceiling' });
    }
    // No substitution: nothing else was quoted for this buyer.
    expect(Number((await one<{ c: string }>(w, 'SELECT count(*) AS c FROM quotes')).c)).toBe(0);
  });
});

describe('A-06 no_universal_floor', () => {
  it('a publisher price of 0.40 USD is quoted as 0.40 USD', async () => {
    const w = await makeWorld();
    const q = await quoteFor(w, BUYER_A, 'tide-tables');
    expect(q.price).toEqual({ currency: 'USD', minor: 40 });
    const g = await approvalFor(w, BUYER_A, 'tide-tables');
    expect(g.snapshot.total_minor).toBe(40);
  });
});

describe('A-07 renegotiation_permissioned', () => {
  it('an offer without renegotiation: a lower proposal is no_match', async () => {
    const w = await makeWorld();
    const r = await startFromOffer(w.deps, {
      offer: offerRef(HARBOUR, 'ferry-timetables'),
      actor: BUYER_A,
      source: 'direct',
      option: 'keep_retrieve',
      proposed_minor: 100,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.kind).toBe('no_match');
  });

  it('an offer with floor 2.00: 2.50 is accepted at 2.50', async () => {
    const w = await makeWorld();
    const q = await quoteFor(w, BUYER_A, 'harbour-fees', { proposed_minor: 250 });
    expect(q.price.minor).toBe(250);
  });

  it('an offer with floor 2.00: 1.90 is below_publisher_floor', async () => {
    const w = await makeWorld();
    const r = await startFromOffer(w.deps, {
      offer: offerRef(HARBOUR, 'harbour-fees'),
      actor: BUYER_A,
      source: 'direct',
      option: 'keep_retrieve',
      proposed_minor: 190,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ kind: 'no_match', reason: 'below_publisher_floor' });
  });
});

describe('A-08 snapshot_frozen', () => {
  it('the snapshot holds offer id and version, terms version, payee, amount, currency, rights, access policy and version, reader id, rule version', async () => {
    const w = await makeWorld();
    const g = await approvalFor(w, BUYER_A, 'tide-tables');
    const text = JSON.stringify(g.snapshot);
    const q = await one<{ offer_id: string; offer_version: string }>(
      w,
      'SELECT offer_id, offer_version FROM quotes LIMIT 1',
    );
    const payee = await one<{ paypal_merchant_id: string }>(
      w,
      'SELECT paypal_merchant_id FROM publishers WHERE slug = $1',
      [HARBOUR],
    );
    for (const needle of [
      q.offer_id,
      q.offer_version,
      'terms-1',
      payee.paypal_merchant_id,
      'USD',
      'personal_use',
      'keep_retrieve',
      'buy_A',
      'rules-test',
    ]) {
      expect(text, `snapshot misses ${needle}`).toContain(needle);
    }
    expect(g.snapshot.total_minor).toBe(40);
  });

  it('the publisher changes the price after approval: the order uses the frozen price', async () => {
    const w = await makeWorld();
    const g = await approvalFor(w, BUYER_A, 'tide-tables');
    const changed = await w.td.db.query(
      `UPDATE offers SET options = jsonb_set(options, '{0,price_minor}', '9900'::jsonb) WHERE id LIKE '%tide-tables' RETURNING id`,
    );
    expect(changed.rows).toHaveLength(1);
    const placed = await placeOrder(w.deps, {
      approval_id: g.approval_id,
      token: g.token,
      actor: BUYER_A,
    });
    expect(placed.ok).toBe(true);
    const o = await one<{ total_minor: string | number }>(
      w,
      'SELECT total_minor FROM orders LIMIT 1',
    );
    expect(Number(o.total_minor)).toBe(40);
  });

  it('a tampered token is refused 403', async () => {
    const w = await makeWorld();
    const g = await approvalFor(w, BUYER_A, 'tide-tables');
    const bad = `${g.token.slice(0, -2)}${g.token.endsWith('aa') ? 'bb' : 'aa'}`;
    const r = await placeOrder(w.deps, { approval_id: g.approval_id, token: bad, actor: BUYER_A });
    expect(r.ok).toBe(false);
    if (!r.ok && r.error.code === 'approval') expect(r.error.error.http).toBe(403);
    else throw new Error(`unexpected ${JSON.stringify(r)}`);
  });

  it('after 15 minutes the approval is 410, and expires_at is exactly created_at plus 15 minutes', async () => {
    const w = await makeWorld();
    const g = await approvalFor(w, BUYER_A, 'tide-tables');
    const row = await one<{ created_at: Date; expires_at: Date }>(
      w,
      'SELECT created_at, expires_at FROM approvals WHERE id = $1',
      [g.approval_id],
    );
    expect(new Date(row.expires_at).getTime() - new Date(row.created_at).getTime()).toBe(MIN15);
    w.td.clock.advance(MIN15 + 1000);
    const r = await placeOrder(w.deps, {
      approval_id: g.approval_id,
      token: g.token,
      actor: BUYER_A,
    });
    expect(r.ok).toBe(false);
    if (!r.ok && r.error.code === 'approval') expect(r.error.error.http).toBe(410);
    else throw new Error(`unexpected ${JSON.stringify(r)}`);
  });

  it('reusing an approval is 409', async () => {
    const w = await makeWorld();
    const g = await approvalFor(w, BUYER_A, 'tide-tables');
    const first = await placeOrder(w.deps, {
      approval_id: g.approval_id,
      token: g.token,
      actor: BUYER_A,
    });
    expect(first.ok).toBe(true);
    const again = await placeOrder(w.deps, {
      approval_id: g.approval_id,
      token: g.token,
      actor: BUYER_A,
    });
    expect(again.ok).toBe(false);
    if (!again.ok) {
      const http = again.error.code === 'approval' ? again.error.error.http : again.error.http;
      expect(http).toBe(409);
    }
  });

  it("buyer B cannot place buyer A's approval (404)", async () => {
    const w = await makeWorld();
    const g = await approvalFor(w, BUYER_A, 'tide-tables');
    const r = await placeOrder(w.deps, {
      approval_id: g.approval_id,
      token: g.token,
      actor: BUYER_B,
    });
    expect(r.ok).toBe(false);
    if (!r.ok && r.error.code === 'approval') expect(r.error.error.http).toBe(404);
    else throw new Error(`unexpected ${JSON.stringify(r)}`);
  });
});

describe('A-09 mixed_currency_rejected', () => {
  it('a selection with USD and GBP items is refused before approval with mixed_currency', async () => {
    const w = await makeWorld();
    const usd = await quoteFor(w, BUYER_A, 'tide-tables');
    const gbpOffer = await one<{ id: string; version: string }>(
      w,
      `SELECT id, terms_version AS version FROM offers WHERE currency = 'GBP' AND status = 'authorised' LIMIT 1`,
    );
    const now = w.td.clock.now().toISOString();
    await w.td.db.query(
      `INSERT INTO quotes (id, buyer_id, offer_id, offer_version, option, price_minor, currency, corridor_id, source, expires_at, created_at, updated_at)
       SELECT 'quo_gbp', buyer_id, $1, offer_version, option, 150, 'GBP', 'gb-gbp', source, expires_at, $2, $2
         FROM quotes WHERE id = $3`,
      [gbpOffer.id, now, usd.quote_id],
    );
    await w.td.db.query(
      `INSERT INTO briefs (id, buyer_id, raw_text, structured, version, confirmed_at, created_at, updated_at)
       VALUES ('brf_mix', 'buy_A', 'need', '{}'::jsonb, '1', $1, $1, $1)`,
      [now],
    );
    await w.td.db.query(
      `INSERT INTO proposals (id, brief_id, buyer_id, items, fit, created_at, updated_at)
       VALUES ('prp_mix', 'brf_mix', 'buy_A', $1::jsonb, '[]'::jsonb, $2, $2)`,
      [
        JSON.stringify([
          {
            quote: { quote_id: usd.quote_id, offer_id: usd.offer_id },
            fit: null,
            title: 't',
            publisher: 'p',
          },
          {
            quote: { quote_id: 'quo_gbp', offer_id: gbpOffer.id },
            fit: null,
            title: 't',
            publisher: 'p',
          },
        ]),
        now,
      ],
    );
    const r = await requestApproval(w.deps, {
      actor: BUYER_A,
      selection: {
        kind: 'proposal',
        proposal_id: 'prp_mix',
        offer_ids: [usd.offer_id, gbpOffer.id],
      },
      consent: CONSENT,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('mixed_currency');
    expect(Number((await one<{ c: string }>(w, 'SELECT count(*) AS c FROM approvals')).c)).toBe(0);
  });
});
