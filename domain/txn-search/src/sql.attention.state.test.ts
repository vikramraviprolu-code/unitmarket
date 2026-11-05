// INT-SR0 (SR0.4, SR0.5): the plain Needs attention list takes a shortcut (each attention set is cut to the page
// size before the union). This file proves the shortcut gives the same pages as the rule itself: the expected
// lines are computed in JavaScript with statusGroupOf from every line in the view, then compared page by page,
// in both directions, for several page sizes, for each scope, and for a query that has a filter and so does not
// take the shortcut.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseTxnQuery, statusGroupOf } from '@umsbx/contracts';
import type { Actor } from '@umsbx/contracts';
import { buildTxnSql, scopeQuery, searchTransactions } from './index';
import { NOW, openMigrated, seedOrder, seedStandardWorld } from './test-fixtures';
import type { Db } from './test-fixtures';

const OPERATOR: Actor = { kind: 'operator', operator_id: 'op_1', mfa: true };
const BUYER1: Actor = { kind: 'buyer', buyer_id: 'b1' };
const SELLER2: Actor = { kind: 'publisher', publisher_id: 'p2' };

const minutesAgo = (m: number): string => new Date(NOW.getTime() - m * 60_000).toISOString();

interface Line {
  unit_id: string;
  order_id: string;
  created_at: string;
  order_status: string;
  unit_status: string;
  unit_updated_at: string;
  buyer_id: string;
  publisher_id: string;
  currency: string;
}

let db: Db;
let lines: Line[] = [];

beforeAll(async () => {
  db = await openMigrated();
  await seedStandardWorld(db);
  // 36 more lines. Six orders share each created_at (ties are broken by order id, then unit id). Order status,
  // unit status and age rotate so that some lines are attention by the order only, some by the unit only, and
  // some by both (a mismatch inside an unresolved order is in both sets).
  const orderStatuses = ['paid', 'unresolved', 'frozen', 'paid', 'created', 'paid'];
  const unitStatuses = [
    'captured_verified',
    'mismatch',
    'pending',
    'pending',
    'reversal_suspected',
    'refunded',
  ];
  for (let i = 0; i < 36; i += 1) {
    const n = String(i).padStart(2, '0');
    await seedOrder(db, {
      id: `ox${n}`,
      buyer: i % 2 === 0 ? 'b1' : 'b2',
      created_at: `2026-11-03T10:${String(Math.floor(i / 6)).padStart(2, '0')}:00.000Z`,
      status: orderStatuses[i % 6]!,
      units: [
        {
          id: `ux${n}`,
          publisher: i % 3 === 0 ? 'p2' : 'p1',
          amount_minor: 100 + i,
          status: unitStatuses[(i + Math.floor(i / 6)) % 6]!,
          // Half of the pending lines are older than the hour, half are not.
          updated_at: minutesAgo(i % 4 < 2 ? 90 : 20),
        },
      ],
    });
  }
  const r = await db.query<Line>(
    `SELECT unit_id, order_id, to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
            order_status, unit_status, to_char(unit_updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS unit_updated_at,
            buyer_id, publisher_id, currency
       FROM txn_rows`,
  );
  lines = r.rows;
});
afterAll(() => db.close());

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The expected ids by the rule itself, in the sort order of the list. */
function expected(dir: 'asc' | 'desc', keep: (l: Line) => boolean = () => true): string[] {
  const rows = lines
    .filter((l) => statusGroupOf(l, NOW) === 'attention' && keep(l))
    .sort(
      (a, b) =>
        cmp(a.created_at, b.created_at) || cmp(a.order_id, b.order_id) || cmp(a.unit_id, b.unit_id),
    );
  if (dir === 'desc') rows.reverse();
  return rows.map((l) => l.unit_id);
}

/** Every page of the list, followed by cursor. */
async function allPages(
  who: Actor,
  raw: Record<string, string>,
): Promise<{ ids: string[]; pages: number }> {
  const ids: string[] = [];
  let cursor: string | undefined;
  let pages = 0;
  for (let i = 0; i < 80; i += 1) {
    const q = cursor === undefined ? raw : { ...raw, cursor };
    const page = await searchTransactions(db, scopeQuery(who, q, parseTxnQuery(q)), {
      now: NOW,
      h: 'h',
    });
    ids.push(...page.rows.map((r) => String(r['unit_id'])));
    pages += 1;
    if (page.next_cursor === null) break;
    cursor = page.next_cursor;
  }
  return { ids, pages };
}

describe('the world has what the tests need', () => {
  it('has lines in the order set only, the unit set only and both', () => {
    const attention = lines.filter((l) => statusGroupOf(l, NOW) === 'attention');
    const byOrder = (l: Line): boolean => ['unresolved', 'frozen'].includes(l.order_status);
    const byUnit = (l: Line): boolean =>
      ['mismatch', 'reversal_suspected'].includes(l.unit_status) ||
      (l.unit_status === 'pending' && Date.parse(l.unit_updated_at) < NOW.getTime() - 3_600_000);
    expect(attention.filter((l) => byOrder(l) && !byUnit(l)).length).toBeGreaterThan(2);
    expect(attention.filter((l) => byUnit(l) && !byOrder(l)).length).toBeGreaterThan(2);
    expect(attention.filter((l) => byOrder(l) && byUnit(l)).length).toBeGreaterThan(2);
    expect(lines.length - attention.length).toBeGreaterThan(5);
  });
});

describe('the Needs attention shortcut gives the pages the rule gives', () => {
  it('takes the shortcut for the plain list and not for a list with a filter', () => {
    const text = (raw: Record<string, string>): string =>
      buildTxnSql(scopeQuery(OPERATOR, raw, parseTxnQuery(raw)), { now: NOW, h: 'h' }).text;
    expect(text({ status: 'attention' })).toContain('UNION\n');
    expect(text({ status: 'attention', currency: 'USD' })).not.toContain('UNION\n');
    expect(text({ status: 'attention', sort: 'amount' })).not.toContain('UNION\n');
    expect(text({ status: 'attention,paid' })).not.toContain('UNION\n');
  });

  for (const dir of ['desc', 'asc'] as const) {
    for (const limit of [1, 2, 3, 5, 100]) {
      it(`operator, dir=${dir}, limit=${limit}: every page, in order, no line twice`, async () => {
        const { ids } = await allPages(OPERATOR, {
          status: 'attention',
          dir,
          limit: String(limit),
        });
        expect(ids).toEqual(expected(dir));
        expect(new Set(ids).size).toBe(ids.length);
      });
    }
  }

  it('a first page of limit lines holds limit lines, also when the top lines are in both sets', async () => {
    const want = expected('desc');
    const page = await searchTransactions(
      db,
      scopeQuery(
        OPERATOR,
        { status: 'attention', limit: '7' },
        parseTxnQuery({ status: 'attention', limit: '7' }),
      ),
      { now: NOW, h: 'h' },
    );
    expect(page.rows.map((r) => String(r['unit_id']))).toEqual(want.slice(0, 7));
    expect(page.next_cursor).not.toBeNull();
  });

  it('a buyer gets only its own lines, in order', async () => {
    const { ids } = await allPages(BUYER1, { status: 'attention', limit: '3' });
    expect(ids).toEqual(expected('desc', (l) => l.buyer_id === 'b1'));
    expect(ids.length).toBeGreaterThan(3);
  });

  it('a seller gets only its own lines, in order', async () => {
    const { ids } = await allPages(SELLER2, { status: 'attention', limit: '2', dir: 'asc' });
    expect(ids).toEqual(expected('asc', (l) => l.publisher_id === 'p2'));
    expect(ids.length).toBeGreaterThan(3);
  });

  it('a list with a filter (no shortcut) gives the same lines as the rule', async () => {
    const { ids } = await allPages(OPERATOR, { status: 'attention', currency: 'USD', limit: '4' });
    expect(ids).toEqual(expected('desc', (l) => l.currency === 'USD'));
  });

  it('a query for nothing that matches is an empty page', async () => {
    const { ids } = await allPages(BUYER1, { status: 'attention', limit: '3', from: '2030-01-01' });
    expect(ids).toEqual([]);
  });
});
