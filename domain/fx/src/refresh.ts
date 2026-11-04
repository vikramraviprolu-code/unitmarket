import type { Clock, Database, SqlExecutor } from '@umsbx/contracts';
import { FX_MAX_RATE_AGE_DAYS } from './convert';
import { isIsoDate, parseRate } from './decimal';
import { readLatest } from './rates';
import type { Stored } from './rates';

/** What the injected fetch answers (the transport's createEcbFetch has this shape). Never an exception. */
export type FetchedRates =
  { ok: true; date: string; usd: string; gbp: string } | { ok: false; kind: string };

export type RefreshResult =
  | { status: 'fresh'; date: string; age_ms: number }
  | { status: 'refreshed'; date: string }
  | {
      status: 'kept';
      reason: 'older_date' | 'same_date' | 'rejected_move' | 'recent_attempt';
      date: string | null;
    }
  | { status: 'failed'; kind: string };

/** A stored rate fetched at most this long ago is fresh (D-085). */
export const FX_STALE_AFTER_MS = 6 * 3600_000;
/** After an attempt that stored nothing, no new fetch starts for this long (per process and database). */
export const FX_RETRY_AFTER_MS = 15 * 60_000;
/** A new rate that moves more than this share (1/10) from the stored one is rejected (D-085). */
const MAX_MOVE_DENOMINATOR = 10n;

const LOCK_KEY = 'ums.fx.refresh';
const KIND = /^[a-z_]{1,32}$/;

// The last attempt per database, so an unreachable ECB (or a weekend that brings no new date, which adds no
// row and so does not move fetched_at) costs one fetch per quarter hour and not one per page view. In
// memory only: a restart forgets it, which is harmless.
const lastAttempt = new WeakMap<object, number>();

const moved = (next: bigint, old: bigint): boolean => {
  const diff = next > old ? next - old : old - next;
  return diff * MAX_MOVE_DENOMINATOR > old;
};

/**
 * Fetches new rates only when the newest stored fetch is over 6 hours old, once, under an advisory lock, so
 * concurrent callers make one request and the rest find the rows it wrote. Never throws. The old rate
 * stays on any failure. A rate that moves more than 10% from the stored one, a date older than the newest
 * stored date, and a fetch answer of the wrong shape are not stored.
 *
 * The lock is transaction scoped (it works on PGlite and Postgres alike) and the fetch runs inside the
 * transaction, at most 3 seconds. The advisory lock is taken before the staleness is read again.
 */
export async function refreshIfStale(deps: {
  db: Database;
  clock: Clock;
  fetchRates: () => Promise<FetchedRates>;
}): Promise<RefreshResult> {
  try {
    const first = await readLatest(deps.db);
    if (first !== null && isFresh(first, deps.clock)) return fresh(first, deps.clock);
    return await deps.db.transaction((tx) => locked(tx, deps));
  } catch {
    return { status: 'failed', kind: 'unexpected' };
  }
}

function isFresh(s: Stored, clock: Clock): boolean {
  return clock.now().getTime() - s.fetched_ms <= FX_STALE_AFTER_MS;
}
function fresh(s: Stored, clock: Clock): RefreshResult {
  return {
    status: 'fresh',
    date: s.date,
    age_ms: Math.max(0, clock.now().getTime() - s.fetched_ms),
  };
}

async function locked(
  tx: SqlExecutor,
  deps: { db: Database; clock: Clock; fetchRates: () => Promise<FetchedRates> },
): Promise<RefreshResult> {
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [LOCK_KEY]);
  // Another caller may have stored a rate while this one waited for the lock.
  const cur = await readLatest(tx);
  if (cur !== null && isFresh(cur, deps.clock)) return fresh(cur, deps.clock);
  const now = deps.clock.now().getTime();
  const before = lastAttempt.get(deps.db);
  if (before !== undefined && now - before < FX_RETRY_AFTER_MS)
    return { status: 'kept', reason: 'recent_attempt', date: cur?.date ?? null };
  lastAttempt.set(deps.db, now);

  let got: unknown;
  try {
    got = await deps.fetchRates();
  } catch {
    return { status: 'failed', kind: 'unexpected' };
  }
  if (got === null || typeof got !== 'object') return { status: 'failed', kind: 'invalid' };
  const r = got as Record<string, unknown>;
  if (r['ok'] === false) {
    const kind = r['kind'];
    return {
      status: 'failed',
      kind: typeof kind === 'string' && KIND.test(kind) ? kind : 'unexpected',
    };
  }
  const usd = parseRate(r['usd']);
  const gbp = parseRate(r['gbp']);
  const date = r['date'];
  if (r['ok'] !== true || !isIsoDate(date) || usd === null || gbp === null)
    return { status: 'failed', kind: 'invalid' };

  // A date after tomorrow (UTC) cannot be a real ECB date: it would make every later real date look older.
  if (date > new Date(deps.clock.now().getTime() + 86_400_000).toISOString().slice(0, 10))
    return { status: 'failed', kind: 'invalid' };

  if (cur !== null) {
    if (date < cur.date) return { status: 'kept', reason: 'older_date', date: cur.date };
    if (date === cur.date) return { status: 'kept', reason: 'same_date', date: cur.date };
    // The 10% guard compares like with like. A placeholder seed row, or a stored rate more than 7 days
    // old (the point where convert gives up on it), would otherwise lock real rates out for good.
    const staleBase =
      cur.source === 'seed' ||
      (Date.parse(`${date}T00:00:00Z`) - Date.parse(`${cur.date}T00:00:00Z`)) / 86_400_000 >
        FX_MAX_RATE_AGE_DAYS;
    if (!staleBase && (moved(usd, cur.usd) || moved(gbp, cur.gbp)))
      return { status: 'kept', reason: 'rejected_move', date: cur.date };
  }
  const at = deps.clock.now().toISOString();
  const sql = `INSERT INTO fx_rates (date, base, quote, rate, source, fetched_at)
               VALUES ($1, 'EUR', $2, $3, 'ecb', $4) ON CONFLICT (date, quote) DO NOTHING`;
  await tx.query(sql, [date, 'USD', r['usd'], at]);
  await tx.query(sql, [date, 'GBP', r['gbp'], at]);
  return { status: 'refreshed', date };
}
