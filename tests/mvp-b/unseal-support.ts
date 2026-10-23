// BU-2 test support: a rig around buildOutbound with a real in-memory database, a real approval row,
// a counting fake Wire and a memory logger. Nothing here reaches a network: the Wire is a fake and
// no test passes the production Wire token. Approval rows are inserted into in-memory test
// databases only. Credentials are obviously fake placeholders built at run time.
import { migrate, openDatabase } from '@umsbx/db';
import { fakeClock, systemClock } from '@umsbx/runtime';
import { createSwitchReader } from '@umsbx/safety';
import { makeSecret } from '@umsbx/config';
import type {
  Actor,
  Clock,
  Database,
  LogEvent,
  Logger,
  OutboundRequest,
  SwitchReader,
} from '@umsbx/contracts';
import type { Wire, WireRequest, WireResult } from '@umsbx/transport';
import { createApp, installApp } from '../../apps/web/composition.server';
import type { App } from '../../apps/web/composition.server';
import { createDryRunModel } from '../../apps/web/src/server/dryrun-model';
import { testEnv } from '../../apps/web/src/support';
import { buildOutbound } from '../../apps/web/src/server/outbound.server';
import type { Outbound, OutboundDeps } from '../../apps/web/src/server/outbound.server';

export const REF = 'DL-2026-10-23-bu2';
export const T0 = '2026-10-23T10:00:00Z';
export const VALID_UNTIL = '2026-10-24T00:00:00Z';
export const FAKE_ID = ['placeholder', 'client', 'id'].join('-');
export const FAKE_SECRET = ['placeholder', 'client', 'secret'].join('-');

export type Scope = 'mvp_b_polling' | 'mvp_c_refunds';
export type TestDb = Database & { close(): Promise<void> };

export interface CountingWire {
  wire: Wire;
  calls: WireRequest[];
}

const ok200 = (): WireResult => ({
  kind: 'response',
  status: 200,
  headers: { 'content-type': 'application/json', 'paypal-debug-id': 'dbgtest0001' },
  body: '{}',
});

export function countingWire(answer?: (r: WireRequest, n: number) => WireResult): CountingWire {
  const calls: WireRequest[] = [];
  const wire: Wire = {
    async request(r) {
      calls.push(structuredClone(r));
      return answer === undefined ? ok200() : answer(r, calls.length);
    },
  };
  return { wire, calls };
}

export function memoryLogger(): Logger & { events: LogEvent[] } {
  const events: LogEvent[] = [];
  const make = (base: LogEvent['fields']): Logger => ({
    log: (e) => void events.push({ ...e, fields: { ...base, ...e.fields } }),
    child: (f) => make({ ...base, ...f }),
  });
  return Object.assign(make({}), { events });
}

export const ALL_OPS = [
  'oauth_token',
  'create_order',
  'get_order',
  'capture_order',
  'get_capture',
] as const;

export interface RigOptions {
  mode?: 'offline' | 'sandbox';
  connect?: boolean;
  ref?: string | null;
  scope?: string;
  /** false: no credentials in config (L5). */
  credentials?: boolean;
  /** false: no approval row (L3). */
  approval?:
    | false
    | {
        scope?: string;
        ops?: readonly string[];
        max_calls?: number;
        max_amount_minor?: number;
        valid_until?: string;
      };
  /** false: the paypal_outbound switch stays off (L4). */
  switch_on?: boolean;
  /** null: the production Wire token (never exercised against a network here). */
  wire?: Wire | null;
  selfcheck?: OutboundDeps['selfcheck'];
  answer?: (r: WireRequest, n: number) => WireResult;
  switches?: SwitchReader;
}

export interface Rig {
  db: TestDb;
  clock: ReturnType<typeof fakeClock>;
  log: ReturnType<typeof memoryLogger>;
  switches: SwitchReader;
  counting: CountingWire;
  outbound: Outbound;
  deps: OutboundDeps;
  /** gate.reserve rows written so far (one per call the gate allowed). */
  reservations(): Promise<number>;
  close(): Promise<void>;
}

export async function insertApproval(
  db: Database,
  o: {
    ref?: string;
    scope?: string;
    ops?: readonly string[];
    max_calls?: number;
    max_amount_minor?: number;
    valid_until?: string;
    id?: string;
  } = {},
): Promise<void> {
  await db.query(
    `INSERT INTO outbound_approvals (id, approval_ref, scope, operations, max_amount_minor, max_calls_per_day, valid_until, approved_by, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'bu2-test',$8,$8)`,
    [
      o.id ?? `oap_bu2_${(o.ref ?? REF).slice(-8)}`,
      o.ref ?? REF,
      o.scope ?? 'mvp_b_polling',
      [...(o.ops ?? ALL_OPS)],
      o.max_amount_minor ?? 5000,
      o.max_calls ?? 100,
      o.valid_until ?? VALID_UNTIL,
      T0,
    ],
  );
}

export async function setOutboundSwitch(db: Database, on: boolean): Promise<void> {
  await db.query(`UPDATE safety_switches SET "on" = $1 WHERE name = 'paypal_outbound'`, [on]);
}

export async function makeRig(o: RigOptions = {}): Promise<Rig> {
  const clock = fakeClock(T0);
  const db = (await openDatabase({ kind: 'pglite-memory' })) as TestDb;
  await migrate(db, clock);
  const scope = o.scope ?? 'mvp_b_polling';
  const ref = o.ref === undefined ? REF : o.ref;
  if (o.approval !== false) await insertApproval(db, { ref: REF, scope, ...(o.approval ?? {}) });
  if (o.switch_on !== false) await setOutboundSwitch(db, true);
  const log = memoryLogger();
  const counting = countingWire(o.answer);
  const switches = o.switches ?? createSwitchReader(db, clock, 0);
  const deps: OutboundDeps = {
    config: {
      mode: o.mode ?? 'sandbox',
      connect: o.connect ?? true,
      outbound_approval_ref: ref,
      outbound_scope: scope as Scope,
      paypal:
        o.credentials === false
          ? null
          : {
              client_id: makeSecret(FAKE_ID),
              client_secret: makeSecret(FAKE_SECRET),
              webhook_id: null,
            },
    },
    db,
    clock: clock as Clock,
    log,
    switches,
    wire: o.wire === undefined ? counting.wire : o.wire,
    ...(o.selfcheck === undefined ? {} : { selfcheck: o.selfcheck }),
  };
  const outbound = buildOutbound(deps);
  return {
    db,
    clock,
    log,
    switches,
    counting,
    outbound,
    deps,
    async reservations() {
      const r = await db.query<{ n: string }>(
        `SELECT count(*) AS n FROM audit_log WHERE action = 'gate.reserve'`,
      );
      return Number(r.rows[0]?.n ?? 0);
    },
    close: () => db.close(),
  };
}

const base: Omit<OutboundRequest, 'operation' | 'method' | 'path' | 'headers' | 'body'> = {
  order_ref: null,
  amount_minor: null,
  scenario: null,
};

export const req = {
  getOrder(id = 'ABC123'): OutboundRequest {
    return {
      ...base,
      operation: 'get_order',
      method: 'GET',
      path: `/v2/checkout/orders/${id}`,
      headers: { authorization: 'Bearer tok-placeholder-1' },
      body: null,
    };
  },
  oauth(): OutboundRequest {
    return {
      ...base,
      operation: 'oauth_token',
      method: 'POST',
      path: '/v1/oauth2/token',
      headers: {
        authorization: 'Basic cGxhY2Vob2xkZXI6cGxhY2Vob2xkZXI=',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    };
  },
  createOrder(
    o: { value?: string; currency?: string; minor?: number; payee?: boolean; pad?: number } = {},
  ): OutboundRequest {
    const unit: Record<string, unknown> = {
      reference_id: 'unit-1',
      amount: { currency_code: o.currency ?? 'USD', value: o.value ?? '1.00' },
    };
    if (o.payee === true) unit['payee'] = { merchant_id: 'SBXMERCHANT01' };
    if (o.pad !== undefined) unit['description'] = 'x'.repeat(o.pad);
    return {
      ...base,
      operation: 'create_order',
      method: 'POST',
      path: '/v2/checkout/orders',
      headers: {
        authorization: 'Bearer tok-placeholder-1',
        'content-type': 'application/json',
        'paypal-request-id': 'umsC-bu2-1',
      },
      body: JSON.stringify({ intent: 'CAPTURE', purchase_units: [unit] }),
      amount_minor: o.minor ?? 100,
    };
  },
  refund(): OutboundRequest {
    return {
      ...base,
      operation: 'refund_capture',
      method: 'POST',
      path: '/v2/payments/captures/CAP123/refund',
      headers: {
        authorization: 'Bearer tok-placeholder-1',
        'content-type': 'application/json',
        'paypal-request-id': 'umsR-bu2-1',
      },
      body: JSON.stringify({ amount: { currency_code: 'USD', value: '1.00' } }),
      amount_minor: 100,
    };
  },
};

/** An environment for createApp in sandbox mode with obviously fake credentials (NODE_ENV test). */
export async function sandboxEnv(
  over: Record<string, string> = {},
): Promise<Record<string, string>> {
  return testEnv({
    UMS_MODE: 'sandbox',
    UMS_PAYPAL_CONNECT: 'on',
    UMS_OUTBOUND_APPROVAL_REF: REF,
    PAYPAL_CLIENT_ID: FAKE_ID,
    PAYPAL_CLIENT_SECRET: FAKE_SECRET,
    ...over,
  });
}

// ---- BU-7 (D-028): createApp in sandbox mode over a fake Wire that plays PayPal with the dry-run order
// model. Adapted from the BU-2 journey test. Ids are obviously fake and built here; no real merchant id
// exists in the repository.
export const OWN = 'SBXOWNMERCH01';
export const OTHER = 'SBXOTHERMERCH2';
export const FAKE_TOKEN = ['bu7', 'tok', 'c0ffee'].join('-');

export interface Played {
  method: string;
  path: string;
  operation: string;
  body: string | null;
}

export interface OwnRig {
  app: App;
  actor: Actor;
  lines: string[];
  played: Played[];
  model: ReturnType<typeof createDryRunModel>;
  ops(): string[];
  placeOrder(): Promise<{ order_ref: string; order_id: string }>;
  providerOrderId(order_id: string): Promise<string>;
  statusRow(order_ref: string): Promise<string | undefined>;
  count(sql: string, params?: unknown[]): Promise<number>;
  close(): Promise<void>;
}

export interface OwnRigOptions {
  /** UMS_OWN_MERCHANT_ID given to the app (null: unset). Default OWN. */
  own?: string | null;
  /** The harbour-ledger merchant id stored after boot. Default: the same as the own id. */
  publisher_payee?: string;
  /** The default payee the order model echoes for a unit with none. Default: the own id. */
  model_payee?: string | null;
  /** Changes a purchase_units array in every order answer before the app sees it. */
  tamper?: (units: Record<string, unknown>[]) => Record<string, unknown>[];
  scope?: 'mvp_b_polling' | 'mvp_c_refunds';
}

export async function bootOwn(o: OwnRigOptions = {}): Promise<OwnRig> {
  const own = o.own === undefined ? OWN : o.own;
  const lines: string[] = [];
  const played: Played[] = [];
  const model = createDryRunModel(systemClock(), {
    own_merchant_id: o.model_payee === undefined ? own : o.model_payee,
  });
  const reply = (status: number, body: unknown): WireResult => ({
    kind: 'response',
    status,
    headers: { 'content-type': 'application/json', 'paypal-debug-id': `bu7dbg${played.length}` },
    body: JSON.stringify(body),
  });
  const wire: Wire = {
    async request(r: WireRequest): Promise<WireResult> {
      const path = new URL(r.url).pathname;
      const body = typeof r.body === 'string' ? r.body : null;
      if (r.method === 'POST' && path === '/v1/oauth2/token') {
        played.push({ method: r.method, path, operation: 'oauth_token', body });
        return reply(200, { access_token: FAKE_TOKEN, token_type: 'Bearer', expires_in: 32400 });
      }
      const operation =
        r.method === 'POST' && path === '/v2/checkout/orders'
          ? 'create_order'
          : r.method === 'GET' && path.startsWith('/v2/checkout/orders/')
            ? 'get_order'
            : r.method === 'POST' && path.endsWith('/capture')
              ? 'capture_order'
              : r.method === 'GET' && path.startsWith('/v2/payments/captures/')
                ? 'get_capture'
                : 'unknown';
      played.push({ method: r.method, path, operation, body });
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
      let answer = out.body;
      if (o.tamper !== undefined) {
        try {
          const j = JSON.parse(answer) as Record<string, unknown>;
          if (Array.isArray(j['purchase_units'])) {
            answer = JSON.stringify({
              ...j,
              purchase_units: o.tamper(j['purchase_units'] as Record<string, unknown>[]),
            });
          }
        } catch {
          /* keep the answer as it is */
        }
      }
      return { kind: 'response', status: out.status, headers: out.headers, body: answer };
    },
  };

  const scope = o.scope ?? 'mvp_b_polling';
  const app = createApp(
    await sandboxEnv({
      UMS_OUTBOUND_SCOPE: scope,
      ...(own === null ? {} : { UMS_OWN_MERCHANT_ID: own }),
    }),
    { switch_cache_ms: 0, log_sink: (l) => lines.push(l), test_wire: wire },
  );
  installApp(app);
  await app.ready();
  await insertApproval(app.db, {
    ref: REF,
    scope,
    valid_until: '2999-01-01T00:00:00Z',
    max_calls: 300,
    max_amount_minor: 2000,
  });
  await setOutboundSwitch(app.db, true);
  const at = systemClock().now().toISOString();
  await app.db.query(
    `UPDATE publishers SET paypal_merchant_id = $2, payee_verified_at = $1 WHERE slug = 'harbour-ledger'`,
    [at, o.publisher_payee ?? own ?? OWN],
  );
  const row = await app.db.query<{ id: string }>(
    `SELECT id FROM buyers WHERE auth_subject = 'persona:buyer-a'`,
  );
  const actor: Actor = { kind: 'buyer', buyer_id: row.rows[0]!.id };

  const count = async (sql: string, params: unknown[] = []): Promise<number> =>
    Number((await app.db.query<{ c: string }>(sql, params)).rows[0]?.c);
  return {
    app,
    actor,
    lines,
    played,
    model,
    ops: () => played.map((p) => p.operation),
    async placeOrder() {
      const offers = (await app.engine.listOffers()).filter(
        (x) => x.publisher_slug === 'harbour-ledger',
      );
      const offer = offers[0]!.offer_code;
      const page = await app.engine.offerPage({ publisher: 'harbour-ledger', offer });
      const q = await app.engine.quote({
        offer: { publisher_slug: 'harbour-ledger', offer_code: offer },
        actor,
        source: 'direct',
        option: page!.options[0]!.option,
      });
      if (!q.ok || q.value.kind !== 'quote') throw new Error('no quote');
      const g = await app.engine.requestApproval({
        actor,
        selection: { kind: 'quote', quote_id: q.value.quote_id },
        consent: { terms: true, identity_share: false },
      });
      if (!g.ok) throw new Error('no approval');
      const placed = await app.engine.payments.placeOrder({
        approval_id: g.value.approval_id,
        token: g.value.token,
        actor,
      });
      if (!placed.ok) throw new Error(`place failed: ${placed.error.code}`);
      return placed.value;
    },
    async providerOrderId(order_id) {
      const r = await app.db.query<{ provider_order_id: string }>(
        'SELECT provider_order_id FROM provider_orders WHERE order_id = $1',
        [order_id],
      );
      return r.rows[0]!.provider_order_id;
    },
    async statusRow(order_ref) {
      const r = await app.db.query<{ status: string }>(
        'SELECT status FROM orders WHERE order_ref = $1',
        [order_ref],
      );
      return r.rows[0]?.status;
    },
    count,
    close: () => app.close(),
  };
}
