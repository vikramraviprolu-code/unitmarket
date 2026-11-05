// INT-SR0: the filters F1 to F13, the three sorts and keyset paging, run against txn_rows on PGlite. The
// status filter is checked against statusGroupOf for every order status and unit status pair, so SQL and
// the contract can never disagree about what "paid" or "needs attention" means.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { STATUS_GROUPS, parseTxnQuery, statusGroupOf } from '@umsbx/contracts';
import type { Actor } from '@umsbx/contracts';
import { scopeQuery, searchTransactions } from './index';
import {
  NOW,
  openMigrated,
  seedAlert,
  seedCase,
  seedCorridor,
  seedOrder,
  seedRefund,
  seedStandardWorld,
  seedUnknownOperation,
} from './test-fixtures';
import type { Db } from './test-fixtures';

const OPERATOR: Actor = { kind: 'operator', operator_id: 'op_1', mfa: true };
const BUYER1: Actor = { kind: 'buyer', buyer_id: 'b1' };

const minutesAgo = (m: number): string => new Date(NOW.getTime() - m * 60_000).toISOString();

describe('filters and sorts', () => {
  let db: Db;
  beforeAll(async () => {
    db = await openMigrated();
    await seedStandardWorld(db);
  });
  afterAll(() => db.close());

  const ids = async (raw: Record<string, string>, who: Actor = OPERATOR): Promise<string[]> =>
    (
      await searchTransactions(db, scopeQuery(who, raw, parseTxnQuery(raw)), { now: NOW, h: 'h' })
    ).rows.map((r) => String(r['unit_id']));

  it('lists newest first by default', async () => {
    expect(await ids({})).toEqual(['u4', 'u3', 'u2', 'u1']);
    expect(await ids({ dir: 'asc' })).toEqual(['u1', 'u2', 'u3', 'u4']);
  });

  it('F1: from and to are UTC days, inclusive at both ends', async () => {
    expect(await ids({ from: '2026-11-02', to: '2026-11-03' })).toEqual(['u3', 'u2']);
    expect(await ids({ from: '2026-11-04' })).toEqual(['u4']);
    expect(await ids({ to: '2026-11-01' })).toEqual(['u1']);
    expect(await ids({ from: '2026-12-01' })).toEqual([]);
  });

  it('F2: amount range on the line, in minor units', async () => {
    expect(await ids({ min_minor: '500', max_minor: '800' })).toEqual(['u4', 'u1']);
    expect(await ids({ min_minor: '1200' })).toEqual(['u2']);
    expect(await ids({ max_minor: '299' })).toEqual([]);
  });

  it('F4: status groups', async () => {
    expect(await ids({ status: 'paid' })).toEqual(['u3', 'u2', 'u1']);
    expect(await ids({ status: 'attention' })).toEqual(['u4']);
    expect(await ids({ status: 'paid,attention' })).toEqual(['u4', 'u3', 'u2', 'u1']);
    expect(await ids({ status: 'refunded,failed,in_progress,part_refunded' })).toEqual([]);
  });

  it('F8: a buyer may find a seller by id, slug or name; F9 q matches item titles', async () => {
    expect(await ids({ seller: 'p1' }, BUYER1)).toEqual(['u1']);
    expect(await ids({ seller: 'pine' }, BUYER1)).toEqual(['u2']);
    expect(await ids({ seller: 'pine press' }, BUYER1)).toEqual(['u2']);
    expect(await ids({ q: 'pine extra' })).toEqual(['u2']);
    expect(await ids({ q: 'DAILY' })).toEqual(['u3', 'u1']);
  });

  it('F10: reference finds an order by ref', async () => {
    expect(await ids({ ref: 'ref_o3' })).toEqual(['u3']);
  });

  it('F11: channel human or agent, and agent key', async () => {
    expect(await ids({ channel: 'agent' })).toEqual(['u3']);
    expect(await ids({ channel: 'human' })).toEqual(['u4', 'u2', 'u1']);
    expect(await ids({ agent_key: 'key_b2' })).toEqual(['u3']);
  });

  it('F12: environment', async () => {
    expect(await ids({ environment: 'dryrun' })).toHaveLength(4);
    expect(await ids({ environment: 'sandbox' })).toEqual([]);
  });

  it('sort=amount orders by the line amount, ties by unit id; dir flips both', async () => {
    expect(await ids({ sort: 'amount' })).toEqual(['u2', 'u4', 'u1', 'u3']);
    expect(await ids({ sort: 'amount', dir: 'asc' })).toEqual(['u3', 'u1', 'u4', 'u2']);
  });

  it('sort=status puts needs attention first, then paid; ties by unit id', async () => {
    expect(await ids({ sort: 'status' })).toEqual(['u4', 'u3', 'u2', 'u1']);
    expect(await ids({ sort: 'status', dir: 'asc' })).toEqual(['u1', 'u2', 'u3', 'u4']);
  });

  it('pages with a keyset cursor: every line once, in order, none repeated', async () => {
    for (const raw of [
      { sort: 'newest' },
      { sort: 'newest', dir: 'asc' },
      { sort: 'amount' },
      { sort: 'amount', dir: 'asc' },
      { sort: 'status' },
      { sort: 'status', dir: 'asc' },
    ]) {
      const whole = await ids({ ...raw });
      const seen: string[] = [];
      let cursor: string | undefined;
      for (let i = 0; i < 10; i += 1) {
        const q: Record<string, string> = { ...raw, limit: '3' };
        if (cursor !== undefined) q['cursor'] = cursor;
        const page = await searchTransactions(db, scopeQuery(OPERATOR, q, parseTxnQuery(q)), {
          now: NOW,
          h: 'h',
        });
        seen.push(...page.rows.map((r) => String(r['unit_id'])));
        if (page.next_cursor === null) break;
        expect(page.rows).toHaveLength(3);
        cursor = page.next_cursor;
      }
      expect(seen, JSON.stringify(raw)).toEqual(whole);
    }
  });

  it('returns no next cursor when the page is not full or the list ends exactly', async () => {
    const q = { limit: '4' };
    const page = await searchTransactions(db, scopeQuery(OPERATOR, q, parseTxnQuery(q)), {
      now: NOW,
      h: 'h',
    });
    expect(page.rows).toHaveLength(4);
    expect(page.next_cursor).toBeNull();
  });
});

describe('more filters on a richer world', () => {
  let db: Db;
  beforeAll(async () => {
    db = await openMigrated();
    await seedStandardWorld(db);
    await seedCorridor(db, 'eu-eur', 'EUR');
    await seedOrder(db, {
      id: 'o7',
      buyer: 'b1',
      created_at: '2026-11-04T12:00:00.000Z',
      status: 'paid',
      currency: 'EUR',
      corridor: 'eu-eur',
      environment: 'dryrun',
      units: [
        {
          id: 'u7',
          publisher: 'p1',
          amount_minor: 400,
          status: 'partially_refunded',
          refunded_minor: 100,
        },
      ],
    });
    await seedOrder(db, {
      id: 'o8',
      buyer: 'b1',
      created_at: '2026-11-04T13:00:00.000Z',
      status: 'paid',
      units: [
        { id: 'u8', publisher: 'p1', amount_minor: 600, status: 'refunded', refunded_minor: 600 },
      ],
    });
    await seedRefund(db, {
      id: 'rf_8',
      unit: 'u8',
      state: 'completed',
      created_at: '2026-11-04T14:00:00.000Z',
    });
    await seedRefund(db, {
      id: 'rf_1',
      unit: 'u1',
      state: 'requested',
      created_at: '2026-11-04T14:00:00.000Z',
    });
    await seedCase(db, {
      id: 'cas_1',
      order: 'o1',
      buyer: 'b1',
      kind: 'delivery_failed',
      state: 'diagnosing',
      created_at: '2026-11-04T10:00:00.000Z',
    });
    await seedCase(db, {
      id: 'cas_2',
      order: 'o2',
      buyer: 'b1',
      kind: 'delivery_failed',
      state: 'closed',
      created_at: '2026-11-04T10:00:00.000Z',
    });
    await seedAlert(db, { id: 'alr_1', order: 'o2', kind: 'x', reason: 'r' });
    await seedUnknownOperation(db, { id: 'opr_1', order: 'o3', unit: 'u3' });
    await seedOrder(db, {
      id: 'o9',
      buyer: 'b2',
      created_at: '2026-11-04T15:00:00.000Z',
      status: 'paid',
      mismatch: true,
      environment: 'sandbox',
      units: [{ id: 'u9', publisher: 'p2', amount_minor: 50, status: 'mismatch' }],
    });
  });
  afterAll(() => db.close());

  const ids = async (raw: Record<string, string>): Promise<string[]> =>
    (
      await searchTransactions(db, scopeQuery(OPERATOR, raw, parseTxnQuery(raw)), {
        now: NOW,
        h: 'h',
      })
    ).rows
      .map((r) => String(r['unit_id']))
      .sort();

  it('F3: currency', async () => {
    expect(await ids({ currency: 'eur' })).toEqual(['u7']);
    expect(await ids({ currency: 'EUR,USD' })).toHaveLength(7);
  });

  it('F4: partly refunded and refunded groups', async () => {
    expect(await ids({ status: 'part_refunded' })).toEqual(['u7']);
    expect(await ids({ status: 'refunded' })).toEqual(['u8']);
  });

  it('F5: refund none, requested, partial, full', async () => {
    expect(await ids({ refund: 'requested' })).toEqual(['u1']);
    expect(await ids({ refund: 'partial' })).toEqual(['u7']);
    expect(await ids({ refund: 'full' })).toEqual(['u8']);
    expect(await ids({ refund: 'none' })).toEqual(['u2', 'u3', 'u4', 'u9']);
    expect(await ids({ refund: 'partial,full' })).toEqual(['u7', 'u8']);
  });

  it('F6: case none, open (open, diagnosing, refund_pending), resolved', async () => {
    expect(await ids({ case: 'open' })).toEqual(['u1']);
    expect(await ids({ case: 'resolved' })).toEqual(['u2']);
    expect(await ids({ case: 'none' })).toEqual(['u3', 'u4', 'u7', 'u8', 'u9']);
  });

  it('F12: environment sandbox; F13: flags alert, mismatch, unknown_op', async () => {
    expect(await ids({ environment: 'sandbox' })).toEqual(['u9']);
    expect(await ids({ flags: 'alert' })).toEqual(['u2']);
    expect(await ids({ flags: 'unknown_op' })).toEqual(['u3']);
    expect(await ids({ flags: 'mismatch' })).toEqual(['u9']);
    expect(await ids({ flags: 'alert,unknown_op' })).toEqual(['u2', 'u3']);
  });

  it('combines filters with AND', async () => {
    expect(await ids({ seller: 'p1', min_minor: '400', status: 'paid' })).toEqual(['u1']);
    expect(await ids({ case: 'open', refund: 'requested', q: 'harbour' })).toEqual(['u1']);
    expect(await ids({ case: 'open', refund: 'full' })).toEqual([]);
  });
});

describe('status filter agrees with statusGroupOf for every pair', () => {
  let db: Db;
  const rows: Array<{ unit: string; order_status: string; unit_status: string; age: number }> = [];
  beforeAll(async () => {
    db = await openMigrated();
    await seedStandardWorld(db);
    const orderStatuses = [
      'created',
      'awaiting_buyer',
      'capture_requested',
      'capture_claimed',
      'unresolved',
      'paid',
      'paid_partial',
      'failed',
      'abandoned',
      'frozen',
    ];
    const unitStatuses = [
      'expected',
      'captured_verified',
      'pending',
      'declined',
      'mismatch',
      'partially_refunded',
      'refunded',
      'reversal_suspected',
      'reversed',
    ];
    let n = 0;
    for (const order_status of orderStatuses) {
      for (const unit_status of unitStatuses) {
        // Pending is the only status whose group depends on age: try both sides of the hour.
        const ages = unit_status === 'pending' ? [59, 61] : [10];
        for (const age of ages) {
          n += 1;
          const unit = `uz${n}`;
          rows.push({ unit, order_status, unit_status, age });
          await seedOrder(db, {
            id: `oz${n}`,
            buyer: 'b1',
            created_at: '2026-10-20T10:00:00.000Z',
            status: order_status,
            units: [
              {
                id: unit,
                publisher: 'p1',
                amount_minor: 10,
                status: unit_status,
                updated_at: minutesAgo(age),
              },
            ],
          });
        }
      }
    }
  });
  afterAll(() => db.close());

  it('has 100 cases', () => {
    expect(rows).toHaveLength(100);
  });

  for (const group of Object.keys(STATUS_GROUPS)) {
    it(`status=${group} returns exactly the lines statusGroupOf calls ${group}`, async () => {
      const raw = { status: group, limit: '100', from: '2026-10-20', to: '2026-10-20' };
      const got: string[] = [];
      let cursor: string | undefined;
      for (let i = 0; i < 5; i += 1) {
        const q: Record<string, string> = cursor === undefined ? raw : { ...raw, cursor };
        const page = await searchTransactions(
          db,
          scopeQuery({ kind: 'operator', operator_id: 'op_1', mfa: true }, q, parseTxnQuery(q)),
          { now: NOW, h: 'h' },
        );
        got.push(...page.rows.map((r) => String(r['unit_id'])));
        if (page.next_cursor === null) break;
        cursor = page.next_cursor;
      }
      const want = rows
        .filter(
          (r) =>
            statusGroupOf(
              {
                order_status: r.order_status,
                unit_status: r.unit_status,
                unit_updated_at: minutesAgo(r.age),
              },
              NOW,
            ) === group,
        )
        .map((r) => r.unit);
      expect(got.sort()).toEqual(want.sort());
      expect(want.length).toBeGreaterThan(0);
    });
  }
});
