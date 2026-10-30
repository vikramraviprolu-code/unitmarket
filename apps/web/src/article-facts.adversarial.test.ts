// PUB-E5 adversarial (docs/specs/pub-e5-article-facts.md): through the engine calls the offer pages make,
// publisher A never receives the article facts of publisher B; the write routes echo no facts; the buyer
// offer page view carries title, abstract, language and size but never the hash or the content key; and the
// withdrawn and suspended behaviour of that view (on_sale) is unchanged by the new fields.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { bootOffersWorld, both, postRevise, postWithdraw, QUAY, TIDE } from './offers-support';
import type { OffersWebWorld } from './offers-support';

vi.mock('server-only', () => ({}));

let w: OffersWebWorld;
beforeAll(async () => {
  w = await bootOffersWorld();
});
afterAll(async () => {
  await w.app.close();
});

interface ArticleRow {
  abstract: string;
  sha256: string;
  content_key: string;
  bytes: number;
  language: string;
  title: string;
}
const articleOf = async (offerId: string): Promise<ArticleRow> =>
  (
    await w.app.db.query<ArticleRow>(
      `SELECT a.abstract, a.sha256, a.content_key, a.bytes, a.language, a.title
         FROM articles a JOIN offers o ON o.article_id = a.id WHERE o.id = $1 LIMIT 1`,
      [offerId],
    )
  ).rows[0]!;

describe('publisher isolation through the engine', () => {
  it('Harbour list and detail hold none of the Quayside article facts', async () => {
    const list = (await w.app.engine.offers.list(w.actor['harbour-ledger']))!;
    const details = [];
    for (const o of list.offers) {
      details.push(await w.app.engine.offers.get(w.actor['harbour-ledger'], o.offer_id));
    }
    const blob = JSON.stringify([list, details]);
    const theirs = await articleOf(QUAY);
    expect(blob).not.toContain(theirs.abstract);
    expect(blob).not.toContain(theirs.sha256);
    expect(blob).not.toContain(theirs.title);
    const own = await articleOf(TIDE);
    expect(blob).toContain(own.abstract);
    expect(blob).toContain(own.sha256);
  });

  it('Harbour asking for the Quayside offer id gets null, as for an id that does not exist', async () => {
    expect(await w.app.engine.offers.get(w.actor['harbour-ledger'], QUAY)).toBeNull();
    expect(await w.app.engine.offers.get(w.actor['harbour-ledger'], 'ofr_nothing')).toBeNull();
    expect(await w.app.engine.offers.get(w.actor['quayside-gazette'], TIDE)).toBeNull();
  });

  it('a buyer or an anonymous visitor gets no facts from the publisher calls', async () => {
    const buyer = { kind: 'buyer' as const, buyer_id: 'buy_someone' };
    expect(await w.app.engine.offers.list(buyer)).toBeNull();
    expect(await w.app.engine.offers.get(buyer, TIDE)).toBeNull();
  });

  it('the write routes answer without any article fact', async () => {
    const own = await articleOf(TIDE);
    const res = await postRevise(w, w.pub['harbour-ledger'], {
      offer_id: TIDE,
      expected_version: '1',
      options: both(120, 120),
      attestation: true,
    });
    const text = await res.text();
    expect(text).not.toContain(own.abstract);
    expect(text).not.toContain(own.sha256);
    const foreign = await postRevise(w, w.pub['harbour-ledger'], {
      offer_id: QUAY,
      expected_version: '1',
      options: both(120, 120),
      attestation: true,
    });
    expect(foreign.status).toBe(404);
    const theirs = await articleOf(QUAY);
    const ftext = await foreign.text();
    expect(ftext).not.toContain(theirs.abstract);
    expect(ftext).not.toContain(theirs.sha256);
  });
});

describe('the buyer offer page view', () => {
  it('carries language and size from the article row, and no hash or content key', async () => {
    const row = await articleOf('ofr_harbour-ledger_knot-notebook');
    const v = (await w.app.engine.offerPage({
      publisher: 'harbour-ledger',
      offer: 'knot-notebook',
    }))!;
    expect(v.language).toBe(row.language);
    expect(v.bytes).toBe(row.bytes);
    expect(v.abstract).toBe(row.abstract);
    const text = JSON.stringify(v);
    expect(text).not.toContain(row.sha256);
    expect(text).not.toContain(row.content_key);
    expect(Object.keys(v)).not.toContain('sha256');
  });

  it('withdrawn and suspended: facts still present, on_sale exactly as before', async () => {
    const id = 'ofr_harbour-ledger_knot-notebook';
    const live = (await w.app.engine.offerPage({
      publisher: 'harbour-ledger',
      offer: 'knot-notebook',
    }))!;
    expect(live.on_sale).toBe(true);
    const r = await postWithdraw(w, w.pub['harbour-ledger'], {
      offer_id: id,
      expected_version: '1',
      reason: 'Pulled for a rewrite.',
    });
    expect(r.status).toBe(200);
    const gone = (await w.app.engine.offerPage({
      publisher: 'harbour-ledger',
      offer: 'knot-notebook',
    }))!;
    expect(gone.on_sale).toBe(false);
    expect(gone.language).toBe(live.language);
    expect(gone.bytes).toBe(live.bytes);
    await w.app.db.query(
      `UPDATE publishers SET status = 'suspended' WHERE slug = 'quayside-gazette'`,
    );
    const susp = (await w.app.engine.offerPage({
      publisher: 'quayside-gazette',
      offer: 'quay-walk',
    }))!;
    expect(susp.on_sale).toBe(false);
    expect(susp.bytes).toBeGreaterThan(0);
    expect(susp.language.length).toBeGreaterThan(0);
  });
});
