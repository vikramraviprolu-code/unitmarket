// CO-G test support (docs/specs/mvp-c-offline-gate.md). Not a test file.
//
// One rig for the MVP-C twins that need a sandbox-mode app: the real app (createApp, the route
// handlers, the approved sandbox transport behind a real scoped gate over an in-memory database with a
// real approval row) with a FAKE Wire that plays PayPal with the dry-run order model, a webhook
// certificate source injected for the tests (a key pair made when the module loads), and operators who
// sign in through the session route with a TOTP code made here. No byte leaves the process: the
// production Wire is never built, no test passes the production Wire token, every key and id is a
// synthetic value made at run time or a public test vector.
//
// Relative imports of apps/web (the web composition is reachable only by path, @umsbx/web exports
// none) are covered by the one named exemption for tests/mvp-c in eslint.config.mjs.
import { createHmac } from 'node:crypto';
import { systemClock } from '@umsbx/runtime';
import type { Actor, Database, OutboundRequest } from '@umsbx/contracts';
import type { Wire, WireRequest, WireResult } from '@umsbx/transport';
import { createApp, installApp } from '../../apps/web/composition.server';
import type { App } from '../../apps/web/composition.server';
import { createDryRunModel } from '../../apps/web/src/server/dryrun-model';
import type { DryRunModel } from '../../apps/web/src/server/dryrun-model';
import { PASSCODE, call, testEnv } from '../../apps/web/src/support';
import type { Session } from '../../apps/web/src/support';
import { certsFor, delivery, eventBody } from '../../apps/web/src/webhook-support';
import type { Delivery, FakeCerts } from '../../apps/web/src/webhook-support';

export { PASSCODE, call, certsFor, delivery, eventBody };
export type { Delivery, FakeCerts, Session };

// ---------------------------------------------------------------------------------------------
// Fixed, obviously fake values.
// ---------------------------------------------------------------------------------------------
export const APPROVAL_REF = 'DL-2026-10-25-cog';
export const FAKE_ID = ['placeholder', 'client', 'id'].join('-');
export const FAKE_SECRET = ['placeholder', 'client', 'secret'].join('-');
export const FAKE_TOKEN = ['cog', 'tok', 'c0ffee'].join('-');
/** The public RFC 6238 test key, and a second synthetic one. Not credentials. */
export const VIKRAM_B32 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
export const SAKTHI_B32 = 'IFBEGRCFIZDUQSKKJNGE2TSPKBIVEU2U';
export const TOTP_KEYS = `vikram:${VIKRAM_B32},sakthi:${SAKTHI_B32}`;

// RFC 6238 once more, here, so no test trusts the code under test to make its own codes.
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function totpCode(b32: string, atMs: number, delta = 0): string {
  const bits = [...b32].map((c) => B32.indexOf(c).toString(2).padStart(5, '0')).join('');
  const bytes = (bits.match(/.{8}/g) ?? []).map((b) => parseInt(b, 2));
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(Math.floor(atMs / 30_000) + delta));
  const mac = createHmac('sha1', Buffer.from(bytes)).update(msg).digest();
  const o = (mac[19] ?? 0) & 15;
  return String((mac.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

/** The transmission time of a delivery made now, in PayPal's format (whole seconds, Z). */
export const nowTransmissionTime = (): string =>
  new Date(systemClock().now().getTime() - 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');

// ---------------------------------------------------------------------------------------------
// The fake Wire: PayPal, played by the dry-run order model.
// ---------------------------------------------------------------------------------------------
export interface Played {
  method: string;
  path: string;
  operation: string;
}

type Hook = (p: Played, n: number) => Promise<WireResult | undefined> | WireResult | undefined;

export function paypalWire(
  model: DryRunModel,
  hook?: Hook,
): { wire: Wire; played: Played[]; sent: WireRequest[] } {
  const played: Played[] = [];
  const sent: WireRequest[] = [];
  const reply = (status: number, body: unknown): WireResult => ({
    kind: 'response',
    status,
    headers: { 'content-type': 'application/json', 'paypal-debug-id': `cogdbg${played.length}` },
    body: JSON.stringify(body),
  });
  const wire: Wire = {
    async request(r: WireRequest): Promise<WireResult> {
      sent.push(structuredClone(r));
      const path = new URL(r.url).pathname;
      if (r.method === 'POST' && path === '/v1/oauth2/token') {
        played.push({ method: r.method, path, operation: 'oauth_token' });
        return reply(200, { access_token: FAKE_TOKEN, token_type: 'Bearer', expires_in: 32400 });
      }
      const operation =
        r.method === 'POST' && path === '/v2/checkout/orders'
          ? 'create_order'
          : r.method === 'GET' && path.startsWith('/v2/checkout/orders/')
            ? 'get_order'
            : r.method === 'POST' && /^\/v2\/checkout\/orders\/[^/]+\/capture$/.test(path)
              ? 'capture_order'
              : r.method === 'GET' && path.startsWith('/v2/payments/captures/')
                ? 'get_capture'
                : r.method === 'POST' && /^\/v2\/payments\/captures\/[^/]+\/refund$/.test(path)
                  ? 'refund_capture'
                  : r.method === 'GET' && path.startsWith('/v2/payments/refunds/')
                    ? 'get_refund'
                    : 'unknown';
      const entry = { method: r.method, path, operation };
      played.push(entry);
      if (hook !== undefined) {
        const early = await hook(entry, played.length);
        if (early !== undefined) return early;
      }
      if (operation === 'unknown') return reply(404, { name: 'RESOURCE_NOT_FOUND' });
      const out = model.send({
        operation,
        method: r.method,
        path,
        headers: r.headers,
        body: r.body,
        order_ref: null,
        amount_minor: null,
        scenario: null,
      } as OutboundRequest);
      if (out.kind === 'timeout') return { kind: 'error', error: 'timeout' };
      if (out.kind !== 'response') return { kind: 'error', error: 'other' };
      return { kind: 'response', status: out.status, headers: out.headers, body: out.body };
    },
  };
  return { wire, played, sent };
}

// ---------------------------------------------------------------------------------------------
// The rig.
// ---------------------------------------------------------------------------------------------
export interface CRig {
  app: App;
  lines: string[];
  model: DryRunModel;
  played: Played[];
  /** every request the fake Wire saw */
  sent: WireRequest[];
  certs: FakeCerts;
  buyer: Actor;
  buyerB: Actor;
  routes: {
    session: typeof import('../../apps/web/src/app/api/session/route');
    webhook: typeof import('../../apps/web/src/app/api/webhooks/paypal/route');
    refunds: typeof import('../../apps/web/src/app/api/refunds/route');
    library: typeof import('../../apps/web/src/app/api/library/route');
    link: typeof import('../../apps/web/src/app/api/library/[id]/link/route');
    receipts: typeof import('../../apps/web/src/app/api/receipts/[order]/route');
  };
  ops(): string[];
  count(sql: string, params?: unknown[]): Promise<number>;
  /** POST a delivery to the webhook route; `ip` is the right-most X-Forwarded-For entry. */
  post(d: Delivery, ip?: string): Promise<Response>;
  /** Sign an operator in through the session route with a code made here. */
  operator(name: 'vikram' | 'sakthi', atMs?: number): Promise<Session>;
  close(): Promise<void>;
}

export interface RigOptions {
  /** a hook on every Wire request; a returned result replaces the model's answer */
  hook?: Hook;
  /** extra environment values */
  env?: Record<string, string>;
  /** the injected certificate source (default: one that trusts the module's signer) */
  certs?: FakeCerts;
  max_calls?: number;
}

const OPS = [
  'oauth_token',
  'create_order',
  'get_order',
  'capture_order',
  'get_capture',
  'refund_capture',
  'get_refund',
] as const;

export async function bootRig(o: RigOptions = {}): Promise<CRig> {
  const lines: string[] = [];
  const model = createDryRunModel(systemClock(), { own_merchant_id: null });
  const pw = paypalWire(model, o.hook);
  const certs = o.certs ?? certsFor();
  const env = await testEnv({
    UMS_MODE: 'sandbox',
    UMS_PAYPAL_CONNECT: 'on',
    UMS_OUTBOUND_APPROVAL_REF: APPROVAL_REF,
    UMS_OUTBOUND_SCOPE: 'mvp_c_refunds',
    PAYPAL_CLIENT_ID: FAKE_ID,
    PAYPAL_CLIENT_SECRET: FAKE_SECRET,
    PAYPAL_WEBHOOK_ID: 'SYN-WEBHOOK-ID-0001',
    UMS_TRUSTED_PROXIES: '1',
    UMS_OPERATOR_TOTP_KEYS: TOTP_KEYS,
    ...(o.env ?? {}),
  });
  const app = createApp(env, {
    switch_cache_ms: 0,
    log_sink: (l) => lines.push(l),
    test_wire: pw.wire,
    webhook_certificates: certs,
  });
  installApp(app);
  await app.ready();
  const at = systemClock().now().toISOString();
  // The approval row the owner would insert with `safety:approve`, in this in-memory database only.
  await app.db.query(
    `INSERT INTO outbound_approvals (id, approval_ref, scope, operations, max_amount_minor, max_calls_per_day, valid_until, approved_by, created_at, updated_at)
     VALUES ('oap_cog_0000000000000001', $1, 'mvp_c_refunds', $2, 2000, $3, '2999-01-01T00:00:00Z', 'cog-test', $4, $4)`,
    [APPROVAL_REF, [...OPS], o.max_calls ?? 300, at],
  );
  await app.db.query(`UPDATE safety_switches SET "on" = true WHERE name = 'paypal_outbound'`);
  await app.db.query(
    `UPDATE publishers SET paypal_merchant_id = 'SBXM' || upper(left(md5(slug), 9)), payee_verified_at = $1`,
    [at],
  );
  const row = await app.db.query<{ id: string }>(
    `SELECT id FROM buyers WHERE auth_subject = 'persona:buyer-a'`,
  );
  const buyer: Actor = { kind: 'buyer', buyer_id: row.rows[0]?.id ?? '' };
  const rowB = await app.db.query<{ id: string }>(
    `SELECT id FROM buyers WHERE auth_subject = 'persona:buyer-b'`,
  );
  const buyerB: Actor = { kind: 'buyer', buyer_id: rowB.rows[0]?.id ?? '' };
  const routes = {
    session: await import('../../apps/web/src/app/api/session/route'),
    webhook: await import('../../apps/web/src/app/api/webhooks/paypal/route'),
    refunds: await import('../../apps/web/src/app/api/refunds/route'),
    library: await import('../../apps/web/src/app/api/library/route'),
    link: await import('../../apps/web/src/app/api/library/[id]/link/route'),
    receipts: await import('../../apps/web/src/app/api/receipts/[order]/route'),
  };
  return {
    app,
    lines,
    model,
    played: pw.played,
    sent: pw.sent,
    certs,
    buyer,
    buyerB,
    routes,
    ops: () => pw.played.map((p) => p.operation),
    async count(sql, params = []) {
      return Number((await app.db.query<{ c: string }>(sql, params)).rows[0]?.c);
    },
    post(d, ip = '203.0.113.1') {
      return routes.webhook.POST(
        new Request('http://localhost:3000/api/webhooks/paypal', {
          method: 'POST',
          headers: {
            ...d.headers,
            'x-forwarded-for': `198.18.0.1, ${ip}`,
            'content-type': 'application/json',
          },
          body: d.raw_body,
        }),
        { params: Promise.resolve({}) },
      );
    },
    async operator(name, atMs = systemClock().now().getTime()) {
      const key = name === 'vikram' ? VIKRAM_B32 : SAKTHI_B32;
      const res = await call(routes.session.POST, {
        url: '/api/session',
        method: 'POST',
        body: {
          persona: 'operator',
          passcode: PASSCODE,
          operator: name,
          code: totpCode(key, atMs),
        },
      });
      if (res.status !== 200) throw new Error(`operator sign-in refused: ${res.status}`);
      const body = (await res.json()) as { csrf_token: string; mfa?: boolean };
      if (body.mfa !== true) throw new Error('operator sign-in gave no second factor');
      return {
        cookie: (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '',
        csrf: body.csrf_token,
      };
    },
    close: () => app.close(),
  };
}

// ---------------------------------------------------------------------------------------------
// A buyer's purchase, through the real engine and the fake Wire.
// ---------------------------------------------------------------------------------------------
export interface Bought {
  order_ref: string;
  order_id: string;
  unit_id: string;
  entitlement_id: string;
  provider_order_id: string;
  amount_minor: number;
}

export async function placeAndCheckout(
  rig: CRig,
  o: { offer: string; option: 'keep_retrieve' | 'online_read'; scenario?: string; who?: 'A' | 'B' },
): Promise<{ order_ref: string; order_id: string; provider_order_id: string }> {
  const { app } = rig;
  const actor = o.who === 'B' ? rig.buyerB : rig.buyer;
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
  if (!g.ok) throw new Error(`no approval for ${o.offer}`);
  const placed = await app.engine.payments.placeOrder({
    approval_id: g.value.approval_id,
    token: g.value.token,
    actor,
  });
  if (!placed.ok) throw new Error(`place failed: ${placed.error.code}`);
  const co = await app.engine.payments.beginCheckout({ order_id: placed.value.order_id, actor });
  if (!co.ok) throw new Error(`checkout failed: ${co.error.code}`);
  const pid = (
    await app.db.query<{ provider_order_id: string }>(
      'SELECT provider_order_id FROM provider_orders WHERE order_id = $1',
      [placed.value.order_id],
    )
  ).rows[0]?.provider_order_id;
  if (pid === undefined) throw new Error('no provider order');
  if (!rig.model.approve(pid, o.scenario ?? 'happy')) throw new Error('the model refused approve');
  return {
    order_ref: placed.value.order_ref,
    order_id: placed.value.order_id,
    provider_order_id: pid,
  };
}

/** Quote, approval, order, checkout, approval at the pretend PayPal and the buyer's return. */
export async function buy(
  rig: CRig,
  o: { offer: string; option: 'keep_retrieve' | 'online_read'; scenario?: string; who?: 'A' | 'B' },
): Promise<Bought> {
  const placed = await placeAndCheckout(rig, o);
  await rig.app.engine.payments.onBuyerReturn({
    order_ref: placed.order_ref,
    actor: o.who === 'B' ? rig.buyerB : rig.buyer,
  });
  const u = (
    await rig.app.db.query<{ id: string; amount_minor: string | number }>(
      'SELECT id, amount_minor FROM order_units WHERE order_id = $1',
      [placed.order_id],
    )
  ).rows[0];
  const e = (
    await rig.app.db.query<{ id: string }>('SELECT id FROM entitlements WHERE unit_id = $1', [
      u?.id ?? '',
    ])
  ).rows[0];
  return {
    ...placed,
    unit_id: u?.id ?? '',
    entitlement_id: e?.id ?? '',
    amount_minor: Number(u?.amount_minor ?? 0),
  };
}

export const orderStatus = async (rig: CRig, order_id: string): Promise<string | undefined> =>
  (
    await rig.app.db.query<{ status: string }>('SELECT status FROM orders WHERE id = $1', [
      order_id,
    ])
  ).rows[0]?.status;

// ---------------------------------------------------------------------------------------------
// "No state change": a fingerprint of every table a webhook or a refusal must not touch.
// ---------------------------------------------------------------------------------------------
export const STATE_TABLES = [
  'orders',
  'order_units',
  'provider_orders',
  'operations',
  'provider_calls',
  'webhook_events',
  'refund_requests',
  'ledger_entries',
  'receipts',
  'entitlements',
  'access_windows',
  'access_events',
  'links',
  'recovery_cases',
  'alerts',
] as const;

/** Row count and a hash of every row's text, per table. Audit rows, sessions and limiter buckets are left out on purpose. */
export async function fingerprint(db: Database): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const t of STATE_TABLES) {
    const r = await db.query<{ n: string | number; h: string }>(
      `SELECT count(*) AS n, md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) AS h FROM ${t} x`,
    );
    out[t] = `${String(r.rows[0]?.n)}:${r.rows[0]?.h}`;
  }
  return out;
}

export const auditCount = async (db: Database, action: string): Promise<number> =>
  Number(
    (
      await db.query<{ c: string }>('SELECT count(*) AS c FROM audit_log WHERE action = $1', [
        action,
      ])
    ).rows[0]?.c,
  );

/** The `outcome` of every webhook.delivery log line, in order. */
export const outcomes = (lines: string[]): string[] =>
  lines
    .map((l) => JSON.parse(l) as { msg?: string; outcome?: string })
    .filter((l) => l.msg === 'webhook.delivery')
    .map((l) => l.outcome ?? '');

export type { WireRequest };

// ---------------------------------------------------------------------------------------------
// Buyer and operator calls through the route handlers.
// ---------------------------------------------------------------------------------------------
type Handler = (
  req: Request,
  ctx?: { params: Promise<Record<string, string>> },
) => Promise<Response>;

let nextKey = 1;
/** POST /api/refunds as the given operator session. */
export function postRefund(
  rig: CRig,
  session: Session | null,
  body: { unit_id: string; amount_minor: number | null; reason: string },
  key: string | null = `cog-key-${nextKey++}-refund`,
): Promise<Response> {
  return call(rig.routes.refunds.POST as Handler, {
    url: '/api/refunds',
    method: 'POST',
    body,
    session,
    headers: key === null ? {} : { 'idempotency-key': key },
  });
}

export interface LibraryItem {
  entitlement_id: string;
  status_text: string;
  can_open: boolean;
  access: string;
  refunded: boolean;
  receipt_versions: number[];
}
export async function libraryOf(rig: CRig, s: Session): Promise<LibraryItem[]> {
  const res = await call(rig.routes.library.GET as Handler, { url: '/api/library', session: s });
  return ((await res.json()) as { items: LibraryItem[] }).items;
}

export function openLink(rig: CRig, s: Session, entitlement_id: string): Promise<Response> {
  return call(rig.routes.link.POST as Handler, {
    url: `/api/library/${entitlement_id}/link`,
    method: 'POST',
    body: {},
    session: s,
    params: { id: entitlement_id },
  });
}

export async function receiptOf(
  rig: CRig,
  s: Session,
  order_id: string,
): Promise<{
  status: number;
  body: { version: number; refunds: Array<{ refund_id: string; amount: { minor: number } }> };
}> {
  const res = await call(rig.routes.receipts.GET as Handler, {
    url: `/api/receipts/${order_id}`,
    session: s,
    params: { order: order_id },
  });
  return { status: res.status, body: (await res.json()) as never };
}
