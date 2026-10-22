// FIX-PAY2 M-3: the deadlock/serialization retry wrapper, tested against a fake driver (PGlite never
// raises 40P01 or 40001; the future node-postgres adapter will).
import { describe, expect, it } from 'vitest';
import type { Database, SqlExecutor } from '@umsbx/contracts';
import { isRetryableSqlError, withSerializationRetry } from './retry';

const failure = (code: string): Error => Object.assign(new Error(`sqlstate ${code}`), { code });

function fakeDriver(script: (string | null)[]): {
  db: Database;
  runs: SqlExecutor[];
  begins: number;
} {
  const runs: SqlExecutor[] = [];
  const state = { begins: 0 };
  const tx: SqlExecutor = {
    query: () => Promise.resolve({ rows: [] }),
    exec: () => Promise.resolve(),
  };
  const db: Database = {
    dialect: 'pg',
    query: tx.query,
    exec: tx.exec,
    transaction: async <T>(fn: (t: SqlExecutor) => Promise<T>): Promise<T> => {
      state.begins += 1;
      runs.push(tx);
      const code = script[state.begins - 1] ?? null;
      const out = await fn(tx);
      if (code !== null) throw failure(code); // the error comes at COMMIT, after fn ran
      return out;
    },
  };
  return {
    db,
    runs,
    get begins() {
      return state.begins;
    },
  };
}

describe('withSerializationRetry', () => {
  it('knows the two retryable SQLSTATEs', () => {
    expect(isRetryableSqlError(failure('40P01'))).toBe(true);
    expect(isRetryableSqlError(failure('40001'))).toBe(true);
    expect(isRetryableSqlError(failure('23505'))).toBe(false);
    expect(isRetryableSqlError(new Error('plain'))).toBe(false);
    expect(isRetryableSqlError(null)).toBe(false);
  });

  it('runs the same function again after a deadlock and returns its result', async () => {
    const f = fakeDriver(['40P01', '40001', null]);
    const db = withSerializationRetry(f.db);
    let calls = 0;
    const out = await db.transaction(async () => {
      calls += 1;
      return 'done';
    });
    expect(out).toBe('done');
    expect(calls).toBe(3);
    expect(f.begins).toBe(3);
  });

  it('gives up after 3 retries (4 attempts) and throws the last error', async () => {
    const f = fakeDriver(['40001', '40001', '40001', '40001', null]);
    const db = withSerializationRetry(f.db);
    let calls = 0;
    await expect(
      db.transaction(async () => {
        calls += 1;
      }),
    ).rejects.toMatchObject({ code: '40001' });
    expect(calls).toBe(4);
  });

  it('does not retry any other error', async () => {
    const f = fakeDriver(['23505', null]);
    const db = withSerializationRetry(f.db);
    let calls = 0;
    await expect(
      db.transaction(async () => {
        calls += 1;
      }),
    ).rejects.toMatchObject({ code: '23505' });
    expect(calls).toBe(1);
  });

  it('keeps the dialect and the plain query path', async () => {
    const f = fakeDriver([]);
    const db = withSerializationRetry(f.db);
    expect(db.dialect).toBe('pg');
    expect(await db.query('SELECT 1')).toEqual({ rows: [] });
  });

  it('rethrows an error raised by the function itself when it is retryable and the budget is spent', async () => {
    const f = fakeDriver([]);
    const db = withSerializationRetry(f.db, { max_retries: 1 });
    let calls = 0;
    await expect(
      db.transaction(() => {
        calls += 1;
        return Promise.reject(failure('40P01'));
      }),
    ).rejects.toMatchObject({ code: '40P01' });
    expect(calls).toBe(2);
  });
});
