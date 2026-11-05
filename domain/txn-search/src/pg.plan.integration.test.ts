// INT-SR0 (SR0.5): the four list shapes use their index on real Postgres 16, at 100,000 seeded lines, and
// stay under 50 ms at p95. Runs only when UMS_TEST_PG_BIN is set (throwaway server on a unix socket in a temp
// directory, no network). A SKIP COUNTS AS A FAIL: the gate runs it with the variable set and checks that the
// output shows the line counts and the run counts printed below.
//
//   UMS_TEST_PG_BIN=$(pg_config --bindir) pnpm vitest run domain/txn-search/src/pg.plan.integration.test.ts
//
// The seed is plain generate_series SQL. The corridor (us-usd, from migration 0001), the buyers, the sellers,
// the articles and the approvals are inserted before the orders, so the 0004 guards (currency, approval buyer
// and environment) pass for every row.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseTxnQuery } from '@umsbx/contracts';
import type { Actor } from '@umsbx/contracts';
import { migrate, openDatabase } from '@umsbx/db';
import { fakeClock, systemClock } from '@umsbx/runtime';
import { pgBinConfigured, startTestPostgres } from '../../../packages/db/src/pg-testing';
import type { TestPostgres } from '../../../packages/db/src/pg-testing';
import { buildTxnSql, scopeQuery, searchTransactions } from './index';
import type { ScopedQuery } from './index';
import { NOW } from './test-fixtures';
import type { Db } from './test-fixtures';

const LINES = 100_000;
const WARMUPS = 5;
const RUNS = 50;
const P95_LIMIT_MS = 50;
const NOW_SQL = '2026-11-05 12:00:00+00';

interface PlanNode {
  'Node Type': string;
  'Index Name'?: string;
  Plans?: PlanNode[];
}

function walk(node: PlanNode, out: PlanNode[] = []): PlanNode[] {
  out.push(node);
  for (const child of node.Plans ?? []) walk(child, out);
  return out;
}

const INDEX_SCANS = new Set(['Index Scan', 'Index Only Scan', 'Bitmap Index Scan']);

interface Shape {
  name: string;
  who: Actor;
  raw: Record<string, string>;
  /** At least one of these indexes appears in an index scan node of the plan. */
  indexes: string[];
}

const SHAPES: Shape[] = [
  {
    name: 'buyer newest page',
    who: { kind: 'buyer', buyer_id: 'buy_7' },
    raw: {},
    indexes: ['orders_buyer_time'],
  },
  {
    name: 'seller newest page',
    who: { kind: 'publisher', publisher_id: 'pub_7' },
    raw: {},
    indexes: ['order_units_pub_time'],
  },
  {
    name: 'operator 30-day page',
    who: { kind: 'operator', operator_id: 'op_1', mfa: true },
    raw: { from: '2026-10-06' },
    indexes: ['orders_time'],
  },
  {
    name: 'operator Needs attention page',
    who: { kind: 'operator', operator_id: 'op_1', mfa: true },
    raw: { status: 'attention' },
    indexes: ['orders_attention', 'order_units_problem'],
  },
];

const scoped = (s: Shape): ScopedQuery => scopeQuery(s.who, s.raw, parseTxnQuery(s.raw));

describe.skipIf(!pgBinConfigured())('txn_rows plan and speed on real Postgres (SR0.5)', () => {
  let server: TestPostgres;
  let db: Db;

  beforeAll(async () => {
    server = await startTestPostgres();
    const created = await server.createDatabase('ums_test_sr0');
    db = (await openDatabase({ kind: 'postgres', url: created.url, pool_max: 2 })) as Db;
    await migrate(db, fakeClock('2026-11-05T10:00:00.000Z'));
    await seed(db);
  }, 600_000);

  afterAll(async () => {
    await db?.close().catch(() => undefined);
    await server?.stop();
  });

  it(`seeded ${LINES} order lines, one unit per order`, async () => {
    const n = (sql: string) => db.query<{ n: number }>(sql).then((r) => r.rows[0]!.n);
    const units = await n('SELECT count(*)::int AS n FROM order_units');
    const view = await n('SELECT count(*)::int AS n FROM txn_rows');
    const analyzed = await n(
      `SELECT count(*)::int AS n FROM pg_stat_user_tables WHERE relname = 'order_units' AND last_analyze IS NOT NULL`,
    );
    console.log(
      `SR0.5 seed: ${units} order_units, ${view} txn_rows lines, analyzed=${analyzed === 1}`,
    );
    expect(units).toBe(LINES);
    expect(view).toBe(LINES);
    expect(analyzed).toBe(1);
  });

  it('the view is created with security_invoker on real Postgres too', async () => {
    const r = await db.query<{ reloptions: string[] | null }>(
      `SELECT reloptions FROM pg_class WHERE relname = 'txn_rows' AND relnamespace = 'public'::regnamespace`,
    );
    expect(r.rows[0]!.reloptions).toContain('security_invoker=true');
  });

  for (const shape of SHAPES) {
    it(`${shape.name}: EXPLAIN uses ${shape.indexes.join(' or ')}`, async () => {
      const { text, params } = buildTxnSql(scoped(shape), { now: NOW, h: 'h' });
      const plan = await db.query<{ 'QUERY PLAN': Array<{ Plan: PlanNode }> }>(
        `EXPLAIN (FORMAT JSON) ${text}`,
        params,
      );
      const nodes = walk(plan.rows[0]!['QUERY PLAN'][0]!.Plan);
      const used = nodes
        .filter((x) => INDEX_SCANS.has(x['Node Type']) && x['Index Name'] !== undefined)
        .map((x) => x['Index Name']!);
      console.log(`SR0.5 plan ${shape.name}: index scans on [${[...new Set(used)].join(', ')}]`);
      expect(
        used.some((u) => shape.indexes.includes(u)),
        `${shape.name} used [${used.join(', ')}]`,
      ).toBe(true);
    });

    it(`${shape.name}: p95 under ${P95_LIMIT_MS} ms over ${RUNS} runs after ${WARMUPS} warm-ups`, async () => {
      const clock = systemClock();
      const run = async (): Promise<number> => {
        const t0 = clock.now().getTime();
        const page = await searchTransactions(db, scoped(shape), { now: NOW, h: 'h' });
        const dt = clock.now().getTime() - t0;
        expect(page.rows.length).toBeGreaterThan(0);
        return dt;
      };
      for (let i = 0; i < WARMUPS; i += 1) await run();
      const times: number[] = [];
      for (let i = 0; i < RUNS; i += 1) times.push(await run());
      times.sort((a, b) => a - b);
      const p95 = times[Math.ceil(0.95 * times.length) - 1]!;
      console.log(
        `SR0.5 speed ${shape.name}: ${times.length} runs after ${WARMUPS} warm-ups, p50=${times[Math.floor(times.length / 2)]} ms, p95=${p95} ms, max=${times[times.length - 1]} ms`,
      );
      expect(times).toHaveLength(RUNS);
      expect(p95).toBeLessThan(P95_LIMIT_MS);
    });
  }
});

async function seed(db: Db): Promise<void> {
  // One simple-query string: one connection, one implicit transaction, a temp table that lives inside it.
  await db.exec(`
CREATE TEMP TABLE seed_src AS
SELECT g AS i,
       CASE WHEN g % 100 = 0 THEN 1 WHEN g % 97 = 0 THEN 2 WHEN g % 53 = 0 THEN 3 WHEN g % 41 = 0 THEN 4 ELSE 0 END AS k,
       timestamptz '${NOW_SQL}' - (g * interval '78 seconds') AS at,
       100 + (g % 900) AS amount
  FROM generate_series(1, ${LINES}) AS g;

INSERT INTO buyers (id, display_name, auth_subject, country, created_at, updated_at)
SELECT 'buy_' || b, 'Buyer ' || b, 'sub-' || b, 'US', timestamptz '${NOW_SQL}', timestamptz '${NOW_SQL}'
  FROM generate_series(0, 999) AS b;

INSERT INTO publishers (id, slug, display_name, country, paypal_merchant_id, created_at, updated_at)
SELECT 'pub_' || p, 'seller-' || p, 'Seller ' || p, 'US', 'MERCH' || p, timestamptz '${NOW_SQL}', timestamptz '${NOW_SQL}'
  FROM generate_series(0, 999) AS p;

INSERT INTO articles (id, publisher_id, title, abstract, language, topics, published_at, sha256, content_key, bytes, mime, created_at, updated_at)
SELECT 'art_' || p, 'pub_' || p, 'Article ' || p, 'abstract', 'en', ARRAY['news'], timestamptz '${NOW_SQL}',
       lpad(to_hex(p), 64, '0'), 'content-' || p, 10, 'text/plain', timestamptz '${NOW_SQL}', timestamptz '${NOW_SQL}'
  FROM generate_series(0, 99) AS p;

INSERT INTO approvals (id, buyer_id, snapshot, content_hash, nonce, expires_at, used_at, environment, created_at, updated_at)
SELECT 'apr_' || i, 'buy_' || (i % 1000), '{}'::jsonb, lpad(to_hex(i), 64, '0'), 'nonce-' || i,
       at + interval '15 minutes', NULL, 'dryrun', at, at
  FROM seed_src;

INSERT INTO orders (id, approval_id, buyer_id, content_hash, order_ref, expected, status, mismatch, corridor_id, currency, total_minor, environment, created_at, updated_at)
SELECT 'ord_' || i, 'apr_' || i, 'buy_' || (i % 1000), lpad(to_hex(i + 1000000), 64, '0'), 'ref_' || i, '{}'::jsonb,
       CASE k WHEN 1 THEN 'unresolved' WHEN 2 THEN 'paid_partial' WHEN 4 THEN 'failed' ELSE 'paid' END,
       k = 2, 'us-usd', 'USD', amount, 'dryrun', at, at
  FROM seed_src;

INSERT INTO provider_orders (id, order_id, provider_order_id, route, approve_url, status, created_at, updated_at, position, po_ref, publisher_id, state, first_approved_at)
SELECT 'po_' || i, 'ord_' || i, 'PP' || lpad(i::text, 10, '0'), 'single', NULL, NULL, at, at, 1, 'ref_' || i, NULL, 'prepared', NULL
  FROM seed_src;

INSERT INTO order_units (id, order_id, provider_order_ref, publisher_id, reference_id, payee_merchant_id, amount_minor, platform_fee_minor, capture_id, status, status_reason, paypal_fee_minor, refunded_minor, captured_verified_at, mismatch_reason, created_at, updated_at)
SELECT 'unt_' || i, 'ord_' || i, 'po_' || i, 'pub_' || (i % 1000), 'r' || i, 'MERCH' || (i % 1000), amount, 0,
       CASE WHEN k IN (0, 3) THEN 'CAP' || i END,
       CASE k WHEN 1 THEN 'pending' WHEN 2 THEN 'mismatch' WHEN 3 THEN 'refunded' WHEN 4 THEN 'declined' ELSE 'captured_verified' END,
       NULL, NULL, CASE WHEN k = 3 THEN amount ELSE 0 END,
       CASE WHEN k IN (0, 3) THEN at END, NULL, at, at
  FROM seed_src;

INSERT INTO entitlements (id, buyer_id, article_id, unit_id, option, policy, money_state, access_state, licence_state, transition_log, environment, created_at, updated_at)
SELECT 'ent_' || i, 'buy_' || (i % 1000), 'art_' || (i % 100), 'unt_' || i, 'keep_retrieve', '{}'::jsonb,
       'denied', 'locked', NULL, '[]'::jsonb, 'dryrun', at, at
  FROM seed_src;

DROP TABLE seed_src;
`);
  await db.exec('ANALYZE');
}
