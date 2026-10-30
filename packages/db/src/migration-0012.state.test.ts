// PUB-A1: migration 0012 (the publisher side). Columns and defaults, two append-only tables, the
// attestation column, and the article immutability trigger. Existing rows keep their values.
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { Database } from '@umsbx/contracts';
import { applyMigrations, migrate, openDatabase } from './index';

const T = '2026-10-30T10:00:00Z';
const clock = { now: () => new Date(T) };
const HASH = 'a'.repeat(64);
const HASH2 = 'b'.repeat(64);
const j = (v: unknown): string => JSON.stringify(v);

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

async function ins(d: Db, table: string, row: Record<string, unknown>): Promise<void> {
  const r: Record<string, unknown> = { created_at: T, updated_at: T, ...row };
  const cols = Object.keys(r);
  await d.query(
    `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`,
    cols.map((c) => r[c]),
  );
}

const publisher = (d: Db, id: string, extra: Record<string, unknown> = {}): Promise<void> =>
  ins(d, 'publishers', {
    id,
    slug: `slug-${id}`,
    display_name: `Name ${id}`,
    country: 'US',
    ...extra,
  });
const article = (d: Db, id: string, pub: string, n: number): Promise<void> =>
  ins(d, 'articles', {
    id,
    publisher_id: pub,
    title: 't',
    abstract: 'a',
    language: 'en',
    topics: ['x'],
    published_at: T,
    sha256: HASH,
    content_key: `key-${String(n)}`,
    bytes: 10,
    mime: 'text/plain',
  });
const offer = (
  d: Db,
  id: string,
  version: string,
  pub: string,
  art: string,
  status: string,
): Promise<void> =>
  ins(d, 'offers', {
    id,
    version,
    publisher_id: pub,
    article_id: art,
    status,
    currency: 'USD',
    options: j([]),
    affordability: j({}),
    terms_version: 't1',
    rights: j({}),
    valid_from: T,
    valid_until: null,
    superseded_by: null,
  });

describe('migration 0012 is forward-only and keeps existing rows', () => {
  it('applies after 0011 on a copy, keeps every old value, and a second run is a no-op', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ums-mig12-'));
    try {
      const common = new URL('../migrations/common/', import.meta.url);
      for (const f of readdirSync(common).filter((n) => /^(000[1-9]|001[01])_.+\.sql$/.test(n))) {
        writeFileSync(join(dir, f), readFileSync(new URL(f, common), 'utf8'));
      }
      const d = await openDatabase({ kind: 'pglite-memory' });
      toClose.push(d);
      expect((await applyMigrations(d, clock, dir)).at(-1)).toBe('0011_provider_order_state');
      await publisher(d, 'pub_old', { paypal_merchant_id: 'MERCHOLD', payee_verified_at: T });
      await article(d, 'art_old', 'pub_old', 1);
      await offer(d, 'ofr_old', '1', 'pub_old', 'art_old', 'authorised');
      await ins(d, 'publisher_authorisations', {
        id: 'pau_old',
        offer_id: 'ofr_old',
        offer_version: '1',
        authorised_by: 'seed',
        at: T,
      });
      const before = (await d.query('SELECT * FROM publishers ORDER BY id')).rows;

      // Later migrations (0013 and on) also apply to this copy; 0012 must be the first one applied.
      const applied = await migrate(d, clock);
      expect(applied[0]).toBe('0012_publisher_side');
      expect(applied).toContain('0014_publisher_visits');

      const after = await d.query<Record<string, unknown>>('SELECT * FROM publishers ORDER BY id');
      expect(after.rows.map(({ status, ...rest }) => ({ ...rest, s: status }))).toEqual(
        before.map((r) => ({ ...r, s: 'active' })),
      );
      expect((await d.query('SELECT created_by FROM articles')).rows).toEqual([
        { created_by: null },
      ]);
      expect(
        (await d.query('SELECT attestation_version FROM publisher_authorisations')).rows,
      ).toEqual([{ attestation_version: null }]);
      expect(await migrate(d, clock)).toEqual([]);
      expect(
        readdirSync(common).filter((n) => /^0012_.+\.sql$/.test(n) && /down|rollback/i.test(n)),
      ).toEqual([]);
      expect(readdirSync(common).filter((n) => /^0012_/.test(n))).toEqual([
        '0012_publisher_side.sql',
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('publishers.status', () => {
  it('defaults to active and accepts only applied, active and suspended', async () => {
    const d = await fresh();
    await publisher(d, 'pub_a');
    expect((await d.query('SELECT status FROM publishers WHERE id = $1', ['pub_a'])).rows).toEqual([
      { status: 'active' },
    ]);
    for (const s of ['applied', 'suspended', 'active']) {
      await d.query('UPDATE publishers SET status = $2 WHERE id = $1', ['pub_a', s]);
    }
    for (const bad of ['live', 'Active', '', 'deleted']) {
      await expect(
        d.query('UPDATE publishers SET status = $2 WHERE id = $1', ['pub_a', bad]),
        bad,
      ).rejects.toThrow();
    }
    await expect(
      d.query('UPDATE publishers SET status = NULL WHERE id = $1', ['pub_a']),
    ).rejects.toThrow();
  });
});

describe('payee_change_requests and payee_decisions are append-only', () => {
  async function withRequest(): Promise<Db> {
    const d = await fresh();
    await publisher(d, 'pub_a');
    await ins(d, 'payee_change_requests', {
      id: 'pcr_1',
      publisher_id: 'pub_a',
      requested_merchant_id: 'MERCHNEW1',
      note: 'please verify',
      created_by: 'publisher:pub_a',
    });
    return d;
  }

  it('a request holds its columns, needs a publisher, and refuses UPDATE, DELETE, TRUNCATE', async () => {
    const d = await withRequest();
    const row = (await d.query<Record<string, unknown>>('SELECT * FROM payee_change_requests'))
      .rows;
    expect(Object.keys(row[0]!).sort()).toEqual(
      [
        'created_at',
        'created_by',
        'id',
        'note',
        'publisher_id',
        'requested_merchant_id',
        'updated_at',
      ].sort(),
    );
    await expect(
      ins(d, 'payee_change_requests', {
        id: 'pcr_2',
        publisher_id: 'pub_missing',
        requested_merchant_id: 'MERCHNEW2',
        note: 'n',
        created_by: 'x',
      }),
    ).rejects.toThrow();
    await expect(d.query("UPDATE payee_change_requests SET note = 'x'")).rejects.toThrow(
      /append-only/,
    );
    await expect(d.query('DELETE FROM payee_change_requests')).rejects.toThrow(/append-only/);
    await expect(d.exec('TRUNCATE payee_change_requests CASCADE')).rejects.toThrow(
      /TRUNCATE|append-only/,
    );
    expect((await d.query('SELECT count(*)::int AS n FROM payee_change_requests')).rows).toEqual([
      { n: 1 },
    ]);
  });

  it('a decision is one per request, verified or rejected, with an operator and a reason', async () => {
    const d = await withRequest();
    const decide = (id: string, over: Record<string, unknown> = {}): Promise<void> =>
      ins(d, 'payee_decisions', {
        id,
        request_id: 'pcr_1',
        decision: 'verified',
        operator_id: 'opr_vikram',
        reason: 'checked with the publisher',
        ...over,
      });
    await expect(decide('pdc_bad', { decision: 'maybe' })).rejects.toThrow();
    await expect(decide('pdc_noop', { operator_id: null })).rejects.toThrow();
    await expect(decide('pdc_noreason', { reason: null })).rejects.toThrow();
    await expect(decide('pdc_noreq', { request_id: 'pcr_missing' })).rejects.toThrow();
    await decide('pdc_1');
    await expect(decide('pdc_2', { decision: 'rejected' })).rejects.toThrow();
    await expect(d.query("UPDATE payee_decisions SET reason = 'x'")).rejects.toThrow(/append-only/);
    await expect(d.query('DELETE FROM payee_decisions')).rejects.toThrow(/append-only/);
    await expect(d.exec('TRUNCATE payee_decisions')).rejects.toThrow(/TRUNCATE|append-only/);
    // A request is open while it has no decision.
    const open = await d.query(
      `SELECT r.id FROM payee_change_requests r
        WHERE NOT EXISTS (SELECT 1 FROM payee_decisions x WHERE x.request_id = r.id)`,
    );
    expect(open.rows).toEqual([]);
  });

  it('a request with no decision is open', async () => {
    const d = await withRequest();
    const open = await d.query(
      `SELECT r.id FROM payee_change_requests r
        WHERE NOT EXISTS (SELECT 1 FROM payee_decisions x WHERE x.request_id = r.id)`,
    );
    expect(open.rows).toEqual([{ id: 'pcr_1' }]);
  });
});

describe('the new columns on existing tables', () => {
  it('publisher_authorisations.attestation_version accepts a value on insert; the table stays append-only', async () => {
    const d = await fresh();
    await publisher(d, 'pub_a');
    await article(d, 'art_a', 'pub_a', 1);
    await offer(d, 'ofr_a', '1', 'pub_a', 'art_a', 'authorised');
    await ins(d, 'publisher_authorisations', {
      id: 'pau_a',
      offer_id: 'ofr_a',
      offer_version: '1',
      authorised_by: 'pub_a',
      at: T,
      attestation_version: 'att-1',
    });
    expect(
      (await d.query('SELECT attestation_version FROM publisher_authorisations')).rows,
    ).toEqual([{ attestation_version: 'att-1' }]);
    await expect(
      d.query("UPDATE publisher_authorisations SET attestation_version = 'x'"),
    ).rejects.toThrow(/append-only/);
  });

  it('articles.created_by is optional and stores what it is given', async () => {
    const d = await fresh();
    await publisher(d, 'pub_a');
    await article(d, 'art_a', 'pub_a', 1);
    await d.query("UPDATE articles SET created_by = 'publisher:pub_a' WHERE id = 'art_a'");
    expect((await d.query('SELECT created_by FROM articles')).rows).toEqual([
      { created_by: 'publisher:pub_a' },
    ]);
  });
});

describe('articles: sha256 and content_key are frozen while an authorised offer uses the article', () => {
  it('refuses a change of either column with check_violation, and keeps the row', async () => {
    const d = await fresh();
    await publisher(d, 'pub_a');
    await article(d, 'art_a', 'pub_a', 1);
    await offer(d, 'ofr_a', '1', 'pub_a', 'art_a', 'authorised');
    await expect(
      d.query('UPDATE articles SET sha256 = $1 WHERE id = $2', [HASH2, 'art_a']),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      d.query("UPDATE articles SET content_key = 'other' WHERE id = 'art_a'"),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      d.query("UPDATE articles SET sha256 = $1, content_key = 'other2' WHERE id = 'art_a'", [
        HASH2,
      ]),
    ).rejects.toMatchObject({ code: '23514' });
    expect((await d.query('SELECT sha256, content_key FROM articles')).rows).toEqual([
      { sha256: HASH, content_key: 'key-1' },
    ]);
  });

  it('still allows other columns, and a write that changes neither value', async () => {
    const d = await fresh();
    await publisher(d, 'pub_a');
    await article(d, 'art_a', 'pub_a', 1);
    await offer(d, 'ofr_a', '1', 'pub_a', 'art_a', 'authorised');
    await d.query("UPDATE articles SET title = 'new title', abstract = 'new' WHERE id = 'art_a'");
    await d.query('UPDATE articles SET sha256 = $1 WHERE id = $2', [HASH, 'art_a']);
    expect((await d.query('SELECT title FROM articles')).rows).toEqual([{ title: 'new title' }]);
  });

  it('allows the change with no offer, a draft, a withdrawn offer, or an authorised offer on another article', async () => {
    const d = await fresh();
    await publisher(d, 'pub_a');
    await article(d, 'art_none', 'pub_a', 1);
    await article(d, 'art_draft', 'pub_a', 2);
    await article(d, 'art_wd', 'pub_a', 3);
    await article(d, 'art_other', 'pub_a', 4);
    await article(d, 'art_busy', 'pub_a', 5);
    await offer(d, 'ofr_d', '1', 'pub_a', 'art_draft', 'draft');
    await offer(d, 'ofr_w', '1', 'pub_a', 'art_wd', 'withdrawn');
    await offer(d, 'ofr_b', '1', 'pub_a', 'art_busy', 'authorised');
    for (const id of ['art_none', 'art_draft', 'art_wd', 'art_other']) {
      await d.query('UPDATE articles SET sha256 = $1, content_key = $3 WHERE id = $2', [
        HASH2,
        id,
        `moved-${id}`,
      ]);
    }
    expect(
      (await d.query('SELECT count(*)::int AS n FROM articles WHERE sha256 = $1', [HASH2])).rows,
    ).toEqual([{ n: 4 }]);
  });

  it('a later version of the offer that is not authorised does not free the article while an earlier authorised version exists', async () => {
    const d = await fresh();
    await publisher(d, 'pub_a');
    await article(d, 'art_a', 'pub_a', 1);
    await offer(d, 'ofr_a', '1', 'pub_a', 'art_a', 'authorised');
    await offer(d, 'ofr_a', '2', 'pub_a', 'art_a', 'withdrawn');
    await expect(
      d.query('UPDATE articles SET sha256 = $1 WHERE id = $2', [HASH2, 'art_a']),
    ).rejects.toMatchObject({ code: '23514' });
  });
});
