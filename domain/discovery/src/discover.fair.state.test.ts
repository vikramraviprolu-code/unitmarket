// CAT-1.2 and CAT-1.3: after one publisher imports 1,000 photos, a buyer's request still reaches the other
// publishers' matching offers, and the five items are spread over publishers without shrinking.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AgentDeps, ModelPort, ModelRequest } from '@umsbx/contracts';
import { listAuthorisedOffers } from '@umsbx/catalogue';
import { discover } from './index';
import type { DiscoveryResult } from './index';
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
const firstOf = (ids: string[], pub: string, n: number): string[] =>
  ids.filter((i) => pubOf(i) === pub).slice(0, n);

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

let db: TestDb;
beforeAll(async () => {
  ({ db } = await seededDb(emptyCatalogue()));
  for (const p of ['p1', 'p2', 'p3', 'p4', 'p5']) await addPublisher(db, p);
  // P1 imports 1,000 photos, every one with the topic harbour.
  await addOffers(db, {
    pub: 'p1',
    prefix: 'p1',
    n: 1000,
    title: 'Photo {i}',
    topics: ['harbour'],
  });
  // P2..P5: 20 offers, 8 of which match "harbour at sunset".
  for (const p of ['p2', 'p3', 'p4', 'p5']) {
    await addOffers(db, { pub: p, prefix: `${p}m`, n: 2, title: 'Sunset over the harbour {i}' });
    await addOffers(db, { pub: p, prefix: `${p}o`, n: 3, title: 'Quarterly wheat prices {i}' });
  }
}, 120_000);
afterAll(async () => {
  await db.close();
});

const NEED = { need: 'harbour at sunset', terms: ['harbour', 'sunset'] };

describe('candidates after a bulk import', () => {
  it('hands the model all 8 matching offers of P2..P5 and at most 10 of P1', async () => {
    const m = pickingModel((ids) => ids.slice(0, 5));
    await run(db, m.model, NEED);
    expect(m.requests).toHaveLength(1);
    const ids = candidateIdsOf(m.requests);
    const matching = ids.filter((i) => /^ofr_p[2-5]m_/.test(i));
    expect(matching).toHaveLength(8);
    expect(ids.filter((i) => pubOf(i) === 'p1').length).toBeLessThanOrEqual(10);
    expect(ids.length).toBeLessThanOrEqual(50);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('the buyer sees a P2..P5 offer, not only P1 photos', async () => {
    const m = pickingModel((ids) => ids.filter((i) => /^ofr_p[2-5]m_/.test(i)).slice(0, 5));
    const r = await run(db, m.model, NEED);
    expect(r.kind).toBe('proposal');
    if (r.kind !== 'proposal') return;
    expect(r.items.length).toBe(5);
    expect(r.items.every((i) => i.publisher !== 'P1')).toBe(true);
  });

  it("a brief with no matching word gets today's candidates", async () => {
    const m = pickingModel((ids) => ids.slice(0, 5));
    await run(db, m.model, { need: 'zyxwv qponm', terms: ['zyxwv'] });
    const today = (await listAuthorisedOffers(db, { corridor_id: 'us-usd', limit: 50 })).map(
      (v) => v.offer.id,
    );
    expect(candidateIdsOf(m.requests)).toEqual(today);
  });
});

describe('the five items are spread over publishers', () => {
  it('5 picks from P1 plus 2 from P2 give 3 P1 and 2 P2', async () => {
    const m = pickingModel((ids) => [...firstOf(ids, 'p1', 5), ...firstOf(ids, 'p2', 2)]);
    const r = await run(db, m.model, NEED);
    expect(r.kind).toBe('proposal');
    if (r.kind !== 'proposal') return;
    expect(r.items).toHaveLength(5);
    expect(r.items.filter((i) => i.publisher === 'P1')).toHaveLength(3);
    expect(r.items.filter((i) => i.publisher === 'P2')).toHaveLength(2);
  });

  it('4 picks from P1, then 1 each from P2 and P3, keep 3 P1 + P2 + P3', async () => {
    const m = pickingModel((ids) => [
      ...firstOf(ids, 'p1', 4),
      ...firstOf(ids, 'p2', 1),
      ...firstOf(ids, 'p3', 1),
    ]);
    const r = await run(db, m.model, NEED);
    if (r.kind !== 'proposal') throw new Error('expected proposal');
    expect(r.items.map((i) => i.publisher).sort()).toEqual(['P1', 'P1', 'P1', 'P2', 'P3']);
  });

  it('with 3 P1 picks and one P2 pick the held-back P1 picks fill free slots', async () => {
    const m = pickingModel((ids) => [...firstOf(ids, 'p1', 4), ...firstOf(ids, 'p2', 1)]);
    const r = await run(db, m.model, NEED);
    if (r.kind !== 'proposal') throw new Error('expected proposal');
    expect(r.items).toHaveLength(5);
    expect(r.items.filter((i) => i.publisher === 'P1')).toHaveLength(4);
  });
});

describe('the spread keeps exactly 3 per publisher', () => {
  it('5 picks from P1 then one each from P2..P5 keep 3 P1, P2 and P3', async () => {
    const m = pickingModel((ids) => [
      ...firstOf(ids, 'p1', 5),
      ...['p2', 'p3', 'p4', 'p5'].flatMap((p) => firstOf(ids, p, 1)),
    ]);
    const r = await run(db, m.model, NEED);
    if (r.kind !== 'proposal') throw new Error('expected proposal');
    expect(r.items.map((i) => i.publisher).sort()).toEqual(['P1', 'P1', 'P1', 'P2', 'P3']);
  });
});

describe('a one-publisher world', () => {
  it('5 picks of one publisher still give 5 items', async () => {
    const solo = await seededDb(emptyCatalogue());
    try {
      await addPublisher(solo.db, 'p1');
      await addOffers(solo.db, { pub: 'p1', prefix: 'p1', n: 20, title: 'Harbour sunset {i}' });
      const m = pickingModel((ids) => ids.slice(0, 5));
      const r = await run(solo.db, m.model, NEED);
      if (r.kind !== 'proposal') throw new Error('expected proposal');
      expect(r.items).toHaveLength(5);
      expect(new Set(r.items.map((i) => i.publisher))).toEqual(new Set(['P1']));
    } finally {
      await solo.db.close();
    }
  });
});
