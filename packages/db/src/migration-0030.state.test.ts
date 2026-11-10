// POB-I1: migration 0030 (publisher_domains, import_batches, import_items). Forward-only. The CHECKs hold what
// no later change may loosen: lengths, the 8 topics of 40, the states, one active batch per publisher, one
// verified owner per host. Two triggers: a domain only moves from pending to verified, and an item belongs to
// the publisher of its batch (and, once published, to the publisher of its article). Tolerates later
// migrations: it never checks an exact list of migrations or tables.
import { readdirSync, readFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import type { Database } from '@umsbx/contracts';
import { migrate, openDatabase } from './index';

const T = '2026-11-05T10:00:00Z';
const T2 = '2026-11-05T11:00:00Z';
const clock = { now: () => new Date(T) };
type Db = Database & { close(): Promise<void> };
const toClose: Db[] = [];
afterAll(async () => {
  for (const d of toClose) await d.close();
});
async function fresh(): Promise<Db> {
  const d = await openDatabase({ kind: 'pglite-memory' });
  toClose.push(d);
  await migrate(d, clock);
  return d;
}
const SHA = 'a'.repeat(64);
const SHA2 = 'b'.repeat(64);

async function publisher(d: Db, id: string): Promise<void> {
  await d.query(
    `INSERT INTO publishers (id, slug, display_name, country, created_at, updated_at)
     VALUES ($1, $2, $2, 'US', $3, $3)`,
    [id, id.replace('pub_', 'slug-'), T],
  );
}
async function article(d: Db, id: string, publisher_id: string): Promise<void> {
  await d.query(
    `INSERT INTO articles (id, publisher_id, title, abstract, language, topics, published_at, sha256, content_key, bytes, mime, created_at, updated_at)
     VALUES ($1,$2,'T','A','en',ARRAY['t'],$3,$4,$5,1,'text/plain',$3,$3)`,
    [id, publisher_id, T, SHA, `k/${id}`],
  );
}
const ins = (d: Db, table: string, r: Record<string, unknown>): Promise<unknown> => {
  const cols = Object.keys(r);
  return d.query(
    `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`,
    cols.map((c) => r[c]),
  );
};
const domain = (d: Db, o: Record<string, unknown> = {}) =>
  ins(d, 'publisher_domains', {
    id: 'pdm_1',
    publisher_id: 'pub_a',
    host: 'shop.pub-one.invalid',
    token_hash: SHA,
    state: 'pending',
    requested_at: T,
    verified_at: null,
    created_at: T,
    updated_at: T,
    ...o,
  });
const batch = (d: Db, o: Record<string, unknown> = {}) =>
  ins(d, 'import_batches', {
    id: 'imb_1',
    publisher_id: 'pub_a',
    source_host: 'shop.pub-one.invalid',
    source_url: 'https://shop.pub-one.invalid/catalogue',
    state: 'queued',
    note: null,
    total: 0,
    done: 0,
    refused: 0,
    existing: 0,
    changed: 0,
    attested_at: null,
    attestation_version: null,
    created_by: 'pub_a',
    created_at: T,
    started_at: null,
    finished_at: null,
    updated_at: T,
    ...o,
  });
const item = (d: Db, o: Record<string, unknown> = {}) =>
  ins(d, 'import_items', {
    id: 'imi_1',
    batch_id: 'imb_1',
    publisher_id: 'pub_a',
    source_key: 'https://shop.pub-one.invalid/a/one',
    kind: 'article',
    title: 'One',
    summary: 'Summary one',
    language: 'en',
    topics: ['a'],
    price_minor: 150,
    source_price_minor: 150,
    currency: 'USD',
    image_ref: null,
    content_ref: 'import/slug-a/aaaa.txt',
    content_sha256: SHA,
    content_mime: 'text/plain',
    content_bytes: 20,
    source_published_at: T,
    state: 'staged',
    reason: null,
    article_id: null,
    offer_id: null,
    created_at: T,
    updated_at: T,
    ...o,
  });
const bad = async (p: Promise<unknown>): Promise<void> => {
  await expect(p).rejects.toThrow();
};

describe('migration 0030', () => {
  it('is applied once, after 0027, with no down step and no default value', async () => {
    const d = await openDatabase({ kind: 'pglite-memory' });
    toClose.push(d);
    const first = await migrate(d, clock);
    const name = first.find((n) => n.startsWith('0030_'));
    expect(name).toBeDefined();
    expect(first.indexOf(name!)).toBeGreaterThan(first.indexOf('0027_rule_settings'));
    expect(await migrate(d, clock)).toEqual([]);
    const dir = new URL('../migrations/common/', import.meta.url);
    expect(readdirSync(dir).filter((n) => /^0030_.*(down|rollback)/i.test(n))).toEqual([]);
    const file = readdirSync(dir).find((n) => n.startsWith('0030_'))!;
    const sql = readFileSync(new URL(file, dir), 'utf8').replace(/--.*$/gm, '');
    expect(sql).not.toMatch(/\bnow\s*\(/i);
    expect(sql).not.toMatch(/\bDEFAULT\b/i);
  });

  it('has the documented columns', async () => {
    const d = await fresh();
    const cols = async (t: string) =>
      (
        await d.query<{ column_name: string }>(
          `SELECT column_name FROM information_schema.columns WHERE table_name = $1 ORDER BY column_name`,
          [t],
        )
      ).rows.map((r) => r.column_name);
    expect(await cols('publisher_domains')).toEqual(
      [
        'created_at',
        'host',
        'id',
        'publisher_id',
        'requested_at',
        'state',
        'token_hash',
        'updated_at',
        'verified_at',
        // fresh() migrates to head: 0037 (DOMAIN-PROOF-2) adds who verified an address and an operator's vouch.
        'verified_by',
        'vouch_reason',
        'vouched_by',
      ].sort(),
    );
    expect(await cols('import_batches')).toEqual(
      [
        'attestation_version',
        'attested_at',
        'changed',
        'created_at',
        'created_by',
        'done',
        'existing',
        'finished_at',
        'id',
        'note',
        'publisher_id',
        'refused',
        'source_host',
        'source_url',
        'started_at',
        'state',
        'total',
        'updated_at',
      ].sort(),
    );
    expect(await cols('import_items')).toEqual(
      [
        'article_id',
        'batch_id',
        'content_bytes',
        'content_mime',
        'content_ref',
        'content_sha256',
        'created_at',
        'currency',
        'id',
        'image_ref',
        'kind',
        'language',
        'offer_id',
        'price_minor',
        'publisher_id',
        'reason',
        'source_key',
        'source_price_minor',
        'source_published_at',
        'state',
        'summary',
        'title',
        'topics',
        'updated_at',
      ].sort(),
    );
  });
});

describe('publisher_domains', () => {
  it('takes a pending row and refuses a bad host, state, hash or proof time', async () => {
    const d = await fresh();
    await publisher(d, 'pub_a');
    await domain(d);
    await bad(domain(d, { id: 'pdm_2', host: 'Shop.Upper.invalid' }));
    await bad(domain(d, { id: 'pdm_3', host: 'localhost' }));
    await bad(domain(d, { id: 'pdm_4', host: 'a b.invalid' }));
    await bad(domain(d, { id: 'pdm_5', host: '10.0.0.1' }));
    await bad(domain(d, { id: 'pdm_6', host: 'x'.repeat(254) }));
    await bad(domain(d, { id: 'pdm_7', host: 'other.invalid', state: 'maybe' }));
    await bad(domain(d, { id: 'pdm_8', host: 'other.invalid', token_hash: 'not a hash' }));
    // verified needs a time, pending must not have one
    await bad(domain(d, { id: 'pdm_9', host: 'other.invalid', state: 'verified' }));
    await bad(domain(d, { id: 'pdm_10', host: 'other.invalid', verified_at: T }));
    await bad(domain(d, { id: 'pdm_11', publisher_id: 'pub_none', host: 'other.invalid' }));
  });

  it('one row per publisher and host; one verified owner per host', async () => {
    const d = await fresh();
    await publisher(d, 'pub_a');
    await publisher(d, 'pub_b');
    await domain(d);
    await bad(domain(d, { id: 'pdm_2' }));
    await domain(d, { id: 'pdm_3', publisher_id: 'pub_b' }); // two pending claims for one host are allowed
    await d.query(
      `UPDATE publisher_domains SET state = 'verified', verified_at = $2, updated_at = $2 WHERE id = $1`,
      ['pdm_1', T2],
    );
    await bad(
      d.query(
        `UPDATE publisher_domains SET state = 'verified', verified_at = $2, updated_at = $2 WHERE id = $1`,
        ['pdm_3', T2],
      ),
    );
  });

  it('a domain moves from pending to verified and never back; host and owner never change', async () => {
    const d = await fresh();
    await publisher(d, 'pub_a');
    await publisher(d, 'pub_b');
    await domain(d);
    // a pending row may get a new token (the publisher asked again)
    await d.query(`UPDATE publisher_domains SET token_hash = $2, updated_at = $3 WHERE id = $1`, [
      'pdm_1',
      SHA2,
      T2,
    ]);
    await bad(d.query(`UPDATE publisher_domains SET host = 'x.invalid' WHERE id = 'pdm_1'`));
    await bad(d.query(`UPDATE publisher_domains SET publisher_id = 'pub_b' WHERE id = 'pdm_1'`));
    await d.query(
      `UPDATE publisher_domains SET state = 'verified', verified_at = $2, updated_at = $2 WHERE id = $1`,
      ['pdm_1', T2],
    );
    await bad(
      d.query(
        `UPDATE publisher_domains SET state = 'pending', verified_at = NULL WHERE id = 'pdm_1'`,
      ),
    );
    await bad(d.query(`UPDATE publisher_domains SET token_hash = $1 WHERE id = 'pdm_1'`, [SHA]));
    await bad(d.query(`UPDATE publisher_domains SET verified_at = $1 WHERE id = 'pdm_1'`, [T]));
    // updated_at alone may move on a verified row (a re-check)
    await d.query(`UPDATE publisher_domains SET updated_at = $1 WHERE id = 'pdm_1'`, [T2]);
  });
});

describe('import_batches', () => {
  it('takes the five states and refuses anything else', async () => {
    const d = await fresh();
    await publisher(d, 'pub_a');
    await batch(d);
    for (const [i, s] of ['done', 'failed', 'interrupted'].entries())
      await batch(d, { id: `imb_s${i}`, state: s });
    await bad(batch(d, { id: 'imb_x', state: 'paused' }));
  });

  it('counts are whole numbers, done is at most total, refused at most done, total at most 100', async () => {
    const d = await fresh();
    await publisher(d, 'pub_a');
    await batch(d, { id: 'imb_ok', state: 'done', total: 100, done: 100, refused: 100 });
    await bad(batch(d, { id: 'imb_1', state: 'done', total: 101, done: 101 }));
    await bad(batch(d, { id: 'imb_2', state: 'done', total: 3, done: 4 }));
    await bad(batch(d, { id: 'imb_3', state: 'done', total: 3, done: 2, refused: 3 }));
    await bad(batch(d, { id: 'imb_4', state: 'done', total: -1 }));
    await bad(batch(d, { id: 'imb_5', state: 'done', existing: -1 }));
  });

  it('the source address and the note are bounded', async () => {
    const d = await fresh();
    await publisher(d, 'pub_a');
    await bad(batch(d, { id: 'imb_1', source_url: 'https://x' + 'a'.repeat(2100) }));
    await bad(batch(d, { id: 'imb_2', source_url: '' }));
    await bad(batch(d, { id: 'imb_3', note: 'n'.repeat(61) }));
    await bad(batch(d, { id: 'imb_4', note: '' }));
    await bad(batch(d, { id: 'imb_5', publisher_id: 'pub_none' }));
  });

  it('only one batch per publisher is queued or running at a time', async () => {
    const d = await fresh();
    await publisher(d, 'pub_a');
    await publisher(d, 'pub_b');
    await batch(d, { id: 'imb_1', state: 'running' });
    await bad(batch(d, { id: 'imb_2', state: 'queued' }));
    await bad(batch(d, { id: 'imb_3', state: 'running' }));
    await batch(d, { id: 'imb_4', state: 'done' });
    await batch(d, { id: 'imb_5', state: 'failed' });
    await batch(d, { id: 'imb_6', publisher_id: 'pub_b', state: 'queued', created_by: 'pub_b' });
    await d.query(`UPDATE import_batches SET state = 'interrupted' WHERE id = 'imb_1'`);
    await batch(d, { id: 'imb_7', state: 'queued' });
  });

  it('an ended batch stays ended: the state, the counts and the source never change again', async () => {
    const d = await fresh();
    await publisher(d, 'pub_a');
    await batch(d, { id: 'imb_1', state: 'running', total: 5 });
    await d.query(`UPDATE import_batches SET done = 2, updated_at = $1 WHERE id = 'imb_1'`, [T2]);
    await d.query(
      `UPDATE import_batches SET state = 'interrupted', note = 'restart' WHERE id = 'imb_1'`,
    );
    await bad(d.query(`UPDATE import_batches SET state = 'done' WHERE id = 'imb_1'`));
    await bad(d.query(`UPDATE import_batches SET state = 'running' WHERE id = 'imb_1'`));
    await bad(d.query(`UPDATE import_batches SET done = 5 WHERE id = 'imb_1'`));
    await bad(d.query(`UPDATE import_batches SET note = 'x' WHERE id = 'imb_1'`));
    await bad(d.query(`UPDATE import_batches SET source_host = 'x.invalid' WHERE id = 'imb_1'`));
    // the attestation of rights is recorded on an ended batch (publishing happens after the run)
    await d.query(
      `UPDATE import_batches SET attested_at = $1, attestation_version = 'PUB-ATTEST-1', updated_at = $1 WHERE id = 'imb_1'`,
      [T2],
    );
  });

  it('a running batch cannot change its publisher, source or start', async () => {
    const d = await fresh();
    await publisher(d, 'pub_a');
    await publisher(d, 'pub_b');
    await batch(d, { id: 'imb_1', state: 'queued' });
    await bad(d.query(`UPDATE import_batches SET publisher_id = 'pub_b' WHERE id = 'imb_1'`));
    await bad(
      d.query(`UPDATE import_batches SET source_url = 'https://x.invalid/' WHERE id = 'imb_1'`),
    );
    await bad(d.query(`UPDATE import_batches SET created_at = $1 WHERE id = 'imb_1'`, [T2]));
  });
});

describe('import_items', () => {
  async function world(): Promise<Db> {
    const d = await fresh();
    await publisher(d, 'pub_a');
    await publisher(d, 'pub_b');
    await batch(d, { id: 'imb_1', state: 'done' });
    return d;
  }

  it('takes a staged item and refuses a bad state or kind', async () => {
    const d = await world();
    await item(d);
    await bad(item(d, { id: 'imi_2', source_key: 'k2', state: 'listed' }));
    await bad(item(d, { id: 'imi_3', source_key: 'k3', kind: 'video' }));
    await bad(item(d, { id: 'imi_4', source_key: 'k4', batch_id: 'imb_none' }));
  });

  it('bounds title, summary, language, source key, references and size', async () => {
    const d = await world();
    let n = 10;
    const k = () => ({ id: `imi_${n}`, source_key: `key-${n++}` });
    await item(d, { ...k(), title: 't'.repeat(200), summary: 's'.repeat(600), language: 'en-GB' });
    await bad(item(d, { ...k(), title: 't'.repeat(201) }));
    await bad(item(d, { ...k(), title: '' }));
    await bad(item(d, { ...k(), summary: 's'.repeat(601) }));
    await bad(item(d, { ...k(), language: 'x' }));
    await bad(item(d, { ...k(), language: 'l'.repeat(17) }));
    await bad(item(d, { ...k(), source_key: '' }));
    await bad(item(d, { id: 'imi_90', source_key: 'k'.repeat(501) }));
    await item(d, { ...k(), image_ref: 'i'.repeat(300), content_ref: 'c'.repeat(300) });
    await bad(item(d, { ...k(), image_ref: 'i'.repeat(301) }));
    await bad(item(d, { ...k(), content_ref: 'c'.repeat(301) }));
    await bad(item(d, { ...k(), image_ref: '' }));
    await bad(item(d, { ...k(), content_bytes: 2 * 1024 * 1024 + 1 }));
    await bad(item(d, { ...k(), content_mime: 'text/html' }));
    await bad(item(d, { ...k(), content_sha256: 'xyz' }));
  });

  it('allows at most 8 topics of 1 to 40 characters', async () => {
    const d = await world();
    let n = 10;
    const k = () => ({ id: `imi_${n}`, source_key: `key-${n++}` });
    await item(d, { ...k(), topics: [] });
    await item(d, { ...k(), topics: Array.from({ length: 8 }, (_, i) => `t${i}`) });
    await item(d, { ...k(), topics: ['t'.repeat(40)] });
    await bad(item(d, { ...k(), topics: Array.from({ length: 9 }, (_, i) => `t${i}`) }));
    await bad(item(d, { ...k(), topics: ['t'.repeat(41)] }));
    await bad(item(d, { ...k(), topics: [''] }));
    await bad(item(d, { ...k(), topics: ['ok', ''] }));
  });

  it('a price is a whole number of at least 1 or none', async () => {
    const d = await world();
    let n = 10;
    const k = () => ({ id: `imi_${n}`, source_key: `key-${n++}` });
    await item(d, { ...k(), price_minor: null, source_price_minor: null });
    await bad(item(d, { ...k(), price_minor: 0 }));
    await bad(item(d, { ...k(), price_minor: -5 }));
    await bad(item(d, { ...k(), currency: 'usd' }));
  });

  it('a source key is used once per publisher, not once overall', async () => {
    const d = await world();
    await item(d);
    await bad(item(d, { id: 'imi_2' }));
    await batch(d, { id: 'imb_2', publisher_id: 'pub_b', state: 'done', created_by: 'pub_b' });
    await item(d, { id: 'imi_3', batch_id: 'imb_2', publisher_id: 'pub_b' });
  });

  it('a refused item has a reason; any other item has none; staged items carry their content', async () => {
    const d = await world();
    let n = 10;
    const k = () => ({ id: `imi_${n}`, source_key: `key-${n++}` });
    await item(d, {
      ...k(),
      state: 'refused',
      reason: 'image_off_host',
      content_ref: null,
      content_sha256: null,
      content_mime: null,
      content_bytes: null,
    });
    await bad(item(d, { ...k(), state: 'refused', reason: null }));
    await bad(item(d, { ...k(), state: 'staged', reason: 'no_text' }));
    await bad(item(d, { ...k(), state: 'refused', reason: 'Bad Reason!' }));
    await bad(item(d, { ...k(), state: 'refused', reason: 'r'.repeat(41) }));
    await bad(item(d, { ...k(), content_ref: null }));
    await bad(item(d, { ...k(), state: 'hidden', content_sha256: null }));
  });

  it('a published item names its article and its offer; the offer id has no foreign key', async () => {
    const d = await world();
    await article(d, 'art_1', 'pub_a');
    await item(d, { id: 'imi_1', state: 'staged' });
    await d.query(
      `UPDATE import_items SET state = 'published', article_id = 'art_1', offer_id = 'ofr_not_there_yet', updated_at = $1 WHERE id = 'imi_1'`,
      [T2],
    );
    await bad(item(d, { id: 'imi_2', source_key: 'k2', state: 'published', article_id: 'art_1' }));
    await bad(item(d, { id: 'imi_3', source_key: 'k3', state: 'published', offer_id: 'ofr_x' }));
    await bad(item(d, { id: 'imi_4', source_key: 'k4', article_id: 'art_none', offer_id: null }));
  });

  it('an item belongs to the publisher of its batch', async () => {
    const d = await world();
    await bad(item(d, { publisher_id: 'pub_b' }));
    await item(d);
    await bad(d.query(`UPDATE import_items SET publisher_id = 'pub_b' WHERE id = 'imi_1'`));
    await bad(
      d.query(
        `UPDATE import_items SET batch_id = 'imb_1', publisher_id = 'pub_b' WHERE id = 'imi_1'`,
      ),
    );
  });

  it('the article of a published item has the same publisher as the item', async () => {
    const d = await world();
    await article(d, 'art_b', 'pub_b');
    await item(d);
    await bad(
      d.query(
        `UPDATE import_items SET state = 'published', article_id = 'art_b', offer_id = 'ofr_x', updated_at = $1 WHERE id = 'imi_1'`,
        [T2],
      ),
    );
    await bad(
      item(d, {
        id: 'imi_2',
        source_key: 'k2',
        state: 'published',
        article_id: 'art_b',
        offer_id: 'ofr_x',
      }),
    );
  });

  it('staged and hidden items may be edited and swapped; published and refused items are final', async () => {
    const d = await world();
    await article(d, 'art_1', 'pub_a');
    await item(d);
    await d.query(
      `UPDATE import_items SET title = 'New', price_minor = 200, updated_at = $1 WHERE id = 'imi_1'`,
      [T2],
    );
    await d.query(`UPDATE import_items SET state = 'hidden', updated_at = $1 WHERE id = 'imi_1'`, [
      T2,
    ]);
    await d.query(`UPDATE import_items SET state = 'staged', updated_at = $1 WHERE id = 'imi_1'`, [
      T2,
    ]);
    await d.query(
      `UPDATE import_items SET state = 'published', article_id = 'art_1', offer_id = 'ofr_1', updated_at = $1 WHERE id = 'imi_1'`,
      [T2],
    );
    await bad(d.query(`UPDATE import_items SET title = 'Again' WHERE id = 'imi_1'`));
    await bad(d.query(`UPDATE import_items SET state = 'staged' WHERE id = 'imi_1'`));
    await bad(d.query(`UPDATE import_items SET price_minor = 5 WHERE id = 'imi_1'`));
    await item(d, {
      id: 'imi_2',
      source_key: 'k2',
      state: 'refused',
      reason: 'no_text',
      content_ref: null,
      content_sha256: null,
      content_mime: null,
      content_bytes: null,
    });
    await bad(
      d.query(`UPDATE import_items SET state = 'staged', reason = NULL WHERE id = 'imi_2'`),
    );
  });

  it('the source key, kind, batch and content never change on a staged item', async () => {
    const d = await world();
    await item(d);
    await bad(d.query(`UPDATE import_items SET source_key = 'other' WHERE id = 'imi_1'`));
    await bad(d.query(`UPDATE import_items SET kind = 'image' WHERE id = 'imi_1'`));
    await bad(d.query(`UPDATE import_items SET content_sha256 = $1 WHERE id = 'imi_1'`, [SHA2]));
    await bad(d.query(`UPDATE import_items SET content_ref = 'import/x' WHERE id = 'imi_1'`));
    await bad(d.query(`UPDATE import_items SET source_price_minor = 9 WHERE id = 'imi_1'`));
  });
});

describe('a reset empties the new tables (test databases only)', () => {
  it('truncates with the rest', async () => {
    const d = await fresh();
    await publisher(d, 'pub_a');
    await domain(d);
    await batch(d, { state: 'done' });
    await item(d);
    const { resetDatabase } = await import('./reset');
    await resetDatabase(d as Parameters<typeof resetDatabase>[0]);
    for (const t of ['publisher_domains', 'import_batches', 'import_items'])
      expect((await d.query(`SELECT 1 FROM ${t}`)).rows).toEqual([]);
  });
});
