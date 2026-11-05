// INT-TR1 / TR1.4: the operator activity log. All journal rows, newest first, 50 to a page (200 at most),
// keyset on (occurred_at, chain_key, seq) descending, so rows written while someone pages are neither
// skipped nor repeated. A cursor is base64url JSON {v:'a1', k:[occurred_at, chain_key, seq], h}, where h
// binds it to its filters and principal. The route computes h (a hash, which domain code may not make) and
// passes it in as an opaque string; here it is only compared.
import type { OpsTimelineEntry, SqlExecutor } from '@umsbx/contracts';
import { EVENT_COLUMNS, EVENT_FROM, toRichEntries } from './timeline';
import type { RawEvent } from './timeline';
import { operatorView } from './views';

export const ACTIVITY_DEFAULT_LIMIT = 50;
export const ACTIVITY_MAX_LIMIT = 200;

export interface ActivityFilters {
  actor_kind?: string | undefined;
  actor_id?: string | undefined;
  channel?: string | undefined;
  /** A prefix: `orders.` or `safety_switches.updated`. */
  event_type?: string | undefined;
  chain_key?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
}

export type ActivityResult =
  | { ok: true; items: OpsTimelineEntry[]; next_cursor: string | null }
  | { ok: false; error: 'bad_cursor' | 'mfa_required' };

interface CursorBody {
  v: 'a1';
  k: [string, string, number];
  h: string;
}

const encode = (c: CursorBody): string =>
  Buffer.from(JSON.stringify(c), 'utf8').toString('base64url');

function decode(text: string, h: string): CursorBody | null {
  if (!/^[A-Za-z0-9_-]{8,1000}$/.test(text)) return null;
  try {
    const c = JSON.parse(
      Buffer.from(text, 'base64url').toString('utf8'),
    ) as Partial<CursorBody> | null;
    if (c === null || typeof c !== 'object' || c.v !== 'a1' || c.h !== h) return null;
    const k = c.k;
    if (!Array.isArray(k) || k.length !== 3) return null;
    if (typeof k[0] !== 'string' || typeof k[1] !== 'string' || !Number.isInteger(k[2]))
      return null;
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(k[0])) return null;
    return { v: 'a1', k: [k[0], k[1], k[2]], h };
  } catch {
    return null;
  }
}

export async function activityPage(
  db: SqlExecutor,
  o: { filters: ActivityFilters; limit?: number; cursor?: string; h: string; mfa: boolean },
): Promise<ActivityResult> {
  const f = o.filters;
  // Filtering on an actor id would let a caller without the second factor probe for an identity.
  if (f.actor_id !== undefined && !o.mfa) return { ok: false, error: 'mfa_required' };
  const limit = Math.min(
    Math.max(Math.trunc(o.limit ?? ACTIVITY_DEFAULT_LIMIT), 1),
    ACTIVITY_MAX_LIMIT,
  );
  const where: string[] = [];
  const p: unknown[] = [];
  const add = (sql: string, v: unknown): void => {
    p.push(v);
    where.push(sql.replace('?', `$${p.length}`));
  };
  if (f.actor_kind !== undefined) add('e.actor_kind = ?', f.actor_kind);
  if (f.actor_id !== undefined) add('e.actor_id = ?', f.actor_id);
  if (f.channel !== undefined) add('e.channel = ?', f.channel);
  if (f.event_type !== undefined) add('starts_with(e.event_type, ?)', f.event_type);
  if (f.chain_key !== undefined) add('e.chain_key = ?', f.chain_key);
  if (f.from !== undefined) add('e.occurred_at >= ?::timestamptz', f.from);
  if (f.to !== undefined) add('e.occurred_at <= ?::timestamptz', f.to);
  if (o.cursor !== undefined) {
    const c = decode(o.cursor, o.h);
    if (c === null) return { ok: false, error: 'bad_cursor' };
    p.push(c.k[0], c.k[1], c.k[2]);
    const n = p.length;
    where.push(
      `(e.occurred_at, e.chain_key COLLATE "C", e.seq) < ($${n - 2}::timestamptz, $${n - 1}::text COLLATE "C", $${n}::bigint)`,
    );
  }
  const rows = (
    await db.query<RawEvent & { cur_at: string }>(
      `SELECT ${EVENT_COLUMNS}, to_char(e.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cur_at
         ${EVENT_FROM} ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY e.occurred_at DESC, e.chain_key COLLATE "C" DESC, e.seq DESC LIMIT ${limit + 1}`,
      p,
    )
  ).rows;
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  const next_cursor =
    rows.length > limit && last !== undefined
      ? encode({ v: 'a1', k: [last.cur_at, last.chain_key, last.seq], h: o.h })
      : null;
  return { ok: true, items: operatorView(toRichEntries(page), { mfa: o.mfa }), next_cursor };
}
