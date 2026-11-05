// INT-SR1 (SR1.1, SR1.2, SR1.3): the paging rules every list shares. A call with no query keys is "plain":
// it answers all rows up to 5,000 with no next_cursor. Any filter, sort, limit or cursor pages by keyset
// (default 25, max 100). A cursor carries a hash of the canonical query (without the cursor) and the
// principal; a cursor of another filter or another principal is refused with 400 bad_cursor. The four saved
// views are literal queries; Needs attention has no date filter so SR0's fast path still answers it.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Actor } from '@umsbx/contracts';
import { VIEWS_EXPECTED, VIEWS_MEMBERS, seedViewsWorld } from '../fixtures/views-seed';
import {
  EXPORT_CAP,
  LEGACY_CAP,
  TxnSearchError,
  isPlainQuery,
  listTransactions,
  principalKey,
  queryHash,
  savedView,
  savedViews,
  VIEW_IDS,
} from './index';
import { NOW, openMigrated, seedOrder, seedStandardWorld } from './test-fixtures';
import type { Db } from './test-fixtures';

const B1: Actor = { kind: 'buyer', buyer_id: 'b1' };
const B2: Actor = { kind: 'buyer', buyer_id: 'b2' };
const OP: Actor = { kind: 'operator', operator_id: 'op_1', mfa: true };

let db: Db;
beforeAll(async () => {
  db = await openMigrated();
  await seedStandardWorld(db);
  for (let i = 0; i < 30; i++) {
    await seedOrder(db, {
      id: `bulk${String(i)}`,
      buyer: 'b1',
      created_at: new Date(Date.parse('2026-10-01T00:00:00.000Z') + i * 3_600_000).toISOString(),
      status: 'paid',
      units: [
        {
          id: `bu${String(i)}`,
          publisher: 'p1',
          amount_minor: 100 + i,
          status: 'captured_verified',
        },
      ],
    });
  }
});
afterAll(async () => {
  await db.close();
});

describe('plain and paged', () => {
  it('constants', () => {
    expect(LEGACY_CAP).toBe(5000);
    expect(EXPORT_CAP).toBe(5000);
  });

  it('isPlainQuery: no keys, or only values that parse to nothing', () => {
    expect(isPlainQuery({})).toBe(true);
    expect(isPlainQuery({ status: 'bogus' })).toBe(true);
    expect(isPlainQuery({ limit: '5' })).toBe(false);
    expect(isPlainQuery({ cursor: 'abc' })).toBe(false);
    expect(isPlainQuery({ status: 'paid' })).toBe(false);
    expect(isPlainQuery({ sort: 'amount' })).toBe(false);
  });

  it('a plain call answers every row with no next_cursor', async () => {
    const r = await listTransactions(db, B1, {}, { now: NOW });
    expect(r.mode).toBe('all');
    expect(r.rows).toHaveLength(32);
    expect(r.next_cursor).toBeNull();
  });

  it('a limit pages by keyset: 25 then the rest, no repeats', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    const sizes: number[] = [];
    do {
      const raw: Record<string, string> =
        cursor === null ? { limit: '25' } : { limit: '25', cursor };
      const page = await listTransactions(db, B1, raw, { now: NOW });
      expect(page.mode).toBe('paged');
      sizes.push(page.rows.length);
      seen.push(...page.rows.map((x) => String(x['unit_id'])));
      cursor = page.next_cursor;
    } while (cursor !== null);
    expect(sizes).toEqual([25, 7]);
    expect(new Set(seen).size).toBe(32);
  });

  it('the default page is 25 and a limit above 100 is dropped to the default', async () => {
    expect((await listTransactions(db, B1, { status: 'paid' }, { now: NOW })).rows).toHaveLength(
      25,
    );
    expect(
      (await listTransactions(db, B1, { status: 'paid', limit: '500' }, { now: NOW })).rows,
    ).toHaveLength(25);
    expect(
      (await listTransactions(db, B1, { status: 'paid', limit: '100' }, { now: NOW })).rows,
    ).toHaveLength(32);
  });
});

describe('cursor binding', () => {
  const first = (p: Actor, raw: Record<string, string>) =>
    listTransactions(db, p, raw, { now: NOW });

  it('a cursor continues the same query for the same principal', async () => {
    const p1 = await first(B1, { status: 'paid', limit: '10' });
    const p2 = await first(B1, { status: 'paid', limit: '10', cursor: p1.next_cursor! });
    expect(p2.rows).toHaveLength(10);
  });

  it('a cursor reused with another filter is bad_cursor', async () => {
    const p1 = await first(B1, { status: 'paid', limit: '10' });
    await expect(
      first(B1, { status: 'refunded', limit: '10', cursor: p1.next_cursor! }),
    ).rejects.toMatchObject({ status: 400, code: 'bad_cursor' });
    await expect(
      first(B1, { status: 'paid,refunded', limit: '10', cursor: p1.next_cursor! }),
    ).rejects.toMatchObject({ code: 'bad_cursor' });
    await expect(first(B1, { limit: '10', cursor: p1.next_cursor! })).rejects.toMatchObject({
      code: 'bad_cursor',
    });
  });

  it('a cursor reused by another principal is bad_cursor', async () => {
    const p1 = await first(B1, { status: 'paid', limit: '1' });
    await expect(
      first(B2, { status: 'paid', limit: '1', cursor: p1.next_cursor! }),
    ).rejects.toBeInstanceOf(TxnSearchError);
    await expect(
      first(OP, { status: 'paid', limit: '1', cursor: p1.next_cursor! }),
    ).rejects.toMatchObject({ code: 'bad_cursor' });
  });

  it('garbage is bad_cursor, never page 1', async () => {
    await expect(first(B1, { limit: '5', cursor: 'not-a-cursor' })).rejects.toMatchObject({
      code: 'bad_cursor',
    });
    await expect(
      first(B1, { cursor: Buffer.from('o1:ord_1').toString('base64url') }),
    ).rejects.toMatchObject({ code: 'bad_cursor' });
  });

  it('the hash ignores the cursor and key order, and sees every filter and the principal', () => {
    const k = principalKey(B1);
    expect(queryHash({ status: ['paid'], limit: 5 }, k)).toBe(
      queryHash({ limit: 5, status: ['paid'], cursor: 'zzz' }, k),
    );
    expect(queryHash({ status: ['paid'] }, k)).not.toBe(queryHash({ status: ['failed'] }, k));
    expect(queryHash({ status: ['paid'] }, k)).not.toBe(
      queryHash({ status: ['paid'] }, principalKey(B2)),
    );
    expect(queryHash({ q: 'a' }, k)).not.toBe(queryHash({ q: 'b' }, k));
    expect(principalKey(B1)).not.toBe(
      principalKey({ kind: 'operator', operator_id: 'b1', mfa: false }),
    );
    expect(principalKey({ kind: 'operator', operator_id: 'o', mfa: true })).not.toBe(
      principalKey({ kind: 'operator', operator_id: 'o', mfa: false }),
    );
  });
});

describe('SR1.3 saved views', () => {
  it('are literal queries; Refunds today is the UTC day of the injected clock', () => {
    const now = new Date('2026-11-05T23:59:59.000Z');
    expect(savedViews(now)).toEqual({
      needs_attention: { status: ['attention'] },
      refunds_today: { refund: ['partial', 'full'], from: '2026-11-05' },
      agent_purchases: { channel: 'agent' },
      sandbox_only: { environment: 'sandbox' },
    });
    expect(savedView('refunds_today', new Date('2026-11-06T00:00:00.000Z')).from).toBe(
      '2026-11-06',
    );
    expect(VIEW_IDS).toEqual([
      'needs_attention',
      'refunds_today',
      'agent_purchases',
      'sandbox_only',
    ]);
  });

  it('views-seed gives each view its count', async () => {
    const d = await openMigrated();
    try {
      await seedViewsWorld(d, NOW);
      for (const id of VIEW_IDS) {
        const page = await listTransactions(d, OP, {}, { now: NOW, view: id });
        expect(page.rows.map((r) => r['unit_id']).sort()).toEqual([...VIEWS_MEMBERS[id]].sort());
        expect(page.rows).toHaveLength(VIEWS_EXPECTED[id]);
      }
    } finally {
      await d.close();
    }
  });
});
