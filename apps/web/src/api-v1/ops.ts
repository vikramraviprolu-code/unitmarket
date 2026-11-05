// API-A: the operator routes O1 to O5. All reads. An operator key has no second factor (toActor sets
// mfa false), and nothing here changes a switch, starts or stops outbound calls, or opens a refund: the
// facade for operators has no such method (see facades.ts), and this file has none either.
// The answers carry no buyer or publisher identity, no PayPal order id, no merchant id and no secret.
import type { Actor } from '@umsbx/contracts';
import type { HttpResult } from '@umsbx/security';
import {
  exportName,
  exportTransactions,
  isViewId,
  listTransactions,
  txnCsv,
  quickFind,
} from '../../composition.server';
import type { App } from '../../composition.server';
import { findForActor, hasOpsIdentity, withOpsIdentity } from '../server/ops-identity';
import { FORBIDDEN, NOT_FOUND, ownerOf, searchRefusal, type Ctx } from './guard';

type Result<T> = Promise<HttpResult<T>>;

async function snapshot(a: App, ctx: Ctx) {
  const actor = ownerOf(ctx, 'operator');
  return actor === null ? null : await a.engine.opsSnapshot(actor);
}

// O1
export async function overview(a: App, ctx: Ctx): Result<unknown> {
  const s = await snapshot(a, ctx);
  if (s === null) return FORBIDDEN;
  return {
    status: 200,
    body: {
      environment: s.environment,
      orders: s.orders,
      operations: s.operations,
      alerts: s.alerts,
      // The v1 shape is unchanged: `rows` (INT-OPS-A) is for the operator pages only.
      invariants: s.invariants.map((v) => ({ id: v.id, ok: v.ok, detail: v.detail })),
      jobs: s.jobs,
    },
  };
}

// O2
export async function reconciler(a: App, ctx: Ctx): Result<unknown> {
  const s = await snapshot(a, ctx);
  if (s === null) return FORBIDDEN;
  return {
    status: 200,
    body: {
      last_pass_at: s.jobs.last_pass_at,
      due: s.jobs.due,
      operations: s.operations,
      alerts: s.alerts,
    },
  };
}

const iso = (v: unknown): string => new Date(v as string | number | Date).toISOString();

// O3: a read of the order, its units, its provider-order states and its operations. Counts and states only.
export async function orderDetail(a: App, ctx: Ctx, order_ref: string): Result<unknown> {
  if (ownerOf(ctx, 'operator') === null) return FORBIDDEN;
  const o = (
    await a.db.query<{
      id: string;
      order_ref: string;
      status: string;
      environment: string;
      currency: string;
      total_minor: string | number;
      mismatch: boolean;
      created_at: unknown;
      updated_at: unknown;
    }>(
      `SELECT id, order_ref, status, environment, currency, total_minor, mismatch, created_at, updated_at
         FROM orders WHERE order_ref = $1`,
      [order_ref],
    )
  ).rows[0];
  if (o === undefined) return NOT_FOUND('order');
  const units = await a.db.query<{
    status: string;
    amount_minor: string | number;
    refunded_minor: string | number;
  }>(
    'SELECT status, amount_minor, refunded_minor FROM order_units WHERE order_id = $1 ORDER BY created_at, id',
    [o.id],
  );
  const pos = await a.db.query<{ position: number | null; state: string | null }>(
    'SELECT position, state FROM provider_orders WHERE order_id = $1 ORDER BY position, id',
    [o.id],
  );
  const ops = await a.db.query<{ kind: string; state: string; attempt: number }>(
    'SELECT kind, state, attempt FROM operations WHERE order_id = $1 ORDER BY created_at, id',
    [o.id],
  );
  return {
    status: 200,
    body: {
      order_ref: o.order_ref,
      status: o.status,
      environment: o.environment,
      currency: o.currency,
      total_minor: Number(o.total_minor),
      mismatch: o.mismatch,
      created_at: iso(o.created_at),
      updated_at: iso(o.updated_at),
      units: units.rows.map((u) => ({
        status: u.status,
        amount_minor: Number(u.amount_minor),
        refunded_minor: Number(u.refunded_minor),
      })),
      provider_orders: pos.rows.map((p) => ({ position: p.position, state: p.state })),
      operations: ops.rows.map((x) => ({
        kind: x.kind,
        state: x.state,
        attempt: Number(x.attempt),
      })),
    },
  };
}

// O4: booleans and words only. The lock block is null on the dry-run transport.
export async function switches(a: App, ctx: Ctx): Result<unknown> {
  const s = await snapshot(a, ctx);
  if (s === null) return FORBIDDEN;
  const out = s.gate.outbound;
  return {
    status: 200,
    body: {
      environment: s.environment,
      switches: s.switches,
      kill_switch: { outbound_on: s.kill_switch.outbound_on, changed_at: s.kill_switch.changed_at },
      gate: {
        mode: s.gate.mode,
        connect: s.gate.connect,
        approval_ref_set: s.gate.approval_ref_set,
        locks: out === null ? null : out.locks,
        open: out === null ? null : out.open,
        blocked_by: out === null ? null : out.blocked_by,
      },
    },
  };
}

// O5: /healthz plus the revision and whether the database is open (INT-CL1). 503 stays when unhealthy.
export async function status(a: App): Result<unknown> {
  const h = await a.engine.health();
  return h.ok
    ? {
        status: 200,
        body: {
          ok: true,
          environment: h.environment,
          revision: h.revision,
          db: h.db ? 'up' : 'closed',
          ...(h.maintenance ? { maintenance: true } : {}),
        },
      }
    : { status: 503, code: 'unhealthy', message: 'The service is not ready.' };
}

// INT-SR1 (SR1.3): the operator transaction list with four saved views (`view=`). The key route and the
// session route run the same function; withOpsIdentity adds names and PayPal ids only for a session with MFA.
const viewOf = (raw: Record<string, string>) =>
  raw['view'] !== undefined && isViewId(raw['view']) ? raw['view'] : undefined;

export async function opsTransactionsFor(
  a: App,
  actor: Actor,
  raw: Record<string, string>,
): Result<unknown> {
  const now = a.security.clock.now();
  const view = viewOf(raw);
  try {
    const r = await listTransactions(a.db, actor, raw, { now, ...(view ? { view } : {}) });
    return {
      status: 200,
      body: { items: withOpsIdentity(actor, r.rows, now), next_cursor: r.next_cursor },
    };
  } catch (e) {
    const refused = searchRefusal(e);
    if (refused !== null) return refused;
    throw e;
  }
}

/** GET /api/v1/ops/transactions: an operator key; no identity, whatever the key asks for. */
export async function transactions(a: App, ctx: Ctx, raw: Record<string, string>): Result<unknown> {
  const actor = ownerOf(ctx, 'operator');
  return actor === null ? FORBIDDEN : opsTransactionsFor(a, actor, raw);
}

/** GET /api/ops/transactions/export: the same filter as CSV text; identity columns only with MFA. */
export async function opsExportFor(
  a: App,
  actor: Actor,
  raw: Record<string, string>,
): Result<unknown> {
  const now = a.security.clock.now();
  const view = viewOf(raw);
  try {
    const r = await exportTransactions(a.db, actor, raw, { now, ...(view ? { view } : {}) });
    const lines = withOpsIdentity(actor, r.rows, now);
    return {
      status: 200,
      body: {
        filename: exportName('ops', now),
        csv: txnCsv('ops', lines, hasOpsIdentity(actor)),
        truncated: r.truncated,
      },
    };
  } catch (e) {
    const refused = searchRefusal(e);
    if (refused !== null) return refused;
    throw e;
  }
}

/** GET /api/ops/find: quick-find from the operator session. */
export async function opsFind(a: App, actor: Actor, q: string): Result<unknown> {
  try {
    const found = await quickFind(a.db, actor, q, { now: a.security.clock.now() });
    return { status: 200, body: findForActor(actor, found) };
  } catch (e) {
    const refused = searchRefusal(e);
    if (refused !== null) return refused;
    throw e;
  }
}
