// CO-8 test helper. An offline app plus the pieces every refund test needs: operator sessions made
// directly (a named operator with the second factor, the unverified demo operator without it), buyers
// who buy through the real engine over the dry-run order model, and a call helper for the refund
// routes. Passcodes and secrets are fictional test values; nothing here reads the environment.
import { createSession } from '@umsbx/security';
import type { Actor } from '@umsbx/contracts';
import type { App } from '../composition.server';
import { createApp, installApp } from '../composition.server';
import type { AppOptions } from '../composition.server';
import { call, signIn, testEnv } from './support';
import type { Session } from './support';

type Handler = (
  req: Request,
  ctx?: { params: Promise<Record<string, string>> },
) => Promise<Response>;

/** A public test key (the RFC 6238 vector) for the operator "vikram"; not a credential. */
export const VIKRAM_B32 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

export interface BoughtUnit {
  order_ref: string;
  order_id: string;
  unit_id: string;
  entitlement_id: string;
  amount_minor: number;
  currency: string;
}

export interface RefundWorld {
  app: App;
  /** The signed-in buyers (cookie and CSRF token). */
  A: Session;
  B: Session;
  actorA: Actor;
  actorB: Actor;
  /** Operator sessions. `op` and `op2` have the second factor; `demo` is the unverified operator. */
  op: Session;
  op2: Session;
  demo: Session;
  refunds: typeof import('./app/api/refunds/route');
  cancel: typeof import('./app/api/refunds/[id]/cancel/route');
  library: typeof import('./app/api/library/route');
  receipts: typeof import('./app/api/receipts/[order]/route');
  link: typeof import('./app/api/library/[id]/link/route');
}

async function operatorSession(app: App, operator_id: string, mfa: boolean): Promise<Session> {
  const s = await createSession(app.security, { kind: 'operator', operator_id, mfa });
  return { cookie: s.cookie.split(';')[0] ?? '', csrf: s.csrf_token };
}

export async function bootRefundWorld(
  over: Record<string, string> = {},
  opts: AppOptions = {},
): Promise<RefundWorld> {
  const app = createApp(
    await testEnv({ UMS_OPERATOR_TOTP_KEYS: `vikram:${VIKRAM_B32}`, ...over }),
    {
      switch_cache_ms: 0,
      ...opts,
    },
  );
  installApp(app);
  await app.ready();
  const sessionRoute = await import('./app/api/session/route');
  const A = (await signIn(sessionRoute.POST, 'buyer-a'))!;
  const B = (await signIn(sessionRoute.POST, 'buyer-b'))!;
  const buyerId = async (p: string): Promise<string> =>
    (
      await app.db.query<{ id: string }>('SELECT id FROM buyers WHERE auth_subject = $1', [
        `persona:${p}`,
      ])
    ).rows[0]!.id;
  return {
    app,
    A,
    B,
    actorA: { kind: 'buyer', buyer_id: await buyerId('buyer-a') },
    actorB: { kind: 'buyer', buyer_id: await buyerId('buyer-b') },
    op: await operatorSession(app, 'opr_vikram', true),
    op2: await operatorSession(app, 'opr_sakthi', true),
    demo: await operatorSession(app, 'opr_demo', false),
    refunds: await import('./app/api/refunds/route'),
    cancel: await import('./app/api/refunds/[id]/cancel/route'),
    library: await import('./app/api/library/route'),
    receipts: await import('./app/api/receipts/[order]/route'),
    link: await import('./app/api/library/[id]/link/route'),
  };
}

/** Quote, approve, place, check out, pretend-approve and return: the buyer's whole payment. */
export async function buy(
  w: RefundWorld,
  o: {
    offer: string;
    option: 'keep_retrieve' | 'online_read';
    scenario?: string;
    who?: 'A' | 'B';
  },
): Promise<BoughtUnit> {
  const { app } = w;
  const actor = o.who === 'B' ? w.actorB : w.actorA;
  const q = await app.engine.quote({
    offer: { publisher_slug: 'harbour-ledger', offer_code: o.offer },
    actor,
    source: 'direct',
    option: o.option,
  });
  if (!q.ok || q.value.kind !== 'quote') throw new Error(`no quote for ${o.offer}`);
  const g = await app.engine.requestApproval({
    actor,
    selection: { kind: 'quote', quote_id: q.value.quote_id },
    consent: { terms: true, identity_share: false },
  });
  if (!g.ok) throw new Error(`no approval for ${o.offer}: ${g.error.code}`);
  const placed = await app.engine.payments.placeOrder({
    approval_id: g.value.approval_id,
    token: g.value.token,
    actor,
  });
  if (!placed.ok) throw new Error(`place: ${JSON.stringify(placed.error)}`);
  const scenario = o.scenario ?? 'happy';
  const co = await app.engine.payments.beginCheckout({ order_id: placed.value.order_id, actor });
  if (!co.ok) throw new Error(`checkout: ${co.error.code}`);
  const approved = await app.engine.dryRunApprove({
    order_ref: placed.value.order_ref,
    actor,
    scenario,
  });
  if (!approved) throw new Error('dry-run approve refused');
  await app.engine.payments.onBuyerReturn({ order_ref: placed.value.order_ref, actor, scenario });
  const u = (
    await app.db.query<{ id: string; amount_minor: string | number; currency: string }>(
      `SELECT u.id, u.amount_minor, o.currency FROM order_units u JOIN orders o ON o.id = u.order_id
        WHERE u.order_id = $1`,
      [placed.value.order_id],
    )
  ).rows[0]!;
  const e = (
    await app.db.query<{ id: string }>('SELECT id FROM entitlements WHERE unit_id = $1', [u.id])
  ).rows[0];
  return {
    order_ref: placed.value.order_ref,
    order_id: placed.value.order_id,
    unit_id: u.id,
    entitlement_id: e?.id ?? '',
    amount_minor: Number(u.amount_minor),
    currency: u.currency,
  };
}

/** POST /api/refunds. */
export function postRefund(
  w: RefundWorld,
  session: Session | null,
  body: unknown,
  o: { key?: string | null; headers?: Record<string, string>; csrf?: boolean } = {},
): Promise<Response> {
  const headers: Record<string, string> = { ...(o.headers ?? {}) };
  if (o.key !== null) headers['idempotency-key'] = o.key ?? `key-${nextKey++}-refund-test`;
  return call(w.refunds.POST as Handler, {
    url: '/api/refunds',
    method: 'POST',
    body,
    session,
    headers,
    ...(o.csrf === undefined ? {} : { csrf: o.csrf }),
  });
}
let nextKey = 1;

/** POST /api/refunds/[id]/cancel. */
export function postCancel(
  w: RefundWorld,
  session: Session | null,
  id: string,
  o: { headers?: Record<string, string> } = {},
): Promise<Response> {
  return call(w.cancel.POST as Handler, {
    url: `/api/refunds/${id}/cancel`,
    method: 'POST',
    body: {},
    session,
    params: { id },
    ...(o.headers === undefined ? {} : { headers: o.headers }),
  });
}

export interface ErrorBody {
  error: { code: string; message: string; support_code?: string };
}
export const errorOf = async (res: Response): Promise<ErrorBody['error']> =>
  ((await res.json()) as ErrorBody).error;

export async function count(app: App, sql: string, params: unknown[] = []): Promise<number> {
  const r = await app.db.query<{ c: string | number }>(sql, params);
  return Number(r.rows[0]?.c ?? 0);
}

export const refundRows = (app: App, unit_id?: string): Promise<number> =>
  unit_id === undefined
    ? count(app, 'SELECT count(*) AS c FROM refund_requests')
    : count(app, 'SELECT count(*) AS c FROM refund_requests WHERE unit_id = $1', [unit_id]);

export const providerCalls = (app: App, operation: string): Promise<number> =>
  count(app, 'SELECT count(*) AS c FROM provider_calls WHERE operation = $1', [operation]);

export const ledgerRefunds = async (app: App, unit_id: string): Promise<number> =>
  count(
    app,
    "SELECT COALESCE(sum(amount_minor), 0) AS c FROM ledger_entries WHERE unit_id = $1 AND kind = 'refund'",
    [unit_id],
  );

export const unitStatus = async (app: App, unit_id: string): Promise<string> =>
  (
    await app.db.query<{ status: string }>('SELECT status FROM order_units WHERE id = $1', [
      unit_id,
    ])
  ).rows[0]!.status;

/** The six invariants as the ops page shows them: [id, ok]. */
export async function invariants(w: RefundWorld): Promise<[string, boolean][]> {
  const snap = await w.app.engine.opsSnapshot({
    kind: 'operator',
    operator_id: 'opr_vikram',
    mfa: true,
  });
  return (snap?.invariants ?? []).map((v) => [v.id, v.ok]);
}
