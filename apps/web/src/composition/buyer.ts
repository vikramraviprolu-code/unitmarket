// INT-UI0 / UI0.7: the composition module of the buyer tabs. INT-TR1 added the timeline read. INT-BUY adds the rest:
// caps (Agents), purchases (Spending), the Home reads, the order page reads, receipts, approvals and keys. Every
// read names the buyer, and another buyer's row is "not found", never "forbidden". Domain code is called
// unchanged: nothing here writes.
import type { Actor, ApiKeyView, TxnLine } from '@umsbx/contracts';
import { listKeys } from '@umsbx/security';
import {
  TRACE_WORDS,
  apiKeyDeps,
  app,
  buyerLine,
  createApiV1,
  exportName,
  exportTransactions,
  listTransactions,
  txnCsv,
} from '../server/access';
import type { LibraryEntry, OrderView } from '../server/access';
import { capLine } from '../lib/buyer-agents-view';
import type { AgentKeyInput, CapInput } from '../lib/buyer-agents-view';
import type { PendingApprovalInput, ReadingInput } from '../lib/buyer-home-view';
import type { CaseCardInput } from '../lib/buyer-order-view';
import type { ReceiptInput } from '../lib/buyer-should-view';
import type { TimelineEntryView } from '../lib/timeline-view';

type BuyerActor = Extract<Actor, { kind: 'buyer' }>;
const asBuyer = (buyer_id: string): BuyerActor => ({ kind: 'buyer', buyer_id });

/** The words of the journal steps, for the order page. */
export const traceWords = (): Readonly<Record<string, string>> => TRACE_WORDS;

/** The steps of one order for the buyer who owns it. Null for another buyer's order or an unknown one. */
export async function readBuyerTimeline(buyer_id: string, order_ref: string) {
  return (await app()).trace.buyerTimeline({ order_ref, buyer_id });
}

// ---- BUY.1 and BUY.2: caps ----

/** The buyer's caps, newest first, each with what is left (domain `getMandate` applies `remainingOf`). */
export async function listCaps(buyer_id: string): Promise<CapInput[]> {
  const a = await app();
  const ids = await a.db.query<{ id: string }>(
    'SELECT id FROM mandates WHERE buyer_id = $1 ORDER BY created_at DESC, id DESC',
    [buyer_id],
  );
  const mandates = createApiV1(a).mandates;
  const out: CapInput[] = [];
  for (const r of ids.rows) {
    const m = await mandates.get(buyer_id, r.id);
    if (m !== null) out.push(m);
  }
  return out;
}

/** The buyer's agent keys (not API client keys), newest first. */
export async function readAgentKeys(buyer_id: string): Promise<AgentKeyInput[]> {
  const a = await app();
  const keys = await listKeys(apiKeyDeps(a), asBuyer(buyer_id));
  return keys
    .filter((k) => k.key_kind === 'agent')
    .sort((x, y) => (x.created_at < y.created_at ? 1 : x.created_at > y.created_at ? -1 : 0))
    .map((k) => ({
      id: k.id,
      label: `Agent key ${k.id.slice(-4)}`,
      revoked: k.revoked_at !== null,
    }));
}

/** BUY.2: the cap line of the agent hand-off page. Null when the order used no cap or is not this buyer's. */
export async function readCapLine(buyer_id: string, order_ref: string): Promise<string | null> {
  const a = await app();
  const r = await a.db.query<{ mandate_id: string }>(
    `SELECT r.mandate_id
       FROM orders o JOIN mandate_reservations r ON r.order_id = o.id
      WHERE o.order_ref = $1 AND o.buyer_id = $2
      ORDER BY r.created_at DESC, r.id DESC LIMIT 1`,
    [order_ref, buyer_id],
  );
  const id = r.rows[0]?.mandate_id;
  if (id === undefined) return null;
  const m = await createApiV1(a).mandates.get(buyer_id, id);
  return capLine(m, a.security.clock.now());
}

// ---- BUY.4: spending ----

type Raw = Readonly<Record<string, string | undefined>>;
const defined = (raw: Raw): Record<string, string> =>
  Object.fromEntries(Object.entries(raw).filter((e): e is [string, string] => e[1] !== undefined));

/** The buyer's purchases under a filter, newest first. A field a buyer may not use throws TxnSearchError. */
export async function readSpending(
  buyer_id: string,
  raw: Raw,
): Promise<{ lines: TxnLine[]; next_cursor: string | null }> {
  const a = await app();
  const now = a.security.clock.now();
  const r = await listTransactions(a.db, asBuyer(buyer_id), defined(raw), { now });
  return { lines: r.rows.map((row) => buyerLine(row, now)), next_cursor: r.next_cursor };
}

/** The CSV of the same filter: { filename, csv, truncated }, at most 5,000 rows. */
export async function readSpendingExport(buyer_id: string, raw: Raw) {
  const a = await app();
  const now = a.security.clock.now();
  const r = await exportTransactions(a.db, asBuyer(buyer_id), defined(raw), { now });
  return {
    filename: exportName('buyer', now),
    csv: txnCsv(
      'buyer',
      r.rows.map((row) => buyerLine(row, now)),
    ),
    truncated: r.truncated,
  };
}

// ---- BUY.5: home ----

export interface BuyerHomeRead {
  pending: PendingApprovalInput[];
  reading: ReadingInput[];
  caps: CapInput[];
  recent: TxnLine[];
}

/**
 * Approvals the buyer has not used, which have not ended, newest first. An agent approval (its snapshot names a
 * mandate) is never for the buyer to act on, so it is left out (FIX-B5): a refused agent buy leaves one unused.
 */
export async function readPendingApprovals(buyer_id: string): Promise<PendingApprovalInput[]> {
  const a = await app();
  const now = a.security.clock.now().toISOString();
  const ids = await a.db.query<{ id: string }>(
    `SELECT id FROM approvals
      WHERE buyer_id = $1 AND used_at IS NULL AND expires_at > $2
        AND snapshot->>'mandate_id' IS NULL
      ORDER BY created_at DESC, id DESC LIMIT 20`,
    [buyer_id, now],
  );
  const actor = asBuyer(buyer_id);
  const out: PendingApprovalInput[] = [];
  for (const r of ids.rows) {
    const v = await a.engine.approvalView({ approval_id: r.id, actor });
    if (v === null || v.used) continue;
    out.push({
      approval_id: v.approval_id,
      titles: v.items.map((i) => i.title),
      total_minor: v.total_minor,
      currency: v.currency,
      expires_at: v.expires_at,
    });
  }
  return out;
}

export async function readLibrary(buyer_id: string): Promise<LibraryEntry[]> {
  return (await app()).engine.library({ actor: asBuyer(buyer_id) });
}

export async function readBuyerHome(buyer_id: string): Promise<BuyerHomeRead> {
  const [pending, library, caps, recent] = await Promise.all([
    readPendingApprovals(buyer_id),
    readLibrary(buyer_id),
    listCaps(buyer_id),
    readSpending(buyer_id, { limit: '5' }),
  ]);
  const reading = library
    .filter((e) => e.can_open)
    .slice(0, 3)
    .map((e): ReadingInput => ({
      entitlement_id: e.entitlement_id,
      title: e.title,
      publisher: e.publisher,
      days_left: e.window.days_left,
    }));
  return { pending, reading, caps, recent: recent.lines };
}

// ---- BUY.3: the order page ----

export interface BuyerOrderRead {
  view: OrderView;
  currency: string;
  timeline: { entries: TimelineEntryView[]; truncated: boolean } | null;
  case: CaseCardInput | null;
  entitlement_id: string | null;
}

/** The case of an order, for the buyer who owns the order. Null for any other buyer. */
export async function readOrderCase(
  buyer_id: string,
  case_id: string,
): Promise<CaseCardInput | null> {
  const a = await app();
  const r = await a.db.query<{
    id: string;
    state: string;
    buyer_message: string;
    sla_due_at: unknown;
    created_at: unknown;
  }>(
    `SELECT c.id, c.state, c.buyer_message, c.sla_due_at, c.created_at
       FROM recovery_cases c LEFT JOIN orders o ON o.id = c.order_id
      WHERE c.id = $1 AND (c.buyer_id = $2 OR o.buyer_id = $2)`,
    [case_id, buyer_id],
  );
  const row = r.rows[0];
  if (row === undefined) return null;
  const iso = (v: unknown): string => new Date(v as string | Date).toISOString();
  return {
    case_id: row.id,
    state: row.state,
    buyer_message: row.buyer_message,
    sla_due_at: iso(row.sla_due_at),
    opened_at: iso(row.created_at),
  };
}

export async function readBuyerOrder(
  buyer_id: string,
  order_ref: string,
): Promise<BuyerOrderRead | null> {
  const a = await app();
  const actor = asBuyer(buyer_id);
  const view = await a.engine.orderView({ order_ref, actor });
  if (view === null) return null;
  const [timeline, library, caseInput] = await Promise.all([
    a.trace.buyerTimeline({ order_ref, buyer_id }).catch(() => null),
    a.engine.library({ actor }),
    view.open_case === null
      ? Promise.resolve(null)
      : readOrderCase(buyer_id, view.open_case.case_id),
  ]);
  const currency = (
    await a.db.query<{ currency: string }>(
      'SELECT currency FROM orders WHERE order_ref = $1 AND buyer_id = $2',
      [order_ref, buyer_id],
    )
  ).rows[0]?.currency;
  return {
    view,
    currency: currency ?? 'USD',
    timeline:
      timeline === null
        ? null
        : { entries: timeline.entries as TimelineEntryView[], truncated: timeline.truncated },
    case: caseInput,
    entitlement_id: library.find((e) => e.order_ref === order_ref)?.entitlement_id ?? null,
  };
}

// ---- BUY.6 and BUY.8: receipts and API keys ----

/**
 * The buyer's paid orders for the receipts list: the order ref, the provider order id(s) the buyer's own orders
 * carry, and the seller(s) of record. Scoped to the buyer by `orders.buyer_id`. A buyer's own provider order id is
 * shown here on purpose (BUY.6); the buyer transaction line (SR1) still hides it.
 */
export async function readReceipts(buyer_id: string): Promise<ReceiptInput[]> {
  const a = await app();
  const r = await a.db.query<{
    id: string;
    order_ref: string;
    currency: string;
    total_minor: number | string;
    created_at: unknown;
  }>(
    `SELECT o.id, o.order_ref, o.currency, o.total_minor, o.created_at
       FROM orders o
      WHERE o.buyer_id = $1
        AND EXISTS (SELECT 1 FROM order_units u
                     WHERE u.order_id = o.id AND u.status IN ('captured_verified', 'refunded'))
      ORDER BY o.created_at DESC, o.id DESC
      LIMIT 50`,
    [buyer_id],
  );
  const out: ReceiptInput[] = [];
  for (const o of r.rows) {
    const [ids, sellers] = await Promise.all([
      a.db.query<{ provider_order_id: string }>(
        `SELECT provider_order_id FROM provider_orders
          WHERE order_id = $1 ORDER BY position, id`,
        [o.id],
      ),
      a.db.query<{ display_name: string }>(
        `SELECT DISTINCT p.display_name
           FROM order_units u JOIN publishers p ON p.id = u.publisher_id
          WHERE u.order_id = $1 ORDER BY p.display_name`,
        [o.id],
      ),
    ]);
    out.push({
      order_id: o.id,
      order_ref: o.order_ref,
      provider_order_ids: ids.rows.map((x) => x.provider_order_id),
      sellers: sellers.rows.map((x) => x.display_name),
      currency: o.currency,
      total_minor: Number(o.total_minor),
      created_at: new Date(o.created_at as string | Date).toISOString(),
    });
  }
  return out;
}

/** All the buyer's API keys as the API-W0 view (no secret, no hash), newest first. */
export async function readKeyViews(buyer_id: string): Promise<ApiKeyView[]> {
  const a = await app();
  const keys = await listKeys(apiKeyDeps(a), asBuyer(buyer_id));
  return [...keys].sort((x, y) =>
    x.created_at < y.created_at ? 1 : x.created_at > y.created_at ? -1 : 0,
  );
}
