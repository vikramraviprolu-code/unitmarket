// INT-UI0 / UI0.7: the reads of the operator Money tab: the operations snapshot, one single-use
// Idempotency-Key per refund form (made on the server, CO-8), and the reporting view, which converts only
// through the engine at the latest stored rate (MC2-L7). These are the reads /ops made before, unchanged.
import type { Actor } from '@umsbx/contracts';
import { app } from '../server/access';
import type { OpsSnapshot } from '../server/access';
import { opsReportingView } from '../lib/ops-reporting-view';
import { orderPageView } from '../lib/ops-order-view';
import type { OrderPageView } from '../lib/ops-order-view';
import { INVARIANT_IDS, invariantLink, operationLink } from '../lib/ops-invariants-view';
import type { InvariantId, OperationState, ProblemsQuery } from '../lib/ops-invariants-view';

type OperatorActor = Extract<Actor, { kind: 'operator' }>;

export interface OpsMoneyRead {
  snap: OpsSnapshot;
  refundKeys: string[];
  reporting: ReturnType<typeof opsReportingView>;
}

export async function readOpsMoney(actor: OperatorActor): Promise<OpsMoneyRead | null> {
  const a = await app();
  const snap = await a.engine.opsSnapshot(actor);
  if (snap === null) return null;
  const refundKeys = snap.refunds === null ? [] : snap.refunds.units.map(() => a.engine.newKey());
  const reporting = opsReportingView(snap.totals, {
    convert: a.engine.fx.convert,
    rates: await a.engine.fx.getRates(),
  });
  return { snap, refundKeys, reporting };
}

// INT-OPS-B / OPS-B.2: the props of the Transactions page, and nothing else. The list itself comes from
// GET /api/ops/transactions in the browser (SR1), so the cursor hash and the MFA rule stay in the route. The
// environment is the app's stored one, for the label; `mfa` only says which fields the filter bar may offer.
export interface OpsTransactionsProps {
  environment: OpsSnapshot['environment'];
  mfa: boolean;
}

export async function readOpsTransactionsProps(
  actor: OperatorActor,
): Promise<OpsTransactionsProps | null> {
  const snap = await (await app()).engine.opsSnapshot(actor);
  return snap === null ? null : { environment: snap.environment, mfa: actor.mfa };
}

// INT-OPS-A / OPS-A.4: the order page. An operator reads any order; without the second factor the view carries no
// buyer name, no whole PayPal id and no address (the TR1 operator read redacts the journal the same way). Null for
// anyone who is not an operator and for an order that is not there. The one fix link is the catalogue fix of an
// alert that still waits on the order.
export async function readOrderPage(actor: Actor, ref: string): Promise<OrderPageView | null> {
  if (actor.kind !== 'operator') return null;
  const a = await app();
  const mfa = actor.mfa === true;
  const o = (
    await a.db.query<{
      id: string;
      order_ref: string;
      status: string;
      total_minor: string | number;
      currency: string;
      environment: string;
      created_at: string | Date;
      buyer_name: string | null;
    }>(
      `SELECT o.id, o.order_ref, o.status, o.total_minor, o.currency, o.environment, o.created_at,
              b.display_name AS buyer_name
         FROM orders o LEFT JOIN buyers b ON b.id = o.buyer_id WHERE o.order_ref = $1`,
      [ref],
    )
  ).rows[0];
  if (o === undefined) return null;
  const units = await a.db.query<{
    id: string;
    amount_minor: string | number;
    status: string;
    capture_id: string | null;
  }>(
    'SELECT id, amount_minor, status, capture_id FROM order_units WHERE order_id = $1 ORDER BY id',
    [o.id],
  );
  const pos = await a.db.query<{ provider_order_id: string }>(
    `SELECT provider_order_id FROM provider_orders
      WHERE order_id = $1 AND provider_order_id IS NOT NULL ORDER BY position NULLS LAST, id`,
    [o.id],
  );
  const tl = await a.trace.opsTimeline({ order_ref: ref, mfa });
  const alertIds = await a.db.query<{ id: string }>(
    `SELECT a.id FROM alerts a LEFT JOIN order_units u ON u.id = a.unit_id
      WHERE COALESCE(a.order_id, u.order_id) = $1 ORDER BY a.created_at, a.id`,
    [o.id],
  );
  const alerts: { id: string; fix: { route: string; anchor: string } }[] = [];
  for (const r of alertIds.rows) {
    const d = await a.engine.opsReads.alert(r.id);
    if (d !== null && d.state !== 'resolved') alerts.push({ id: d.id, fix: d.fix });
  }
  return orderPageView({
    order: {
      order_ref: o.order_ref,
      status: o.status,
      total_minor: Number(o.total_minor),
      currency: o.currency,
      environment: o.environment,
      created_at: new Date(o.created_at).toISOString(),
      buyer_name: o.buyer_name,
    },
    units: units.rows.map((u) => ({
      id: u.id,
      amount_minor: Number(u.amount_minor),
      status: u.status,
      capture_id: u.capture_id,
    })),
    provider_orders: pos.rows,
    entries: tl?.entries ?? [],
    truncated: tl?.truncated ?? false,
    words: a.trace.words,
    alerts,
    mfa,
  });
}

// INT-OPS-A / OPS-A.6: the Problems page. What is behind a failing invariant (the orders its rows lead to) or an
// operation state (the operations in it). A list is cut at PROBLEMS_CAP and says how many there are. Read only, and
// open to an operator without the code: it names orders and operations, never a person.
export const PROBLEMS_CAP = 200;

export type ProblemsRead =
  | {
      kind: 'inv';
      id: InvariantId;
      ok: boolean;
      detail: string;
      orders: { order_ref: string; href: string }[];
      total: number;
      capped: boolean;
    }
  | {
      kind: 'op';
      state: OperationState;
      operations: {
        id: string;
        kind: string;
        order_ref: string;
        order_href: string;
        attempt: number;
        lease_until: string | null;
      }[];
      total: number;
      capped: boolean;
    }
  | {
      kind: 'none';
      invariants: { id: InvariantId; ok: boolean; href: string | null }[];
      states: { state: OperationState; count: number; href: string }[];
    };

const orderLink = (ref: string): string => `/ops/money/orders/${encodeURIComponent(ref)}`;

// The order of each kind of row an invariant names, as one query per table.
const ORDER_OF_ROW: Record<string, string> = {
  order_units:
    'SELECT o.order_ref FROM order_units u JOIN orders o ON o.id = u.order_id WHERE u.id = ANY($1::text[])',
  entitlements:
    'SELECT o.order_ref FROM entitlements e JOIN order_units u ON u.id = e.unit_id JOIN orders o ON o.id = u.order_id WHERE e.id = ANY($1::text[])',
  orders: 'SELECT o.order_ref FROM orders o WHERE o.id = ANY($1::text[])',
  provider_orders:
    'SELECT o.order_ref FROM provider_orders p JOIN orders o ON o.id = p.order_id WHERE p.id = ANY($1::text[])',
  refund_requests:
    'SELECT o.order_ref FROM refund_requests r JOIN order_units u ON u.id = r.unit_id JOIN orders o ON o.id = u.order_id WHERE r.id = ANY($1::text[])',
  publishers:
    'SELECT o.order_ref FROM order_units u JOIN orders o ON o.id = u.order_id WHERE u.publisher_id = ANY($1::text[]) AND u.captured_verified_at IS NOT NULL',
};

export async function readProblems(actor: Actor, q: ProblemsQuery): Promise<ProblemsRead | null> {
  if (actor.kind !== 'operator') return null;
  const a = await app();
  const snap = await a.engine.opsSnapshot(actor);
  if (snap === null) return null;
  if (q.kind === 'inv') {
    const inv = snap.invariants.find((v) => v.id === q.id);
    if (inv === undefined) return null;
    const refs = new Set<string>();
    if (!inv.ok) {
      const byTable = new Map<string, string[]>();
      for (const r of inv.rows) byTable.set(r.table, [...(byTable.get(r.table) ?? []), r.id]);
      for (const [table, ids] of byTable) {
        const sql = ORDER_OF_ROW[table];
        if (sql === undefined) continue;
        for (const row of (await a.db.query<{ order_ref: string }>(sql, [ids])).rows)
          refs.add(row.order_ref);
      }
    }
    const all = [...refs].sort();
    return {
      kind: 'inv',
      id: q.id,
      ok: inv.ok,
      detail: inv.detail,
      orders: all
        .slice(0, PROBLEMS_CAP)
        .map((order_ref) => ({ order_ref, href: orderLink(order_ref) })),
      total: all.length,
      capped: all.length > PROBLEMS_CAP,
    };
  }
  if (q.kind === 'op') {
    const total = Number(
      (
        await a.db.query<{ c: string }>('SELECT count(*) AS c FROM operations WHERE state = $1', [
          q.state,
        ])
      ).rows[0]?.c ?? 0,
    );
    const ops = await a.db.query<{
      id: string;
      kind: string;
      order_ref: string;
      attempt: string | number;
      lease_until: string | Date | null;
    }>(
      `SELECT p.id, p.kind, o.order_ref, p.attempt, p.lease_until
         FROM operations p JOIN orders o ON o.id = p.order_id
        WHERE p.state = $1 ORDER BY p.created_at, p.id LIMIT $2`,
      [q.state, PROBLEMS_CAP],
    );
    return {
      kind: 'op',
      state: q.state,
      operations: ops.rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        order_ref: r.order_ref,
        order_href: orderLink(r.order_ref),
        attempt: Number(r.attempt),
        lease_until: r.lease_until === null ? null : new Date(r.lease_until).toISOString(),
      })),
      total,
      capped: total > PROBLEMS_CAP,
    };
  }
  const counts = new Map(snap.operations.map((o) => [o.state, o.count]));
  return {
    kind: 'none',
    invariants: INVARIANT_IDS.map((id) => {
      const v = snap.invariants.find((x) => x.id === id);
      const ok = v?.ok ?? true;
      return { id, ok, href: invariantLink(id, ok) };
    }),
    states: (['prepared', 'sent', 'unknown', 'confirmed', 'failed'] as const).map((state) => ({
      state,
      count: counts.get(state) ?? 0,
      href: operationLink(state) ?? '/ops/money/problems',
    })),
  };
}
