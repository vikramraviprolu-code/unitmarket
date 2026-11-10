// CAT-2.5 adversarial: no single buyer, publisher or typed string can make a term surface, and no answer holds
// anything but a term and a band.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { demandTerms } from './demand';
import { extraData, seededDb, type TestDb } from './support';

const TS = '2026-10-21T10:00:00.000Z';
const RIGHTS = JSON.stringify({ scope: 'personal_use', ai_scope: 'review', redistribution: false });
const FIXED = JSON.stringify({ renegotiation_allowed: false, floor_minor: null });
const OPTIONS = JSON.stringify([
  { option: 'keep_retrieve', price_minor: 500, policy_id: 'keep_retrieve', policy_version: '1' },
]);
const DAY = new Date('2026-11-20T00:00:00.000Z');
const at = (days: number): string => new Date(DAY.getTime() + days * 86_400_000).toISOString();

async function addPublisher(db: TestDb, id: string): Promise<void> {
  await db.query(
    `INSERT INTO publishers (id, slug, display_name, country, paypal_merchant_id, payee_verified_at, status, created_at, updated_at)
     VALUES ($1::text, $1::text, upper($1::text), 'US', 'MERCH' || upper($1::text), $2::timestamptz, 'active', $2::timestamptz, $2::timestamptz)`,
    [id, TS],
  );
}
let offerNo = 0;
async function addOffer(db: TestDb, pub: string, topics: string[]): Promise<void> {
  const n = String(++offerNo).padStart(4, '0');
  await db.query(
    `INSERT INTO articles (id, publisher_id, title, abstract, language, topics, published_at, sha256, content_key, bytes, mime, created_at, updated_at)
     VALUES ($1, $2, 'Title ' || $1, 'Abstract', 'en', $3::text[], $4::timestamptz, $5, 'key_' || $1, 10, 'text/plain', $4::timestamptz, $4::timestamptz)`,
    [`art_x${n}`, pub, topics, TS, `${n}${'b'.repeat(60)}`],
  );
  await db.query(
    `INSERT INTO offers (id, version, publisher_id, article_id, status, currency, options, affordability, terms_version, rights, valid_from, valid_until, superseded_by, created_at, updated_at)
     VALUES ($1, '1', $2, $3, 'authorised', 'USD', $4::jsonb, $5::jsonb, 'terms-1', $6::jsonb, '2026-01-01T00:00:00.000Z', NULL, NULL, $7::timestamptz, $7::timestamptz)`,
    [`ofr_x${n}`, pub, `art_x${n}`, OPTIONS, FIXED, RIGHTS, TS],
  );
  await db.query(
    `INSERT INTO publisher_authorisations (id, offer_id, offer_version, authorised_by, at, created_at, updated_at)
     VALUES ($1, $2, '1', $3, $4::timestamptz, $4::timestamptz, $4::timestamptz)`,
    [`auth_x${n}`, `ofr_x${n}`, pub, TS],
  );
}
let buyerNo = 0;
let briefNo = 0;
/** Five buyers, old enough to count, each with one brief whose structured JSON is `structured`. */
async function five(db: TestDb, structured: unknown, raw = 'plain request'): Promise<void> {
  for (let i = 0; i < 5; i++) {
    const id = `buy_ax${++buyerNo}`;
    await db.query(
      `INSERT INTO buyers (id, display_name, auth_subject, country, created_at, updated_at) VALUES ($1,$2,$3,'US',$4,$4)`,
      [id, `B ${buyerNo}`, `sub-ax-${buyerNo}`, at(-20)],
    );
    await db.query(
      `INSERT INTO briefs (id, buyer_id, raw_text, structured, version, confirmed_at, created_at, updated_at)
       VALUES ($1,$2,$3,$4::jsonb,'scripted-v1',NULL,$5,$5)`,
      [`brf_ax${++briefNo}`, id, raw, JSON.stringify(structured), at(-2)],
    );
  }
}
const asks = (terms: unknown) => ({
  need: 'n',
  ceiling: null,
  option: null,
  language: null,
  terms,
});

let db: TestDb;
beforeEach(async () => {
  ({ db } = await seededDb({ ...extraData(), articles: [], offers: [] }));
  await addPublisher(db, 'p1');
  await addPublisher(db, 'p2');
  await addOffer(db, 'p1', ['harbour']);
  await addOffer(db, 'p2', ['harbour']);
  await addOffer(db, 'p1', ['johnxcom']);
  await addOffer(db, 'p2', ['johnxcom']);
  await addOffer(db, 'p1', ['droptable']);
  await addOffer(db, 'p2', ['droptable']);
});
afterEach(async () => {
  await db.close();
});
const terms = () => demandTerms(db, { day: DAY, limit: 10 });

describe('one publisher cannot make a term surface', () => {
  it('jane doe: one offer in one catalogue and 5 buyers never surfaces', async () => {
    await addOffer(db, 'p1', ['jane doe']);
    await five(db, asks(['jane doe']));
    expect(await terms()).toEqual([]);
  });

  it('many offers of one publisher with the topic are still one publisher', async () => {
    for (let i = 0; i < 6; i++) await addOffer(db, 'p1', ['jane doe']);
    await five(db, asks(['jane doe']));
    expect(await terms()).toEqual([]);
  });

  it('a second publisher with only part of the phrase does not help', async () => {
    await addOffer(db, 'p1', ['jane doe']);
    await addOffer(db, 'p2', ['jane']);
    await five(db, asks(['jane doe']));
    expect(await terms()).toEqual([]);
  });
});

describe('a term is dropped whole, never stripped', () => {
  it('drops john@x.com instead of reading it as johnxcom', async () => {
    await five(db, asks(['john@x.com']));
    expect(await terms()).toEqual([]);
  });

  it.each([
    ['punctuation', 'harbour!'],
    ['an underscore', 'har_bour'],
    ['a regex dot', 'harb.ur'],
    ['a regex star', 'harbour.*'],
    ['too short', 'ha'],
    ['too long', 'h'.repeat(41)],
    ['a quote', "x'; drop table briefs;--"],
    ['a bracket', '(harbour)'],
    ['a backslash', 'harbour\\'],
    ['a newline', 'harbour\nlights'],
    ['a tab', 'harbour\tlights'],
    ['an empty string', ''],
  ])('drops %s', async (_label, term) => {
    await five(db, asks([term]));
    expect(await terms()).toEqual([]);
  });

  it('keeps a 3 letter term, the shortest the rule allows', async () => {
    await addOffer(db, 'p1', ['abc']);
    await addOffer(db, 'p2', ['abc']);
    await five(db, asks(['abc']));
    expect(await terms()).toEqual([{ term: 'abc', band: '5-9' }]);
  });
});

describe('the structured JSON is untrusted', () => {
  it.each([
    ['a string', asks('harbour')],
    ['an object', asks({ 0: 'harbour' })],
    ['a number', asks(7)],
    ['null', asks(null)],
    ['no terms key', { need: 'harbour' }],
    ['a JSON string', 'harbour'],
    ['a JSON array', ['harbour']],
    ['null structured', null],
  ])('skips terms that are %s', async (_label, structured) => {
    await five(db, structured);
    expect(await terms()).toEqual([]);
  });

  it('skips elements that are not strings and still reads the strings beside them', async () => {
    await five(db, asks(['harbour', 7, null, {}, ['harbour'], true]));
    expect(await terms()).toEqual([{ term: 'harbour', band: '5-9' }]);
  });
});

describe('the answer holds nothing but a term and a band', () => {
  it('has exactly the keys term and band, no id and no raw text', async () => {
    await five(db, asks(['harbour']), 'zebra confidential request from Jane Doe');
    const got = await terms();
    expect(got).toHaveLength(1);
    for (const g of got) expect(Object.keys(g).sort()).toEqual(['band', 'term']);
    const text = JSON.stringify(got);
    expect(text).not.toMatch(/buy_|brf_|zebra|confidential|jane/i);
    expect(['5-9', '10-49', '50+']).toContain(got[0]!.band);
  });
});
