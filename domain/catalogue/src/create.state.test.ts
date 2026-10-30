// PUB-E1 (docs/specs/pub-e1-publisher-should.md, item 4): a publisher puts an own article that has no
// live offer on sale. Version 1, one authorisation row with the attestation, one audit row, the 0012
// article freeze still holds. Migrated in-memory database, fake clock.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PUB_ATTEST_1,
  createOffer,
  getOffer,
  listAuthorisedOffers,
  listOfferableArticles,
  listOwnOffers,
  reviseOffer,
  withdrawOffer,
} from './index';
import { CAP, addArticle, count, offersWorld, prices, versionsOf } from './write-support';
import type { OffersWorld } from './write-support';

let w: OffersWorld;
beforeAll(async () => {
  w = await offersWorld();
});
afterAll(async () => {
  await w.db.close();
});

const both = (keep: number, online: number) => [
  { option: 'keep_retrieve' as const, price_minor: keep },
  { option: 'online_read' as const, price_minor: online },
];

describe('listOfferableArticles', () => {
  it('lists own articles with no current offer, and none that already has an authorised offer', async () => {
    const fresh = await addArticle(w.db, w.pubId['harbour-ledger'], 'fresh-1');
    const list = await listOfferableArticles(w.db, w.harbour);
    expect(list).toEqual([{ article_id: fresh, title: 'Title fresh-1' }]);
  });
  it('is null for a buyer, an operator and the system', async () => {
    for (const a of [w.buyer, w.operator, w.system]) {
      expect(await listOfferableArticles(w.db, a)).toBeNull();
    }
  });
});

describe('createOffer', () => {
  it('writes version 1, one authorisation with the attestation, one audit row, in the right currency', async () => {
    const article = await addArticle(w.db, w.pubId['harbour-ledger'], 'make-1');
    const offers0 = await count(w.db, 'SELECT count(*) AS c FROM offers');
    const auth0 = await count(w.db, 'SELECT count(*) AS c FROM publisher_authorisations');
    const r = await createOffer(w.deps(), w.harbour, {
      article_id: article,
      options: both(150, 100),
      attestation: true,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.version).toBe('1');
    expect(r.value.offer_id).toMatch(/^ofr_harbour-ledger_/);
    const v = await versionsOf(w.db, r.value.offer_id);
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({
      version: '1',
      status: 'authorised',
      currency: 'USD',
      article_id: article,
      publisher_id: w.pubId['harbour-ledger'],
      terms_version: 'terms-1',
      superseded_by: null,
    });
    expect(v[0]!.rights).toEqual({
      scope: 'personal_use',
      ai_scope: 'review',
      redistribution: false,
    });
    expect(prices(v[0]!.options)).toEqual({ keep_retrieve: 150, online_read: 100 });
    expect(await count(w.db, 'SELECT count(*) AS c FROM offers')).toBe(offers0 + 1);
    expect(await count(w.db, 'SELECT count(*) AS c FROM publisher_authorisations')).toBe(auth0 + 1);
    const auth = (
      await w.db.query<{ authorised_by: string; attestation_version: string }>(
        'SELECT authorised_by, attestation_version FROM publisher_authorisations WHERE offer_id = $1',
        [r.value.offer_id],
      )
    ).rows;
    expect(auth).toEqual([
      { authorised_by: w.pubId['harbour-ledger'], attestation_version: PUB_ATTEST_1 },
    ]);
    const audit = (
      await w.db.query<{ actor_kind: string; actor_id: string; action: string; target: string }>(
        "SELECT actor_kind, actor_id, action, target FROM audit_log WHERE action = 'offer.created' AND target = $1",
        [r.value.offer_id],
      )
    ).rows;
    expect(audit).toEqual([
      {
        actor_kind: 'publisher',
        actor_id: w.pubId['harbour-ledger'],
        action: 'offer.created',
        target: r.value.offer_id,
      },
    ]);
  });

  it('puts the offer on sale: the buyer side lists it and the publisher sees it', async () => {
    const article = await addArticle(w.db, w.pubId['harbour-ledger'], 'make-2');
    const r = await createOffer(w.deps(), w.harbour, {
      article_id: article,
      options: [{ option: 'online_read', price_minor: 75 }],
      attestation: true,
    });
    if (!r.ok) throw new Error('create failed');
    const view = await getOffer(w.db, { offer_id: r.value.offer_id });
    expect(view?.offer.status).toBe('authorised');
    const listed = await listAuthorisedOffers(w.db, { corridor_id: 'us-usd', limit: 100 });
    expect(listed.map((o) => o.offer.id)).toContain(r.value.offer_id);
    const own = await listOwnOffers(w.db, w.harbour);
    expect(own?.find((o) => o.offer_id === r.value.offer_id)?.options).toEqual([
      { option: 'online_read', price_minor: 75 },
    ]);
    // the article is no longer offerable
    expect((await listOfferableArticles(w.db, w.harbour))?.map((a) => a.article_id)).not.toContain(
      article,
    );
  });

  it('refuses a price of 0, above the cap, 1.5 and a wrong option, and writes nothing', async () => {
    const article = await addArticle(w.db, w.pubId['harbour-ledger'], 'bad-1');
    const n0 = await count(w.db, 'SELECT count(*) AS c FROM offers');
    const cases: [unknown, string][] = [
      [both(0, 100), 'invalid_price'],
      [both(CAP + 1, 100), 'invalid_price'],
      [both(1.5, 100), 'invalid_price'],
      [[{ option: 'rent', price_minor: 100 }], 'invalid_options'],
      [[], 'invalid_options'],
      [[...both(100, 100), ...both(100, 100)], 'invalid_options'],
    ];
    for (const [options, code] of cases) {
      const r = await createOffer(w.deps(), w.harbour, {
        article_id: article,
        options: options as never,
        attestation: true,
      });
      expect(r).toEqual({ ok: false, error: { code } });
    }
    expect(await count(w.db, 'SELECT count(*) AS c FROM offers')).toBe(n0);
  });

  it('honours a lower cap passed in', async () => {
    const article = await addArticle(w.db, w.pubId['harbour-ledger'], 'cap-1');
    const r = await createOffer(w.deps(500), w.harbour, {
      article_id: article,
      options: both(501, 100),
      attestation: true,
    });
    expect(r).toEqual({ ok: false, error: { code: 'invalid_price' } });
  });

  it('refuses without the attestation', async () => {
    const article = await addArticle(w.db, w.pubId['harbour-ledger'], 'att-1');
    for (const attestation of [false, undefined, 'true', 1]) {
      const r = await createOffer(w.deps(), w.harbour, {
        article_id: article,
        options: both(100, 100),
        attestation: attestation as never,
      });
      expect(r).toEqual({ ok: false, error: { code: 'attestation_required' } });
    }
  });

  it('refuses an article that already has a live offer', async () => {
    const live = (await getOffer(w.db, { offer_id: 'ofr_harbour-ledger_tide-tables' }))!.offer
      .article_id;
    const r = await createOffer(w.deps(), w.harbour, {
      article_id: live,
      options: both(100, 100),
      attestation: true,
    });
    expect(r).toEqual({ ok: false, error: { code: 'already_offered' } });
  });

  it('refuses a second create for the same article', async () => {
    const article = await addArticle(w.db, w.pubId['harbour-ledger'], 'twice-1');
    const first = await createOffer(w.deps(), w.harbour, {
      article_id: article,
      options: both(100, 100),
      attestation: true,
    });
    expect(first.ok).toBe(true);
    const second = await createOffer(w.deps(), w.harbour, {
      article_id: article,
      options: both(100, 100),
      attestation: true,
    });
    expect(second).toEqual({ ok: false, error: { code: 'already_offered' } });
  });

  it('after a withdraw the article is offerable again and gets a distinct offer id', async () => {
    const article = await addArticle(w.db, w.pubId['harbour-ledger'], 'again-1');
    const first = await createOffer(w.deps(), w.harbour, {
      article_id: article,
      options: both(100, 100),
      attestation: true,
    });
    if (!first.ok) throw new Error('create failed');
    const wd = await withdrawOffer(w.deps(), w.harbour, {
      offer_id: first.value.offer_id,
      expected_version: '1',
      reason: 'Taking it off for now.',
    });
    expect(wd.ok).toBe(true);
    expect((await listOfferableArticles(w.db, w.harbour))?.map((a) => a.article_id)).toContain(
      article,
    );
    const again = await createOffer(w.deps(), w.harbour, {
      article_id: article,
      options: both(120, 120),
      attestation: true,
    });
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.value.offer_id).not.toBe(first.value.offer_id);
    expect(again.value.version).toBe('1');
    // the first offer's history is untouched
    expect((await versionsOf(w.db, first.value.offer_id)).map((v) => v.status)).toEqual([
      'authorised',
      'withdrawn',
    ]);
  });

  it('a created offer can be revised like any other', async () => {
    const article = await addArticle(w.db, w.pubId['harbour-ledger'], 'rev-1');
    const r = await createOffer(w.deps(), w.harbour, {
      article_id: article,
      options: both(100, 100),
      attestation: true,
    });
    if (!r.ok) throw new Error('create failed');
    const rv = await reviseOffer(w.deps(), w.harbour, {
      offer_id: r.value.offer_id,
      expected_version: '1',
      options: both(200, 200),
      attestation: true,
    });
    expect(rv).toEqual({ ok: true, value: { version: '2' } });
  });

  it('refuses when the publisher is not active', async () => {
    const article = await addArticle(w.db, w.pubId['northfield-quarterly'], 'sus-1');
    await w.db.query("UPDATE publishers SET status = 'suspended' WHERE id = $1", [
      w.pubId['northfield-quarterly'],
    ]);
    const r = await createOffer(w.deps(), w.northfield, {
      article_id: article,
      options: both(100, 100),
      attestation: true,
    });
    expect(r).toEqual({ ok: false, error: { code: 'publisher_not_active' } });
    await w.db.query("UPDATE publishers SET status = 'applied' WHERE id = $1", [
      w.pubId['northfield-quarterly'],
    ]);
    expect(
      await createOffer(w.deps(), w.northfield, {
        article_id: article,
        options: both(100, 100),
        attestation: true,
      }),
    ).toEqual({ ok: false, error: { code: 'publisher_not_active' } });
    await w.db.query("UPDATE publishers SET status = 'active' WHERE id = $1", [
      w.pubId['northfield-quarterly'],
    ]);
  });

  it('keeps the article content freeze of migration 0012: bytes cannot change once the offer is authorised', async () => {
    const article = await addArticle(w.db, w.pubId['harbour-ledger'], 'frz-1');
    // before the offer: the bytes may change
    await w.db.query('UPDATE articles SET sha256 = $2 WHERE id = $1', [article, 'd'.repeat(64)]);
    const r = await createOffer(w.deps(), w.harbour, {
      article_id: article,
      options: both(100, 100),
      attestation: true,
    });
    expect(r.ok).toBe(true);
    await expect(
      w.db.query('UPDATE articles SET sha256 = $2 WHERE id = $1', [article, 'e'.repeat(64)]),
    ).rejects.toThrow(/cannot change while an authorised offer/);
  });

  it('is atomic: a failure after the checks leaves no offer, authorisation or audit row', async () => {
    const article = await addArticle(w.db, w.pubId['harbour-ledger'], 'atom-1');
    const failing = {
      ...w.deps(),
      audit: {
        record: () => Promise.reject(new Error('audit down')),
      },
    };
    const before = [
      await count(w.db, 'SELECT count(*) AS c FROM offers'),
      await count(w.db, 'SELECT count(*) AS c FROM publisher_authorisations'),
    ];
    await expect(
      createOffer(failing, w.harbour, {
        article_id: article,
        options: both(100, 100),
        attestation: true,
      }),
    ).rejects.toThrow('audit down');
    expect([
      await count(w.db, 'SELECT count(*) AS c FROM offers'),
      await count(w.db, 'SELECT count(*) AS c FROM publisher_authorisations'),
    ]).toEqual(before);
  });
});
