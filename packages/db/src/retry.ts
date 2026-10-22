// Owned by SBX (FIX-PAY2, M-3). Deadlock and serialization retry for Database.transaction.
// PGlite serialises everything and never raises these; a node-postgres adapter (dialect 'pg') will,
// when two money transactions meet. PostgreSQL rolls the loser back and asks the client to run the
// whole transaction again (SQLSTATE 40P01 deadlock_detected, 40001 serialization_failure). The
// wrapper runs the same function again with the same inputs, at most `max_retries` more times.
// The function must be free of side effects outside the transaction: the Database port already
// forbids provider calls and other I/O inside transaction(fn).
import type { Database, SqlExecutor } from '@umsbx/contracts';

/** deadlock_detected and serialization_failure. */
const RETRYABLE = new Set(['40P01', '40001']);
export const DEFAULT_MAX_RETRIES = 3;

export function isRetryableSqlError(e: unknown): boolean {
  if (typeof e !== 'object' || e === null) return false;
  const code = (e as { code?: unknown }).code;
  return typeof code === 'string' && RETRYABLE.has(code);
}

export function withSerializationRetry<D extends Database>(
  db: D,
  opts: { max_retries?: number } = {},
): D {
  const max = opts.max_retries ?? DEFAULT_MAX_RETRIES;
  const transaction = async <T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T> => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await db.transaction(fn);
      } catch (e) {
        if (!isRetryableSqlError(e) || attempt >= max) throw e;
      }
    }
  };
  return { ...db, transaction };
}
