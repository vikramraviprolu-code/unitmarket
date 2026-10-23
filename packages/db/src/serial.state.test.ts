// CO-9 / ASM-55: PGlite runs one transaction at a time. Two concurrent transaction() calls never
// interleave statements. A statement-order spy records, for every statement, when it starts and when
// it ends; a transaction's statements must form one block with no statement of the other inside.
// A control run without transactions shows the spy does see interleaving when it exists.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Clock, SqlExecutor } from '@umsbx/contracts';
import { openDatabase } from './pglite';
import type { SqlDriver } from './driver';

const clock: Clock = { now: () => new Date('2026-03-04T05:06:07.000Z') };

type Event = { tx: string; stmt: number; at: 'start' | 'end'; seq: number };

// Records every statement through an executor. `seq` is the global order of the events.
function spy(log: Event[], tx: string, inner: SqlExecutor): SqlExecutor {
  let n = 0;
  return {
    query: async <T = Record<string, unknown>>(sql: string, params?: unknown[]) => {
      const stmt = n++;
      log.push({ tx, stmt, at: 'start', seq: log.length });
      try {
        return await inner.query<T>(sql, params);
      } finally {
        log.push({ tx, stmt, at: 'end', seq: log.length });
      }
    },
    exec: async (sql: string) => {
      const stmt = n++;
      log.push({ tx, stmt, at: 'start', seq: log.length });
      try {
        await inner.exec(sql);
      } finally {
        log.push({ tx, stmt, at: 'end', seq: log.length });
      }
    },
  };
}

const yieldTurn = (i: number): Promise<void> =>
  i % 3 === 0
    ? new Promise((r) => setImmediate(r))
    : i % 3 === 1
      ? new Promise((r) => setTimeout(r, 1))
      : Promise.resolve();

// Number of times a statement of one transaction sits between two statements of the other.
function interleavings(log: Event[], a: string, b: string): number {
  const own = (t: string): Event[] => log.filter((e) => e.tx === t);
  const span = (t: string): [number, number] => {
    const e = own(t);
    return [e[0]?.seq ?? 0, e[e.length - 1]?.seq ?? 0];
  };
  const [a0, a1] = span(a);
  const [b0, b1] = span(b);
  // Disjoint spans mean one transaction finished all its statements before the other began.
  return a1 < b0 || b1 < a0 ? 0 : 1;
}

async function readModifyWrite(
  db: SqlDriver,
  log: Event[],
  tx: string,
  pause: number,
): Promise<number> {
  return db.transaction(async (raw) => {
    const t = spy(log, tx, raw);
    const read = await t.query<{ v: number }>('SELECT v FROM ctr WHERE id = 1');
    const seen = Number(read.rows[0]?.v);
    await yieldTurn(pause);
    await t.query('INSERT INTO seen (tx, v) VALUES ($1, $2)', [tx, seen]);
    await yieldTurn(pause + 1);
    await t.query('UPDATE ctr SET v = $1 WHERE id = 1', [seen + 1]);
    await yieldTurn(pause + 2);
    await t.query('SELECT v FROM ctr WHERE id = 1');
    return seen;
  });
}

async function runPairs(db: SqlDriver, pairs: number): Promise<{ log: Event[]; seen: number[] }> {
  await db.exec('CREATE TABLE ctr (id int PRIMARY KEY, v int NOT NULL)');
  await db.exec('CREATE TABLE seen (tx text, v int)');
  await db.query('INSERT INTO ctr VALUES (1, 0)');
  const log: Event[] = [];
  const seen: number[] = [];
  for (let i = 0; i < pairs; i += 1) {
    const [x, y] = await Promise.all([
      readModifyWrite(db, log, `p${i}a`, i),
      readModifyWrite(db, log, `p${i}b`, i + 1),
    ]);
    seen.push(x, y);
    const mine = log.filter((e) => e.tx === `p${i}a` || e.tx === `p${i}b`);
    expect(interleavings(mine, `p${i}a`, `p${i}b`), `pair ${i} interleaved`).toBe(0);
  }
  return { log, seen };
}

describe('PGlite runs one transaction at a time (memory target)', { timeout: 120_000 }, () => {
  let db: SqlDriver;
  beforeAll(async () => {
    db = await openDatabase({ kind: 'pglite-memory' });
  });
  afterAll(async () => {
    await db.close();
  });

  it('50 pairs of concurrent transactions: no statement of one appears between the statements of the other', async () => {
    const { log, seen } = await runPairs(db, 50);
    // Every statement was seen: 50 pairs x 2 transactions x 4 statements x (start, end).
    expect(log).toHaveLength(50 * 2 * 4 * 2);
    // Read-modify-write on one row: no lost update means every transaction saw a distinct value.
    expect(seen).toHaveLength(100);
    expect([...seen].sort((p, q) => p - q)).toEqual(Array.from({ length: 100 }, (_v, i) => i));
    const final = await db.query<{ v: number }>('SELECT v FROM ctr WHERE id = 1');
    expect(Number(final.rows[0]?.v)).toBe(100);
    // Evidence line for the PR: the interleaving spy output for the first pair.
    const first = log
      .filter((e) => e.tx.startsWith('p0'))
      .map((e) => `${e.tx}#${e.stmt}:${e.at}`)
      .join(' ');
    process.stdout.write(`serial spy, pair 0: ${first}\nserial spy: 50 pairs, 0 interleavings\n`);
  });
});

describe('PGlite runs one transaction at a time (disk target)', { timeout: 120_000 }, () => {
  let dir: string;
  let db: SqlDriver;
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ums-serial-'));
    db = await openDatabase({ kind: 'pglite-disk', dir }, { clock });
  });
  afterAll(async () => {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('10 pairs of concurrent transactions do not interleave', async () => {
    const { seen } = await runPairs(db, 10);
    expect([...seen].sort((p, q) => p - q)).toEqual(Array.from({ length: 20 }, (_v, i) => i));
  });
});

describe('the spy is able to see interleaving (control)', { timeout: 120_000 }, () => {
  it('two concurrent loops on plain query() calls (no transaction) do interleave', async () => {
    const db = await openDatabase({ kind: 'pglite-memory' });
    try {
      await db.exec('CREATE TABLE c (v int)');
      const log: Event[] = [];
      const loop = async (name: string): Promise<void> => {
        const t = spy(log, name, db);
        for (let i = 0; i < 4; i += 1) {
          await t.query('INSERT INTO c VALUES ($1)', [i]);
          await yieldTurn(i);
        }
      };
      await Promise.all([loop('x'), loop('y')]);
      expect(interleavings(log, 'x', 'y')).toBe(1);
    } finally {
      await db.close();
    }
  });
});
