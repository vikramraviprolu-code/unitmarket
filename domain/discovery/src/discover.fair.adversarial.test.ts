// CAT-1 adversarial: keyword stuffing, metacharacters, oversize words and needs, two corridors, and
// excluded versions never use a publisher's slots.
import { afterEach, describe, expect, it } from 'vitest';
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

const open: TestDb[] = [];
async function world(publishers: string[]): Promise<TestDb> {
  const { db } = await seededDb(emptyCatalogue());
  open.push(db);
  for (const p of publishers) await addPublisher(db, p);
  return db;
}
afterEach(async () => {
  while (open.length > 0) await open.pop()!.close();
});

const ONE = (ids: string[]) => ids.slice(0, 5);
const candidates = async (db: TestDb, b: { need: string; terms: string[] }) => {
  const m = pickingModel(ONE);
  await run(db, m.model, b);
  return { ids: m.requests.length > 0 ? candidateIdsOf(m.requests) : [], calls: m.requests.length };
};
const count = (ids: string[], pub: string): number => ids.filter((i) => pubOf(i) === pub).length;

describe('keyword stuffing', () => {
  it('one publisher with 20 topics per offer covering every brief word keeps at most 10 candidates', async () => {
    const db = await world(['p1', 'p2']);
    const topics = ['harbour', 'sunset', ...Array.from({ length: 18 }, (_, i) => `filler${i}`)];
    await addOffers(db, {
      pub: 'p1',
      prefix: 'p1',
      n: 200,
      title: 'Stuffed {i}',
      abstract: 'harbour sunset',
      topics,
    });
    await addOffers(db, { pub: 'p2', prefix: 'p2', n: 4, title: 'Sunset harbour {i}' });
    const { ids } = await candidates(db, {
      need: 'harbour at sunset',
      terms: ['harbour', 'sunset'],
    });
    expect(count(ids, 'p1')).toBeLessThanOrEqual(10);
    expect(count(ids, 'p2')).toBe(4);
  });
});

describe('metacharacters and oversize input', () => {
  it("words with % _ ' \\ .* or );-- neither error nor widen the match", async () => {
    const db = await world(['p1', 'p2']);
    await addOffers(db, { pub: 'p1', prefix: 'p1', n: 20, title: 'Harbour {i}' });
    await addOffers(db, { pub: 'p2', prefix: 'p2', n: 20, title: 'Wheat {i}' });
    const weird = ['%', '_', "'", '\\', '.*', ');--'];
    // Only metacharacters: nothing matches, so today's candidates are used and nothing breaks.
    const only = await candidates(db, { need: 'zzz', terms: weird });
    const today = (await listAuthorisedOffers(db, { corridor_id: 'us-usd', limit: 50 })).map(
      (v) => v.offer.id,
    );
    expect(only.ids).toEqual(today);
    // Next to a real word they add nothing: only harbour offers are candidates.
    const mixed = await candidates(db, { need: 'harbour', terms: [...weird, 'harbour'] });
    expect(mixed.ids.length).toBeGreaterThan(0);
    expect(count(mixed.ids, 'p2')).toBe(0);
    expect(count(mixed.ids, 'p1')).toBeLessThanOrEqual(10);
  });

  it('one 2,000-character word is cut to 40 characters', async () => {
    const db = await world(['p1', 'p2']);
    const forty = 'x'.repeat(40);
    await addOffers(db, { pub: 'p1', prefix: 'p1', n: 1, title: forty });
    await addOffers(db, { pub: 'p2', prefix: 'p2', n: 30, title: 'Wheat {i}' });
    const { ids, calls } = await candidates(db, { need: 'x'.repeat(2000), terms: [] });
    expect(calls).toBe(1);
    expect(ids).toEqual(['ofr_p1_0001']);
  });

  it('a 2,000-character need gives at most 12 words and one model call', async () => {
    const db = await world(['p1', 'p2']);
    const letters = 'abcdefghijklmnopqrstuvwxyz'.split('').map((c) => c.repeat(3));
    await addOffers(db, { pub: 'p1', prefix: 'p1', n: 1, title: 'aaa' });
    await addOffers(db, { pub: 'p2', prefix: 'p2', n: 1, title: 'zzz' });
    let need = '';
    while (need.length < 2000) need += `${letters.join(' ')} `;
    const { ids, calls } = await candidates(db, { need: need.slice(0, 2000), terms: [] });
    expect(calls).toBe(1);
    expect(ids).toEqual(['ofr_p1_0001']);
  });
});

describe('slots', () => {
  it('the same offer reached through two corridors counts once and uses one slot', async () => {
    const db = await world(['p1', 'p2', 'p3']);
    await db.query(
      `INSERT INTO corridors (id, currency, minor_units, buyer_countries, payee_countries, domestic_supported, min_charge_minor, enabled, created_at, updated_at)
       VALUES ('xx-usd', 'USD', 2, ARRAY['US'], ARRAY['US'], true, NULL, true, $1, $1)`,
      [TS],
    );
    await addOffers(db, { pub: 'p1', prefix: 'p1', n: 12, title: 'Twincorr {i}' });
    await addOffers(db, { pub: 'p2', prefix: 'p2', n: 10, title: 'Twincorr {i}' });
    await addOffers(db, { pub: 'p3', prefix: 'p3', n: 3, title: 'Twincorr {i}' });
    const { ids } = await candidates(db, { need: 'twincorr', terms: ['twincorr'] });
    expect(new Set(ids).size).toBe(ids.length);
    expect(count(ids, 'p1')).toBe(10);
    expect(count(ids, 'p2')).toBe(10);
    expect(count(ids, 'p3')).toBe(3);
  });

  it("a superseded or unauthorised P2 version does not use one of P2's 10 slots", async () => {
    const db = await world(['p2']);
    await addOffers(db, {
      pub: 'p2',
      prefix: 'p2d',
      n: 5,
      title: 'Slotword slotword',
      topics: ['slotword'],
      superseded: true,
    });
    await addOffers(db, {
      pub: 'p2',
      prefix: 'p2e',
      n: 5,
      title: 'Slotword slotword',
      topics: ['slotword'],
      authorised: false,
    });
    await addOffers(db, { pub: 'p2', prefix: 'p2f', n: 10, title: 'Slotword live {i}' });
    const { ids } = await candidates(db, { need: 'slotword', terms: ['slotword'] });
    expect(ids).toHaveLength(10);
    expect(ids.every((i) => i.startsWith('ofr_p2f_'))).toBe(true);
  });
});

describe('whole words and case', () => {
  it('"art" does not match "start"', async () => {
    const db = await world(['p2', 'p3']);
    await addOffers(db, { pub: 'p2', prefix: 'p2', n: 1, title: 'We start now' });
    await addOffers(db, { pub: 'p3', prefix: 'p3', n: 1, title: 'The Art of tides' });
    const { ids } = await candidates(db, { need: 'art', terms: ['art'] });
    expect(ids).toEqual(['ofr_p3_0001']);
  });

  it('ASCII case is folded: HARBOUR in a title matches the word harbour', async () => {
    const db = await world(['p2']);
    await addOffers(db, { pub: 'p2', prefix: 'p2', n: 1, title: 'HARBOUR LIGHTS' });
    await addOffers(db, { pub: 'p2', prefix: 'p2x', n: 1, title: 'Wheat' });
    const { ids } = await candidates(db, { need: 'harbour', terms: ['harbour'] });
    expect(ids).toEqual(['ofr_p2_0001']);
  });
});
