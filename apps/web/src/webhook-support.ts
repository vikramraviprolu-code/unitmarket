// CO-3 test support: a sandbox-mode app with an injected certificate source, a key pair made when the
// module loads, and signed deliveries made here. No key is stored anywhere, no secret is real, no
// byte leaves the process (the Wire is a counting stand-in that must see no call). Not a test file.
import { createSign, generateKeyPairSync } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { crc32 } from 'node:zlib';
import type { Actor } from '@umsbx/contracts';
import { createApp, installApp } from '../composition.server';
import type { App, AppOptions } from '../composition.server';
import { testEnv } from './support';

type Wire = NonNullable<AppOptions['test_wire']>;
type WireRequest = Parameters<Wire['request']>[0];
export type CertSource = NonNullable<AppOptions['webhook_certificates']>;

export const WEBHOOK_ID = 'SYN-WEBHOOK-ID-0001';
export const NOW_ISO = '2026-10-23T12:01:00.000Z';
export const NOW_MS = Date.parse(NOW_ISO);
export const TRANSMISSION_TIME = '2026-10-23T12:00:00Z';
export const PROVIDER_ORDER = 'SBXORD0000000001';
export const CAPTURE = 'SBXCAP0000000001';
export const WEBHOOK_URL = 'http://localhost:3000/api/webhooks/paypal';

const FAKE_ID = ['placeholder', 'client', 'id'].join('-');
const FAKE_SECRET = ['placeholder', 'client', 'secret'].join('-');
const APPROVAL_REF = 'DL-2026-10-23-co3';
const OWN = 'SBXOWNMERCH01';

// ---------- keys, certificate source ----------
export const signer = generateKeyPairSync('rsa', { modulusLength: 2048 });
export const forger = generateKeyPairSync('rsa', { modulusLength: 2048 });
const DOMAIN = ['sandbox', 'paypal', 'com'].join('.');
export const certUrl = (): string =>
  `https://${['certs', DOMAIN].join('.')}/v1/notifications/certs/CERT-SYNTHETIC-0001`;

export interface FakeCerts extends CertSource {
  calls: string[];
  trusted: string[];
}
export function certsFor(
  publicKey: KeyObject = signer.publicKey,
  answer?: () => Awaited<ReturnType<CertSource['get']>>,
): FakeCerts {
  const calls: string[] = [];
  const trusted: string[] = [];
  return {
    calls,
    trusted,
    trust(url: string) {
      trusted.push(url);
    },
    async get(url: string) {
      calls.push(url);
      if (answer !== undefined) return answer();
      return {
        kind: 'ok' as const,
        cert: {
          public_key: publicKey,
          subject: 'CN=synthetic.invalid',
          valid_from: new Date('2026-01-01T00:00:00Z'),
          valid_to: new Date('2036-01-01T00:00:00Z'),
        },
      };
    },
  };
}

// ---------- bodies and signatures ----------
export interface EventSpec {
  id: string;
  type?: string;
  order?: string | null;
  capture?: string | null;
  summary?: string;
}
/** A pretty-printed event body: re-serialising it changes the bytes, as with PayPal's own. */
export function eventBody(e: EventSpec): string {
  const type = e.type ?? 'CHECKOUT.ORDER.APPROVED';
  const resource: Record<string, unknown> = type.startsWith('CHECKOUT.')
    ? { id: e.order ?? PROVIDER_ORDER, status: 'APPROVED' }
    : {
        id: e.capture ?? CAPTURE,
        status: 'COMPLETED',
        supplementary_data: { related_ids: { order_id: e.order ?? PROVIDER_ORDER } },
      };
  return JSON.stringify(
    {
      id: e.id,
      event_version: '1.0',
      create_time: '2026-10-23T11:59:58Z',
      resource_type: type.startsWith('CHECKOUT.') ? 'checkout-order' : 'capture',
      event_type: type,
      summary: e.summary ?? 'Synthetic event',
      resource,
    },
    null,
    2,
  );
}
/** An event body of exactly `bytes` UTF-8 bytes (the summary carries the padding). */
export function eventBodyOfSize(e: EventSpec, bytes: number): string {
  const base = Buffer.byteLength(eventBody({ ...e, summary: '' }), 'utf8');
  return eventBody({ ...e, summary: 'x'.repeat(bytes - base) });
}

export interface Delivery {
  headers: Record<string, string>;
  raw_body: string;
}
export interface SignOptions {
  id?: string;
  time?: string;
  webhook_id?: string;
  key?: KeyObject;
  algo?: string;
  cert_url?: string;
  /** the body the signature is made over, when it differs from the one delivered */
  signed_body?: string;
}
export const messageFor = (id: string, time: string, webhook_id: string, body: string): string =>
  `${id}|${time}|${webhook_id}|${crc32(Buffer.from(body, 'utf8'))}`;

/** A delivery the way PayPal sends one: five paypal-* headers and the raw body. */
export function delivery(raw_body: string, o: SignOptions = {}): Delivery {
  const id = o.id ?? 'SYN-TRANS-0001';
  const time = o.time ?? TRANSMISSION_TIME;
  const s = createSign('SHA256');
  s.update(messageFor(id, time, o.webhook_id ?? WEBHOOK_ID, o.signed_body ?? raw_body), 'utf8');
  s.end();
  return {
    headers: {
      'paypal-transmission-id': id,
      'paypal-transmission-time': time,
      'paypal-auth-algo': o.algo ?? 'SHA256withRSA',
      'paypal-cert-url': o.cert_url ?? certUrl(),
      'paypal-transmission-sig': s.sign(o.key ?? signer.privateKey, 'base64'),
    },
    raw_body,
  };
}

// ---------- the app ----------
export interface WebhookRig {
  app: App;
  /** every line the app logged */
  lines: string[];
  /** requests the stand-in Wire saw: must stay empty */
  wire: WireRequest[];
  certs: FakeCerts | null;
  route: typeof import('./app/api/webhooks/paypal/route');
  /** post a delivery to the route handler; `ip` is the right-most X-Forwarded-For entry */
  post(
    d: Delivery,
    o?: { ip?: string; content_type?: string; method?: string; body?: BodyInit | null },
  ): Promise<Response>;
  count(sql: string, params?: unknown[]): Promise<number>;
  close(): Promise<void>;
}

export interface BootOptions {
  scope?: 'mvp_b_polling' | 'mvp_c_refunds';
  /** a source, or null: none injected (the app builds its own through the transport) */
  certs?: FakeCerts | null;
  /** null: PAYPAL_WEBHOOK_ID not set */
  webhook_id?: string | null;
  mode?: 'sandbox' | 'offline';
  env?: Record<string, string>;
}

export async function bootWebhookApp(o: BootOptions = {}): Promise<WebhookRig> {
  const lines: string[] = [];
  const wire: WireRequest[] = [];
  const stand: Wire = {
    async request(r) {
      wire.push(r);
      return { kind: 'error', error: 'other' };
    },
  };
  const certs = o.certs === undefined ? certsFor() : o.certs;
  const sandbox = (o.mode ?? 'sandbox') === 'sandbox';
  const webhookId = o.webhook_id === undefined ? WEBHOOK_ID : o.webhook_id;
  const env = await testEnv({
    UMS_TRUSTED_PROXIES: '1',
    ...(sandbox
      ? {
          UMS_MODE: 'sandbox',
          UMS_OUTBOUND_APPROVAL_REF: APPROVAL_REF,
          UMS_OUTBOUND_SCOPE: o.scope ?? 'mvp_b_polling',
          UMS_OWN_MERCHANT_ID: OWN,
          PAYPAL_CLIENT_ID: FAKE_ID,
          PAYPAL_CLIENT_SECRET: FAKE_SECRET,
          ...(webhookId === null ? {} : { PAYPAL_WEBHOOK_ID: webhookId }),
        }
      : {}),
    ...(o.env ?? {}),
  });
  const app = createApp(env, {
    switch_cache_ms: 0,
    log_sink: (l) => lines.push(l),
    ...(sandbox ? { test_wire: stand } : {}),
    ...(certs === null ? {} : { webhook_certificates: certs }),
  });
  installApp(app);
  await app.ready();
  const route = await import('./app/api/webhooks/paypal/route');
  return {
    app,
    lines,
    wire,
    certs,
    route,
    async post(d, p = {}) {
      const headers: Record<string, string> = {
        ...d.headers,
        'x-forwarded-for': `198.18.0.1, ${p.ip ?? '203.0.113.1'}`,
        'content-type': p.content_type ?? 'application/json',
      };
      const init: RequestInit = { method: p.method ?? 'POST', headers };
      if ((p.method ?? 'POST') !== 'GET') init.body = p.body === undefined ? d.raw_body : p.body;
      return route.POST(new Request(WEBHOOK_URL, init), { params: Promise.resolve({}) });
    },
    async count(sql, params = []) {
      return Number((await app.db.query<{ c: string }>(sql, params)).rows[0]?.c);
    },
    close: () => app.close(),
  };
}

/**
 * An order the buyer has approved and is capturing, with a provider order id: what a webhook must be
 * able to find. Built through the engine (quote, approval, place), then moved to capture_requested
 * with SQL, so no PayPal call is needed.
 */
export async function seedCapturingOrder(
  app: App,
  provider_order_id: string = PROVIDER_ORDER,
): Promise<{ order_id: string; order_ref: string }> {
  const buyer = await app.db.query<{ id: string }>(
    `SELECT id FROM buyers WHERE auth_subject = 'persona:buyer-a'`,
  );
  const actor: Actor = { kind: 'buyer', buyer_id: buyer.rows[0]?.id ?? '' };
  const offers = (await app.engine.listOffers()).filter(
    (x) => x.publisher_slug === 'harbour-ledger',
  );
  const offer = offers[0]?.offer_code ?? '';
  const page = await app.engine.offerPage({ publisher: 'harbour-ledger', offer });
  const q = await app.engine.quote({
    offer: { publisher_slug: 'harbour-ledger', offer_code: offer },
    actor,
    source: 'direct',
    option: page?.options[0]?.option ?? 'keep_retrieve',
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
  const at = new Date(NOW_MS).toISOString();
  await app.db.query(
    `INSERT INTO provider_orders (id, order_id, provider_order_id, route, status, created_at, updated_at)
     VALUES ('por_co3test0000000000000000001', $1, $2, 'single', 'APPROVED', $3, $3)`,
    [placed.value.order_id, provider_order_id, at],
  );
  await app.db.query(
    `UPDATE orders SET status = 'capture_requested', updated_at = $2 WHERE id = $1`,
    [placed.value.order_id, at],
  );
  return { order_id: placed.value.order_id, order_ref: placed.value.order_ref };
}
