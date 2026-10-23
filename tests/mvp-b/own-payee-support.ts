// BU-7 test support: createApp in sandbox mode over a fake Wire that plays PayPal with the dry-run
// order model. Adapted from the BU-2 journey test. Nothing here opens a socket: the production Wire
// is never built. Ids are obviously fake and built here; no real merchant id exists in the repo.
import { systemClock } from '@umsbx/runtime';
import type { Actor, OutboundRequest } from '@umsbx/contracts';
import type { Wire, WireRequest, WireResult } from '@umsbx/transport';
import { createApp, installApp } from '../../apps/web/composition.server';
import type { App } from '../../apps/web/composition.server';
import { createDryRunModel } from '../../apps/web/src/server/dryrun-model';
import { REF, insertApproval, sandboxEnv, setOutboundSwitch } from './unseal-support';

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
