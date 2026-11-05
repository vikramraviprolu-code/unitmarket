// INT-SR0 (SR0.2, SR0.4, SR0.5): the SQL of a transaction list. One query shape over the txn_rows view
// (migration 0024) for the buyer, seller and operator lists. The scope pin is added before any filter. Every
// value from a client is a bound parameter; the only text put into SQL is a fixed word taken from the
// contracts tables (statuses), checked against a strict pattern. Keyset paging; no OFFSET.
import { PENDING_ATTENTION_MS, STATUS_GROUPS, StatusGroupSchema } from '@umsbx/contracts';
import type { SqlExecutor, StatusGroup, TxnQuery } from '@umsbx/contracts';
import { TxnSearchError, decodeCursor, encodeCursor } from './cursor';
import type { TxnSort } from './cursor';
import type { ScopedQuery } from './scope';

export type TxnRow = Record<string, unknown>;

export interface TxnPage {
  rows: TxnRow[];
  /** Present when another page follows. */
  next_cursor: string | null;
}

export const DEFAULT_LIMIT = 25;

const TIME_COLUMNS = new Set(['unit_updated_at', 'created_at', 'captured_verified_at']);

/** Every column of txn_rows, in the order a row is returned. */
export const ALL_COLUMNS: readonly string[] = [
  'unit_id',
  'order_id',
  'order_ref',
  'order_ref6',
  'order_status',
  'order_mismatch',
  'unit_status',
  'unit_updated_at',
  'created_at',
  'captured_verified_at',
  'currency',
  'amount_minor',
  'order_total_minor',
  'refunded_minor',
  'environment',
  'publisher_id',
  'seller_name',
  'seller_slug',
  'provider_order_id',
  'capture_id',
  'buyer_id',
  'buyer_display_name',
  'titles',
  'refund_state',
  'refund_id',
  'refund_amount_minor',
  'case_state',
  'case_kind',
  'alert_count',
  'has_unknown_op',
  'channel',
  'agent_key_id',
  'mandate_id',
];

/** A seller never sees who bought, which agent key or mandate was used, or the total of a mixed order. */
const SELLER_HIDDEN = new Set([
  'buyer_id',
  'buyer_display_name',
  'agent_key_id',
  'mandate_id',
  'order_total_minor',
]);
export const SELLER_COLUMNS: readonly string[] = ALL_COLUMNS.filter((c) => !SELLER_HIDDEN.has(c));

const ISO_MS = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;
const ISO_US = `'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'`;

const selectColumn = (c: string): string =>
  TIME_COLUMNS.has(c) ? `to_char(${c} AT TIME ZONE 'UTC', ${ISO_MS}) AS ${c}` : c;

/** A status word from the contracts tables, as an SQL literal. Anything else is a bug and stops here. */
function lit(word: string): string {
  if (!/^[a-z_]+$/.test(word)) throw new Error(`unsafe SQL word: ${word}`);
  return `'${word}'`;
}
const inLit = (col: string, words: readonly string[]): string | null =>
  words.length === 0 ? null : `${col} IN (${words.map(lit).join(', ')})`;

// ---------- Status groups in SQL ----------

/** The rule of one group on txn_rows columns (before precedence). `stale` yields the bound cut-off time. */
function ruleSql(group: StatusGroup, stale: () => string): string {
  const rule = STATUS_GROUPS[group];
  const parts = [inLit('order_status', rule.order), inLit('unit_status', rule.unit)].filter(
    (x): x is string => x !== null,
  );
  if (group === 'attention')
    parts.push(`(unit_status = 'pending' AND unit_updated_at < ${stale()})`);
  return parts.length === 0 ? 'false' : `(${parts.join(' OR ')})`;
}

/** The lines of a group after precedence: its own rule and none of the rules of the groups before it. */
function groupSql(group: StatusGroup, stale: () => string): string {
  const order = StatusGroupSchema.options;
  if (group === 'in_progress') {
    return `NOT (${order
      .filter((g) => g !== 'in_progress')
      .map((g) => ruleSql(g, stale))
      .join(' OR ')})`;
  }
  const before = order.slice(0, order.indexOf(group)).map((g) => `NOT ${ruleSql(g, stale)}`);
  return [ruleSql(group, stale), ...before].join(' AND ');
}

/**
 * "Needs attention" as a list of unit ids that the partial indexes orders_attention and order_units_problem
 * answer. `= ANY (ARRAY(subquery))` runs the subquery once, first; the planner then starts from those few
 * ids and looks up each line by its key, instead of joining the whole list and filtering.
 */
function attentionIn(stale: () => string): string {
  const a = STATUS_GROUPS.attention;
  return `txn_rows.unit_id = ANY (ARRAY(
    SELECT u.id FROM order_units u WHERE ${inLit('u.status', a.unit)}
    UNION ALL
    SELECT u.id FROM order_units u WHERE u.status = 'pending' AND u.updated_at < ${stale()}
    UNION ALL
    SELECT u.id FROM order_units u
     WHERE u.order_id = ANY (ARRAY(SELECT o.id FROM orders o WHERE ${inLit('o.status', a.order)}))
  ))`;
}

/** 5 for needs attention down to 0 for in progress: the sort=status key, descending shows problems first. */
function rankSql(stale: () => string): string {
  const order = StatusGroupSchema.options;
  const whens = order
    .filter((g) => g !== 'in_progress')
    .map((g, i) => `WHEN ${ruleSql(g, stale)} THEN ${order.length - 1 - i}`);
  return `(CASE ${whens.join(' ')} ELSE 0 END)`;
}

// ---------- Text ----------

/** Escape for LIKE: the escape character first, then % and _. Lower-casing happens in SQL, on both sides. */
const escapeLike = (s: string): string =>
  s.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');

const REFUND_REQUESTED = ['requested', 'sent', 'unknown', 'pending', 'unresolved'];
const CASE_OPEN = ['open', 'diagnosing', 'refund_pending'];
const CASE_RESOLVED = ['restored', 'closed_not_charged', 'refunded', 'closed_no_fault', 'closed'];

const nextDay = (day: string): string =>
  new Date(Date.parse(`${day}T00:00:00.000Z`) + 86_400_000).toISOString();

// ---------- The query ----------

export interface BuiltSql {
  text: string;
  params: unknown[];
  limit: number;
  sort: TxnSort;
  dir: 'asc' | 'desc';
}

export interface SearchContext {
  /** From the injected Clock: the age rules (pending for more than an hour) read it. */
  now: Date;
  /** Opaque: bound into the cursor; a cursor with another value is refused. The API puts a query hash here. */
  h: string;
}

export function buildTxnSql(scoped: ScopedQuery, ctx: SearchContext): BuiltSql {
  const { query: q, scope } = scoped;
  const params: unknown[] = [];
  const bind = (v: unknown): string => `$${params.push(v)}`;
  let staleParam: string | null = null;
  const stale = (): string => {
    staleParam ??= `${bind(new Date(ctx.now.getTime() - PENDING_ATTENTION_MS).toISOString())}::timestamptz`;
    return staleParam;
  };
  const where: string[] = [];

  // The pin first: nothing a client sends can remove it.
  if (scope.kind === 'buyer') where.push(`buyer_id = ${bind(scope.buyer_id)}`);
  if (scope.kind === 'publisher') where.push(`publisher_id = ${bind(scope.publisher_id)}`);
  const opaque = scope.kind === 'operator' && scope.opaque_ids_only;

  if (q.from !== undefined)
    where.push(`created_at >= ${bind(`${q.from}T00:00:00.000Z`)}::timestamptz`);
  if (q.to !== undefined) where.push(`created_at < ${bind(nextDay(q.to))}::timestamptz`);
  if (q.min_minor !== undefined) where.push(`amount_minor >= ${bind(q.min_minor)}`);
  if (q.max_minor !== undefined) where.push(`amount_minor <= ${bind(q.max_minor)}`);
  if (q.currency !== undefined)
    where.push(`currency IN (${q.currency.map((c) => bind(c)).join(', ')})`);

  if (q.status !== undefined) {
    const parts = q.status.map((g) =>
      g === 'attention' ? attentionIn(stale) : `(${groupSql(g, stale)})`,
    );
    where.push(`(${parts.join(' OR ')})`);
  }
  if (q.refund !== undefined) {
    const parts = q.refund.map((r) => {
      switch (r) {
        case 'none':
          return '(refund_state IS NULL AND refunded_minor = 0)';
        case 'requested':
          return `refund_state IN (${REFUND_REQUESTED.map(lit).join(', ')})`;
        case 'partial':
          return '(refunded_minor > 0 AND refunded_minor < amount_minor)';
        case 'full':
          return '(amount_minor > 0 AND refunded_minor >= amount_minor)';
      }
    });
    where.push(`(${parts.join(' OR ')})`);
  }
  if (q.case !== undefined) {
    const parts = q.case.map((c) => {
      switch (c) {
        case 'none':
          return 'case_state IS NULL';
        case 'open':
          return `case_state IN (${CASE_OPEN.map(lit).join(', ')})`;
        case 'resolved':
          return `case_state IN (${CASE_RESOLVED.map(lit).join(', ')})`;
      }
    });
    where.push(`(${parts.join(' OR ')})`);
  }

  if (q.buyer !== undefined) {
    const id = bind(q.buyer);
    where.push(
      opaque
        ? `buyer_id = ${id}`
        : `(buyer_id = ${id} OR lower(buyer_display_name) LIKE '%' || lower(${bind(escapeLike(q.buyer))}) || '%' ESCAPE '\\')`,
    );
  }
  if (q.seller !== undefined) {
    const id = bind(q.seller);
    where.push(
      opaque
        ? `publisher_id = ${id}`
        : `(publisher_id = ${id} OR lower(seller_slug) = lower(${id}) OR lower(seller_name) LIKE '%' || lower(${bind(escapeLike(q.seller))}) || '%' ESCAPE '\\')`,
    );
  }
  if (q.q !== undefined) {
    where.push(
      `EXISTS (SELECT 1 FROM entitlements e JOIN articles a ON a.id = e.article_id
        WHERE e.unit_id = txn_rows.unit_id AND lower(a.title) LIKE '%' || lower(${bind(escapeLike(q.q))}) || '%' ESCAPE '\\')`,
    );
  }
  if (q.ref !== undefined) {
    const r = bind(q.ref);
    where.push(
      `(order_ref = ${r} OR order_ref6 = ${r} OR provider_order_id = ${r} OR capture_id = ${r}
        OR EXISTS (SELECT 1 FROM refund_requests rf JOIN order_units ru ON ru.id = rf.unit_id
                    WHERE ru.order_id = txn_rows.order_id AND rf.refund_id = ${r})
        OR EXISTS (SELECT 1 FROM receipts rc WHERE rc.order_id = txn_rows.order_id AND rc.id = ${r}))`,
    );
  }
  if (q.channel !== undefined) where.push(`channel = ${bind(q.channel)}`);
  if (q.agent_key !== undefined) where.push(`agent_key_id = ${bind(q.agent_key)}`);
  if (q.environment !== undefined) where.push(`environment = ${bind(q.environment)}`);
  if (q.flags !== undefined) {
    const parts = q.flags.map((f) => {
      switch (f) {
        case 'alert':
          return 'alert_count > 0';
        case 'mismatch':
          return `(order_mismatch OR unit_status = 'mismatch')`;
        case 'unknown_op':
          return 'has_unknown_op';
      }
    });
    where.push(`(${parts.join(' OR ')})`);
  }

  // Sort, direction, keyset position. Names are qualified with the view: a bare `created_at` in ORDER BY
  // would mean the formatted output column of the same name. For `newest` the order is (created_at, order_id,
  // unit_id), the order of the orders_time and orders_buyer_time indexes, so a page needs no sort; the cursor
  // holds the unit id and the order id is read back from it.
  const sort: TxnSort = q.sort ?? 'newest';
  const dir = q.dir ?? 'desc';
  const op = dir === 'desc' ? '<' : '>';
  const upper = dir.toUpperCase();
  const sortExpr =
    sort === 'newest'
      ? 'txn_rows.created_at'
      : sort === 'amount'
        ? 'txn_rows.amount_minor'
        : rankSql(stale);
  const keyExpr =
    sort === 'newest' ? `to_char(txn_rows.created_at AT TIME ZONE 'UTC', ${ISO_US})` : sortExpr;
  const orderBy =
    sort === 'newest'
      ? `txn_rows.created_at ${upper}, txn_rows.order_id ${upper}, txn_rows.unit_id ${upper}`
      : `${sortExpr} ${upper}, txn_rows.unit_id ${upper}`;
  if (q.cursor !== undefined) {
    const c = decodeCursor(q.cursor, { sort, h: ctx.h });
    const id = bind(c.id);
    where.push(
      sort === 'newest'
        ? `(txn_rows.created_at, txn_rows.order_id, txn_rows.unit_id) ${op} (${bind(c.k)}::timestamptz, (SELECT x.order_id FROM order_units x WHERE x.id = ${id}), ${id})`
        : `(${sortExpr}, txn_rows.unit_id) ${op} (${bind(c.k)}::int, ${id})`,
    );
  }

  const limit = q.limit ?? DEFAULT_LIMIT;
  const columns = scope.kind === 'publisher' ? SELLER_COLUMNS : ALL_COLUMNS;
  // Two steps in one statement. The inner step finds the ids of the page: it names only the columns the
  // filters and the sort need, so Postgres drops every other view column (titles, refund, case, alert and
  // mandate lookups, the provider order join) and pays only for the candidate lines. The outer step reads
  // the full columns for those few ids and puts them in the same order.
  const text = `SELECT ${columns.map(selectColumn).join(', ')}, ${keyExpr} AS _k
  FROM txn_rows
 WHERE txn_rows.unit_id = ANY (ARRAY(
   SELECT txn_rows.unit_id
     FROM txn_rows
    ${where.length > 0 ? `WHERE ${where.join('\n      AND ')}` : ''}
    ORDER BY ${orderBy}
    LIMIT ${bind(limit + 1)}
 ))
 ORDER BY ${orderBy}`;
  return { text, params, limit, sort, dir };
}

/** Runs one page. Throws TxnSearchError `bad_cursor` for a cursor that does not fit this request. */
export async function searchTransactions(
  db: SqlExecutor,
  scoped: ScopedQuery,
  ctx: SearchContext,
): Promise<TxnPage> {
  const built = buildTxnSql(scoped, ctx);
  const res = await db.query<TxnRow>(built.text, built.params);
  const more = res.rows.length > built.limit;
  const page = more ? res.rows.slice(0, built.limit) : res.rows;
  let next_cursor: string | null = null;
  if (more) {
    const last = page[page.length - 1]!;
    const k = last['_k'];
    if (typeof k !== 'string' && typeof k !== 'number') {
      throw new TxnSearchError('bad_cursor', 'The page marker could not be made.');
    }
    next_cursor = encodeCursor({ s: built.sort, k, id: String(last['unit_id']), h: ctx.h });
  }
  const rows = page.map((r) => {
    const rest = { ...r };
    delete rest['_k'];
    return rest;
  });
  return { rows, next_cursor };
}

export type { TxnQuery };
