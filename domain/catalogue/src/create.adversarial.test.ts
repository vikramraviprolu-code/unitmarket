// PUB-E1 adversarial tests for createOffer: another publisher's article, a guessed id, other actor kinds,
// and extra input fields. Nothing is written in any of these cases.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createOffer, listOfferableArticles } from './index';
import { addArticle, count, offersWorld, versionsOf } from './write-support';
import type { OffersWorld } from './write-support';

let w: OffersWorld;
beforeAll(async () => {
  w = await offersWorld();
});
afterAll(async () => {
  await w.db.close();
});

const both = [
  { option: 'keep_retrieve' as const, price_minor: 100 },
  { option: 'online_read' as const, price_minor: 100 },
];
const totals = async () => [
  await count(w.db, 'SELECT count(*) AS c FROM offers'),
  await count(w.db, 'SELECT count(*) AS c FROM publisher_authorisations'),
  await count(w.db, "SELECT count(*) AS c FROM audit_log WHERE action = 'offer.created'"),
];

describe('createOffer isolation', () => {
  it('another publisher cannot offer my article, and a guessed id looks the same', async () => {
    const mine = await addArticle(w.db, w.pubId['quayside-gazette'], 'q-private');
    const before = await totals();
    const results = [];
    for (const id of [mine, 'art_does_not_exist', 'nothing', '']) {
      results.push(
        await createOffer(w.deps(), w.harbour, {
          article_id: id,
          options: both,
          attestation: true,
        }),
      );
    }
    for (const r of results) expect(r).toEqual({ ok: false, error: { code: 'not_found' } });
    expect(await totals()).toEqual(before);
    // and the owner still sees it as offerable, the thief does not
    expect((await listOfferableArticles(w.db, w.quayside))?.map((a) => a.article_id)).toContain(
      mine,
    );
    expect((await listOfferableArticles(w.db, w.harbour))?.map((a) => a.article_id)).not.toContain(
      mine,
    );
  });

  it('a buyer, an operator and the system cannot create an offer', async () => {
    const article = await addArticle(w.db, w.pubId['harbour-ledger'], 'h-nobody');
    const before = await totals();
    for (const a of [w.buyer, w.operator, w.system]) {
      expect(
        await createOffer(w.deps(), a, { article_id: article, options: both, attestation: true }),
      ).toEqual({ ok: false, error: { code: 'not_publisher' } });
    }
    expect(await totals()).toEqual(before);
  });

  it('extra input fields change nothing (currency, publisher, status, terms, rights)', async () => {
    const article = await addArticle(w.db, w.pubId['harbour-ledger'], 'h-mass');
    const r = await createOffer(w.deps(), w.harbour, {
      article_id: article,
      options: both.map((o) => ({ ...o, policy_id: 'evil', currency: 'EUR' })),
      attestation: true,
      currency: 'EUR',
      publisher_id: w.pubId['quayside-gazette'],
      status: 'draft',
      terms_version: 'terms-evil',
      rights: { scope: 'personal_use', ai_scope: 'agent_allowed', redistribution: false },
    } as never);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const v = (await versionsOf(w.db, r.value.offer_id))[0]!;
    expect(v).toMatchObject({
      currency: 'USD',
      publisher_id: w.pubId['harbour-ledger'],
      status: 'authorised',
      terms_version: 'terms-1',
    });
    expect(v.rights).toEqual({ scope: 'personal_use', ai_scope: 'review', redistribution: false });
    expect(v.options.map((o) => o.policy_id).sort()).toEqual(['keep_retrieve', 'online_read']);
  });

  it('a price that is a string, null or an object is refused', async () => {
    const article = await addArticle(w.db, w.pubId['harbour-ledger'], 'h-types');
    for (const price_minor of ['100', null, {}, [], true, Number.NaN, Infinity]) {
      const r = await createOffer(w.deps(), w.harbour, {
        article_id: article,
        options: [{ option: 'online_read', price_minor }] as never,
        attestation: true,
      });
      expect(r).toEqual({ ok: false, error: { code: 'invalid_price' } });
    }
  });
});
