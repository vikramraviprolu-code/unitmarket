// Webhook signing certificate: fetched through the Transport as `fetch_webhook_cert` (so every lock
// and the egress guard apply), parsed with node:crypto, checked for its dates and its key type, and
// cached by URL. Nothing here decides whether a webhook is genuine; webhook-verify.ts does.
//
// Every failure is `unavailable`: the verdict is then `unverifiable` (HTTP 503, PayPal retries) and
// is never recorded as a forgery (nfr.md P1).
//
// Cost control (review of CO-1, H1). The webhook route is public, and the certificate URL is read
// from a request header. The URL must pass the allow-list, but any file name under the certificate
// path does, and every fetch is one outbound call that counts against the approval's
// max_calls_per_day (and writes an audit row). Without limits a few hundred forged posts would
// leave nothing for captures, refunds and read-backs. So this source:
//   - remembers a failed URL for 10 minutes (success is cached by URL for up to 24 h, see below);
//   - makes at most 6 fetches in any rolling hour of the injected clock, over all URLs; beyond that
//     it answers `unavailable` without calling the Transport (and does not remember that as a
//     failure of the URL);
//   - keeps the certificate cache least-recently-used, so a certificate that real deliveries keep
//     using is not pushed out by attacker URLs (at most 6 fetches an hour cannot fill 8 slots);
//   - bounds every map: 8 certificates, 32 remembered failures, and in-flight fetches (each one
//     holds a unit of the budget).
// Consequence: during an attack a legitimate delivery whose certificate is not cached yet is
// `unverifiable` (503) until the budget returns; PayPal retries for 3 days.
//
// Requirements on the callers (CO-3, the route):
//   - count every `unverifiable` that comes from a certificate failure in the per-IP limiter of
//     invalid webhook traffic (COST-3), exactly like a bad signature, so one address cannot keep
//     the budget empty;
//   - consider a safety budget for these fetches that is separate from the order and refund
//     budget (a scope or counter of its own), so that exhausting it cannot block money movement;
//   - after the first recorded delivery, tighten the allow-list to the one certificate URL (ASM-54).
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
/** Outbound certificate fetches over all URLs: at most this many in any rolling hour. */
export const CERT_FETCH_BUDGET_PER_HOUR = 6;
export const CERT_FETCH_WINDOW_MS = 60 * 60 * 1000;
/** A failed URL is not tried again for this long; at most this many failures are remembered. */
export const CERT_NEGATIVE_TTL_MS = 10 * 60 * 1000;
export const CERT_NEGATIVE_MAX_ENTRIES = 32;
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

/** URL-keyed LRU cache: expires at the earlier of `validTo` and 24 h, holds at most 8, evicts the least recently used. */
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
      entries.delete(url); // least-recently-used: a hit becomes the newest entry
      entries.set(url, e);
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
  /** test hooks; production uses the exported constants */
  limits?: { fetches_per_hour?: number; failures_max?: number };
}

export interface CertificateSourceStats {
  certificates: number;
  failures: number;
  in_flight: number;
  fetches_in_window: number;
}
export interface CertificateSourceWithStats extends CertificateSource {
  stats(): CertificateSourceStats;
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
 * Concurrent lookups of one URL share one fetch. See the header for the cost limits.
 */
export function createCertificateSource(d: CertificateSourceDeps): CertificateSourceWithStats {
  const cache = createCertCache(d.clock);
  const inflight = new Map<string, Promise<CertificateResult>>();
  const failures = new Map<string, { result: CertificateResult; until: number }>();
  const fetchTimes: number[] = [];
  const expected = d.expected_subjects ?? EXPECTED_CERT_SUBJECTS;
  const budget = d.limits?.fetches_per_hour ?? CERT_FETCH_BUDGET_PER_HOUR;
  const failuresMax = d.limits?.failures_max ?? CERT_NEGATIVE_MAX_ENTRIES;

  const purgeFetches = (now: number) => {
    // a fetch leaves the window at exactly one hour
    while (fetchTimes.length > 0 && (fetchTimes[0] as number) <= now - CERT_FETCH_WINDOW_MS)
      fetchTimes.shift();
  };
  const purgeFailures = (now: number) => {
    for (const [url, f] of failures) if (now >= f.until) failures.delete(url);
  };
  const rememberFailure = (url: string, result: CertificateResult) => {
    const now = d.clock.now().getTime();
    purgeFailures(now);
    failures.delete(url);
    while (failures.size >= failuresMax) {
      const oldest = failures.keys().next();
      if (oldest.done === true) break;
      failures.delete(oldest.value);
    }
    failures.set(url, { result, until: now + CERT_NEGATIVE_TTL_MS });
  };

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
      const now = d.clock.now().getTime();
      const failed = failures.get(url);
      if (failed !== undefined) {
        if (now < failed.until) return failed.result;
        failures.delete(url);
      }
      const pending = inflight.get(url);
      if (pending !== undefined) return pending;
      purgeFetches(now);
      if (fetchTimes.length >= budget) return unavailable('fetch');
      fetchTimes.push(now);
      const flight = fetchOne(url)
        .then((result) => {
          if (result.kind === 'unavailable') rememberFailure(url, result);
          return result;
        })
        .finally(() => {
          inflight.delete(url);
        });
      inflight.set(url, flight);
      return flight;
    },
    stats() {
      const now = d.clock.now().getTime();
      purgeFetches(now);
      purgeFailures(now);
      return {
        certificates: cache.size(),
        failures: failures.size,
        in_flight: inflight.size,
        fetches_in_window: fetchTimes.length,
      };
    },
  };
}
