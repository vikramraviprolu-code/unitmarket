// Test helpers for the webhook verification lane (CO-1). No network, no stored key: every key pair
// is generated when the test module loads, every certificate is built here from a generated key,
// and every signature is made here. Nothing in this file reads the environment or the clock.
import { createSign, generateKeyPairSync, sign } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { crc32 } from 'node:zlib';
import type { OutboundRequest, Transport, TransportResult } from '@umsbx/contracts';
import type { CertificateResult, CertificateSource, WebhookCertificate } from './webhook-cert';

export const SYNTHETIC_DIR = fileURLToPath(
  new URL('../../../fixtures/webhooks/synthetic/', import.meta.url),
);
export const GOLDEN_FILE = fileURLToPath(
  new URL('../../../fixtures/webhooks/golden/signed-messages.json', import.meta.url),
);

/** The webhook id the synthetic signatures are made for. */
export const WEBHOOK_ID = 'SYN-WEBHOOK-ID-0001';
/** One minute after every synthetic fixture's transmission time. */
export const NOW_ISO = '2026-10-23T12:01:00Z';
export const TRANSMISSION_TIME = '2026-10-23T12:00:00Z';

export const MINUTE = 60_000;
export const HOUR = 3_600_000;
export const DAY = 86_400_000;

// ---------- keys ----------
const rsa = (bits = 2048) => generateKeyPairSync('rsa', { modulusLength: bits });
/** The key PayPal's (synthetic) certificate holds. */
export const signer = rsa();
/** A different key: what a forger has. */
export const forger = rsa();

// ---------- certificate URL (host built from parts, as the other test files do) ----------
const DOMAIN = ['sandbox', 'paypal', 'com'].join('.');
export const CERT_PATH = '/v1/notifications/certs/CERT-SYNTHETIC-0001';
export const certHost = (labels: string[] = ['api']) => [...labels, DOMAIN].join('.');
export const certUrl = (over: { host?: string; path?: string; scheme?: string } = {}) =>
  `${over.scheme ?? 'https'}://${over.host ?? certHost()}${over.path ?? CERT_PATH}`;

// ---------- the signed message, computed independently of the code under test ----------
export interface MessageParts {
  transmission_id: string;
  transmission_time: string;
  webhook_id: string;
  raw_body: string;
}
export const messageFor = (p: MessageParts): string =>
  `${p.transmission_id}|${p.transmission_time}|${p.webhook_id}|${crc32(Buffer.from(p.raw_body, 'utf8'))}`;

export function signMessage(key: KeyObject, message: string, hash = 'SHA256'): string {
  const s = createSign(hash);
  s.update(message, 'utf8');
  s.end();
  return s.sign(key, 'base64');
}

// ---------- fixtures ----------
export interface WebhookFixture {
  name: string;
  meta: { source: string; label: string };
  headers: Record<string, string>;
  body: unknown;
  expect: {
    event_id: string;
    transmission_id: string;
    type: string;
    provider_order_id: string | null;
    capture_id: string | null;
    refund_id: string | null;
    occurred_at: string;
  };
}
export function loadWebhookFixtures(): WebhookFixture[] {
  return readdirSync(SYNTHETIC_DIR)
    .filter((n) => n.endsWith('.json'))
    .sort()
    .map((n) => {
      const doc = JSON.parse(readFileSync(SYNTHETIC_DIR + n, 'utf8')) as Omit<
        WebhookFixture,
        'name'
      >;
      return { name: n.slice(0, -'.json'.length), ...doc };
    });
}
/** The raw body the fixtures are signed over: pretty-printed, so re-serialising it changes it. */
export const rawBodyOf = (f: WebhookFixture): string => JSON.stringify(f.body, null, 2);

export interface Delivery {
  headers: Record<string, string>;
  raw_body: string;
}
export interface SignOptions {
  key?: KeyObject;
  webhook_id?: string;
  cert_url?: string;
  raw_body?: string;
  /** body text the signature is made over, when it differs from the body delivered */
  signed_body?: string;
  algo?: string;
  hash?: string;
  time?: string;
  id?: string;
}
/** A delivery the way PayPal sends one: five paypal-* headers (lower case) and the raw body. */
export function deliver(f: WebhookFixture, o: SignOptions = {}): Delivery {
  const raw_body = o.raw_body ?? rawBodyOf(f);
  const id = o.id ?? f.headers['paypal-transmission-id'] ?? '';
  const time = o.time ?? f.headers['paypal-transmission-time'] ?? '';
  const message = messageFor({
    transmission_id: id,
    transmission_time: time,
    webhook_id: o.webhook_id ?? WEBHOOK_ID,
    raw_body: o.signed_body ?? raw_body,
  });
  return {
    headers: {
      'paypal-transmission-id': id,
      'paypal-transmission-time': time,
      'paypal-auth-algo': o.algo ?? 'SHA256withRSA',
      'paypal-cert-url': o.cert_url ?? certUrl(),
      'paypal-transmission-sig': signMessage(
        (o.key ?? signer.privateKey) as KeyObject,
        message,
        o.hash,
      ),
    },
    raw_body,
  };
}

// ---------- fakes ----------
export const certificateOf = (
  publicKey: KeyObject,
  over: Partial<WebhookCertificate> = {},
): WebhookCertificate => ({
  public_key: publicKey,
  subject: 'CN=synthetic.invalid',
  valid_from: new Date('2026-01-01T00:00:00Z'),
  valid_to: new Date('2036-01-01T00:00:00Z'),
  ...over,
});

export interface FakeCertificates extends CertificateSource {
  calls: string[];
  /** urls the verifier reported as trusted (after a genuine signature) */
  trusted: string[];
}
export function fakeCertificates(
  answer: CertificateResult | ((url: string) => CertificateResult | Promise<CertificateResult>),
): FakeCertificates {
  const calls: string[] = [];
  const trusted: string[] = [];
  return {
    calls,
    trusted,
    trust(url) {
      trusted.push(url);
    },
    async get(url) {
      calls.push(url);
      return typeof answer === 'function' ? answer(url) : answer;
    },
  };
}
export const okCertificates = (publicKey: KeyObject = signer.publicKey) =>
  fakeCertificates({ kind: 'ok', cert: certificateOf(publicKey) });

export interface FakeTransport extends Transport {
  calls: OutboundRequest[];
}
export function fakeTransport(
  answer: (r: OutboundRequest, n: number) => TransportResult | Promise<TransportResult>,
): FakeTransport {
  const calls: OutboundRequest[] = [];
  return {
    kind: 'sandbox',
    calls,
    async send(r) {
      calls.push(r);
      return answer(r, calls.length);
    },
  };
}
export const pemResponse = (pem: string, status = 200): TransportResult => ({
  kind: 'response',
  status,
  headers: { 'content-type': 'application/x-pem-file' },
  body: pem,
  duration_ms: 1,
});

// ---------- a minimal X.509 builder (DER by hand) ----------
// Node can read certificates but not make them, and no private key may be committed, so the tests
// build a v3 certificate around a generated key. The signature is real (RSA, SHA-256) but nothing
// here checks it: the code under test reads the public key, the subject and the dates.
const lenOf = (n: number) =>
  n < 0x80
    ? Buffer.from([n])
    : n < 0x100
      ? Buffer.from([0x81, n])
      : Buffer.from([0x82, n >> 8, n & 0xff]);
const tlv = (tag: number, ...parts: Buffer[]) => {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag]), lenOf(body.length), body]);
};
const seq = (...p: Buffer[]) => tlv(0x30, ...p);
const oid = (dotted: string) => {
  const n = dotted.split('.').map(Number);
  const out: number[] = [n[0]! * 40 + n[1]!];
  for (const v of n.slice(2)) {
    const groups = [v & 0x7f];
    for (let r = v >> 7; r > 0; r >>= 7) groups.unshift((r & 0x7f) | 0x80);
    out.push(...groups);
  }
  return tlv(0x06, Buffer.from(out));
};
const time = (d: Date) => {
  const iso = d.toISOString(); // 2026-10-23T12:00:00.000Z
  const digits = iso.replace(/[-:T]/g, '').slice(0, 14);
  return d.getUTCFullYear() < 2050
    ? tlv(0x17, Buffer.from(`${digits.slice(2)}Z`, 'ascii'))
    : tlv(0x18, Buffer.from(`${digits}Z`, 'ascii'));
};
const name = (cn: string) =>
  seq(tlv(0x31, seq(oid('2.5.4.3'), tlv(0x0c, Buffer.from(cn, 'utf8')))));

export interface CertOptions {
  publicKey: KeyObject;
  /** signs the certificate; its own key may differ from the one inside */
  signingKey?: KeyObject;
  notBefore: Date;
  notAfter: Date;
  cn?: string;
  /** the issuer's common name (default 'Synthetic Issuer') */
  issuer_cn?: string;
}
export function certificatePem(o: CertOptions): string {
  const sigAlg = seq(oid('1.2.840.113549.1.1.11'), tlv(0x05));
  const tbs = seq(
    tlv(0xa0, tlv(0x02, Buffer.from([2]))),
    tlv(0x02, Buffer.from([1])),
    sigAlg,
    name(o.issuer_cn ?? 'Synthetic Issuer'),
    seq(time(o.notBefore), time(o.notAfter)),
    name(o.cn ?? 'synthetic-webhook.invalid'),
    o.publicKey.export({ type: 'spki', format: 'der' }),
  );
  const signature = sign('sha256', tbs, o.signingKey ?? signer.privateKey);
  const der = seq(tbs, sigAlg, tlv(0x03, Buffer.concat([Buffer.from([0]), signature])));
  const b64 = der.toString('base64').replace(/(.{64})/g, '$1\n');
  return `-----BEGIN CERTIFICATE-----\n${b64.replace(/\n$/, '')}\n-----END CERTIFICATE-----\n`;
}
export { rsa as generateRsa };
export const generateEc = () => generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
