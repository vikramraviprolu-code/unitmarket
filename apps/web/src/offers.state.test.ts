// PUB-B state (docs/specs/pub-b-offer-revise-withdraw.md): through a booted offline app. A publisher
// revises or withdraws its own offer over the routes; a buyer who already approved keeps the price they
// saw; a new quote shows the new price; the demo prices (decision 37) apply at boot and only when asked
// for in tests. The pages are .tsx files the unit runner does not compile, so their source is read as text.
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  bootOffersWorld,
  both,
  FERRY,
  FEES,
  postRevise,
  postWithdraw,
  QUAY,
  TIDE,
} from './offers-support';
import type { OffersWebWorld } from './offers-support';

vi.mock('server-only', () => ({}));

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8');

let w: OffersWebWorld;
beforeAll(async () => {
  w = await bootOffersWorld();
});
afterAll(async () => {
  await w.app.close();
});
beforeEach(async () => {
  await w.app.db.query('DELETE FROM rate_buckets');
});

const harbour = () => w.pub['harbour-ledger'];
const quote = async (who: 'A' | 'B', offer_code: string, option: 'keep_retrieve' | 'online_read') =>
  w.app.engine.quote({
    offer: { publisher_slug: 'harbour-ledger', offer_code },
    actor: who === 'A' ? w.refund.actorA : w.refund.actorB,
    source: 'direct',
    option,
  });
const priceNow = async (id: string) =>
  (
    await w.app.db.query<{ options: { option: string; price_minor: number }[] }>(
      `SELECT options FROM offers WHERE id = $1
        ORDER BY created_at DESC, NULLIF(regexp_replace(version, '[^0-9]', '', 'g'), '')::numeric DESC LIMIT 1`,
      [id],
    )
  ).rows[0]!.options.map((o) => `${o.option}=${String(o.price_minor)}`);

describe('the engine view', () => {
  it('lists a publisher own offers with prices, the dry run label and the cap', async () => {
    const v = (await w.app.engine.offers.list(w.actor['harbour-ledger']))!;
    expect(v.environment).toBe('dryrun');
    expect(v.offer_max_minor).toBe(2000);
    const tide = v.offers.find((o) => o.offer_id === TIDE)!;
    expect(tide.status).toBe('authorised');
    expect(tide.options.map((o) => o.price_minor)).toEqual([40, 40]);
    expect(v.offers.some((o) => o.offer_id === QUAY)).toBe(false);
  });

  it('buyers, operators and the system get nothing', async () => {
    expect(await w.app.engine.offers.list(w.refund.actorA)).toBeNull();
    expect(await w.app.engine.offers.list({ kind: 'system' })).toBeNull();
    expect(
      await w.app.engine.offers.list({ kind: 'operator', operator_id: 'opr_x', mfa: true }),
    ).toBeNull();
    expect(await w.app.engine.offers.get(w.refund.actorA, TIDE)).toBeNull();
  });

  it('the detail has the licence, terms, version history and the cap; another publisher id is null', async () => {
    const d = (await w.app.engine.offers.get(w.actor['harbour-ledger'], FERRY))!;
    expect(d.offer_id).toBe(FERRY);
    expect(d.terms_version).toBe('terms-1');
    expect(d.rights.scope).toBe('personal_use');
    expect(d.history.length).toBeGreaterThanOrEqual(1);
    expect(d.environment).toBe('dryrun');
    expect(await w.app.engine.offers.get(w.actor['quayside-gazette'], FERRY)).toBeNull();
  });
});

describe('the routes', () => {
  it('revise answers 200 with the new version and the engine shows the new price', async () => {
    const res = await postRevise(w, harbour(), {
      offer_id: FEES,
      expected_version: '1',
      options: both(310, 260),
      attestation: true,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ offer_id: FEES, version: '2' });
    expect(await priceNow(FEES)).toEqual(['keep_retrieve=310', 'online_read=260']);
  });

  it('a stale version is 409, a bad price is 422, an offer of someone else is 404', async () => {
    const stale = await postRevise(w, harbour(), {
      offer_id: FEES,
      expected_version: '1',
      options: both(100, 100),
      attestation: true,
    });
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as { error: { code: string } }).error.code).toBe('conflict');
    const bad = await postRevise(w, harbour(), {
      offer_id: FEES,
      expected_version: '2',
      options: both(100, 2001),
      attestation: true,
    });
    expect(bad.status).toBe(422);
    const other = await postRevise(w, harbour(), {
      offer_id: QUAY,
      expected_version: '1',
      options: both(100, 100),
      attestation: true,
    });
    expect(other.status).toBe(404);
  });

  it('needs a publisher session and the CSRF token', async () => {
    const body = {
      offer_id: FEES,
      expected_version: '2',
      options: both(100, 100),
      attestation: true,
    };
    expect((await postRevise(w, null, body)).status).toBe(401);
    expect((await postRevise(w, w.refund.A, body)).status).toBe(403);
    expect((await postRevise(w, w.refund.op, body)).status).toBe(403);
    expect((await postRevise(w, harbour(), body, { csrf: false })).status).toBe(403);
    expect(
      (await postWithdraw(w, null, { offer_id: FEES, expected_version: '2', reason: 'Nope.' }))
        .status,
    ).toBe(401);
    expect(
      (
        await postWithdraw(w, w.refund.A, {
          offer_id: FEES,
          expected_version: '2',
          reason: 'Nope.',
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await postWithdraw(
          w,
          harbour(),
          { offer_id: FEES, expected_version: '2', reason: 'Nope.' },
          { csrf: false },
        )
      ).status,
    ).toBe(403);
    expect(await priceNow(FEES)).toEqual(['keep_retrieve=310', 'online_read=260']);
  });

  it('is limited to 20 writes a minute per publisher', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 22; i += 1) {
      statuses.push(
        (
          await postRevise(w, w.pub['northfield-quarterly'], {
            offer_id: 'ofr_northfield-quarterly_nothing',
            expected_version: '1',
            options: both(100, 100),
            attestation: true,
          })
        ).status,
      );
    }
    expect(statuses.slice(0, 20).every((s) => s === 404)).toBe(true);
    expect(statuses.slice(20)).toEqual([429, 429]);
  });
});

describe('a buyer who already approved keeps the price they saw (money path)', () => {
  it('an approval made before a revise still charges the frozen price; a new quote shows the new one', async () => {
    const q = await quote('A', 'tide-tables', 'online_read');
    if (!q.ok || q.value.kind !== 'quote') throw new Error('no quote');
    expect(q.value.price.minor).toBe(40);
    const g = await w.app.engine.requestApproval({
      actor: w.refund.actorA,
      selection: { kind: 'quote', quote_id: q.value.quote_id },
      consent: { terms: true, identity_share: false },
    });
    if (!g.ok) throw new Error(`no approval: ${g.error.code}`);

    const res = await postRevise(w, harbour(), {
      offer_id: TIDE,
      expected_version: '1',
      options: both(180, 175),
      attestation: true,
    });
    expect(res.status).toBe(200);
    expect(await priceNow(TIDE)).toEqual(['keep_retrieve=180', 'online_read=175']);

    const placed = await w.app.engine.payments.placeOrder({
      approval_id: g.value.approval_id,
      token: g.value.token,
      actor: w.refund.actorA,
    });
    if (!placed.ok) throw new Error(`place: ${JSON.stringify(placed.error)}`);
    const unit = (
      await w.app.db.query<{ amount_minor: string | number; offer_version: string | null }>(
        'SELECT u.amount_minor FROM order_units u WHERE u.order_id = $1',
        [placed.value.order_id],
      )
    ).rows;
    expect(unit.map((u) => Number(u.amount_minor))).toEqual([40]);
    const snap = (
      await w.app.db.query<{ snapshot: unknown }>('SELECT snapshot FROM approvals WHERE id = $1', [
        g.value.approval_id,
      ])
    ).rows[0]!.snapshot;
    expect(JSON.stringify(snap)).toContain('"amount_minor":40');
    expect(JSON.stringify(snap)).toContain('"offer_version":"1"');

    // A new quote, after the revise, shows the new price and the new version.
    const q2 = await quote('B', 'tide-tables', 'online_read');
    if (!q2.ok || q2.value.kind !== 'quote') throw new Error('no second quote');
    expect(q2.value.price.minor).toBe(175);
    expect(q2.value.offer_version).toBe('2');
  });

  it('a quote taken before a revise but not yet approved is refused as changed, not charged at the old price', async () => {
    const q = await quote('B', 'ferry-timetables', 'keep_retrieve');
    if (!q.ok || q.value.kind !== 'quote') throw new Error('no quote');
    expect(q.value.price.minor).toBe(125);
    const res = await postRevise(w, harbour(), {
      offer_id: FERRY,
      expected_version: '1',
      options: both(150, 150),
      attestation: true,
    });
    expect(res.status).toBe(200);
    const g = await w.app.engine.requestApproval({
      actor: w.refund.actorB,
      selection: { kind: 'quote', quote_id: q.value.quote_id },
      consent: { terms: true, identity_share: false },
    });
    expect(g.ok).toBe(false);
    if (!g.ok) expect(g.error).toMatchObject({ code: 'offer_changed' });
  });
});

describe('withdraw', () => {
  it('a new buyer gets no match with the reason withdrawn', async () => {
    const res = await postWithdraw(w, harbour(), {
      offer_id: FEES,
      expected_version: '2',
      reason: 'Pulled for a rewrite.',
    });
    expect(res.status).toBe(200);
    const q = await quote('A', 'harbour-fees', 'keep_retrieve');
    if (!q.ok) throw new Error('quote errored');
    expect(q.value.kind).toBe('no_match');
    if (q.value.kind === 'no_match') expect(q.value.reason).toBe('withdrawn');
    const again = await postWithdraw(w, harbour(), {
      offer_id: FEES,
      expected_version: '3',
      reason: 'Again, for no reason.',
    });
    expect(again.status).toBe(409);
  });
});

describe('demo prices at boot (decision 37)', () => {
  it('stay off in tests unless asked for, so the seed prices hold', async () => {
    const n = await w.app.db.query<{ c: string }>(
      "SELECT count(*) AS c FROM audit_log WHERE reason = 'seed: demo prices (decision 37)'",
    );
    expect(Number(n.rows[0]!.c)).toBe(0);
  });

  it('when asked for, the offers read 1.00 to 2.50 and the quote shows it', async () => {
    const d = await bootOffersWorld({ demo_prices: true });
    try {
      const v = (await d.app.engine.offers.list(d.actor['harbour-ledger']))!;
      const all = v.offers
        .filter((o) => o.currency === 'USD' && o.status === 'authorised')
        .flatMap((o) => o.options.map((x) => x.price_minor));
      expect(all.length).toBeGreaterThan(0);
      expect(Math.min(...all)).toBeGreaterThanOrEqual(100);
      expect(Math.max(...all)).toBeLessThanOrEqual(250);
      const q = await d.app.engine.quote({
        offer: { publisher_slug: 'harbour-ledger', offer_code: 'tide-tables' },
        actor: d.refund.actorA,
        source: 'direct',
        option: 'online_read',
      });
      if (!q.ok || q.value.kind !== 'quote') throw new Error('no quote');
      expect(q.value.price.minor).toBe(100);
      const rows = await d.app.db.query<{ c: string }>(
        "SELECT count(*) AS c FROM offers WHERE id = 'ofr_harbour-ledger_tide-tables'",
      );
      expect(Number(rows.rows[0]!.c)).toBe(2);
    } finally {
      await d.app.close();
    }
  });
});

describe('the pages (source text)', () => {
  const s2 = read('./app/publisher/offers/page.tsx');
  const s3 = read('./app/publisher/offers/[id]/page.tsx');
  const form = read('./app/publisher/offers/[id]/OfferForm.tsx');

  it('S2 reads the session actor and the engine, takes its words from the copy file, has no inline style', () => {
    expect(s2).toContain('currentActor');
    expect(s2).toContain("actor?.kind !== 'publisher'");
    expect(s2).toContain('offer-copy');
    expect(s2).toContain('engine.offers.list');
    expect(s2).toContain('EnvLabel');
    expect(s2).not.toMatch(/style=/);
    expect(s2).not.toMatch(/searchParams|publisher_id/);
  });

  it('S3 reads only the offer id from the address and asks the engine as the session actor', () => {
    expect(s3).toContain('currentActor');
    expect(s3).toContain("actor?.kind !== 'publisher'");
    expect(s3).toContain('engine.offers.get(actor');
    expect(s3).toContain('notFound');
    expect(s3).toContain('offer-copy');
    expect(s3).toContain('EnvLabel');
    expect(s3).not.toMatch(/style=/);
    expect(s3).not.toMatch(/searchParams/);
  });

  it('S3 shows the read only facts, the freeze note and the version history', () => {
    for (const name of [
      'FREEZE_NOTE',
      'WINDOW_VALUE',
      'licenceText',
      'LABEL_TERMS',
      'HISTORY_HEADING',
    ])
      expect(s3, name).toContain(name);
  });

  it('the form posts to the two routes, sends no currency or publisher id and has no inline style', () => {
    expect(form).toContain("'/api/publisher/offers/revise'");
    expect(form).toContain("'/api/publisher/offers/withdraw'");
    expect(form).toContain('expected_version');
    expect(form).toContain('attestation');
    expect(form).not.toMatch(/style=/);
    expect(form).not.toMatch(/currency|publisher_id/);
  });
});
