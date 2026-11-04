import type { Clock, SqlExecutor } from '@umsbx/contracts';
import { formatRate, parseRate } from './decimal';

/** The newest complete set of stored rates: 1 EUR = eur_usd USD and 1 EUR = eur_gbp GBP, as of `date`. */
export interface FxRates {
  /** The ECB date the rates are for, YYYY-MM-DD. */
  date: string;
  /** Decimal strings, shortest form ("1.15"). */
  eur_usd: string;
  eur_gbp: string;
  /** When this app stored them (ISO UTC). */
  fetched_at: string;
  /** Milliseconds from fetched_at to the injected clock now (never below 0). */
  age_ms: number;
  /** 'seed' for the rows that ship with the build, 'ecb' for a stored fetch. */
  source: 'ecb' | 'seed';
}

/** What is stored, in the form the refresh compares: scaled rates and the fetch time in milliseconds. */
export interface Stored {
  date: string;
  usd: bigint;
  gbp: bigint;
  fetched_ms: number;
  fetched_at: string;
  source: 'ecb' | 'seed';
}

/** Reads the newest ECB date that has both quotes. Null when there is none. */
export async function readLatest(q: SqlExecutor): Promise<Stored | null> {
  const r = await q.query<{
    date: string;
    usd: string;
    gbp: string;
    source: string;
    fetched_at: Date | string;
  }>(
    `SELECT u.date::text AS date, u.rate::text AS usd, g.rate::text AS gbp, u.source AS source,
            GREATEST(u.fetched_at, g.fetched_at) AS fetched_at
       FROM fx_rates u
       JOIN fx_rates g ON g.date = u.date AND g.quote = 'GBP' AND g.base = 'EUR'
      WHERE u.quote = 'USD' AND u.base = 'EUR'
      ORDER BY u.date DESC
      LIMIT 1`,
  );
  const row = r.rows[0];
  if (row === undefined) return null;
  const usd = parseRate(row.usd);
  const gbp = parseRate(row.gbp);
  const at = new Date(row.fetched_at);
  if (usd === null || gbp === null || Number.isNaN(at.getTime())) return null;
  return {
    date: row.date,
    usd,
    gbp,
    fetched_ms: at.getTime(),
    fetched_at: at.toISOString(),
    source: row.source === 'seed' ? 'seed' : 'ecb',
  };
}

/** The latest stored EUR to USD and EUR to GBP rates with their ECB date and age, or null when none is stored. */
export async function getRates(db: SqlExecutor, clock: Clock): Promise<FxRates | null> {
  const s = await readLatest(db);
  if (s === null) return null;
  return {
    date: s.date,
    eur_usd: formatRate(s.usd),
    eur_gbp: formatRate(s.gbp),
    fetched_at: s.fetched_at,
    age_ms: Math.max(0, clock.now().getTime() - s.fetched_ms),
    source: s.source,
  };
}
