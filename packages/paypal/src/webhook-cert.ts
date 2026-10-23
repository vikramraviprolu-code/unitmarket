// Webhook signing certificate: fetched through the Transport as `fetch_webhook_cert` (so every lock
// and the egress guard apply), parsed with node:crypto, checked for its dates and its key type, and
// cached by URL. Nothing here decides whether a webhook is genuine; webhook-verify.ts does.
//
// Every failure is `unavailable`: the verdict is then `unverifiable` (HTTP 503, PayPal retries) and
// is never recorded as a forgery (nfr.md P1).
import { X509Certificate } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import type { Clock, Logger, Transport } from '@umsbx/contracts';
import { guard } from '@umsbx/transport';

export interface WebhookCertificate {
  public_key: KeyObject;
  /** distinguished name, one line, for the log and the pin */
  subject: string;
  valid_from: Date;
  valid_to: Date;
}

export type CertificateFailure = 'fetch' | 'parse' | 'validity' | 'key' | 'subject';
export type CertificateResult =
  { kind: 'ok'; cert: WebhookCertificate } | { kind: 'unavailable'; why: CertificateFailure };

/** The port the verifier uses to obtain a certificate by (already allow-listed) URL. */
export interface CertificateSource {
  get(url: string): Promise<CertificateResult>;
}

/** Cached certificates: at most this many, each for at most this long (or until `validTo`). */
export const CERT_CACHE_MAX_ENTRIES = 8;
export const CERT_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** A PEM answer larger than this is refused unread (a certificate is about 2 KB). */
export const MAX_CERT_BYTES = 64 * 1024;
const MIN_RSA_BITS = 2048;

/**
 * Expected certificate subjects. Empty for now: the subject is logged on the first fetch and not
 * checked. After the first owner run the recorded subject is pinned here, as a code constant (no
 * configuration can change it). Entries are the one-line subject, e.g. `CN=example, O=Example`.
 */
export const EXPECTED_CERT_SUBJECTS: readonly string[] = [];

const unavailable = (why: CertificateFailure): CertificateResult => ({ kind: 'unavailable', why });

/** Parse one PEM certificate; refuse it outside its dates or when its key is not RSA of 2048+ bits. */
export function parseCertificate(pem: string, now: Date): CertificateResult {
  let x: X509Certificate;
  try {
    if (typeof pem !== 'string' || Buffer.byteLength(pem) > MAX_CERT_BYTES)
      return unavailable('parse');
    x = new X509Certificate(pem);
  } catch {
    return unavailable('parse');
  }
  const t = now.getTime();
  const valid_from = x.validFromDate;
  const valid_to = x.validToDate;
  if (!(t >= valid_from.getTime() && t <= valid_to.getTime())) return unavailable('validity');
  const key = x.publicKey;
  // SHA256withRSA is the only algorithm accepted: a certificate with another key type must not be
  // able to verify a signature (no algorithm confusion).
  if (
    key.asymmetricKeyType !== 'rsa' ||
    (key.asymmetricKeyDetails?.modulusLength ?? 0) < MIN_RSA_BITS
  )
    return unavailable('key');
  return {
    kind: 'ok',
    cert: { public_key: key, subject: x.subject.split('\n').join(', '), valid_from, valid_to },
  };
}

export interface CertCache {
  get(url: string): WebhookCertificate | null;
  set(url: string, cert: WebhookCertificate): void;
  size(): number;
}

/** URL-keyed cache: expires at the earlier of `validTo` and 24 h, holds at most 8, evicts the oldest. */
export function createCertCache(clock: Clock): CertCache {
  const entries = new Map<string, { cert: WebhookCertificate; expires_at: number }>();
  const purge = (now: number) => {
    for (const [url, e] of entries) if (now > e.expires_at) entries.delete(url);
  };
  return {
    get(url) {
      const now = clock.now().getTime();
      const e = entries.get(url);
      if (e === undefined) return null;
      if (now > e.expires_at) {
        entries.delete(url);
        return null;
      }
      return e.cert;
    },
    set(url, cert) {
      const now = clock.now().getTime();
      const expires_at = Math.min(cert.valid_to.getTime(), now + CERT_CACHE_MAX_AGE_MS);
      entries.delete(url);
      if (now > expires_at) return;
      purge(now);
      while (entries.size >= CERT_CACHE_MAX_ENTRIES) {
        const oldest = entries.keys().next();
        if (oldest.done === true) break;
        entries.delete(oldest.value);
      }
      entries.set(url, { cert, expires_at });
    },
    size() {
      purge(clock.now().getTime());
      return entries.size;
    },
  };
}

export interface CertificateSourceDeps {
  transport: Transport;
  clock: Clock;
  log?: Logger;
  /** defaults to EXPECTED_CERT_SUBJECTS; empty means log, do not check */
  expected_subjects?: readonly string[];
}

const requestFor = (path: string) =>
  ({
    operation: 'fetch_webhook_cert',
    method: 'GET',
    path,
    headers: { Accept: '*/*' },
    body: null,
    order_ref: null,
    amount_minor: null,
    scenario: null,
  }) as const;

/**
 * The production source. The URL is checked here with the transport's own guard (the Transport
 * checks it again), so an off-list URL is refused without a call even if a caller forgot to check.
 * Concurrent lookups of one URL share one fetch; failures are not cached.
 */
export function createCertificateSource(d: CertificateSourceDeps): CertificateSource {
  const cache = createCertCache(d.clock);
  const inflight = new Map<string, Promise<CertificateResult>>();
  const expected = d.expected_subjects ?? EXPECTED_CERT_SUBJECTS;

  async function fetchOne(url: string): Promise<CertificateResult> {
    let tr;
    try {
      tr = await d.transport.send(requestFor(url));
    } catch {
      return unavailable('fetch');
    }
    if (tr.kind !== 'response' || tr.status !== 200) return unavailable('fetch');
    const parsed = parseCertificate(tr.body, d.clock.now());
    if (parsed.kind !== 'ok') return parsed;
    if (expected.length === 0) {
      d.log?.log({
        msg: 'paypal.webhook_cert',
        level: 'info',
        fields: { subject: parsed.cert.subject, valid_to: parsed.cert.valid_to.toISOString() },
      });
    } else if (!expected.includes(parsed.cert.subject)) {
      return unavailable('subject');
    }
    cache.set(url, parsed.cert);
    return parsed;
  }

  return {
    async get(raw) {
      const checked = guard({ ...requestFor(raw), path: raw }, 'sandbox');
      if (!checked.ok) return unavailable('fetch');
      const url = checked.url.href;
      const hit = cache.get(url);
      if (hit !== null) return { kind: 'ok', cert: hit };
      const pending = inflight.get(url);
      if (pending !== undefined) return pending;
      const flight = fetchOne(url).finally(() => {
        inflight.delete(url);
      });
      inflight.set(url, flight);
      return flight;
    },
  };
}
