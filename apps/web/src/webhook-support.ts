// CO-3 test support: a sandbox-mode app with an injected certificate source, a key pair made when the
// module loads, and signed deliveries made here. No key is stored anywhere, no secret is real, no
// byte leaves the process (the Wire is a counting stand-in that must see no call). Not a test file.
import { createSign, generateKeyPairSync } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { crc32 } from 'node:zlib';
import type { Actor } from '@umsbx/contracts';
import { createApp, installApp } from '../composition.server';
import type { App, AppOptions } from '../composition.server';
import { testEnv } from './support';

type Wire = NonNullable<AppOptions['test_wire']>;
type WireRequest = Parameters<Wire['request']>[0];
type WireResult = Awaited<ReturnType<Wire['request']>>;
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
  /** CO-1d: how the stand-in Wire answers (default: an error). It is the only thing that ever "answers". */
  wire_answer?: (r: WireRequest) => WireResult;
  /** CO-1d: UMS_PAYPAL_CONNECT (default off, as in the other rigs). */
  connect?: 'on' | 'off';
  /** CO-1d: insert an approval row for these operations (scope mvp_c_refunds) and turn paypal_outbound on. */
  approval?: { operations: string[]; outbound_on?: boolean } | null;
  /** CO-1d: UMS_WEBHOOK_CERT_LEARN_UNTIL (an ISO time); null or omitted: not set. */
  learn_until?: string | null;
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
      wire.push(structuredClone(r));
      return o.wire_answer === undefined ? { kind: 'error', error: 'other' } : o.wire_answer(r);
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
          ...(o.connect === 'on' ? { UMS_PAYPAL_CONNECT: 'on' } : {}),
          UMS_OUTBOUND_APPROVAL_REF: APPROVAL_REF,
          UMS_OUTBOUND_SCOPE: o.scope ?? 'mvp_b_polling',
          UMS_OWN_MERCHANT_ID: OWN,
          PAYPAL_CLIENT_ID: FAKE_ID,
          PAYPAL_CLIENT_SECRET: FAKE_SECRET,
          ...(webhookId === null ? {} : { PAYPAL_WEBHOOK_ID: webhookId }),
        }
      : {}),
    ...(o.learn_until === undefined || o.learn_until === null
      ? {}
      : { UMS_WEBHOOK_CERT_LEARN_UNTIL: o.learn_until }),
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
  if (o.approval !== undefined && o.approval !== null) {
    await app.db.query(
      `INSERT INTO outbound_approvals (id, approval_ref, scope, operations, max_amount_minor, max_calls_per_day, valid_until, approved_by, created_at, updated_at)
       VALUES ('oap_co1d_000000000000001', $1, 'mvp_c_refunds', $2, 2000, 300, '2999-01-01T00:00:00Z', 'co1d-test', $3, $3)`,
      [APPROVAL_REF, o.approval.operations, NOW_ISO],
    );
    if (o.approval.outbound_on !== false)
      await app.db.query(`UPDATE safety_switches SET "on" = true WHERE name = 'paypal_outbound'`);
  }
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

// ---------------------------------------------------------------------------------------------
// CO-1d: the certificate learn window. The Wire is a stand-in that answers certificate fetches with
// the committed parse-only PEM (a public test certificate, its key discarded) and counts every
// request; nothing leaves the process.
// ---------------------------------------------------------------------------------------------
export const PARSE_ONLY_PEM = readFileSync(
  new URL('../../../fixtures/webhooks/synthetic/parse-only.pem', import.meta.url),
  'utf8',
);
/** Public test certificates (keys discarded) whose subject the log/audit redaction would change (CO-1d F2). Valid from 2026-10-25T13:28Z. */
export const EMAIL_SUBJECT_PEM = readFileSync(
  new URL('../../../fixtures/webhooks/synthetic/parse-only-email.pem', import.meta.url),
  'utf8',
);
export const TOKEN_SUBJECT_PEM = readFileSync(
  new URL('../../../fixtures/webhooks/synthetic/parse-only-token.pem', import.meta.url),
  'utf8',
);
/** What Node reads from the PEM above: pinned here so a changed fixture is noticed. */
export const PARSE_ONLY_FACTS = {
  subject: 'CN=synthetic-webhook-cert.invalid, O=UnitMarket SBX synthetic test',
  subject_cn: 'synthetic-webhook-cert.invalid',
  issuer: 'CN=synthetic-webhook-cert.invalid, O=UnitMarket SBX synthetic test',
  valid_from: '2026-10-23T05:52:31.000Z',
  valid_to: '2046-10-18T05:52:31.000Z',
  fingerprint_sha256:
    'A3:25:90:28:E2:82:D1:FE:7D:FE:F5:86:9E:3D:42:39:5D:50:F3:B8:D7:17:B2:E1:EB:C7:C6:C9:51:2C:35:B9',
} as const;
export const CERT_HOST = ['certs', ...DOMAIN.split('.')].join('.');
export const certUrlN = (n: number, o: { host?: string; query?: string } = {}): string =>
  `https://${o.host ?? CERT_HOST}/v1/notifications/certs/CERT-LEARN-${String(n).padStart(4, '0')}${o.query ?? ''}`;

/** The operations the MVP-C approval names, with the certificate fetch. */
export const LEARN_OPERATIONS = ['oauth_token', 'get_order', 'get_capture', 'fetch_webhook_cert'];

/** A PEM answer for any path under the certificate path, a 404 for anything else. */
export const certWire =
  (pem: string = PARSE_ONLY_PEM) =>
  (r: WireRequest): WireResult => {
    const path = new URL(r.url).pathname;
    if (r.method === 'GET' && path.startsWith('/v1/notifications/certs/'))
      return {
        kind: 'response',
        status: 200,
        headers: { 'content-type': 'application/x-pem-file' },
        body: pem,
      };
    return {
      kind: 'response',
      status: 404,
      headers: { 'content-type': 'application/json' },
      body: '{}',
    };
  };

/** A sandbox app with the learn window open (default: until 30 minutes after NOW_ISO). */
export function bootLearnApp(o: BootOptions = {}): Promise<WebhookRig> {
  return bootWebhookApp({
    scope: 'mvp_c_refunds',
    connect: 'on',
    certs: null,
    approval: { operations: LEARN_OPERATIONS },
    wire_answer: certWire(),
    learn_until: new Date(NOW_MS + 30 * 60_000).toISOString(),
    ...o,
  });
}

/** Tables a webhook, a refusal or a learn must not touch: row count and a hash of every row's text. */
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
export async function stateOf(app: App): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const t of STATE_TABLES) {
    const r = await app.db.query<{ n: string | number; h: string }>(
      `SELECT count(*) AS n, md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) AS h FROM ${t} x`,
    );
    out[t] = `${String(r.rows[0]?.n)}:${r.rows[0]?.h}`;
  }
  return out;
}
export async function learnRows(app: App): Promise<
  Array<{
    actor_kind: string;
    actor_id: string | null;
    target: string | null;
    reason: string | null;
    detail: Record<string, unknown>;
  }>
> {
  const r = await app.db.query<{
    actor_kind: string;
    actor_id: string | null;
    target: string | null;
    reason: string | null;
    detail: Record<string, unknown> | string;
  }>(
    `SELECT actor_kind, actor_id, target, reason, detail FROM audit_log WHERE action = 'webhook.cert_learned' ORDER BY created_at, id`,
  );
  return r.rows.map((x) => ({
    ...x,
    detail:
      typeof x.detail === 'string' ? (JSON.parse(x.detail) as Record<string, unknown>) : x.detail,
  }));
}
/** The parsed log lines with the given message. */
export const logLines = (lines: string[], msg: string): Array<Record<string, unknown>> =>
  lines.map((l) => JSON.parse(l) as Record<string, unknown>).filter((l) => l['msg'] === msg);
