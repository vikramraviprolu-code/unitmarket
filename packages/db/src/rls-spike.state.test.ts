// RLS spike (informational, NOT a gate): does PGlite enforce policies under SET ROLE?
// The result is printed and recorded in docs/READINESS.md by hand; this test never fails on it.
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate, openDatabase } from './index';

describe('RLS spike (informational)', () => {
  it('reports whether PGlite enforces the supabase policy file under SET ROLE', async () => {
    const db = await openDatabase({ kind: 'pglite-memory' });
    const outcome: Record<string, unknown> = {};
    try {
      await migrate(db, { now: () => new Date('2026-10-21T10:00:00Z') });
      const T = '2026-10-21T10:00:00Z';
      for (const b of ['buy_a', 'buy_b']) {
        await db.query(
          'INSERT INTO buyers (id, display_name, auth_subject, country, created_at, updated_at) VALUES ($1::text, $1::text, $1::text, $2::text, $3::timestamptz, $3::timestamptz)',
          [b, 'US', T],
        );
      }
      await db.exec(
        readFileSync(new URL('../migrations/supabase/0001_roles_rls.sql', import.meta.url), 'utf8'),
      );
      outcome.policyFileApplies = true;
      await db.exec('GRANT USAGE ON SCHEMA public TO ums_app');
      await db.exec('SET ROLE ums_app');
      await db.query(
        "SELECT set_config('ums.actor_kind', 'buyer', false), set_config('ums.actor_id', 'buy_a', false)",
      );
      const rows = await db.query<{ id: string }>('SELECT id FROM buyers ORDER BY id');
      await db.exec('RESET ROLE');
      outcome.rowsVisibleToBuyerA = rows.rows.map((r) => r.id);
      outcome.rlsEnforced = rows.rows.length === 1 && rows.rows[0]!.id === 'buy_a';
    } catch (e) {
      outcome.error = String(e instanceof Error ? e.message : e);
    } finally {
      await db.close();
    }
    console.log('RLS_SPIKE_RESULT ' + JSON.stringify(outcome));
    expect(outcome).toBeTypeOf('object');
  });
});

// Review A (H2): the policy file is enforced, not only parsed. PGlite honours SET ROLE and row-level
// security (see the spike above), so each rule is proved against ums_app with the two actor settings.
describe('RLS enforcement (H2)', () => {
  const T = '2026-10-21T10:00:00Z';
  const clock = { now: () => new Date(T) };
  let db: Awaited<ReturnType<typeof openDatabase>>;

  async function asActor<R>(kind: string, id: string, fn: () => Promise<R>): Promise<R> {
    await db.exec('SET ROLE ums_app');
    try {
      await db.query('SELECT set_config($1, $2, false), set_config($3, $4, false)', [
        'ums.actor_kind',
        kind,
        'ums.actor_id',
        id,
      ]);
      return await fn();
    } finally {
      await db.exec('RESET ROLE');
    }
  }
  const owner = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows;

  beforeAll(async () => {
    db = await openDatabase({ kind: 'pglite-memory' });
    await migrate(db, clock);
    const ts = `'${T}'`;
    for (const p of ['pub_a', 'pub_b']) {
      await db.exec(
        `INSERT INTO publishers (id, slug, display_name, country, paypal_merchant_id, payee_verified_at, created_at, updated_at)
         VALUES ('${p}', '${p}', '${p}', 'US', 'M_${p}', ${ts}, ${ts}, ${ts});
         INSERT INTO articles (id, publisher_id, title, abstract, language, topics, published_at, sha256, content_key, bytes, mime, created_at, updated_at)
         VALUES ('art_${p}', '${p}', 't', 'a', 'en', ARRAY['x'], ${ts}, '${'a'.repeat(64)}', 'key_${p}', 1, 'text/plain', ${ts}, ${ts});
         INSERT INTO offers (id, version, publisher_id, article_id, status, currency, options, affordability, terms_version, rights, valid_from, created_at, updated_at)
         VALUES ('off_${p}', '1', '${p}', 'art_${p}', 'authorised', 'USD', '{}', '{}', 't1', '{}', ${ts}, ${ts}, ${ts});
         INSERT INTO offers (id, version, publisher_id, article_id, status, currency, options, affordability, terms_version, rights, valid_from, created_at, updated_at)
         VALUES ('draft_${p}', '1', '${p}', 'art_${p}', 'draft', 'USD', '{}', '{}', 't1', '{}', ${ts}, ${ts}, ${ts});`,
      );
    }
    for (const b of ['buy_a', 'buy_b']) {
      await db.exec(
        `INSERT INTO buyers (id, display_name, auth_subject, country, created_at, updated_at) VALUES ('${b}', '${b}', '${b}', 'US', ${ts}, ${ts})`,
      );
    }
    await db.exec(
      `INSERT INTO quotes (id, buyer_id, offer_id, offer_version, option, price_minor, currency, corridor_id, source, expires_at, created_at, updated_at)
       VALUES ('q_a', 'buy_a', 'off_pub_a', '1', 'keep_retrieve', 500, 'USD', 'us-usd', 'direct', '2026-10-21T11:00:00Z', ${ts}, ${ts})`,
    );
    await db.exec(
      readFileSync(new URL('../migrations/supabase/0001_roles_rls.sql', import.meta.url), 'utf8'),
    );
  });
  afterAll(async () => {
    await db.close();
  });

  it('H2: a publisher reads its own row and cannot change payee columns or delete it', async () => {
    const seen = await asActor('publisher', 'pub_a', () => db.query('SELECT id FROM publishers'));
    expect(seen.rows).toEqual([{ id: 'pub_a' }]);
    await asActor('publisher', 'pub_a', async () => {
      await db
        .query(
          "UPDATE publishers SET paypal_merchant_id = 'EVIL', payee_verified_at = NULL WHERE id = 'pub_a'",
        )
        .catch(() => undefined);
      await db.query("DELETE FROM publishers WHERE id = 'pub_a'").catch(() => undefined);
      await db
        .query(
          `INSERT INTO publishers (id, slug, display_name, country, created_at, updated_at) VALUES ('pub_a', 'x', 'x', 'US', '${T}', '${T}')`,
        )
        .catch(() => undefined);
    });
    expect(
      await owner(
        "SELECT paypal_merchant_id, payee_verified_at IS NOT NULL AS verified FROM publishers WHERE id = 'pub_a'",
      ),
    ).toEqual([{ paypal_merchant_id: 'M_pub_a', verified: true }]);
    await expect(
      asActor('publisher', 'pub_a', () =>
        db.query(
          "UPDATE publishers SET paypal_merchant_id = 'EVIL' WHERE id = 'pub_a' RETURNING id",
        ),
      ).then((r) => r.rows.length),
    ).resolves.toBe(0);
  });

  it('H2: an operator may change payee columns (audited by the app) and a publisher may not see other publishers', async () => {
    const r = await asActor('operator', 'op_1', () =>
      db.query(
        "UPDATE publishers SET payee_verified_at = payee_verified_at WHERE id = 'pub_b' RETURNING id",
      ),
    );
    expect(r.rows).toEqual([{ id: 'pub_b' }]);
    const other = await asActor('publisher', 'pub_a', () =>
      db.query("SELECT id FROM publishers WHERE id = 'pub_b'"),
    );
    expect(other.rows).toEqual([]);
  });

  it("H2: a publisher cannot authorise another publisher's offer", async () => {
    const insert = (offer: string, by: string, id: string) =>
      db.query(
        `INSERT INTO publisher_authorisations (id, offer_id, offer_version, authorised_by, at, created_at, updated_at)
         VALUES ($1, $2, '1', $3, '${T}', '${T}', '${T}')`,
        [id, offer, by],
      );
    await expect(
      asActor('publisher', 'pub_b', () => insert('off_pub_a', 'pub_b', 'auth_x')),
    ).rejects.toThrow(/row-level security/i);
    await asActor('publisher', 'pub_b', () => insert('off_pub_b', 'pub_b', 'auth_ok'));
    await expect(
      asActor('publisher', 'pub_b', () => insert('off_pub_b', 'pub_a', 'auth_y')),
    ).rejects.toThrow(/row-level security/i);
  });

  it("H2: a publisher can write content only for its own article's key", async () => {
    const insert = (key: string) =>
      db.query(
        `INSERT INTO content_blobs (content_key, sha256, mime, bytes, data, created_at, updated_at)
         VALUES ($1, '${'a'.repeat(64)}', 'text/plain', 1, 'x'::bytea, '${T}', '${T}')`,
        [key],
      );
    await expect(asActor('publisher', 'pub_b', () => insert('key_pub_a'))).rejects.toThrow(
      /row-level security/i,
    );
    await expect(asActor('publisher', 'pub_b', () => insert('key_nobody'))).rejects.toThrow(
      /row-level security/i,
    );
    await asActor('publisher', 'pub_b', () => insert('key_pub_b'));
  });

  it('H2: a buyer reads own quotes, cannot update them, and inserts only narrow quotes', async () => {
    const own = await asActor('buyer', 'buy_a', () => db.query('SELECT id FROM quotes'));
    expect(own.rows).toEqual([{ id: 'q_a' }]);
    const upd = await asActor('buyer', 'buy_a', () =>
      db.query("UPDATE quotes SET price_minor = 1 WHERE id = 'q_a' RETURNING id").catch(() => ({
        rows: [],
      })),
    );
    expect(upd.rows).toEqual([]);
    expect(await owner("SELECT price_minor FROM quotes WHERE id = 'q_a'")).toEqual([
      { price_minor: 500 },
    ]);
    const quote = (id: string, buyer: string, offer: string) =>
      db.query(
        `INSERT INTO quotes (id, buyer_id, offer_id, offer_version, option, price_minor, currency, corridor_id, source, expires_at, created_at, updated_at)
         VALUES ($1, $2, $3, '1', 'keep_retrieve', 500, 'USD', 'us-usd', 'direct', '2026-10-21T11:00:00Z', '${T}', '${T}')`,
        [id, buyer, offer],
      );
    await expect(
      asActor('buyer', 'buy_a', () => quote('q_b', 'buy_b', 'off_pub_a')),
    ).rejects.toThrow(/row-level security/i);
    await expect(
      asActor('buyer', 'buy_a', () => quote('q_c', 'buy_a', 'draft_pub_a')),
    ).rejects.toThrow(/row-level security/i);
    await asActor('buyer', 'buy_a', () => quote('q_d', 'buy_a', 'off_pub_a'));
  });

  it('H2: a buyer cannot insert orders or approvals; the system actor can insert approvals', async () => {
    const approval = (id: string, buyer: string) =>
      db.query(
        `INSERT INTO approvals (id, buyer_id, snapshot, content_hash, nonce, expires_at, used_at, environment, created_at, updated_at)
         VALUES ($1::text, $2::text, '{}', '${'a'.repeat(64)}', $1::text, '2026-10-21T10:15:00Z', NULL, 'dryrun', '${T}', '${T}')`,
        [id, buyer],
      );
    await expect(asActor('buyer', 'buy_a', () => approval('apr_x', 'buy_a'))).rejects.toThrow(
      /row-level security/i,
    );
    await asActor('system', 'job', () => approval('apr_ok', 'buy_a'));
    await expect(
      asActor('buyer', 'buy_a', () =>
        db.query(
          `INSERT INTO orders (id, approval_id, buyer_id, content_hash, order_ref, expected, status, mismatch, corridor_id, currency, total_minor, environment, created_at, updated_at)
           VALUES ('ord_x', 'apr_ok', 'buy_a', '${'a'.repeat(64)}', 'rx', '{}', 'created', false, 'us-usd', 'USD', 1, 'dryrun', '${T}', '${T}')`,
        ),
      ),
    ).rejects.toThrow(/row-level security/i);
  });
});
