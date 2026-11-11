// CAT-2.2 and CAT-2.3: exact copies take one slot, the size of a collection counts all of a publisher's offers,
// and the items are spread over publishers and collections without shrinking the answer.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AgentDeps, ModelPort, ModelRequest } from '@umsbx/contracts';
import { discover } from './index';
import type { DiscoveryResult } from './index';
import { spreadPicks } from './discover';
import { addBuyer, depsWith, extraData, seededDb, type TestDb } from './support';

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
  /** One sha256 for the whole batch: the offers are copies of one photo. */
  sameSha?: boolean;
  mime?: string;
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
    b.sameSha ?? false,
    b.mime ?? 'text/plain',
  ];
  await db.query(
    `INSERT INTO articles (id, publisher_id, title, abstract, language, topics, published_at, sha256, content_key, bytes, mime, created_at, updated_at)
     SELECT 'art_' || $2::text || '_' || lpad(i::text, 4, '0'), $1::text, replace($3::text, '{i}', i::text),
            replace($4::text, '{i}', i::text), 'en', $5::text[], $6::timestamptz,
            CASE WHEN $8::boolean THEN md5($2::text) || md5($2::text || 'x') ELSE md5($2::text || i::text) || md5(i::text || $2::text) END, 'key_' || $2::text || '_' || i::text,
            10, $9::text, $6::timestamptz, $6::timestamptz
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

// A scripted model port that records its input and picks ids by a rule over the candidates it was given.
function pickingModel(choose: (candidateIds: string[]) => string[]) {
  const requests: ModelRequest[] = [];
  const model: ModelPort = {
    model_id: 'pick-test',
    async complete(r: ModelRequest) {
      requests.push(structuredClone(r));
      const input = r.input as { candidates?: { offer_id: string }[] };
      const picks = choose((input.candidates ?? []).map((c) => c.offer_id));
      return {
        kind: 'ok' as const,
        output: { picks: picks.map((offer_id) => ({ offer_id, reason: 'test' })), tool_calls: [] },
        input_tokens: 1,
        output_tokens: 1,
      };
    },
  };
  return { model, requests };
}
const candidateIdsOf = (requests: ModelRequest[]): string[] =>
  (requests[0]!.input as { candidates: { offer_id: string }[] }).candidates.map((c) => c.offer_id);
const pubOf = (offerId: string): string => /^ofr_(p\d)/.exec(offerId)![1]!;

async function insertBrief(
  db: TestDb,
  buyerId: string,
  b: { need: string; terms: string[] },
): Promise<string> {
  const id = `brf_cat_${Math.abs(hash(b.need + b.terms.join(',')))}_${++briefs}`;
  await db.query(
    `INSERT INTO briefs (id, buyer_id, raw_text, structured, version, confirmed_at, created_at, updated_at)
     VALUES ($1,$2,$3,$4,'scripted-v1',NULL,$5,$5)`,
    [
      id,
      buyerId,
      b.need,
      JSON.stringify({ need: b.need, ceiling: null, option: null, language: null, terms: b.terms }),
      TS,
    ],
  );
  return id;
}
let briefs = 0;
const hash = (s: string): number => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7);

async function run(
  db: TestDb,
  model: ModelPort,
  b: { need: string; terms: string[] },
): Promise<DiscoveryResult> {
  const buyer = await addBuyer(db);
  const brief_id = await insertBrief(db, buyer, b);
  const deps: AgentDeps = depsWith(db, model);
  const r = await discover(deps, { actor: { kind: 'buyer', buyer_id: buyer }, brief_id });
  if (!r.ok) throw new Error(`discover failed: ${r.error.code}`);
  return r.value;
}
const emptyCatalogue = () => ({ ...extraData(), articles: [], offers: [] });
const proposal = (r: DiscoveryResult) => {
  if (r.kind !== 'proposal') throw new Error('expected proposal');
  return r.items;
};
const idOf = (i: { quote: { offer_id: string } }): string => i.quote.offer_id;

describe('exact copies take one slot', () => {
  let w: Awaited<ReturnType<typeof seededDb>>;
  beforeAll(async () => {
    w = await seededDb(emptyCatalogue());
    for (const p of ['p1', 'p2']) await addPublisher(w.db, p);
    // P1 holds 10 copies of one photo; P2 has 3 distinct matching offers.
    await addOffers(w.db, {
      pub: 'p1',
      prefix: 'p1',
      n: 10,
      title: 'Harbour photo {i}',
      sameSha: true,
    });
    await addOffers(w.db, { pub: 'p2', prefix: 'p2', n: 3, title: 'Harbour photo {i}' });
  }, 120_000);
  afterAll(async () => {
    await w.db.close();
  });

  it('hands the model one of the 10 copies, and the item says duplicates_hidden: 9', async () => {
    const m = pickingModel((ids) => ids.slice(0, 5));
    const items = proposal(await run(w.db, m.model, { need: 'harbour photo', terms: ['harbour'] }));
    const ids = candidateIdsOf(m.requests);
    expect(ids.filter((i) => pubOf(i) === 'p1')).toEqual(['ofr_p1_0001']);
    expect(ids.filter((i) => pubOf(i) === 'p2')).toHaveLength(3);
    const p1 = items.find((i) => idOf(i) === 'ofr_p1_0001')!;
    expect(p1.duplicates_hidden).toBe(9);
  });

  it('leaves duplicates_hidden out of an item that has no copy', async () => {
    const m = pickingModel((ids) => ids.slice(0, 5));
    const items = proposal(await run(w.db, m.model, { need: 'harbour photo', terms: ['harbour'] }));
    const p2 = items.filter((i) => idOf(i).startsWith('ofr_p2'));
    expect(p2.length).toBeGreaterThan(0);
    for (const i of p2) expect(Object.keys(i)).not.toContain('duplicates_hidden');
  });
});

describe('the size of a collection counts every offer of the publisher', () => {
  it('says 1000 for a collection of 1,000 offers whose candidates are 10', async () => {
    const w = await seededDb(emptyCatalogue());
    try {
      await addPublisher(w.db, 'p1');
      await addOffers(w.db, {
        pub: 'p1',
        prefix: 'p1',
        n: 1000,
        title: 'Photo {i}',
        topics: ['harbour'],
      });
      const m = pickingModel((ids) => ids.slice(0, 5));
      const items = proposal(await run(w.db, m.model, { need: 'harbour', terms: ['harbour'] }));
      expect(candidateIdsOf(m.requests).length).toBeLessThanOrEqual(10);
      expect(items).toHaveLength(5);
      for (const i of items)
        expect(i.collection).toEqual({ name: 'harbour', size: 1000, images: false });
    } finally {
      await w.db.close();
    }
  }, 120_000);
});

describe('every item carries its collection', () => {
  it('names the highest-count own topic, and other for an offer with no topic', async () => {
    const w = await seededDb(emptyCatalogue());
    try {
      await addPublisher(w.db, 'p1');
      await addPublisher(w.db, 'p2');
      await addOffers(w.db, {
        pub: 'p1',
        prefix: 'p1a',
        n: 4,
        title: 'Tide photo {i}',
        topics: ['tide', 'sea'],
      });
      await addOffers(w.db, {
        pub: 'p1',
        prefix: 'p1b',
        n: 2,
        title: 'Tide photo b{i}',
        topics: ['sea'],
      });
      await addOffers(w.db, {
        pub: 'p2',
        prefix: 'p2a',
        n: 3,
        title: 'Tide photo p{i}',
        topics: [],
      });
      const m = pickingModel((ids) => [
        ...ids.filter((i) => i.startsWith('ofr_p1a')).slice(0, 2),
        ...ids.filter((i) => i.startsWith('ofr_p2a')).slice(0, 2),
      ]);
      const items = proposal(await run(w.db, m.model, { need: 'tide photo', terms: ['tide'] }));
      expect(items).toHaveLength(4);
      for (const i of items) {
        expect(i.collection).toBeDefined();
        if (idOf(i).startsWith('ofr_p1a'))
          expect(i.collection).toEqual({ name: 'sea', size: 6, images: false });
        else expect(i.collection).toEqual({ name: 'other', size: 3, images: false });
      }
    } finally {
      await w.db.close();
    }
  });
});

describe('photos or items', () => {
  it('says images: true when the cover of the collection is an image, false otherwise', async () => {
    const w = await seededDb(emptyCatalogue());
    try {
      await addPublisher(w.db, 'p1');
      await addPublisher(w.db, 'p2');
      await addOffers(w.db, {
        pub: 'p1',
        prefix: 'p1',
        n: 3,
        title: 'Gull photo {i}',
        topics: ['gulls'],
        mime: 'image/jpeg',
      });
      await addOffers(w.db, {
        pub: 'p2',
        prefix: 'p2',
        n: 3,
        title: 'Gull notes {i}',
        topics: ['gulls'],
        mime: 'application/pdf',
      });
      const m = pickingModel((ids) => [
        ...ids.filter((i) => i.startsWith('ofr_p1')).slice(0, 1),
        ...ids.filter((i) => i.startsWith('ofr_p2')).slice(0, 1),
      ]);
      const items = proposal(await run(w.db, m.model, { need: 'gull', terms: ['gull'] }));
      expect(items).toHaveLength(2);
      for (const i of items)
        expect(i.collection).toEqual({
          name: 'gulls',
          size: 3,
          images: idOf(i).startsWith('ofr_p1'),
        });
    } finally {
      await w.db.close();
    }
  });
});

describe('the walk: 3 per publisher, 2 per collection, back-fill in the model order', () => {
  const info = (id: string) => {
    const pub = id.startsWith('A') ? 'P1' : 'P2';
    return { publisher: pub, collection: `${pub}/${id[0]}` };
  };
  const pick = (id: string) => ({ offer_id: id });
  const ids = (xs: { offer_id: string }[]) => xs.map((x) => x.offer_id);

  it('A1..A5 then B1..B3 give A1, A2, B1, B2, then A3', () => {
    const picks = ['A1', 'A2', 'A3', 'A4', 'A5', 'B1', 'B2', 'B3'].map(pick);
    expect(ids(spreadPicks(picks, info))).toEqual(['A1', 'A2', 'B1', 'B2', 'A3']);
  });

  it('one collection only still gives 5 items', () => {
    const picks = ['A1', 'A2', 'A3', 'A4', 'A5', 'A6'].map(pick);
    expect(ids(spreadPicks(picks, info))).toEqual(['A1', 'A2', 'A3', 'A4', 'A5']);
  });

  it('keeps the publisher cap of 3 in the first pass', () => {
    const two = (id: string) => ({ publisher: id[0]!, collection: id });
    const picks = ['A1', 'A2', 'A3', 'A4', 'B1', 'C1'].map(pick);
    expect(ids(spreadPicks(picks, two))).toEqual(['A1', 'A2', 'A3', 'B1', 'C1']);
  });

  it('answers fewer than 5 when there are fewer picks', () => {
    expect(ids(spreadPicks(['A1'].map(pick), info))).toEqual(['A1']);
    expect(spreadPicks([], info)).toEqual([]);
  });
});

describe('a one-collection world through discover', () => {
  it('5 picks of one collection still give 5 items', async () => {
    const w = await seededDb(emptyCatalogue());
    try {
      await addPublisher(w.db, 'p1');
      await addOffers(w.db, {
        pub: 'p1',
        prefix: 'p1',
        n: 20,
        title: 'Harbour sunset {i}',
        topics: ['harbour'],
      });
      const m = pickingModel((ids) => ids.slice(0, 5));
      const items = proposal(
        await run(w.db, m.model, { need: 'harbour sunset', terms: ['harbour'] }),
      );
      expect(items).toHaveLength(5);
    } finally {
      await w.db.close();
    }
  });
});
