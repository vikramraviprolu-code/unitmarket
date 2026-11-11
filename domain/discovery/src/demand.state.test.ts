// CAT-2.5: demandTerms and demandForPublisher. A term surfaces only when 5 or more distinct buyers asked for it in
// the closed window [day - 30 days, day), buyers who joined in the last 7 days of the window do not count, and at
// least two publishers have a current authorised offer with that topic. The answer is a band, never a count.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { collectionFacts } from './collections';
import { MIN_BUYERS, demandForPublisher, demandTerms } from './demand';
import { extraData, seededDb, type TestDb } from './support';

const TS = '2026-10-21T10:00:00.000Z';
const RIGHTS = JSON.stringify({ scope: 'personal_use', ai_scope: 'review', redistribution: false });
const FIXED = JSON.stringify({ renegotiation_allowed: false, floor_minor: null });
const OPTIONS = JSON.stringify([
  { option: 'keep_retrieve', price_minor: 500, policy_id: 'keep_retrieve', policy_version: '1' },
]);
const DAY = new Date('2026-11-20T00:00:00.000Z');
const at = (days: number, extraMs = 0): string =>
  new Date(DAY.getTime() + days * 86_400_000 + extraMs).toISOString();

async function addPublisher(db: TestDb, id: string, status = 'active'): Promise<void> {
  await db.query(
    `INSERT INTO publishers (id, slug, display_name, country, paypal_merchant_id, payee_verified_at, status, created_at, updated_at)
     VALUES ($1::text, $1::text, upper($1::text), 'US', 'MERCH' || upper($1::text), $2::timestamptz, $3::text, $2::timestamptz, $2::timestamptz)`,
    [id, TS, status],
  );
}
let offerNo = 0;
async function addOffer(
  db: TestDb,
  pub: string,
  topics: string[],
  o: { authorised?: boolean; status?: string } = {},
): Promise<string> {
  const n = String(++offerNo).padStart(4, '0');
  const sha = `${n}${'a'.repeat(60)}`;
  await db.query(
    `INSERT INTO articles (id, publisher_id, title, abstract, language, topics, published_at, sha256, content_key, bytes, mime, created_at, updated_at)
     VALUES ($1::text, $2, 'Title ' || $1::text, 'Abstract', 'en', $3::text[], $4::timestamptz, $5, 'key_' || $1::text, 10, 'text/plain', $4::timestamptz, $4::timestamptz)`,
    [`art_d${n}`, pub, topics, TS, sha],
  );
  await db.query(
    `INSERT INTO offers (id, version, publisher_id, article_id, status, currency, options, affordability, terms_version, rights, valid_from, valid_until, superseded_by, created_at, updated_at)
     VALUES ($1, '1', $2, $3, $4, 'USD', $5::jsonb, $6::jsonb, 'terms-1', $7::jsonb, '2026-01-01T00:00:00.000Z', NULL, NULL, $8::timestamptz, $8::timestamptz)`,
    [`ofr_d${n}`, pub, `art_d${n}`, o.status ?? 'authorised', OPTIONS, FIXED, RIGHTS, TS],
  );
  if (o.authorised ?? true) {
    await db.query(
      `INSERT INTO publisher_authorisations (id, offer_id, offer_version, authorised_by, at, created_at, updated_at)
       VALUES ($1, $2, '1', $3, $4::timestamptz, $4::timestamptz, $4::timestamptz)`,
      [`auth_d${n}`, `ofr_d${n}`, pub, TS],
    );
  }
  return `ofr_d${n}`;
}

let buyerNo = 0;
/** n new buyers created at `createdAt`. */
async function addBuyers(db: TestDb, n: number, createdAt: string): Promise<string[]> {
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const id = `buy_dm${++buyerNo}`;
    await db.query(
      `INSERT INTO buyers (id, display_name, auth_subject, country, created_at, updated_at) VALUES ($1,$2,$3,'US',$4,$4)`,
      [id, `Buyer ${buyerNo}`, `sub-dm-${buyerNo}`, createdAt],
    );
    out.push(id);
  }
  return out;
}
let briefNo = 0;
async function addBrief(
  db: TestDb,
  buyer: string,
  terms: unknown,
  createdAt: string,
  raw = 'a request',
): Promise<void> {
  await db.query(
    `INSERT INTO briefs (id, buyer_id, raw_text, structured, version, confirmed_at, created_at, updated_at)
     VALUES ($1,$2,$3,$4::jsonb,'scripted-v1',NULL,$5,$5)`,
    [
      `brf_dm${++briefNo}`,
      buyer,
      raw,
      JSON.stringify({ need: raw, ceiling: null, option: null, language: null, terms }),
      createdAt,
    ],
  );
}
/** n buyers, created 20 days before `day`, each with one brief 2 days before `day`, all asking `term`. */
async function crowd(db: TestDb, n: number, term: string): Promise<string[]> {
  const buyers = await addBuyers(db, n, at(-20));
  for (const b of buyers) await addBrief(db, b, [term], at(-2));
  return buyers;
}

let db: TestDb;
beforeEach(async () => {
  ({ db } = await seededDb({ ...extraData(), articles: [], offers: [] }));
  for (const p of ['p1', 'p2']) await addPublisher(db, p);
  for (const t of ['harbour', 'sunset', 'tides', 'anchor', 'art']) {
    await addOffer(db, 'p1', [t]);
    await addOffer(db, 'p2', [t]);
  }
  await addOffer(db, 'p1', ['start']);
  await addOffer(db, 'p2', ['smart']);
});
afterEach(async () => {
  await db.close();
});
const terms = (limit = 10, day = DAY) => demandTerms(db, { day, limit });

describe('thresholds and bands', () => {
  it('exports MIN_BUYERS = 5, and the function has no parameter for it', () => {
    expect(MIN_BUYERS).toBe(5);
    expect(demandTerms.length).toBe(2);
  });

  it('4 buyers: absent. 5 buyers: present with band 5-9', async () => {
    await crowd(db, 4, 'harbour');
    expect(await terms()).toEqual([]);
    await crowd(db, 1, 'harbour');
    expect(await terms()).toEqual([{ term: 'harbour', band: '5-9' }]);
  });

  it('bands: 9 is 5-9, 10 is 10-49, 49 is 10-49, 50 is 50+', async () => {
    await crowd(db, 9, 'harbour');
    expect(await terms()).toEqual([{ term: 'harbour', band: '5-9' }]);
    await crowd(db, 1, 'harbour');
    expect(await terms()).toEqual([{ term: 'harbour', band: '10-49' }]);
    await crowd(db, 39, 'harbour');
    expect(await terms()).toEqual([{ term: 'harbour', band: '10-49' }]);
    await crowd(db, 1, 'harbour');
    expect(await terms()).toEqual([{ term: 'harbour', band: '50+' }]);
  }, 60_000);

  it('one buyer with 50 briefs counts once', async () => {
    const [b] = await addBuyers(db, 1, at(-20));
    for (let i = 0; i < 50; i++) await addBrief(db, b!, ['harbour'], at(-3));
    expect(await terms()).toEqual([]);
    await crowd(db, 3, 'harbour');
    expect(await terms()).toEqual([]);
    await crowd(db, 1, 'harbour');
    expect(await terms()).toEqual([{ term: 'harbour', band: '5-9' }]);
  }, 60_000);

  it('merges case and spaces: " Harbour " and "HARBOUR" are the same term', async () => {
    const bs = await addBuyers(db, 5, at(-20));
    for (const [i, b] of bs.entries())
      await addBrief(db, b, [i % 2 ? ' Harbour ' : 'HARBOUR'], at(-2));
    expect(await terms()).toEqual([{ term: 'harbour', band: '5-9' }]);
  });
});

describe('the window is [day - 30 days, day)', () => {
  const askAt = async (when: string, buyers?: string[]): Promise<void> => {
    const bs = buyers ?? (await addBuyers(db, 5, at(-40)));
    for (const b of bs) await addBrief(db, b, ['harbour'], when);
  };

  it('ignores briefs older than 30 days and keeps one exactly 30 days old', async () => {
    await askAt(at(-30, -1));
    expect(await terms()).toEqual([]);
    await askAt(at(-30));
    expect(await terms()).toEqual([{ term: 'harbour', band: '5-9' }]);
  });

  it('ignores a brief created at day or later, so today changes nothing until tomorrow', async () => {
    await crowd(db, 4, 'harbour');
    const [extra] = await addBuyers(db, 1, at(-40));
    const before = await terms();
    await addBrief(db, extra!, ['harbour'], at(0, 5 * 3_600_000));
    expect(await terms()).toEqual(before);
    await addBrief(db, extra!, ['harbour'], at(0));
    expect(await terms()).toEqual(before);
    // The next day the same brief is inside the window.
    const tomorrow = new Date(DAY.getTime() + 86_400_000);
    expect(await terms(10, tomorrow)).toEqual([{ term: 'harbour', band: '5-9' }]);
  });
});

describe('fresh buyers do not count', () => {
  it('leaves out buyers created in the last 7 days of the window', async () => {
    const fresh = await addBuyers(db, 5, at(-3));
    for (const b of fresh) await addBrief(db, b, ['harbour'], at(-1));
    expect(await terms()).toEqual([]);
  });

  it('counts a buyer created 7 days and one second before day, not one created exactly 7 days before', async () => {
    const old = await addBuyers(db, 4, at(-7, -1000));
    const edge = await addBuyers(db, 1, at(-7));
    for (const b of [...old, ...edge]) await addBrief(db, b, ['harbour'], at(-1));
    expect(await terms()).toEqual([]);
    const [more] = await addBuyers(db, 1, at(-8));
    await addBrief(db, more!, ['harbour'], at(-1));
    expect(await terms()).toEqual([{ term: 'harbour', band: '5-9' }]);
  });
});

describe('a term needs offers at two publishers', () => {
  it('whole-word matches: art surfaces from the topic art, not from start or smart', async () => {
    await crowd(db, 5, 'art');
    expect(await terms()).toEqual([{ term: 'art', band: '5-9' }]);
  });

  it('does not surface a term that only part of a topic contains', async () => {
    await crowd(db, 5, 'sta');
    expect(await terms()).toEqual([]);
  });

  it('does not count a suspended publisher, an unauthorised offer or a withdrawn offer', async () => {
    await addPublisher(db, 'p3', 'suspended');
    await addOffer(db, 'p3', ['quiet']);
    await addOffer(db, 'p1', ['quiet']);
    await addOffer(db, 'p2', ['quiet'], { authorised: false, status: 'draft' });
    await crowd(db, 5, 'quiet');
    expect(await terms()).toEqual([]);
    await addOffer(db, 'p2', ['quiet']);
    expect(await terms()).toEqual([{ term: 'quiet', band: '5-9' }]);
  });
});

describe('order and limit', () => {
  it('orders by band, high first, then by term, and keeps at most limit', async () => {
    await crowd(db, 50, 'tides');
    await crowd(db, 10, 'harbour');
    await crowd(db, 5, 'sunset');
    await crowd(db, 5, 'anchor');
    expect(await terms()).toEqual([
      { term: 'tides', band: '50+' },
      { term: 'harbour', band: '10-49' },
      { term: 'anchor', band: '5-9' },
      { term: 'sunset', band: '5-9' },
    ]);
    expect(await terms(3)).toEqual([
      { term: 'tides', band: '50+' },
      { term: 'harbour', band: '10-49' },
      { term: 'anchor', band: '5-9' },
    ]);
  }, 120_000);
});

describe('demandForPublisher', () => {
  it('adds how many of the publisher offers have the topic', async () => {
    await addOffer(db, 'p1', ['harbour']);
    await addOffer(db, 'p1', ['Harbour Lights']);
    await addOffer(db, 'p1', ['harbour'], { authorised: false, status: 'draft' });
    await crowd(db, 5, 'harbour');
    await crowd(db, 5, 'sunset');
    const t = await terms();
    expect(await demandForPublisher(db, 'p1', t)).toEqual([
      { term: 'harbour', band: '5-9', matching: 3 },
      { term: 'sunset', band: '5-9', matching: 1 },
    ]);
    expect(await demandForPublisher(db, 'p2', t)).toEqual([
      { term: 'harbour', band: '5-9', matching: 1 },
      { term: 'sunset', band: '5-9', matching: 1 },
    ]);
  });

  it('gives matching 0 to a publisher with no such offer, and [] for no terms', async () => {
    await addPublisher(db, 'p4');
    await crowd(db, 5, 'harbour');
    expect(await demandForPublisher(db, 'p4', await terms())).toEqual([
      { term: 'harbour', band: '5-9', matching: 0 },
    ]);
    expect(await demandForPublisher(db, 'p1', [])).toEqual([]);
  });
});

describe('collectionFacts', () => {
  const newerWithdrawn = (id: string) =>
    db.query(
      `INSERT INTO offers (id, version, publisher_id, article_id, status, currency, options, affordability, terms_version, rights, valid_from, valid_until, superseded_by, created_at, updated_at)
       SELECT id, '2', publisher_id, article_id, 'withdrawn', currency, options, affordability, terms_version, rights, valid_from, NULL, NULL, created_at + interval '1 day', created_at + interval '1 day'
         FROM offers WHERE id = $1::text`,
      [id],
    );

  it('counts every current authorised offer of the publisher once per offer and topic', async () => {
    const dup = await addOffer(db, 'p1', ['harbour', 'Harbour ', 'sea']);
    await addOffer(db, 'p1', []);
    await addOffer(db, 'p1', ['  ']);
    await addOffer(db, 'p1', ['harbour'], { authorised: false, status: 'draft' });
    const gone = await addOffer(db, 'p1', ['harbour']);
    await newerWithdrawn(gone);
    const f = await collectionFacts(db, ['p1', 'p2'], [dup]);
    expect(f.topicCounts.get('p1')!.get('harbour')).toBe(2);
    expect(f.topicCounts.get('p1')!.get('sea')).toBe(1);
    expect(f.topicCounts.get('p1')!.get('')).toBe(2);
    expect(f.topicCounts.get('p2')!.get('harbour')).toBe(1);
    expect(f.topicCounts.get('p2')!.has('')).toBe(false);
  });

  it('does not count a suspended publisher', async () => {
    await addPublisher(db, 'p5', 'suspended');
    await addOffer(db, 'p5', ['harbour']);
    const f = await collectionFacts(db, ['p5'], []);
    expect(f.topicCounts.has('p5')).toBe(false);
  });

  it('reads topics and mime of the requested offers only', async () => {
    const id = await addOffer(db, 'p1', ['Zed']);
    const f = await collectionFacts(db, ['p1'], [id]);
    expect(f.rows).toEqual([
      { offer_id: id, publisher_id: 'p1', topics: ['Zed'], mime: 'text/plain' },
    ]);
  });

  it('answers nothing for no publishers', async () => {
    const f = await collectionFacts(db, [], ['ofr_d0001']);
    expect(f.rows).toEqual([]);
    expect(f.topicCounts.size).toBe(0);
  });
});

describe('demand: more edges', () => {
  it('orders equal bands by term, whatever the insertion order', async () => {
    await crowd(db, 5, 'sunset');
    await crowd(db, 5, 'anchor');
    await crowd(db, 5, 'harbour');
    expect((await terms()).map((t) => t.term)).toEqual(['anchor', 'harbour', 'sunset']);
  });

  it('reads a padded element of 1000 characters and skips one of 1001', async () => {
    await crowd(db, 5, `${' '.repeat(496)}harbour${' '.repeat(497)}`);
    expect(await terms()).toEqual([{ term: 'harbour', band: '5-9' }]);
    await crowd(db, 5, `${' '.repeat(496)}sunset${' '.repeat(499)}`);
    expect((await terms()).map((t) => t.term)).toEqual(['harbour']);
  });

  it('does not count an offer whose newest version is withdrawn', async () => {
    await addOffer(db, 'p1', ['quiet']);
    const id = await addOffer(db, 'p2', ['quiet']);
    await db.query(
      `INSERT INTO offers (id, version, publisher_id, article_id, status, currency, options, affordability, terms_version, rights, valid_from, valid_until, superseded_by, created_at, updated_at)
       SELECT id, '2', publisher_id, article_id, 'withdrawn', currency, options, affordability, terms_version, rights, valid_from, NULL, NULL, created_at + interval '1 day', created_at + interval '1 day'
         FROM offers WHERE id = $1::text`,
      [id],
    );
    await crowd(db, 5, 'quiet');
    expect(await terms()).toEqual([]);
    expect(await demandForPublisher(db, 'p2', [{ term: 'quiet', band: '5-9' }])).toEqual([
      { term: 'quiet', band: '5-9', matching: 0 },
    ]);
  });
});

describe('demand: the day is floored in the domain', () => {
  it('gives the same answer for 13:00 UTC as for 00:00 UTC of that day', async () => {
    // A brief at 06:00 on the day itself is inside a rolling window and outside the closed one.
    const bs = await addBuyers(db, 5, at(-20));
    for (const b of bs.slice(0, 4)) await addBrief(db, b, ['harbour'], at(-2));
    await addBrief(db, bs[4]!, ['harbour'], at(0, 6 * 3_600_000));
    const noon = new Date(DAY.getTime() + 13 * 3_600_000);
    expect(await terms(10, noon)).toEqual(await terms(10, DAY));
    expect(await terms(10, noon)).toEqual([]);
  });
});
