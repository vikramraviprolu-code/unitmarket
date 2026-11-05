// INT-SR1 (SR1.1, SR1.2, SR1.3, SR1.5): what the list routes share.
//   plain   a call whose query parses to nothing: every row up to 5,000, no next_cursor (what the lists
//           answered before keyset paging). Any filter, sort, limit or cursor pages by keyset instead.
//   cursor  carries a hash of the canonical query without its cursor, plus the principal. A cursor reused
//           with another filter or by another principal is refused (400 bad_cursor) by SR0's decoder.
//   lines   the shape of one row for the buyer, the seller and the operator; the status word is worked out
//           here, with the injected clock.
//   csv     the current filter as text, up to 5,000 rows, every cell through csvCell (= + - @ tab CR).
import { parseTxnQuery, statusGroupOf } from '@umsbx/contracts';
import type { SqlExecutor, TxnLine, TxnQuery } from '@umsbx/contracts';
import { csvLine, decimalText } from '@umsbx/publisher-console';
import { TxnSearchError } from './cursor';
import { scopeQuery } from './scope';
import type { TxnPrincipal } from './scope';
import { searchTransactions } from './sql';
import type { TxnRow } from './sql';
import { savedView } from './views';
import type { ViewId } from './views';

/** The most rows a plain call answers. */
export const LEGACY_CAP = 5000;
/** The most rows a CSV file holds. */
export const EXPORT_CAP = 5000;

type Db = SqlExecutor;

type Raw = Readonly<Record<string, string | undefined>>;

export interface ListContext {
  /** From the injected Clock. */
  now: Date;
  /** A saved view of the operator list; its query is the base the explicit keys are put over. */
  view?: ViewId;
}

export interface ListResult {
  rows: TxnRow[];
  next_cursor: string | null;
  /** `all`: a plain call. `paged`: keyset paging. */
  mode: 'all' | 'paged';
}

/** True when the query map holds nothing the filters can use (no key, or only values that parse to nothing). */
export const isPlainQuery = (raw: Raw): boolean => Object.keys(parseTxnQuery(raw)).length === 0;

/** Who a cursor belongs to. An operator key and an operator session never share one. */
export function principalKey(p: TxnPrincipal): string {
  switch (p.kind) {
    case 'buyer':
      return `buyer:${p.buyer_id}`;
    case 'publisher':
      return `publisher:${p.publisher_id}`;
    case 'operator':
      return `operator:${p.operator_id}:${p.mfa ? 'session' : 'key'}`;
    case 'agent':
      return `agent:${p.key_id}`;
    case 'api_client':
      return `client:${p.key_id}`;
    default:
      throw new TxnSearchError('forbidden', 'This sign-in cannot search transactions.');
  }
}

const canon = (v: unknown): unknown => (Array.isArray(v) ? [...v].map(String).sort() : v);

/**
 * A 64-bit FNV-1a hash of the canonical query (keys sorted, lists sorted, no cursor) and the principal, as 16
 * hex characters. A cursor marks a place and holds no secret, so this is a binding, not a signature.
 */
export function queryHash(query: TxnQuery, principal: string): string {
  const entries = Object.entries(query)
    .filter(([k, v]) => k !== 'cursor' && v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => [k, canon(v)]);
  const text = JSON.stringify([principal, entries]);
  let h = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(text)) {
    h ^= BigInt(byte);
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, '0');
}

function merged(raw: Raw, ctx: ListContext): { parsed: TxnQuery; query: TxnQuery } {
  const parsed = parseTxnQuery(raw);
  const base: TxnQuery = ctx.view === undefined ? {} : savedView(ctx.view, ctx.now);
  return { parsed, query: { ...base, ...parsed } };
}

/** The role check alone: throws 400 `field_not_allowed` for a refused key, whatever its value. No query runs. */
export function checkScope(principal: TxnPrincipal, raw: Raw): void {
  scopeQuery(principal, raw, parseTxnQuery(raw));
}

export async function listTransactions(
  db: Db,
  principal: TxnPrincipal,
  raw: Raw,
  ctx: ListContext,
): Promise<ListResult> {
  const { parsed, query } = merged(raw, ctx);
  const scoped = scopeQuery(principal, raw, query);
  if (ctx.view === undefined && Object.keys(parsed).length === 0) {
    const all = await searchTransactions(
      db,
      { ...scoped, query: { ...query, limit: LEGACY_CAP } },
      { now: ctx.now, h: '' },
    );
    return { rows: all.rows, next_cursor: null, mode: 'all' };
  }
  const h = queryHash(query, principalKey(principal));
  const page = await searchTransactions(db, scoped, { now: ctx.now, h });
  return { rows: page.rows, next_cursor: page.next_cursor, mode: 'paged' };
}

/** The rows of a CSV file: the current filter, newest first unless sorted, at most EXPORT_CAP. */
export async function exportTransactions(
  db: Db,
  principal: TxnPrincipal,
  raw: Raw,
  ctx: ListContext,
): Promise<{ rows: TxnRow[]; truncated: boolean }> {
  const { query } = merged(raw, ctx);
  const scoped = scopeQuery(principal, raw, query);
  const { cursor: _cursor, limit: _limit, ...rest } = scoped.query;
  void _cursor;
  void _limit;
  const page = await searchTransactions(
    db,
    { ...scoped, query: { ...rest, limit: EXPORT_CAP } },
    { now: ctx.now, h: '' },
  );
  return { rows: page.rows, truncated: page.next_cursor !== null };
}

// ---------- lines ----------

const text = (v: unknown): string => String(v);
const orNull = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const int = (v: unknown): number => Number(v);

function base(r: TxnRow, now: Date): TxnLine {
  return {
    unit_id: text(r['unit_id']),
    order_ref: text(r['order_ref']),
    order_ref6: text(r['order_ref6']),
    status: statusGroupOf(
      {
        order_status: text(r['order_status']),
        unit_status: text(r['unit_status']),
        unit_updated_at: text(r['unit_updated_at']),
      },
      now,
    ),
    order_status: text(r['order_status']),
    unit_status: text(r['unit_status']),
    created_at: text(r['created_at']),
    updated_at: text(r['unit_updated_at']),
    captured_at: orNull(r['captured_verified_at']),
    currency: text(r['currency']),
    amount_minor: int(r['amount_minor']),
    refunded_minor: int(r['refunded_minor']),
    environment: r['environment'] === 'sandbox' ? 'sandbox' : 'dryrun',
    titles: Array.isArray(r['titles']) ? (r['titles'] as unknown[]).map(String) : [],
    refund_state: orNull(r['refund_state']),
    refund_amount_minor: r['refund_amount_minor'] == null ? null : int(r['refund_amount_minor']),
    case_state: orNull(r['case_state']),
    case_kind: orNull(r['case_kind']),
    channel: r['channel'] === 'agent' ? 'agent' : 'human',
  };
}

/** A buyer sees its own lines: no buyer name, no seller id, no PayPal id. */
export function buyerLine(r: TxnRow, now: Date): TxnLine {
  return {
    ...base(r, now),
    order_total_minor: int(r['order_total_minor']),
    agent_key_id: orNull(r['agent_key_id']),
    seller_name: text(r['seller_name']),
  };
}

/** A seller never sees who bought, which key or mandate was used, or the total of a mixed order. */
export function sellerLine(r: TxnRow, now: Date): TxnLine {
  return base(r, now);
}

/**
 * An operator line. `identity` false (an operator key, or a session without MFA): order refs, amounts, states,
 * flags and opaque ids, but never the buyer id or the agent key id (C3, FIX-B4: no /api/v1/ops/* answer
 * carries buyer identity). `identity` true adds those two, the buyer and seller names and the PayPal ids. Call
 * sites go through `withOpsIdentity` in apps/web, the one place that decides.
 */
export function opsLine(r: TxnRow, now: Date, identity: boolean): TxnLine {
  const line: TxnLine = {
    ...base(r, now),
    order_total_minor: int(r['order_total_minor']),
    publisher_id: text(r['publisher_id']),
    mandate_id: orNull(r['mandate_id']),
    alert_count: int(r['alert_count']),
    has_unknown_op: r['has_unknown_op'] === true,
    order_mismatch: r['order_mismatch'] === true,
  };
  if (!identity) return line;
  return {
    ...line,
    buyer_id: text(r['buyer_id']),
    agent_key_id: orNull(r['agent_key_id']),
    seller_name: text(r['seller_name']),
    seller_slug: text(r['seller_slug']),
    buyer_display_name: text(r['buyer_display_name']),
    provider_order_id: orNull(r['provider_order_id']),
    capture_id: orNull(r['capture_id']),
    refund_id: orNull(r['refund_id']),
  };
}

// ---------- CSV ----------

export type CsvKind = 'buyer' | 'seller' | 'ops';

const money = (l: TxnLine): string => decimalText(l.amount_minor, l.currency);

const COMMON = [
  'date',
  'order_ref',
  'status',
  'items',
  'currency',
  'amount_minor',
  'amount',
  'refunded_minor',
  'environment',
  'refund',
  'case',
  'channel',
] as const;

/**
 * The CSV text of lines. The seller file has the last 6 of the order ref and no buyer column. The operator
 * file has opaque ids (no buyer id), plus the buyer id, the names and the PayPal ids when `identity` is true. Every cell goes through csvCell.
 */
export function txnCsv(kind: CsvKind, lines: readonly TxnLine[], identity = false): string {
  const header: string[] = [...COMMON];
  if (kind === 'seller') header[1] = 'order_ref_last6';
  if (kind === 'ops') header.push('unit_id', 'publisher_id', 'alerts', 'unknown_operation');
  if (kind === 'ops' && identity)
    header.push(
      'buyer_id',
      'buyer_name',
      'seller_name',
      'provider_order_id',
      'capture_id',
      'refund_id',
    );
  let out = csvLine(header);
  for (const l of lines) {
    const row: (string | number | null)[] = [
      l.created_at,
      kind === 'seller' ? l.order_ref6 : l.order_ref,
      l.status,
      l.titles.join('; '),
      l.currency,
      l.amount_minor,
      money(l),
      l.refunded_minor,
      l.environment,
      l.refund_state,
      l.case_state,
      l.channel,
    ];
    if (kind === 'ops') {
      row.push(
        l.unit_id,
        l.publisher_id ?? null,
        l.alert_count ?? 0,
        l.has_unknown_op === true ? 'yes' : 'no',
      );
      if (identity)
        row.push(
          l.buyer_id ?? null,
          l.buyer_display_name ?? null,
          l.seller_name ?? null,
          l.provider_order_id ?? null,
          l.capture_id ?? null,
          l.refund_id ?? null,
        );
    }
    out += csvLine(row);
  }
  return out;
}

export const exportName = (kind: CsvKind, now: Date): string =>
  `${kind === 'ops' ? 'operator-transactions' : kind === 'seller' ? 'sales' : 'orders'}-${now.toISOString().slice(0, 10)}.csv`;
