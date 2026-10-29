// DP-6 test support (docs/specs/mvp-d-dp6-offline-gate.md). Not a test file.
//
// One rig for the MVP-D twins: the real app (createApp, the route handlers, the approved sandbox
// transport behind the real scoped gate, an in-memory or on-disk PGlite database, a real approval row
// shaped like the one D-042 describes) with a FAKE Wire that plays PayPal with the dry-run order model.
// The app runs in sandbox mode with the owner's own merchant id set, so the boot seeding of DP-5 maps
// both fictional publishers to that one id and every create leaves the payee out (D-028, D-041), the
// way the real run will. No byte leaves the process: the production Wire is never built, every key and
// id is synthetic, the PayPal ids are the model's.
//
// Relative imports of apps/web (the web composition is reachable only by path, @umsbx/web exports
// none) are covered by the one named exemption for tests/mvp-d in eslint.config.mjs.
import { systemClock } from '@umsbx/runtime';
import type { Actor, DomainConfig, OutboundRequest } from '@umsbx/contracts';
import type { Wire, WireRequest, WireResult } from '@umsbx/transport';
import { createApp, installApp } from '../../apps/web/composition.server';
import type { App } from '../../apps/web/composition.server';
import { createDryRunModel } from '../../apps/web/src/server/dryrun-model';
import type { DryRunModel } from '../../apps/web/src/server/dryrun-model';
import { PASSCODE, call, signIn, testEnv } from '../../apps/web/src/support';
import type { Session } from '../../apps/web/src/support';
import {
  CONSENT,
  HARBOUR_FEES,
  HARBOUR_FERRY,
  HARBOUR_KNOTS,
  HARBOUR_TIDE,
  NORTH_ALLOTMENT,
  QUAY_MARKET,
  QUAY_WALK,
  proposalFor,
} from '../../apps/web/src/composite-support';
import type { Offer } from '../../apps/web/src/composite-support';

export {
  CONSENT,
  HARBOUR_FEES,
  HARBOUR_FERRY,
  HARBOUR_KNOTS,
  HARBOUR_TIDE,
  NORTH_ALLOTMENT,
  PASSCODE,
  QUAY_MARKET,
  QUAY_WALK,
  call,
  proposalFor,
};
export type { Offer, Session };

// ---------------------------------------------------------------------------------------------
// Fixed, obviously fake values.
// ---------------------------------------------------------------------------------------------
export const APPROVAL_REF = 'DL-2026-10-29-dp6';
/** The owner's sandbox Business account, as a made-up id: both publishers are paid into it (D-041). */
export const OWNER_MERCHANT = 'SBXDPSIXOWN01';
export const FAKE_ID = ['placeholder', 'client', 'id'].join('-');
export const FAKE_SECRET = ['placeholder', 'client', 'secret'].join('-');
export const FAKE_TOKEN = ['dp6', 'tok', 'c0ffee'].join('-');

/**
 * The operations a D-042 row lists for a sitting with no real composite refund and no hosted webhook:
 * the five MVP-B operations, and neither `verify_webhook_postback`, `fetch_webhook_cert`,
 * `refund_capture` nor `get_refund`.
 */
export const D042_OPERATIONS = [
  'oauth_token',
  'create_order',
  'get_order',
  'capture_order',
  'get_capture',
] as const;
/** The calls per day the owner steps ask for (MVPD-OWNER-STEPS.md, Prerequisite 4 and Step 2). */
export const D042_MAX_CALLS = 60;
/** The cap per PayPal order, in minor units (D-042: the pack total is bounded only by twice this). */
export const D042_CAP_MINOR = 2000;
/** Calls a happy two-publisher pack uses (overview section 3): 1 token, 2 creates, 7 reads, 2 captures. */
export const HAPPY_PACK_CALLS = 12;

// ---------------------------------------------------------------------------------------------
// The fake Wire: PayPal, played by the dry-run order model.
// ---------------------------------------------------------------------------------------------
export interface Played {
  method: string;
  path: string;
  operation: string;
  /** the PayPal order id in the path, when there is one */
  po: string | null;
}

export interface WireOptions {
  /**
   * After the nth capture (1-based, in the order captures are played) completed at the model, every
   * read of that PayPal order is played under this scenario, so a unit that matched before the capture
   * can mismatch after it (D-05).
   */
  after_capture?: Record<number, string>;
  /** Runs after the model answered a request and before the answer returns (a kill switch, a crash). */
  after?: (p: Played, n: number) => Promise<void> | void;
}

export function paypalWire(
  model: DryRunModel,
  o: WireOptions = {},
): { wire: Wire; played: Played[]; sent: WireRequest[]; captured: string[] } {
  const played: Played[] = [];
  const sent: WireRequest[] = [];
  const captured: string[] = [];
  const reply = (status: number, body: unknown): WireResult => ({
    kind: 'response',
    status,
    headers: { 'content-type': 'application/json', 'paypal-debug-id': `dp6dbg${played.length}` },
    body: JSON.stringify(body),
  });
  const wire: Wire = {
    async request(r: WireRequest): Promise<WireResult> {
      sent.push(structuredClone(r));
      const path = new URL(r.url).pathname;
      if (r.method === 'POST' && path === '/v1/oauth2/token') {
        played.push({ method: r.method, path, operation: 'oauth_token', po: null });
        return reply(200, { access_token: FAKE_TOKEN, token_type: 'Bearer', expires_in: 32400 });
      }
      const m = /^\/v2\/checkout\/orders\/([^/]+)(\/capture)?$/.exec(path);
      const operation =
        r.method === 'POST' && path === '/v2/checkout/orders'
          ? 'create_order'
          : r.method === 'GET' && m !== null && m[2] === undefined
            ? 'get_order'
            : r.method === 'POST' && m !== null && m[2] !== undefined
              ? 'capture_order'
              : r.method === 'GET' && path.startsWith('/v2/payments/captures/')
                ? 'get_capture'
                : r.method === 'POST' && /^\/v2\/payments\/captures\/[^/]+\/refund$/.test(path)
                  ? 'refund_capture'
                  : r.method === 'GET' && path.startsWith('/v2/payments/refunds/')
                    ? 'get_refund'
                    : 'unknown';
      const entry: Played = { method: r.method, path, operation, po: m?.[1] ?? null };
      played.push(entry);
      if (operation === 'unknown') return reply(404, { name: 'RESOURCE_NOT_FOUND' });
      // A read of a PayPal order whose nth capture is behind us can be played under another scenario.
      const nth = entry.po === null ? -1 : captured.indexOf(entry.po) + 1;
      const scenario =
        operation === 'get_order' && nth > 0 ? (o.after_capture?.[nth] ?? null) : null;
      const out = model.send({
        operation,
        method: r.method,
        path,
        headers: r.headers,
        body: r.body,
        order_ref: null,
        amount_minor: null,
        scenario,
      } as OutboundRequest);
      if (operation === 'capture_order' && entry.po !== null && out.kind === 'response') {
        if (out.status >= 200 && out.status < 300 && !captured.includes(entry.po)) {
          captured.push(entry.po);
        }
      }
      await o.after?.(entry, played.length);
      if (out.kind === 'timeout') return { kind: 'error', error: 'timeout' };
      if (out.kind !== 'response') return { kind: 'error', error: 'other' };
      return { kind: 'response', status: out.status, headers: out.headers, body: out.body };
    },
  };
  return { wire, played, sent, captured };
}

// ---------------------------------------------------------------------------------------------
// The rig.
// ---------------------------------------------------------------------------------------------
export interface DRig {
  app: App;
  lines: string[];
  model: DryRunModel;
  played: Played[];
  /** every request the fake Wire saw */
  sent: WireRequest[];
  A: Actor;
  B: Actor;
  SA: Session;
  SB: Session;
  routes: {
    approvals: typeof import('../../apps/web/src/app/api/approvals/route');
    orders: typeof import('../../apps/web/src/app/api/orders/route');
    checkout: typeof import('../../apps/web/src/app/api/orders/[ref]/checkout/route');
    library: typeof import('../../apps/web/src/app/api/library/route');
    receipts: typeof import('../../apps/web/src/app/api/receipts/[order]/route');
    cases: typeof import('../../apps/web/src/app/api/cases/route');
  };
  ops(): string[];
  /** Number of Wire requests of one operation. */
  calls(operation: string): number;
  count(sql: string, params?: unknown[]): Promise<number>;
  rows<T>(sql: string, params?: unknown[]): Promise<T[]>;
  /** The switch the ops Stop button turns off, set directly (turning it on is `safety:resume`). */
  switchOutbound(on: boolean): Promise<void>;
  close(): Promise<void>;
}

export interface RigOptions {
  /** extra environment values */
  env?: Record<string, string>;
  /** domain config overrides (pack window) */
  domain?: Partial<DomainConfig>;
  wire?: WireOptions;
  /** a model that outlives the app (a restart on the same disk keeps PayPal's side of the story) */
  model?: DryRunModel;
  max_calls?: number;
  /** the approval row's operations (default: D042_OPERATIONS; the refund twin adds the two refund ones) */
  operations?: readonly string[];
  /** a disk folder for the database (a restart on the same disk); default: in memory */
  disk?: string;
}

export function newModel(): DryRunModel {
  return createDryRunModel(systemClock(), { own_merchant_id: OWNER_MERCHANT });
}

export async function bootDRig(o: RigOptions = {}): Promise<DRig> {
  const lines: string[] = [];
  const model = o.model ?? newModel();
  const pw = paypalWire(model, o.wire);
  const env = await testEnv({
    UMS_MODE: 'sandbox',
    UMS_PAYPAL_CONNECT: 'on',
    UMS_OUTBOUND_APPROVAL_REF: APPROVAL_REF,
    UMS_OUTBOUND_SCOPE: 'mvp_c_refunds',
    UMS_OWN_MERCHANT_ID: OWNER_MERCHANT,
    ...(o.disk === undefined ? {} : { UMS_DB: 'pglite-disk', UMS_PGLITE_DIR: o.disk }),
    PAYPAL_CLIENT_ID: FAKE_ID,
    PAYPAL_CLIENT_SECRET: FAKE_SECRET,
    ...(o.env ?? {}),
  });
  const app = createApp(env, {
    switch_cache_ms: 0,
    log_sink: (l) => lines.push(l),
    test_wire: pw.wire,
    ...(o.domain === undefined ? {} : { test_domain: o.domain }),
  });
  installApp(app);
  await app.ready();
  const at = systemClock().now().toISOString();
  // The approval row the owner would insert with `safety:approve`, in this database only. A restart on
  // the same disk finds it again.
  const have = await app.db.query<{ c: string }>(
    'SELECT count(*) AS c FROM outbound_approvals WHERE approval_ref = $1',
    [APPROVAL_REF],
  );
  if (Number(have.rows[0]?.c) === 0) {
    await app.db.query(
      `INSERT INTO outbound_approvals (id, approval_ref, scope, operations, max_amount_minor, max_calls_per_day, valid_until, approved_by, created_at, updated_at)
       VALUES ('oap_dp6_0000000000000001', $1, 'mvp_c_refunds', $2, $3, $4, '2999-01-01T00:00:00Z', 'dp6-test', $5, $5)`,
      [
        APPROVAL_REF,
        [...(o.operations ?? D042_OPERATIONS)],
        D042_CAP_MINOR,
        o.max_calls ?? D042_MAX_CALLS,
        at,
      ],
    );
    await app.db.query(`UPDATE safety_switches SET "on" = true WHERE name = 'paypal_outbound'`);
  }
  const buyerOf = async (who: 'a' | 'b'): Promise<Actor> => {
    const row = await app.db.query<{ id: string }>(
      'SELECT id FROM buyers WHERE auth_subject = $1',
      [`persona:buyer-${who}`],
    );
    return { kind: 'buyer', buyer_id: row.rows[0]?.id ?? '' };
  };
  const session = await import('../../apps/web/src/app/api/session/route');
  const SA = (await signIn(session.POST, 'buyer-a'))!;
  const SB = (await signIn(session.POST, 'buyer-b'))!;
  const routes = {
    approvals: await import('../../apps/web/src/app/api/approvals/route'),
    orders: await import('../../apps/web/src/app/api/orders/route'),
    checkout: await import('../../apps/web/src/app/api/orders/[ref]/checkout/route'),
    library: await import('../../apps/web/src/app/api/library/route'),
    receipts: await import('../../apps/web/src/app/api/receipts/[order]/route'),
    cases: await import('../../apps/web/src/app/api/cases/route'),
  };
  return {
    app,
    lines,
    model,
    played: pw.played,
    sent: pw.sent,
    A: await buyerOf('a'),
    B: await buyerOf('b'),
    SA,
    SB,
    routes,
    ops: () => pw.played.map((p) => p.operation),
    calls: (operation) => pw.played.filter((p) => p.operation === operation).length,
    count: async (sql, params = []) =>
      Number((await app.db.query<{ c: string }>(sql, params)).rows[0]?.c),
    rows: async <T>(sql: string, params: unknown[] = []) =>
      (await app.db.query<T>(sql, params)).rows,
    switchOutbound: async (on) => {
      await app.db.query(`UPDATE safety_switches SET "on" = $1 WHERE name = 'paypal_outbound'`, [
        on,
      ]);
    },
    close: () => app.close(),
  };
}

// ---------------------------------------------------------------------------------------------
// A buyer's pack, through the real routes and the engine, and the fake PayPal.
// ---------------------------------------------------------------------------------------------
type Handler = (
  req: Request,
  ctx?: { params: Promise<Record<string, string>> },
) => Promise<Response>;

export interface Placed {
  approval_id: string;
  order_id: string;
  order_ref: string;
  /** the PayPal order ids by position (1..N) */
  pos: string[];
}

let nextKey = 1;

/** The approval route, as the buyer's browser calls it: a stored proposal over the offers, with consent. */
export async function postApproval(
  rig: DRig,
  who: 'A' | 'B',
  offers: readonly Offer[],
): Promise<{ status: number; body: Record<string, unknown> }> {
  const p = await proposalFor(rig.app, who === 'A' ? rig.A : rig.B, offers);
  const res = await call(rig.routes.approvals.POST as Handler, {
    url: '/api/approvals',
    method: 'POST',
    session: who === 'A' ? rig.SA : rig.SB,
    body: { proposal_id: p.proposal_id, offer_ids: p.offer_ids, consent: CONSENT },
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

export async function postOrder(
  rig: DRig,
  who: 'A' | 'B',
  approval: { approval_id: string; token: string },
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await call(rig.routes.orders.POST as Handler, {
    url: '/api/orders',
    method: 'POST',
    session: who === 'A' ? rig.SA : rig.SB,
    headers: { 'idempotency-key': `dp6-key-${nextKey++}-order` },
    body: { approval_id: approval.approval_id, token: approval.token },
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

export async function postCheckout(
  rig: DRig,
  who: 'A' | 'B',
  order_ref: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await call(rig.routes.checkout.POST as Handler, {
    url: `/api/orders/${order_ref}/checkout`,
    method: 'POST',
    session: who === 'A' ? rig.SA : rig.SB,
    params: { ref: order_ref },
    body: {},
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** Approval (engine facade), then order and eager checkout (both PayPal orders created) through the two routes. */
export async function startPack(
  rig: DRig,
  who: 'A' | 'B',
  offers: readonly Offer[],
): Promise<Placed> {
  const g = await rig.app.engine.requestApproval({
    actor: who === 'A' ? rig.A : rig.B,
    selection: await selectionFor(rig, who, offers),
    consent: CONSENT,
  });
  if (!g.ok) throw new Error(`approval refused: ${g.error.code}`);
  const placed = await postOrder(rig, who, g.value);
  if (placed.status !== 201) throw new Error(`order refused: ${placed.status}`);
  const order_ref = String(placed.body['order_ref']);
  const order_id = String(placed.body['order_id']);
  const co = await postCheckout(rig, who, order_ref);
  if (co.status !== 200) throw new Error(`checkout refused: ${co.status}`);
  const pos = await rig.rows<{ provider_order_id: string }>(
    'SELECT provider_order_id FROM provider_orders WHERE order_id = $1 ORDER BY position',
    [order_id],
  );
  return {
    approval_id: g.value.approval_id,
    order_id,
    order_ref,
    pos: pos.map((p) => p.provider_order_id),
  };
}

async function selectionFor(rig: DRig, who: 'A' | 'B', offers: readonly Offer[]) {
  const p = await proposalFor(rig.app, who === 'A' ? rig.A : rig.B, offers);
  return { kind: 'proposal' as const, proposal_id: p.proposal_id, offer_ids: p.offer_ids };
}

/**
 * The buyer approves one PayPal order at the pretend PayPal (the model) with its own scenario and
 * comes back. Each pretend PayPal order keeps the scenario it was approved with.
 */
export async function approveStep(
  rig: DRig,
  who: 'A' | 'B',
  placed: Placed,
  position: number,
  scenario: string,
) {
  const id = placed.pos[position - 1];
  if (id === undefined) throw new Error(`no PayPal order at position ${position}`);
  if (!rig.model.approve(id, scenario)) throw new Error('the model refused approve');
  return rig.app.engine.payments.onBuyerReturn({
    order_ref: placed.order_ref,
    actor: who === 'A' ? rig.A : rig.B,
    scenario: null,
  });
}

/** Start a pack and approve every PayPal order in position order with the given scenarios. */
export async function runPack(
  rig: DRig,
  who: 'A' | 'B',
  offers: readonly Offer[],
  scenarios: readonly string[],
) {
  const placed = await startPack(rig, who, offers);
  const returns: Awaited<ReturnType<typeof approveStep>>[] = [];
  for (const [i, scenario] of scenarios.entries()) {
    returns.push(await approveStep(rig, who, placed, i + 1, scenario));
  }
  return { ...placed, returns };
}

export const orderStatus = async (rig: DRig, order_id: string): Promise<string | undefined> =>
  (await rig.rows<{ status: string }>('SELECT status FROM orders WHERE id = $1', [order_id]))[0]
    ?.status;

export const poStates = async (rig: DRig, order_id: string): Promise<string[]> =>
  (
    await rig.rows<{ state: string }>(
      'SELECT state FROM provider_orders WHERE order_id = $1 ORDER BY position',
      [order_id],
    )
  ).map((r) => r.state);

/** Every table a refusal must not touch: row count and a hash of the rows' text. */
export const MONEY_TABLES = [
  'orders',
  'order_units',
  'provider_orders',
  'operations',
  'provider_calls',
  'ledger_entries',
  'receipts',
  'entitlements',
  'recovery_cases',
  'alerts',
  'approvals',
  'quotes',
  'proposals',
] as const;

export async function fingerprint(rig: DRig): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const t of MONEY_TABLES) {
    const r = await rig.rows<{ n: string | number; h: string }>(
      `SELECT count(*) AS n, md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) AS h FROM ${t} x`,
    );
    out[t] = `${String(r[0]?.n)}:${r[0]?.h}`;
  }
  return out;
}

/** The library as the buyer's browser fetches it. */
export async function libraryOf(
  rig: DRig,
  who: 'A' | 'B',
): Promise<
  {
    entitlement_id: string;
    title: string;
    publisher: string;
    can_open: boolean;
    status_text: string;
  }[]
> {
  const res = await call(rig.routes.library.GET as Handler, {
    url: '/api/library',
    session: who === 'A' ? rig.SA : rig.SB,
  });
  return ((await res.json()) as { items: never[] }).items;
}

export async function waitFor<T>(
  f: () => Promise<T | undefined | false>,
  what: string,
  ms = 30_000,
): Promise<T> {
  const deadline = systemClock().now().getTime() + ms;
  for (;;) {
    const v = await f();
    if (v !== undefined && v !== false) return v;
    if (systemClock().now().getTime() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}
