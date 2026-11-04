// INT-TR0 / TR0.5: concurrent writers on real Postgres 16 (UMS_TEST_PG_BIN). Two cases, 50 runs each:
// (1) two writers on one chain, (2) the cap-plus-order agent buy: two buys serialised on the mandate row
// (SELECT ... FOR UPDATE, as domain/mandates/src/reserve.ts does) while a job writes the same order.
// Every run must end without a deadlock (40P01) and without a duplicate or skipped seq; at the end the
// whole journal verifies. A skip is a fail: without the Postgres binaries the first test fails.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { migrate } from './index';
import { openDatabase } from './pglite';
import { pgBinConfigured, startTestPostgres } from './pg-testing';
import type { TestPostgres } from './pg-testing';
import type { SqlDriver } from './driver';
import { T, as, chainOf, clock, ctx, ins, j, seedWorld } from './trace-test-support';
import type { Db } from './trace-test-support';
import { verifyTrace } from './trace-verify';

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });

const RUNS = 50;
let server: TestPostgres | undefined;
let db: SqlDriver;
const runs = { chain: 0, agent: 0 };

beforeAll(async () => {
  if (!pgBinConfigured()) return;
  server = await startTestPostgres();
  const created = await server.createDatabase('tr0_race');
  db = await openDatabase({ kind: 'postgres', url: created.url, pool_max: 6 });
  await migrate(db, { now: () => new Date(T) });
  await seedWorld(db as Db);
}, 300_000);
afterAll(async () => {
  console.log(
    `TRACE-RACE runs: two writers on one chain ${runs.chain}, cap-plus-order agent buy ${runs.agent}`,
  );
  await db?.close().catch(() => undefined);
  await server?.stop();
});

const assertChain = async (chain: string): Promise<void> => {
  const rows = await chainOf(db, chain);
  expect(rows.map((r) => r.seq)).toEqual(rows.map((_, i) => i + 1));
  for (let i = 1; i < rows.length; i += 1) expect(rows[i]!.prev_hash).toBe(rows[i - 1]!.row_hash);
};

describe('TR0.5 races on real Postgres', () => {
  it('real Postgres 16 is available (a skip is a fail)', () => {
    expect(pgBinConfigured(), 'set UMS_TEST_PG_BIN to the Postgres 16 bin directory').toBe(true);
  });

  it(`two writers on one chain: ${RUNS} runs, no deadlock, no duplicate seq`, async () => {
    const before = (await chainOf(db, 'ord:ord_1')).length;
    for (let i = 0; i < RUNS; i += 1) {
      const a = as(db, ctx({ actor_id: 'opr_a' }), clock);
      const b = as(db, ctx({ actor_id: 'opr_b' }), clock);
      const second = String(i * 2 + 2);
      const first = String(i * 2 + 1);
      // Same lock order in both writers (order row, then alert insert): the journal head is the only thing they share.
      await Promise.all([
        a.transaction(async (tx) => {
          await tx.query(
            `UPDATE orders SET order_ref = $1, updated_at = '${T}'::timestamptz + ($2 || ' seconds')::interval WHERE id = 'ord_1'`,
            [`race_a_${i}`, first],
          );
          await ins(tx, 'alerts', {
            id: `alr_race_a_${i}`,
            kind: 'k',
            order_id: 'ord_1',
            unit_id: null,
            detail: j({ i }),
          });
        }),
        b.transaction(async (tx) => {
          await tx.query(
            `UPDATE orders SET order_ref = $1, updated_at = '${T}'::timestamptz + ($2 || ' seconds')::interval WHERE id = 'ord_1'`,
            [`race_b_${i}`, second],
          );
          await ins(tx, 'alerts', {
            id: `alr_race_b_${i}`,
            kind: 'k',
            order_id: 'ord_1',
            unit_id: null,
            detail: j({ i }),
          });
        }),
      ]);
      runs.chain += 1;
    }
    expect(runs.chain).toBe(RUNS);
    const rows = await chainOf(db, 'ord:ord_1');
    expect(rows.length).toBe(before + RUNS * 4);
    await assertChain('ord:ord_1');
  });

  it(`cap-plus-order agent buy: ${RUNS} runs of two buys and a job, no deadlock, valid chains`, async () => {
    const mdtBefore = (await chainOf(db, 'mdt:man_1')).length;
    const ordBefore = (await chainOf(db, 'ord:ord_1')).length;
    for (let i = 0; i < RUNS; i += 1) {
      const buy = (tag: string, n: number) =>
        as(
          db,
          ctx({
            channel: 'mcp',
            actor_kind: 'agent',
            actor_id: 'key_1',
            on_behalf_of: 'buy_1',
            mandate_id: 'man_1',
          }),
          clock,
        ).transaction(async (tx) => {
          await tx.query("SELECT id FROM mandates WHERE id = 'man_1' FOR UPDATE");
          await tx.query(
            `UPDATE mandates SET spent_minor = $1, used_count = $2, updated_at = '${T}'::timestamptz + ($3 || ' seconds')::interval WHERE id = 'man_1'`,
            [(i * 3 + n) % 400, (i + n) % 5, String(i * 10 + n)],
          );
          await ins(
            tx,
            'mandate_reservations',
            {
              id: `rsv_race_${tag}_${i}`,
              mandate_id: 'man_1',
              order_id: null,
              amount_minor: 1,
              state: 'held',
              created_at: T,
              settled_at: null,
            },
            false,
          );
          await tx.query('UPDATE mandate_reservations SET order_id = $1 WHERE id = $2', [
            'ord_1',
            `rsv_race_${tag}_${i}`,
          ]);
          await tx.query(
            `UPDATE orders SET order_ref = $1, updated_at = '${T}'::timestamptz + ($2 || ' seconds')::interval WHERE id = 'ord_1'`,
            [`buy_${tag}_${i}`, String(1000 + i * 10 + n)],
          );
        });
      const job = as(
        db,
        ctx({ channel: 'job', actor_kind: 'system', actor_id: null, mfa: false, job: 'pass' }),
        clock,
      ).transaction(async (tx) => {
        await tx.query(
          `UPDATE orders SET order_ref = $1, updated_at = '${T}'::timestamptz + ($2 || ' seconds')::interval WHERE id = 'ord_1'`,
          [`job_${i}`, String(2000 + i)],
        );
        await ins(tx, 'alerts', {
          id: `alr_race_job_${i}`,
          kind: 'k',
          order_id: 'ord_1',
          unit_id: null,
          detail: j({ i }),
        });
      });
      await Promise.all([buy('a', 1), buy('b', 2), job]);
      runs.agent += 1;
    }
    expect(runs.agent).toBe(RUNS);
    const mdt = await chainOf(db, 'mdt:man_1');
    const ord = await chainOf(db, 'ord:ord_1');
    expect(mdt.length).toBe(mdtBefore + RUNS * 4); // per run: two mandate updates and two reservation inserts
    expect(ord.length).toBe(ordBefore + RUNS * 6); // per run: two attaches, three order updates, one alert
    await assertChain('mdt:man_1');
    await assertChain('ord:ord_1');
  });

  it('the whole journal verifies after the races, in one REPEATABLE READ read only transaction', async () => {
    const report = await db.transaction(async (tx) => {
      await tx.exec('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      return verifyTrace(tx);
    });
    expect(report.findings).toEqual([]);
    expect(report.chains).toBeGreaterThanOrEqual(6);
  });
});
