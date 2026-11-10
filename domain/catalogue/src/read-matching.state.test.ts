// CAT-1.1: listAuthorisedOffersMatching. Match first, whole words, a cap per publisher, every guard of
// listAuthorisedOffers applied before any cap. Fixtures are inline.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getOffer, listAuthorisedOffers, listAuthorisedOffersMatching } from './index';
import { testDb } from './support';

type TestDb = Awaited<ReturnType<typeof testDb>>;
// Inline fixtures (CAT-1): publishers, bulk offers by SQL, a briefs row. Content is synthetic.
const TS = '2026-10-21T10:00:00.000Z';
const RIGHTS = JSON.stringify({ scope: 'personal_use', ai_scope: 'review', redistribution: false });
const FIXED = JSON.stringify({ renegotiation_allowed: false, floor_minor: null });
const OPTIONS = JSON.stringify([
  { option: 'keep_retrieve', price_minor: 500, policy_id: 'keep_retrieve', policy_version: '1' },
  { option: 'online_read', price_minor: 300, policy_id: 'online_read', policy_version: '1' },
]);

async function addPublisher(
  db: Pick<TestDb, 'query'>,
  id: string,
  over: { country?: string; status?: string } = {},
): Promise<void> {
  await db.query(
    `INSERT INTO publishers (id, slug, display_name, country, paypal_merchant_id, payee_verified_at, status, created_at, updated_at)
     VALUES ($1::text, $1::text, upper($1::text), $2::text, 'MERCH' || upper($1::text), $3::timestamptz, $4::text, $3::timestamptz, $3::timestamptz)`,
    [id, over.country ?? 'US', TS, over.status ?? 'active'],
  );
}

interface Batch {
  pub: string;
  /** Offer ids are ofr_<prefix>_<0001..>. */
  prefix: string;
  n: number;
  title?: string;
  abstract?: string;
  topics?: string[];
  status?: string;
  authorised?: boolean;
  currency?: string;
  superseded?: boolean;
}
async function addOffers(db: Pick<TestDb, 'query'>, b: Batch): Promise<void> {
  const args = [
    b.pub,
    b.prefix,
    b.title ?? 'Plain title {i}',
    b.abstract ?? 'Plain abstract {i}',
    b.topics ?? ['misc'],
    TS,
    b.n,
  ];
  await db.query(
    `INSERT INTO articles (id, publisher_id, title, abstract, language, topics, published_at, sha256, content_key, bytes, mime, created_at, updated_at)
     SELECT 'art_' || $2::text || '_' || lpad(i::text, 4, '0'), $1::text, replace($3::text, '{i}', i::text),
            replace($4::text, '{i}', i::text), 'en', $5::text[], $6::timestamptz,
            md5($2::text || i::text) || md5(i::text || $2::text), 'key_' || $2::text || '_' || i::text,
            10, 'text/plain', $6::timestamptz, $6::timestamptz
       FROM generate_series(1, $7::int) AS i`,
    args,
  );
  await db.query(
    `INSERT INTO offers (id, version, publisher_id, article_id, status, currency, options, affordability, terms_version, rights, valid_from, valid_until, superseded_by, created_at, updated_at)
     SELECT 'ofr_' || $2::text || '_' || lpad(i::text, 4, '0'), '1', $1::text,
            'art_' || $2::text || '_' || lpad(i::text, 4, '0'), $3::text, $4::text, $5::jsonb, $6::jsonb,
            'terms-1', $7::jsonb, '2026-01-01T00:00:00.000Z', NULL,
            CASE WHEN $8::boolean THEN 'ofr_newer_' || i::text ELSE NULL END, $9::timestamptz, $9::timestamptz
       FROM generate_series(1, $10::int) AS i`,
    [
      b.pub,
      b.prefix,
      b.status ?? 'authorised',
      b.currency ?? 'USD',
      OPTIONS,
      FIXED,
      RIGHTS,
      b.superseded ?? false,
      TS,
      b.n,
    ],
  );
  if (b.authorised ?? true) {
    await db.query(
      `INSERT INTO publisher_authorisations (id, offer_id, offer_version, authorised_by, at, created_at, updated_at)
       SELECT 'auth_' || o.id, o.id, o.version, $1::text, $3::timestamptz, $3::timestamptz, $3::timestamptz
         FROM offers o WHERE o.id LIKE 'ofr_' || $2::text || '\\_%'`,
      [b.pub, b.prefix, TS],
    );
  }
}

let db: TestDb;
beforeAll(async () => {
  db = await testDb();
});
afterAll(async () => {
  await db.close();
});

const ids = async (
  words: string[],
  over: { per_publisher?: number; limit?: number; corridor_id?: string } = {},
): Promise<string[]> =>
  (
    await listAuthorisedOffersMatching(db, {
      corridor_id: over.corridor_id ?? 'us-usd',
      words,
      per_publisher: over.per_publisher ?? 50,
      limit: over.limit ?? 500,
    })
  ).map((r) => r.view.offer.id);

describe('guards are those of listAuthorisedOffers', () => {
  it('excludes unauthorised, draft, withdrawn, superseded, older-version, inactive-publisher, other-currency and other-country offers', async () => {
    await addPublisher(db, 'g1');
    await addPublisher(db, 'g2', { status: 'suspended' });
    await addPublisher(db, 'g3', { country: 'IN' });
    await addOffers(db, { pub: 'g1', prefix: 'gok', n: 2, title: 'Guardword ok {i}' });
    await addOffers(db, {
      pub: 'g1',
      prefix: 'gunauth',
      n: 1,
      title: 'Guardword nope',
      authorised: false,
    });
    await addOffers(db, {
      pub: 'g1',
      prefix: 'gdraft',
      n: 1,
      title: 'Guardword draft',
      status: 'draft',
      authorised: false,
    });
    await addOffers(db, {
      pub: 'g1',
      prefix: 'gwith',
      n: 1,
      title: 'Guardword withdrawn',
      status: 'withdrawn',
    });
    await addOffers(db, {
      pub: 'g1',
      prefix: 'gsup',
      n: 1,
      title: 'Guardword superseded',
      superseded: true,
    });
    await addOffers(db, { pub: 'g1', prefix: 'gold', n: 1, title: 'Guardword older version' });
    await db.query(
      `INSERT INTO offers (id, version, publisher_id, article_id, status, currency, options, affordability, terms_version, rights, valid_from, valid_until, superseded_by, created_at, updated_at)
       SELECT id, '2', publisher_id, article_id, 'withdrawn', currency, options, affordability, terms_version, rights, valid_from, NULL, NULL, created_at + interval '1 day', created_at + interval '1 day'
         FROM offers WHERE id = 'ofr_gold_0001'`,
    );
    await addOffers(db, {
      pub: 'g1',
      prefix: 'geur',
      n: 1,
      title: 'Guardword euro',
      currency: 'EUR',
    });
    await addOffers(db, { pub: 'g2', prefix: 'gsusp', n: 1, title: 'Guardword suspended' });
    await addOffers(db, { pub: 'g3', prefix: 'gind', n: 1, title: 'Guardword india' });

    const matching = await ids(['guardword']);
    expect(matching).toEqual(['ofr_gok_0001', 'ofr_gok_0002']);
    // Same set as the plain list, restricted to these offers.
    const plain = (await listAuthorisedOffers(db, { corridor_id: 'us-usd', limit: 500 }))
      .map((v) => v.offer.id)
      .filter((id) => id.startsWith('ofr_g'));
    expect(matching).toEqual(plain);
  });

  it('answers [] for an unknown or disabled corridor', async () => {
    expect(await ids(['guardword'], { corridor_id: 'zz-none' })).toEqual([]);
  });
});

describe('score and order', () => {
  it('scores 2 for a title or topic hit and 1 for an abstract-only hit, each word once, ordered by score then id', async () => {
    await addPublisher(db, 's1');
    await addOffers(db, {
      pub: 's1',
      prefix: 'sc1',
      n: 1,
      title: 'Scoreword in title',
      abstract: 'x',
    });
    await addOffers(db, {
      pub: 's1',
      prefix: 'sc2',
      n: 1,
      title: 'Other',
      abstract: 'about scoreword here',
    });
    await addOffers(db, {
      pub: 's1',
      prefix: 'sc3',
      n: 1,
      title: 'Other',
      abstract: 'z',
      topics: ['scoreword'],
    });
    await addOffers(db, {
      pub: 's1',
      prefix: 'sc4',
      n: 1,
      title: 'Scoreword scoreword',
      abstract: 'scoreword again and tideword',
      topics: ['scoreword'],
    });
    const rows = await listAuthorisedOffersMatching(db, {
      corridor_id: 'us-usd',
      words: ['scoreword', 'tideword'],
      per_publisher: 50,
      limit: 500,
    });
    expect(rows.map((r) => [r.view.offer.id, r.score])).toEqual([
      ['ofr_sc4_0001', 3],
      ['ofr_sc1_0001', 2],
      ['ofr_sc3_0001', 2],
      ['ofr_sc2_0001', 1],
    ]);
  });

  it('returns whole OfferViews', async () => {
    const [row] = await listAuthorisedOffersMatching(db, {
      corridor_id: 'us-usd',
      words: ['scoreword'],
      per_publisher: 1,
      limit: 1,
    });
    expect(row!.view.publisher.id).toBe('s1');
    expect(row!.view.article.id).toBe('art_sc1_0001');
    expect(row!.view.offer.status).toBe('authorised');
  });
});

describe('caps', () => {
  it('keeps at most per_publisher rows per publisher, best first, and the cap never uses a slot on excluded rows', async () => {
    await addPublisher(db, 'c1');
    await addPublisher(db, 'c2');
    // c1: a high-scoring but unauthorised offer must not use one of its slots.
    await addOffers(db, {
      pub: 'c1',
      prefix: 'ca',
      n: 1,
      title: 'Capword capword',
      topics: ['capword'],
      authorised: false,
    });
    await addOffers(db, { pub: 'c1', prefix: 'cb', n: 6, title: 'Capword {i}' });
    await addOffers(db, { pub: 'c2', prefix: 'cc', n: 2, title: 'Capword {i}' });
    const got = await ids(['capword'], { per_publisher: 3 });
    expect(got).toEqual([
      'ofr_cb_0001',
      'ofr_cb_0002',
      'ofr_cb_0003',
      'ofr_cc_0001',
      'ofr_cc_0002',
    ]);
  });

  it('applies limit after the cap, ordered by score then id', async () => {
    expect(await ids(['capword'], { per_publisher: 3, limit: 4 })).toEqual([
      'ofr_cb_0001',
      'ofr_cb_0002',
      'ofr_cb_0003',
      'ofr_cc_0001',
    ]);
  });

  it('clamps per_publisher to 1..50 and limit to 1..500', async () => {
    await addPublisher(db, 'c3');
    await addOffers(db, { pub: 'c3', prefix: 'cd', n: 60, title: 'Clampword {i}' });
    expect((await ids(['clampword'], { per_publisher: 99 })).length).toBe(50);
    expect((await ids(['clampword'], { per_publisher: 0 })).length).toBe(1);
    expect((await ids(['clampword'], { limit: 0 })).length).toBe(1);
    expect((await ids(['clampword'], { per_publisher: 50, limit: 9999 })).length).toBe(50);
  });
});

describe('words', () => {
  it('answers [] for no words', async () => {
    expect(await ids([])).toEqual([]);
  });

  it('uses at most 12 words', async () => {
    await addPublisher(db, 'w1');
    await addOffers(db, { pub: 'w1', prefix: 'wa', n: 1, title: 'wordaaa' });
    await addOffers(db, { pub: 'w1', prefix: 'wb', n: 1, title: 'wordmmm' });
    const twelve = 'abcdefghijkl'.split('').map((c) => `fill${c}${c}${c}`);
    expect(await ids([...twelve, 'wordaaa'])).toEqual([]);
    expect(await ids(['wordaaa', ...twelve])).toEqual(['ofr_wa_0001']);
  });

  it('drops a word that is not 3 to 40 letters or digits, and never lets it widen the match', async () => {
    await addPublisher(db, 'w2');
    await addOffers(db, { pub: 'w2', prefix: 'wc', n: 3, title: 'Plainword {i}' });
    for (const bad of ['%', '_', "'", '\\', '.*', ');--', 'ab', 'a b', 'x'.repeat(41), '', 'a.c']) {
      expect(await ids([bad]), JSON.stringify(bad)).toEqual([]);
    }
    // A bad word next to a good one changes nothing.
    expect(await ids(['.*', 'plainword'])).toEqual(['ofr_wc_0001', 'ofr_wc_0002', 'ofr_wc_0003']);
  });

  it('matches whole words only: art does not match start', async () => {
    await addPublisher(db, 'w3');
    await addOffers(db, { pub: 'w3', prefix: 'wd', n: 1, title: 'We start the day' });
    await addOffers(db, { pub: 'w3', prefix: 'we', n: 1, title: 'The Art of tides' });
    await addOffers(db, {
      pub: 'w3',
      prefix: 'wf',
      n: 1,
      title: 'Other',
      topics: ['startup', 'art'],
    });
    await addOffers(db, {
      pub: 'w3',
      prefix: 'wg',
      n: 1,
      title: 'Other',
      abstract: 'a smart start',
    });
    expect(await ids(['art'])).toEqual(['ofr_we_0001', 'ofr_wf_0001']);
  });

  it('folds ASCII case, and a non-ASCII word still matches the same spelling', async () => {
    await addPublisher(db, 'w4');
    await addOffers(db, { pub: 'w4', prefix: 'wh', n: 1, title: 'harbour lights' });
    await addOffers(db, { pub: 'w4', prefix: 'wi', n: 1, title: 'Straße im Winter' });
    expect(await ids(['HARBOUR'])).toEqual(['ofr_wh_0001']);
    expect(await ids(['Straße'])).toEqual(['ofr_wi_0001']);
  });
});

describe('word dedupe and the hard limit', () => {
  it('counts a word once even when it is given twice in different case', async () => {
    const rows = await listAuthorisedOffersMatching(db, {
      corridor_id: 'us-usd',
      words: ['scoreword', 'SCOREWORD', 'scoreword'],
      per_publisher: 1,
      limit: 1,
    });
    expect(rows.map((r) => r.score)).toEqual([2]);
  });

  it('caps limit at 500 even when more match', async () => {
    for (let k = 0; k < 11; k++) {
      await addPublisher(db, `h${k}`);
      await addOffers(db, { pub: `h${k}`, prefix: `h${k}x`, n: 50, title: 'Hugeword {i}' });
    }
    expect((await ids(['hugeword'], { per_publisher: 50, limit: 9999 })).length).toBe(500);
  }, 60_000);
});

// CAT-2.2: exact copies (same publisher, same sha256) take one slot, before the per-publisher cap, and the
// row says how many other current authorised copies the publisher has.
async function addCopies(
  pub: string,
  prefix: string,
  n: number,
  o: { sha?: string; title?: string; authorised?: boolean } = {},
): Promise<void> {
  const sha = o.sha ?? `${prefix}${'0'.repeat(64)}`.slice(0, 64);
  await db.query(
    `INSERT INTO articles (id, publisher_id, title, abstract, language, topics, published_at, sha256, content_key, bytes, mime, created_at, updated_at)
     SELECT 'art_' || $2::text || '_' || lpad(i::text, 4, '0'), $1::text, replace($3::text, '{i}', i::text),
            'Copy abstract', 'en', ARRAY['misc'], $4::timestamptz, $5::text, 'key_' || $2::text || '_' || i::text,
            10, 'image/jpeg', $4::timestamptz, $4::timestamptz
       FROM generate_series(1, $6::int) AS i`,
    [pub, prefix, o.title ?? 'Copyword {i}', TS, sha, n],
  );
  await db.query(
    `INSERT INTO offers (id, version, publisher_id, article_id, status, currency, options, affordability, terms_version, rights, valid_from, valid_until, superseded_by, created_at, updated_at)
     SELECT 'ofr_' || $2::text || '_' || lpad(i::text, 4, '0'), '1', $1::text,
            'art_' || $2::text || '_' || lpad(i::text, 4, '0'), 'authorised', 'USD', $3::jsonb, $4::jsonb,
            'terms-1', $5::jsonb, '2026-01-01T00:00:00.000Z', NULL, NULL, $6::timestamptz, $6::timestamptz
       FROM generate_series(1, $7::int) AS i`,
    [pub, prefix, OPTIONS, FIXED, RIGHTS, TS, n],
  );
  if (o.authorised ?? true) {
    await db.query(
      `INSERT INTO publisher_authorisations (id, offer_id, offer_version, authorised_by, at, created_at, updated_at)
       SELECT 'auth_' || o.id, o.id, o.version, $1::text, $3::timestamptz, $3::timestamptz, $3::timestamptz
         FROM offers o WHERE o.id LIKE 'ofr_' || $2::text || '\\_%'`,
      [pub, prefix, TS],
    );
  }
}
const rowsFor = (words: string[], over: { per_publisher?: number } = {}) =>
  listAuthorisedOffersMatching(db, {
    corridor_id: 'us-usd',
    words,
    per_publisher: over.per_publisher ?? 50,
    limit: 500,
  });

describe('CAT-2.2 exact copies', () => {
  it('10 copies of one photo take one slot and the row says duplicates_hidden: 9', async () => {
    await addPublisher(db, 'd1');
    await addCopies('d1', 'dca', 10, { title: 'Dupword photo {i}' });
    const rows = await rowsFor(['dupword']);
    expect(rows.map((r) => r.view.offer.id)).toEqual(['ofr_dca_0001']);
    expect(rows[0]!.duplicates_hidden).toBe(9);
  });

  it('keeps the smallest offer id of the copies', async () => {
    const rows = await rowsFor(['dupword']);
    expect(rows[0]!.view.offer.id).toBe('ofr_dca_0001');
  });

  it('collapses before the per-publisher cap, so copies leave room for other offers', async () => {
    await addPublisher(db, 'd2');
    await addCopies('d2', 'dcb', 10, { title: 'Capdup photo {i}' });
    await addCopies('d2', 'dcc', 1, { title: 'Capdup other one', sha: 'c'.repeat(64) });
    await addCopies('d2', 'dcd', 1, { title: 'Capdup other two', sha: 'd'.repeat(64) });
    const got = (await rowsFor(['capdup'], { per_publisher: 3 })).map((r) => r.view.offer.id);
    expect(got).toHaveLength(3);
    expect(got).toContain('ofr_dcb_0001');
    expect(got).toContain('ofr_dcc_0001');
    expect(got).toContain('ofr_dcd_0001');
  });

  it('does not collapse the same photo of two publishers', async () => {
    await addPublisher(db, 'd3');
    await addPublisher(db, 'd4');
    const sha = 'e'.repeat(64);
    await addCopies('d3', 'dce', 1, { title: 'Twopub photo', sha });
    await addCopies('d4', 'dcf', 1, { title: 'Twopub photo', sha });
    const rows = await rowsFor(['twopub']);
    expect(rows.map((r) => r.view.offer.id)).toEqual(['ofr_dce_0001', 'ofr_dcf_0001']);
    expect(rows.map((r) => r.duplicates_hidden)).toEqual([0, 0]);
  });

  it('counts only current authorised copies in duplicates_hidden', async () => {
    await addPublisher(db, 'd5');
    const sha = 'f'.repeat(64);
    await addCopies('d5', 'dcg', 3, { title: 'Hiddencount photo {i}', sha });
    await addCopies('d5', 'dch', 2, { title: 'Hiddencount raw {i}', sha, authorised: false });
    const rows = await rowsFor(['hiddencount']);
    expect(rows.map((r) => r.view.offer.id)).toEqual(['ofr_dcg_0001']);
    expect(rows[0]!.duplicates_hidden).toBe(2);
  });

  it('gives 0 to an offer that has no copy', async () => {
    const rows = await rowsFor(['scoreword']);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.duplicates_hidden).toBe(0);
  });
});

describe('the plain reads', () => {
  it('getOffer answers null for an unknown offer and the offer for a known one', async () => {
    expect(await getOffer(db, { offer_id: 'ofr_nobody_0001' })).toBeNull();
    expect((await getOffer(db, { offer_id: 'ofr_gok_0001' }))?.offer.id).toBe('ofr_gok_0001');
  });

  it('listAuthorisedOffers keeps limit between 1 and 500', async () => {
    expect(await listAuthorisedOffers(db, { corridor_id: 'us-usd', limit: 0 })).toHaveLength(1);
    expect(await listAuthorisedOffers(db, { corridor_id: 'us-usd', limit: 2 })).toHaveLength(2);
    expect(
      (await listAuthorisedOffers(db, { corridor_id: 'us-usd', limit: 9999 })).length,
    ).toBeLessThanOrEqual(500);
  });
});
