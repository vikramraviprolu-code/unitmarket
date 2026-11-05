// INT-OPS-B / OPS-B.2: the logic of Money > Transactions. Pure. The table calls GET /api/ops/transactions (SR1)
// through getJson; this file builds that URL from the filter bar's state, turns the answer into rows in words,
// and builds the CSV request (the same canonical query as the list) and the download. Identity is shown only
// when the signed-in session has MFA, and only what the line itself carries: the route (withOpsIdentity) already
// leaves names and PayPal ids out without MFA, and this view never shows an opaque buyer, seller or key id at
// all, so a session without the code sees order refs, amounts, states and flags and nothing else.
import type { EnvironmentLabel, StatusGroup, TxnLine } from '@umsbx/contracts';
import { formatDateTime, formatMinor } from './format';
import {
  SAVED_VIEWS,
  STATUS_LABEL,
  barState,
  hrefWith,
  pageHref,
  queryString,
  withField,
} from './filter-bar-view';
import type { BarContext, RawMap } from './filter-bar-view';

export const LIST_PATH = '/api/ops/transactions';
export const EXPORT_PATH = '/api/ops/transactions/export';
export const PAGE_PATH = '/ops/money/transactions';

export type TxnItem = TxnLine;

/** The list request: the bar's canonical query, and a cursor only when the caller asks for page two on. */
export function listUrl(ctx: BarContext, raw: RawMap, cursor?: string): string {
  const map = barState(ctx, raw).map;
  const qs = queryString(map);
  const tail =
    cursor === undefined ? '' : `${qs === '' ? '' : '&'}cursor=${encodeURIComponent(cursor)}`;
  return qs === '' && tail === '' ? LIST_PATH : `${LIST_PATH}?${qs}${tail}`;
}

/** The CSV request: the same canonical query as the list. It has no cursor, since the file is the whole result. */
export function exportUrl(ctx: BarContext, raw: RawMap): string {
  return hrefWith(EXPORT_PATH, barState(ctx, raw).map);
}

export const nextPageHref = (
  basePath: string,
  ctx: BarContext,
  raw: RawMap,
  cursor: string | null,
): string | null => pageHref(basePath, ctx, raw, cursor);

export interface SavedViewLink {
  id: string;
  label: string;
  href: string;
  current: boolean;
}

/** SR1's four saved views as links. Choosing one keeps the other filters and replaces the view. */
export function savedViewLinks(ctx: BarContext, raw: RawMap): SavedViewLink[] {
  const current = barState(ctx, raw).map['view'];
  return SAVED_VIEWS.map((v) => ({
    id: v.id,
    label: v.label,
    href: hrefWith(PAGE_PATH, withField(ctx, raw, 'view', v.id)),
    current: current === v.id,
  }));
}

export interface TxnRow {
  key: string;
  order_ref: string;
  href: string;
  at: string;
  when: string;
  status: StatusGroup;
  status_word: string;
  amount: string;
  refunded: string | null;
  channel_word: string;
  /** The stored environment. The component draws the label from it. */
  environment: EnvironmentLabel;
  titles: string;
  flags: string[];
  /** Names and the PayPal order id: MFA sessions only, and only what the line carries. */
  buyer: string | null;
  seller: string | null;
  provider_order: string | null;
}

export function rowsOf(items: readonly TxnItem[], o: { mfa: boolean }): TxnRow[] {
  return items.map((l) => {
    const flags: string[] = [];
    if ((l.alert_count ?? 0) > 0) flags.push('Has an alert');
    if (l.order_mismatch === true) flags.push('Amount mismatch');
    if (l.has_unknown_op === true) flags.push('Unknown PayPal step');
    return {
      key: l.unit_id,
      order_ref: l.order_ref,
      href: `/ops/money/orders/${encodeURIComponent(l.order_ref)}`,
      at: l.created_at,
      when: formatDateTime(l.created_at),
      status: l.status,
      status_word: STATUS_LABEL[l.status] ?? l.status,
      amount: formatMinor(l.amount_minor, l.currency),
      refunded: l.refunded_minor > 0 ? formatMinor(l.refunded_minor, l.currency) : null,
      channel_word: l.channel === 'agent' ? 'Agent' : 'Person',
      environment: l.environment,
      titles: (l.titles ?? []).join(', '),
      flags,
      buyer: o.mfa ? (l.buyer_display_name ?? null) : null,
      seller: o.mfa ? (l.seller_name ?? null) : null,
      provider_order: o.mfa ? (l.provider_order_id ?? null) : null,
    };
  });
}

export type ApiResult<T> =
  { ok: true; data: T } | { ok: false; status: number; code: string; message: string };

export type TxnPageView =
  | { kind: 'rows'; rows: TxnRow[]; next_cursor: string | null }
  | { kind: 'empty'; message: string }
  | { kind: 'error'; message: string };

export const TXN_EMPTY = 'No transactions match these filters.';

/** One fixed sentence for each failure: the route's own text is never shown. */
export function failureText(status: number, code: string): string {
  if (code === 'bad_cursor')
    return 'That page marker is not valid. Start again from the first page.';
  if (code === 'mfa_required')
    return 'This needs the second factor. Sign in again with your authenticator code.';
  if (status === 401) return 'Your sign-in ended. Sign in again to see this list.';
  if (status === 403) return 'This sign-in cannot see this list.';
  if (status === 429) return 'Too many requests. Wait a moment and try again.';
  if (status === 400) return 'One of the filters is not available. Remove it and try again.';
  return 'The list could not be loaded. Check your connection and try again.';
}

export function pageViewOf(
  result: ApiResult<{ items: readonly TxnItem[]; next_cursor: string | null }>,
  o: { mfa: boolean },
): TxnPageView {
  if (!result.ok) return { kind: 'error', message: failureText(result.status, result.code) };
  if (result.data.items.length === 0) return { kind: 'empty', message: TXN_EMPTY };
  return { kind: 'rows', rows: rowsOf(result.data.items, o), next_cursor: result.data.next_cursor };
}

export interface CsvFile {
  filename: string;
  text: string;
  mime: 'text/csv;charset=utf-8';
  note: string | null;
}

export function csvDownload(body: { filename: string; csv: string; truncated: boolean }): CsvFile {
  return {
    filename: body.filename,
    text: body.csv,
    mime: 'text/csv;charset=utf-8',
    note: body.truncated
      ? 'The file holds the first rows only. Narrow the filters to get the rest.'
      : null,
  };
}
