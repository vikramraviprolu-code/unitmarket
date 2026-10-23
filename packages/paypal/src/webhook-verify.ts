// Local webhook self-verification (architecture 9.1, nfr.md P1, spec CO-1).
//
// The checks run in a fixed order, and each failure answers at once:
//   1. body over 64 KiB, a missing or duplicated paypal-* header (case-insensitive), a bad id or an
//      unparsable time                                   -> malformed
//   2. algorithm other than SHA256withRSA                -> bad_signature('algo')
//   3. certificate URL off the allow-list (the transport's own guard, no fetch at all)
//                                                        -> bad_signature('cert_url')
//   4. transmission time outside [now - 3 days 1 h, now + 5 min]
//                                                        -> bad_signature('stale')
//   5. no webhook id configured                          -> unverifiable
//   6. signature text that is not canonical base64       -> bad_signature('signature')
//   7. certificate not obtainable, not valid now         -> unverifiable (503; never a forgery)
//   8. signature does not verify                         -> bad_signature('signature')
//   9. only now is the body parsed and checked against ProviderEventSchema -> malformed on failure
// The signed message is `<id>|<time>|<webhook id>|<crc32 of the raw UTF-8 bytes, unsigned decimal>`.
// The raw body, the signature and the certificate are never logged and never put in a verdict.
import { createVerify } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { ProviderEventSchema, ProviderEventTypeSchema } from '@umsbx/contracts';
import type { Clock, ProviderEvent, ProviderEventType, WebhookVerdict } from '@umsbx/contracts';
import { guard } from '@umsbx/transport';
import { crc32 } from './crc32';
import type { CertificateSource } from './webhook-cert';

export const MAX_BODY_BYTES = 64 * 1024;
/** A genuine retry can arrive up to 3 days after the first attempt; one hour of slack. */
export const MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000 + 60 * 60 * 1000;
export const MAX_FUTURE_MS = 5 * 60 * 1000;
export const REQUIRED_ALGO = 'SHA256withRSA';

const MAX_CERT_URL_CHARS = 512;
const MAX_SIGNATURE_CHARS = 1368; // base64 of an 8192-bit RSA signature
const H_ID = 'paypal-transmission-id';
const H_TIME = 'paypal-transmission-time';
const H_SIG = 'paypal-transmission-sig';
const H_CERT = 'paypal-cert-url';
const H_ALGO = 'paypal-auth-algo';
const REQUIRED_HEADERS: readonly string[] = [H_ID, H_TIME, H_SIG, H_CERT, H_ALGO];

// printable ASCII without space and without the pipe that separates the signed fields
const ID_RE = /^[\x21-\x7b\x7d-\x7e]{1,256}$/;
const TIME_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
// Canonical base64 (RFC 4648 section 3.5): padding only at the end, and the unused bits of the last
// character are zero, so one byte string has one spelling ("Qg==" yes, "QR==" no; "AAE=" yes, "AAB=" no).
const BASE64_RE =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/][AQgw]==|[A-Za-z0-9+/]{2}[AEIMQUYcgkosw048]=)?$/;

const MALFORMED: WebhookVerdict = { kind: 'malformed' };
const UNVERIFIABLE: WebhookVerdict = { kind: 'unverifiable' };
const bad = (why: 'algo' | 'cert_url' | 'stale' | 'signature'): WebhookVerdict => ({
  kind: 'bad_signature',
  why,
});

export interface VerifyDeps {
  clock: Clock;
  /** null when not configured: every otherwise well-formed delivery is then unverifiable */
  webhook_id: string | null;
  certificates: CertificateSource;
}

export interface MessageParts {
  transmission_id: string;
  transmission_time: string;
  webhook_id: string;
  raw_body: string;
}

/** The string PayPal signs. The CRC runs over the UTF-8 bytes of the body exactly as received. */
export function signedMessage(p: MessageParts): string {
  const crc = crc32(Buffer.from(p.raw_body, 'utf8'));
  return `${p.transmission_id}|${p.transmission_time}|${p.webhook_id}|${crc}`;
}

/**
 * Milliseconds since the epoch for an ISO 8601 time with a zone, or null when it is not a real
 * instant: a wall-clock reading that rolls over (30 February, 24:00:00, minute 60) is refused, and
 * so is an offset out of range (Date.parse answers NaN for it).
 */
function instantOf(time: string): number | null {
  const m = TIME_RE.exec(time);
  if (m === null) return null;
  const [year, month, day, hour, minute, second] = m.slice(1).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const wall = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  const sameWall =
    wall.getUTCFullYear() === year &&
    wall.getUTCMonth() === month - 1 &&
    wall.getUTCDate() === day &&
    wall.getUTCHours() === hour &&
    wall.getUTCMinutes() === minute &&
    wall.getUTCSeconds() === second;
  if (!sameWall) return null;
  const at = Date.parse(time);
  return Number.isNaN(at) ? null : at;
}

/** The five required headers by lower-case name, or null when one is missing, empty or repeated. */
function requiredHeaders(headers: unknown): Map<string, string> | null {
  if (typeof headers !== 'object' || headers === null) return null;
  const found = new Map<string, string>();
  for (const [name, value] of Object.entries(headers)) {
    const key = name.toLowerCase();
    if (!REQUIRED_HEADERS.includes(key)) continue;
    if (found.has(key)) return null;
    if (typeof value !== 'string' || value === '') return null;
    found.set(key, value);
  }
  return found.size === REQUIRED_HEADERS.length ? found : null;
}

export async function verifyWebhook(
  d: VerifyDeps,
  w: { headers: Record<string, string>; raw_body: string },
): Promise<WebhookVerdict> {
  const raw = w.raw_body;
  if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES) return MALFORMED;
  const h = requiredHeaders(w.headers);
  if (h === null) return MALFORMED;
  const id = h.get(H_ID) as string;
  const time = h.get(H_TIME) as string;
  const sig = h.get(H_SIG) as string;
  const certUrl = h.get(H_CERT) as string;
  const algo = h.get(H_ALGO) as string;
  const sentAt = instantOf(time);
  if (!ID_RE.test(id) || sentAt === null) return MALFORMED;

  if (algo !== REQUIRED_ALGO) return bad('algo');

  // The same rule as the transport guard, applied before any fetch. Only the URL the guard
  // returns (parsed, normalised) is ever used.
  if (certUrl.length > MAX_CERT_URL_CHARS) return bad('cert_url');
  const allowed = guard(
    {
      operation: 'fetch_webhook_cert',
      method: 'GET',
      path: certUrl,
      headers: {},
      body: null,
      order_ref: null,
      amount_minor: null,
      scenario: null,
    },
    'sandbox',
  );
  if (!allowed.ok) return bad('cert_url');

  const now = d.clock.now().getTime();
  if (sentAt < now - MAX_AGE_MS || sentAt > now + MAX_FUTURE_MS) return bad('stale');

  if (typeof d.webhook_id !== 'string' || d.webhook_id === '') return UNVERIFIABLE;

  // Reject a signature that cannot be one before a certificate is fetched for it.
  if (sig.length > MAX_SIGNATURE_CHARS || !BASE64_RE.test(sig)) return bad('signature');

  let result;
  try {
    result = await d.certificates.get(allowed.url.href);
  } catch {
    return UNVERIFIABLE;
  }
  if (result?.kind !== 'ok') return UNVERIFIABLE;
  const cert = result.cert;
  // Belt and braces: the source checks the dates too, but a verdict never rests on that alone.
  if (!(now >= cert.valid_from.getTime() && now <= cert.valid_to.getTime())) return UNVERIFIABLE;

  const message = signedMessage({
    transmission_id: id,
    transmission_time: time,
    webhook_id: d.webhook_id,
    raw_body: raw,
  });
  const genuine = signatureHolds(cert.public_key, message, sig);
  if (!genuine) return bad('signature');

  // The signature verified, so this URL held a certificate that signed for our webhook: it gets
  // the reserved fetch budget (webhook-cert.ts). Nothing before this line may trust a URL.
  d.certificates.trust?.(allowed.url.href);

  // Only a signed body is parsed.
  const event = eventOf(raw, id);
  return event === null ? MALFORMED : { kind: 'verified', event };
}

/** SHA-256 with RSA PKCS#1 v1.5 over the message; any error from the crypto library is a mismatch. */
function signatureHolds(key: KeyObject, message: string, signature: string): boolean {
  try {
    const v = createVerify('SHA256');
    v.update(message, 'utf8');
    v.end();
    return v.verify(key, signature, 'base64');
  } catch {
    return false;
  }
}

// ---------- the body, after the signature ----------
type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown): string | null => (typeof v === 'string' ? v : null);

const CAPTURE_TYPES: ReadonlySet<ProviderEventType> = new Set([
  'PAYMENT.CAPTURE.COMPLETED',
  'PAYMENT.CAPTURE.PENDING',
  'PAYMENT.CAPTURE.DECLINED',
  'PAYMENT.CAPTURE.DENIED',
  'PAYMENT.CAPTURE.REVERSED',
]);
const ORDER_TYPES: ReadonlySet<ProviderEventType> = new Set([
  'CHECKOUT.ORDER.APPROVED',
  'CHECKOUT.PAYMENT-APPROVAL.REVERSED',
]);

/** supplementary_data.related_ids.order_id of a capture or refund resource */
function relatedOrderId(resource: Obj): string | null {
  const sup = resource['supplementary_data'];
  const related = isObj(sup) ? sup['related_ids'] : undefined;
  return isObj(related) ? text(related['order_id']) : null;
}

/** A refund names its capture through the `up` link: .../v2/payments/captures/<id> (host ignored). */
function captureOfRefund(resource: Obj): string | null {
  const links = resource['links'];
  if (!Array.isArray(links)) return null;
  for (const link of links as unknown[]) {
    if (!isObj(link) || link['rel'] !== 'up') continue;
    const href = text(link['href']);
    if (href === null) continue;
    try {
      const m = /\/v2\/payments\/captures\/([A-Za-z0-9]{1,36})$/.exec(new URL(href).pathname);
      if (m !== null) return m[1] as string;
    } catch {
      /* not a URL: try the next link */
    }
  }
  return null;
}

function idsOf(type: ProviderEventType, resource: Obj) {
  if (CAPTURE_TYPES.has(type))
    return {
      provider_order_id: relatedOrderId(resource),
      capture_id: text(resource['id']),
      refund_id: null,
    };
  if (type === 'PAYMENT.CAPTURE.REFUNDED')
    return {
      provider_order_id: relatedOrderId(resource),
      capture_id: captureOfRefund(resource),
      refund_id: text(resource['id']),
    };
  if (ORDER_TYPES.has(type))
    return { provider_order_id: text(resource['id']), capture_id: null, refund_id: null };
  return { provider_order_id: null, capture_id: null, refund_id: null };
}

function eventOf(raw: string, transmission_id: string): ProviderEvent | null {
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObj(body) || !isObj(body['resource'])) return null;
  const event_id = text(body['id']);
  const eventType = text(body['event_type']);
  const created = text(body['create_time']);
  if (event_id === null || eventType === null || created === null) return null;
  const at = Date.parse(created);
  if (Number.isNaN(at)) return null;
  const known = ProviderEventTypeSchema.safeParse(eventType);
  const type: ProviderEventType = known.success ? known.data : 'OTHER';
  const parsed = ProviderEventSchema.safeParse({
    event_id,
    transmission_id,
    type,
    ...idsOf(type, body['resource']),
    occurred_at: new Date(at).toISOString(),
  });
  return parsed.success ? parsed.data : null;
}
