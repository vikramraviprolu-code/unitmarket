// The buyer library read model (architecture 4.5, 9.7): every purchase with its window, evidence
// and receipts, in plain words. History stays after a window ends. Read-only; it reaches rows only
// through the buyer id, so another buyer's items, receipts and cases never appear (P13).
// Owned by SBX lane 10.
import { IdSchema } from '@umsbx/contracts';
import type {
  AccessOption,
  AccessState,
  CaseKind,
  CaseState,
  CaseView,
  EnvironmentLabel,
  Id,
  MoneyState,
  SqlExecutor,
  WindowState,
} from '@umsbx/contracts';

export interface LibraryItem {
  entitlement_id: Id;
  article_id: Id;
  title: string;
  publisher: string;
  option: AccessOption;
  access: AccessState;
  window: WindowState;
  status_text: string;
  receipt_versions: number[];
  can_open: boolean;
  open_case: CaseView | null;
  environment: EnvironmentLabel;
}

const HOUR_MS = 3_600_000;
const DAY_HOURS = 24;
const ACTIVE_CASE_STATES = ['open', 'diagnosing', 'refund_pending'];

const iso = (v: Date | string | null): string | null =>
  v === null ? null : new Date(v).toISOString();
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

/** "Ready, 4 days 23 hours left": whole hours left, never rounded up. */
export function timeLeftText(remaining_ms: number): string {
  const hours = Math.floor(Math.max(0, remaining_ms) / HOUR_MS);
  if (hours < 1) return 'Ready, less than 1 hour left';
  const days = Math.floor(hours / DAY_HOURS);
  const rest = hours % DAY_HOURS;
  const parts = [
    ...(days > 0 ? [plural(days, 'day')] : []),
    ...(rest > 0 ? [plural(rest, 'hour')] : []),
  ];
  return `Ready, ${parts.join(' ')} left`;
}

export function statusText(i: {
  money: MoneyState;
  window: WindowState;
  option: AccessOption;
  unit_status: string;
  order_status: string;
  now: Date;
}): string {
  switch (i.money) {
    case 'refunded':
      return 'Refunded';
    case 'reversed':
      return 'Payment reversed';
    case 'denied':
      return 'Not charged';
    case 'pending':
    case 'unknown':
      if (i.unit_status === 'pending') return 'Payment pending at PayPal';
      if (i.order_status === 'failed' || i.order_status === 'abandoned') return 'Not charged';
      return 'Confirming payment';
    case 'captured':
      break;
  }
  const w = i.window;
  const ends = w.ends_at === null ? null : Date.parse(w.ends_at);
  const over =
    w.state === 'ended' || (w.state === 'running' && ends !== null && ends <= i.now.getTime());
  if (w.state === 'revoked') return 'Refunded';
  if (over) {
    return i.option === 'keep_retrieve' ? 'Retrieval closed, your copy is yours' : 'Reading ended';
  }
  switch (w.state) {
    case 'not_started':
      return 'Getting your copy ready';
    case 'paused':
      return 'Paused: we are fixing delivery';
    default:
      return timeLeftText((ends ?? i.now.getTime()) - i.now.getTime());
  }
}

interface ItemRow {
  id: string;
  article_id: string;
  title: string;
  publisher: string;
  option: AccessOption;
  access_state: AccessState;
  money_state: MoneyState;
  environment: EnvironmentLabel;
  order_id: string;
  unit_status: string;
  order_status: string;
  w_state: WindowState['state'] | null;
  started_at: Date | string | null;
  base_ends_at: Date | string | null;
  ends_at: Date | string | null;
  paused_at: Date | string | null;
  credit_ms: number | null;
}
interface CaseRow {
  id: string;
  kind: CaseKind;
  state: CaseState;
  order_id: string | null;
  entitlement_id: string | null;
  opened_by: CaseView['opened_by'];
  credit_ms: number;
  buyer_message: string;
  created_at: Date | string;
}
const toCaseView = (r: CaseRow): CaseView => ({
  case_id: r.id,
  kind: r.kind,
  state: r.state,
  order_id: r.order_id,
  entitlement_id: r.entitlement_id,
  opened_by: r.opened_by,
  opened_at: new Date(r.created_at).toISOString(),
  buyer_message: r.buyer_message,
  credit_ms: r.credit_ms,
});

/**
 * The buyer's whole library, newest purchase first. `now` is the caller's clock; without it the
 * database time is used (tests and the web composition pass the injected clock).
 */
export async function getLibrary(
  db: SqlExecutor,
  i: { buyer_id: Id; now?: Date },
): Promise<LibraryItem[]> {
  if (!IdSchema.safeParse(i.buyer_id).success) return [];
  const now =
    i.now ?? new Date((await db.query<{ n: Date | string }>('SELECT now() AS n')).rows[0]?.n ?? 0);
  const items = await db.query<ItemRow>(
    `SELECT e.id, e.article_id, a.title, p.display_name AS publisher, e.option, e.access_state,
            e.money_state, e.environment, u.order_id, u.status AS unit_status, o.status AS order_status,
            w.state AS w_state, w.started_at, w.base_ends_at, w.ends_at, w.paused_at, w.credit_ms
       FROM entitlements e
       JOIN articles a ON a.id = e.article_id
       JOIN publishers p ON p.id = a.publisher_id
       JOIN order_units u ON u.id = e.unit_id
       JOIN orders o ON o.id = u.order_id
       LEFT JOIN access_windows w ON w.entitlement_id = e.id
      WHERE e.buyer_id = $1
      ORDER BY e.created_at DESC, e.id`,
    [i.buyer_id],
  );
  const receipts = await db.query<{ order_id: string; version: number }>(
    `SELECT r.order_id, r.version FROM receipts r JOIN orders o ON o.id = r.order_id
      WHERE o.buyer_id = $1 ORDER BY r.order_id, r.version`,
    [i.buyer_id],
  );
  const versions = new Map<string, number[]>();
  for (const r of receipts.rows) {
    versions.set(r.order_id, [...(versions.get(r.order_id) ?? []), Number(r.version)]);
  }
  const cases = await db.query<CaseRow>(
    `SELECT id, kind, state, order_id, entitlement_id, opened_by, credit_ms, buyer_message, created_at
       FROM recovery_cases WHERE buyer_id = $1 AND state = ANY($2::text[])
      ORDER BY created_at DESC, id`,
    [i.buyer_id, ACTIVE_CASE_STATES],
  );

  return items.rows.map((r) => {
    const stored: WindowState = {
      state: r.w_state ?? 'not_started',
      started_at: iso(r.started_at),
      base_ends_at: iso(r.base_ends_at),
      ends_at: iso(r.ends_at),
      paused_at: iso(r.paused_at),
      credit_ms: r.credit_ms ?? 0,
    };
    // The sweep may not have run yet: past its end a running window reads as ended.
    const overdue =
      stored.state === 'running' &&
      stored.ends_at !== null &&
      Date.parse(stored.ends_at) <= now.getTime();
    const window: WindowState = overdue ? { ...stored, state: 'ended' } : stored;
    const access: AccessState =
      overdue && r.access_state === 'available' ? 'ended' : r.access_state;
    const mine =
      cases.rows.find((c) => c.entitlement_id === r.id) ??
      cases.rows.find((c) => c.entitlement_id === null && c.order_id === r.order_id);
    return {
      entitlement_id: r.id,
      article_id: r.article_id,
      title: r.title,
      publisher: r.publisher,
      option: r.option,
      access,
      window,
      status_text: statusText({
        money: r.money_state,
        window,
        option: r.option,
        unit_status: r.unit_status,
        order_status: r.order_status,
        now,
      }),
      receipt_versions: versions.get(r.order_id) ?? [],
      can_open: access === 'available' && (window.state === 'running' || window.state === 'paused'),
      open_case: mine === undefined ? null : toCaseView(mine),
      environment: r.environment,
    };
  });
}
