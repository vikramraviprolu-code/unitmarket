// PUB-E5 adversarial (docs/specs/pub-e5-article-facts.md): the article facts on the offer pages come from the
// articles row of the signed-in publisher's own offers only. Another publisher's facts never appear in the
// list or the detail, a guessed id answers null, and other actors get nothing. The facts match the stored row.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getOwnOffer, listOwnOffers, withdrawOffer } from './index';
import { DOCK, FEES, FERRY, HALL, QUAY, TIDE, offersWorld } from './write-support';
import type { OffersWorld } from './write-support';

let w: OffersWorld;
beforeAll(async () => {
  w = await offersWorld();
});
afterAll(async () => {
  await w.db.close();
});

interface ArticleRow {
  id: string;
  title: string;
  abstract: string;
  language: string;
  bytes: number;
  sha256: string;
  publisher_id: string;
}
const articlesOf = async (publisher_id: string): Promise<ArticleRow[]> =>
  (
    await w.db.query<ArticleRow>(
      'SELECT id, title, abstract, language, bytes, sha256, publisher_id FROM articles WHERE publisher_id = $1',
      [publisher_id],
    )
  ).rows;

describe('the facts are the stored article row', () => {
  it('the detail carries abstract, language, bytes and sha256 of its own article', async () => {
    const o = (await getOwnOffer(w.db, w.harbour, TIDE))!;
    const row = (
      await w.db.query<ArticleRow>('SELECT * FROM articles WHERE id = $1', [o.article_id])
    ).rows[0]!;
    expect(o.article_abstract).toBe(row.abstract);
    expect(o.article_language).toBe(row.language);
    expect(o.article_bytes).toBe(row.bytes);
    expect(o.article_sha256).toBe(row.sha256);
    expect(o.article_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(o.article_bytes).toBeGreaterThan(0);
  });

  it('every row of the list carries the facts of its own article', async () => {
    const list = (await listOwnOffers(w.db, w.harbour))!;
    expect(list.length).toBeGreaterThan(1);
    for (const o of list) {
      const row = (
        await w.db.query<ArticleRow>('SELECT * FROM articles WHERE id = $1', [o.article_id])
      ).rows[0]!;
      expect([o.article_abstract, o.article_language, o.article_bytes, o.article_sha256]).toEqual([
        row.abstract,
        row.language,
        row.bytes,
        row.sha256,
      ]);
    }
  });
});

describe('publisher A never sees the article facts of publisher B', () => {
  it('no list or detail of Harbour holds a Quayside or Northfield abstract, title or hash', async () => {
    const harbourOffers = (await listOwnOffers(w.db, w.harbour))!;
    const harbourDetails = [];
    for (const o of harbourOffers)
      harbourDetails.push((await getOwnOffer(w.db, w.harbour, o.offer_id))!);
    const blob = JSON.stringify([harbourOffers, harbourDetails]);
    for (const other of [w.pubId['quayside-gazette'], w.pubId['northfield-quarterly']]) {
      const theirs = await articlesOf(other);
      expect(theirs.length).toBeGreaterThan(0);
      for (const a of theirs) {
        expect(blob).not.toContain(a.abstract);
        expect(blob).not.toContain(a.title);
        expect(blob).not.toContain(a.sha256);
        expect(blob).not.toContain(a.id);
      }
    }
  });

  it('the same holds the other way round for Quayside', async () => {
    const quayOffers = (await listOwnOffers(w.db, w.quayside))!;
    const blob = JSON.stringify(quayOffers);
    for (const a of await articlesOf(w.pubId['harbour-ledger'])) {
      expect(blob).not.toContain(a.abstract);
      expect(blob).not.toContain(a.sha256);
    }
  });

  it('a guessed or foreign offer id answers null, the same for both', async () => {
    for (const id of [QUAY, HALL, 'ofr_quayside-gazette_does-not-exist', 'ofr_nothing']) {
      expect(await getOwnOffer(w.db, w.harbour, id)).toBeNull();
    }
    expect(await getOwnOffer(w.db, w.quayside, TIDE)).toBeNull();
  });

  it('a publisher id sent by a client is not a thing: the actor decides, and a made-up publisher gets nothing', async () => {
    const stranger = { kind: 'publisher' as const, publisher_id: 'pub_not_a_publisher' };
    expect(await listOwnOffers(w.db, stranger)).toEqual([]);
    expect(await getOwnOffer(w.db, stranger, TIDE)).toBeNull();
  });

  it('buyers, operators and the system get no facts', async () => {
    for (const actor of [w.buyer, w.operator, w.system]) {
      expect(await listOwnOffers(w.db, actor)).toBeNull();
      expect(await getOwnOffer(w.db, actor, TIDE)).toBeNull();
    }
  });
});

describe('withdrawn offers keep their own facts and nothing else changes', () => {
  it('a seeded withdrawn offer shows the facts of its article row', async () => {
    const o = (await getOwnOffer(w.db, w.harbour, DOCK))!;
    expect(o.status).toBe('withdrawn');
    const row = (
      await w.db.query<ArticleRow>('SELECT * FROM articles WHERE id = $1', [o.article_id])
    ).rows[0]!;
    expect([o.article_abstract, o.article_language, o.article_bytes, o.article_sha256]).toEqual([
      row.abstract,
      row.language,
      row.bytes,
      row.sha256,
    ]);
  });

  it('withdrawing an offer keeps its article facts and leaves the other offers alone', async () => {
    const before = (await getOwnOffer(w.db, w.harbour, FEES))!;
    expect(before.status).toBe('authorised');
    const r = await withdrawOffer(w.deps(), w.harbour, {
      offer_id: FEES,
      expected_version: before.version,
      reason: 'Pulled for a rewrite.',
    });
    expect(r.ok).toBe(true);
    const after = (await getOwnOffer(w.db, w.harbour, FEES))!;
    expect(after.status).toBe('withdrawn');
    expect(after.article_abstract).toBe(before.article_abstract);
    expect(after.article_language).toBe(before.article_language);
    expect(after.article_bytes).toBe(before.article_bytes);
    expect(after.article_sha256).toBe(before.article_sha256);
    const listed = (await listOwnOffers(w.db, w.harbour))!.find((o) => o.offer_id === FEES)!;
    expect(listed.status).toBe('withdrawn');
    expect(listed.article_sha256).toBe(before.article_sha256);
    expect((await getOwnOffer(w.db, w.harbour, FERRY))!.status).toBe('authorised');
  });

  it('reading the facts writes nothing', async () => {
    const c = async (t: string): Promise<number> =>
      Number((await w.db.query<{ c: string }>(`SELECT count(*) AS c FROM ${t}`)).rows[0]!.c);
    const n = [
      await c('offers'),
      await c('articles'),
      await c('audit_log'),
      await c('publisher_authorisations'),
    ];
    await listOwnOffers(w.db, w.harbour);
    await getOwnOffer(w.db, w.harbour, TIDE);
    expect([
      await c('offers'),
      await c('articles'),
      await c('audit_log'),
      await c('publisher_authorisations'),
    ]).toEqual(n);
  });
});
