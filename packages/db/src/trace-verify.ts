// INT-TR0 / TR0.4: the journal verifier and its two invariants. The checks run in SQL (trace_verify, in the
// journal migration) so no driver date parsing is involved; this file runs them, counts what was looked at
// and formats the answer. Read only: it never writes, so it can run in a READ ONLY transaction beside the app.
import type { SqlExecutor } from '@umsbx/contracts';

export type TraceCheck = 'chain' | 'head' | 'seal' | 'digest' | 'drift';

export interface TraceFinding {
  check: TraceCheck;
  chain_key: string | null;
  seq: number | null;
  detail: string;
}

export interface TraceReport {
  findings: TraceFinding[];
  /** Chains with at least one row. */
  chains: number;
  /** Journal rows whose hash was recomputed. */
  rows: number;
  seals: number;
  /** Values compared: journal rows, heads, and every copied or hashed column of every tracked row. */
  checked: number;
  /** Rows written with no context (actor_kind unattributed): reported by INV-T2, not a finding. */
  unattributed: number;
}

/** One line that names the chain and the row where there is one. */
export function formatTraceFinding(f: TraceFinding): string {
  if (f.chain_key === null) return f.detail;
  return `${f.check} ${f.chain_key}${f.seq === null ? '' : ` seq ${f.seq}`}: ${f.detail}`;
}

const one = async (db: SqlExecutor, sql: string): Promise<number> =>
  Number((await db.query<{ n: number | string }>(sql)).rows[0]!.n);

export async function verifyTrace(db: SqlExecutor): Promise<TraceReport> {
  const found = await db.query<{
    kind: TraceCheck;
    chain_key: string | null;
    seq: number | null;
    detail: string;
  }>('SELECT kind, chain_key, seq::int AS seq, detail FROM trace_verify()');
  return {
    findings: found.rows.map((r) => ({
      check: r.kind,
      chain_key: r.chain_key,
      seq: r.seq,
      detail: r.detail,
    })),
    chains: await one(db, 'SELECT count(DISTINCT chain_key)::int AS n FROM trace_events'),
    rows: await one(db, 'SELECT count(*)::int AS n FROM trace_events'),
    seals: await one(db, 'SELECT count(*)::int AS n FROM trace_seals'),
    checked: await one(db, 'SELECT trace_checked()::float8 AS n'),
    unattributed: await one(
      db,
      "SELECT count(*)::int AS n FROM trace_events WHERE actor_kind = 'unattributed'",
    ),
  };
}

const SHOWN = 5;
const describe = (title: string, bad: string[]): string =>
  `${title}: ${bad.length} violation${bad.length === 1 ? '' : 's'}: ${bad.slice(0, SHOWN).join(', ')}${bad.length > SHOWN ? ', ...' : ''}`;

/**
 * INV-T1: every chain, head, seal and source digest is intact. INV-T2: no row was written without a context.
 * One line per broken invariant, in the style of checkInvariants.
 */
export async function traceInvariants(db: SqlExecutor): Promise<string[]> {
  const out: string[] = [];
  const report = await verifyTrace(db);
  const broken = report.findings.filter((f) => f.check !== 'drift').map(formatTraceFinding);
  if (broken.length > 0)
    out.push(describe('INV-T1 journal chain, head, seal or digest broken', broken));
  const bare = await db.query<{ t: string }>(
    "SELECT source_table || ' ' || source_id AS t FROM trace_events WHERE actor_kind = 'unattributed' ORDER BY source_table, source_id, seq",
  );
  if (bare.rows.length > 0)
    out.push(
      describe(
        'INV-T2 unattributed writes (no context)',
        bare.rows.map((r) => r.t),
      ),
    );
  return out;
}
