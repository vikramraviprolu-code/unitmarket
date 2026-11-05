// INT-TR1 / TR1.6: the daily seal. TR0 owns the formula and the table (trace_seal(day, at) in SQL); this file
// only decides when to call it: on the first pass at or after 00:05 UTC, for the previous UTC day, with the
// time from the injected clock. A day that already has a seal is left alone, so a second pass is a no-op.
// A seal covers rows by head, not by occurred_at, so a late row falls into the next seal and is never tamper.
import type { Clock, Database, SqlExecutor } from '@umsbx/contracts';

const SEAL_AFTER_MINUTES = 5;
const DAY_MS = 86_400_000;

export interface SealResult {
  sealed: boolean;
  day: string | null;
}

/** True from 00:05 UTC on: the time a pass may seal the previous day. */
export function sealDue(clock: Clock): boolean {
  const now = clock.now();
  return now.getUTCHours() * 60 + now.getUTCMinutes() >= SEAL_AFTER_MINUTES;
}

export async function sealPreviousDay(db: Database, clock: Clock): Promise<SealResult> {
  if (!sealDue(clock)) return { sealed: false, day: null };
  const now = clock.now();
  const day = new Date(now.getTime() - DAY_MS).toISOString().slice(0, 10);
  const have = await db.query('SELECT 1 FROM trace_seals WHERE day = $1::date', [day]);
  if (have.rows.length > 0) return { sealed: false, day: null };
  // A transaction, so the job context (system, job, seal) is the setting of the call.
  await db.transaction((tx) =>
    tx.query('SELECT id FROM trace_seal($1::date, $2::timestamptz)', [day, now.toISOString()]),
  );
  return { sealed: true, day };
}

export interface JournalVerdict {
  ok: boolean;
  chains: number;
  rows: number;
  seals: number;
  drift: number;
  first_broken?: string;
}

/** The answer of GET /api/v1/ops/trace/verify: counts and a verdict from TR0's trace_verify(), nothing about rows. */
export async function verifyJournal(db: SqlExecutor): Promise<JournalVerdict> {
  const found = await db.query<{ kind: string; chain_key: string | null; seq: number | null }>(
    'SELECT kind, chain_key, seq::int AS seq FROM trace_verify()',
  );
  const n = async (sql: string): Promise<number> =>
    Number((await db.query<{ n: number | string }>(sql)).rows[0]!.n);
  const drift = found.rows.filter((r) => r.kind === 'drift').length;
  const broken = found.rows.find((r) => r.kind !== 'drift');
  const out: JournalVerdict = {
    ok: found.rows.length === 0,
    chains: await n('SELECT count(DISTINCT chain_key)::int AS n FROM trace_events'),
    rows: await n('SELECT count(*)::int AS n FROM trace_events'),
    seals: await n('SELECT count(*)::int AS n FROM trace_seals'),
    drift,
  };
  if (broken !== undefined)
    out.first_broken =
      `${broken.kind} ${broken.chain_key ?? ''}${broken.seq === null ? '' : ` seq ${broken.seq}`}`.trim();
  return out;
}
