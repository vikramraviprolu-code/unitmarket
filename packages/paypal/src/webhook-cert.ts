// Webhook signing certificate: fetched through the Transport as `fetch_webhook_cert` (so every lock
// and the egress guard apply), parsed with node:crypto, checked for its dates and its key type, and
// cached by URL. Nothing here decides whether a webhook is genuine; webhook-verify.ts does.
//
// Every failure is `unavailable`: the verdict is then `unverifiable` (HTTP 503, PayPal retries) and
// is never recorded as a forgery (nfr.md P1).
//
// Cost control (review of CO-1, H1; CO-1b). The webhook route is public, and the certificate URL is
// read from a request header. The URL must pass the allow-list, but any file name under the
// certificate path does, and every fetch is one outbound call that counts against the approval's
// max_calls_per_day (and writes an audit row). Without limits a few hundred forged posts would
// leave nothing for captures, refunds and read-backs, and a patient attacker could keep the
// legitimate URL from ever being fetched. So this source:
//   - remembers a failed URL for 10 minutes (success is cached by URL for up to 24 h);
//   - keeps the certificate cache least-recently-used, so a certificate that real deliveries keep
//     using is not pushed out by a few attacker URLs;
//   - bounds every map: 8 certificates, 32 remembered failures, 4 trusted URLs, and in-flight
//     fetches (each one holds a unit of a budget);
//   - splits the fetch budget by who is asking (all windows roll by the injected clock; a fetch
//     leaves a window at exactly its length; a refused lookup makes no Transport call and is not
//     remembered as a failure of the URL):
//       trusted URL    a URL that has already verified a delivery (see trust() below) has a
//                      budget of its own: 1 fetch in any hour and 4 in any 24 hours, so a trusted
//                      URL that has died can burn only its own slots and never another trusted
//                      URL's; no unknown URL can use it, and it does not use the budget below;
//       unknown URL    while nothing is trusted yet (first delivery, after a restart, after the
//                      trusted entries expired): at most 6 fetches an hour, as in CO-1;
//                      once any URL is trusted: at most 1 fetch an hour and 12 in any rolling 24
//                      hours (this daily count includes fetches made while cold).
//     Worst case once a URL is trusted, whatever the posting rate: 12 calls a day for unknown URLs
//     plus 4 for each of at most 4 trusted URLs, 28 a day in all. (Before this split the shared pool
//     let one dead trusted URL starve the live one.) A live trusted certificate is refreshed about
//     once a day, from its own budget. Before the first verified delivery (or after a restart) the
//     CO-1 limit of 6 an hour, about 144 a day, is all that stands in the way; the owner's first
//     run is what trusts the real URL.
// trust(url) is called by the verifier only after a signature has verified. A trusted URL is kept
// until the certificate's end date or 7 days (a later verified delivery extends it), at most 4 at
// a time (PayPal rotates certificate files: a new verified URL replaces the oldest), and the list
// is memory only, so a restart clears it.
// Consequence: while an attack runs, a legitimate delivery that arrives with an unknown URL (a
// rotated certificate) can be `unverifiable` (503) for as long as the attack lasts: the unknown
// budget is 1 an hour and 12 a day and an attacker can use it first every time. PayPal retries
// for 3 days, so a rotation under a sustained attack is lost until the attack stops or the pin
// (the expected URL or subject, ASM-64) is updated by the owner. The route should alert on
// webhook silence (no verified delivery for longer than expected) so this is noticed.
//
// Requirements on the callers (CO-3, the route):
//   - the per-IP limiter for invalid webhook traffic (COST-3) keeps the audit log from filling
//     and should count certificate-failure `unverifiable` like a bad signature, but it does NOT
//     protect the fetch budget: 6 posts an hour is under any per-IP limit, and an attacker can
//     use many addresses. The protection of the budget is the split above;
//   - consider a safety budget for these fetches that is separate from the order and refund
//     budget (a scope or counter of its own), so that exhausting it cannot block money movement;
//   - pin the certificate host after the first recorded delivery (ASM-54); known URLs already get
//     priority here, and the exact file name is not pinned because PayPal rotates certificate files.
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
  /**
   * Called by the verifier after a signature made with the certificate at `url` has verified. The
   * URL then gets the reserved budget (see the header). Optional: a source without a budget need
   * not implement it.
   */
  trust?(url: string): void;
}

/** Cached certificates: at most this many, each for at most this long (or until `validTo`). */
export const CERT_CACHE_MAX_ENTRIES = 8;
export const CERT_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** A PEM answer larger than this is refused unread (a certificate is about 2 KB). */
export const MAX_CERT_BYTES = 64 * 1024;
/** Outbound certificate fetches over all URLs: at most this many in any rolling hour. */
export const CERT_FETCH_BUDGET_PER_HOUR = 6;
export const CERT_FETCH_WINDOW_MS = 60 * 60 * 1000;
/** CO-1b. Once a URL is trusted, unknown URLs: this many an hour and this many a rolling day. */
export const CERT_UNKNOWN_FETCHES_PER_HOUR = 1;
export const CERT_UNKNOWN_FETCHES_PER_DAY = 12;
export const CERT_DAY_MS = 24 * 60 * 60 * 1000;
/** CO-1b, CO-1c. Trusted URLs: at most this many, each for at most this long. */
export const CERT_TRUSTED_MAX_URLS = 4;
export const CERT_TRUSTED_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** CO-1c. Each trusted URL has its own budget: this many fetches in any hour and in any 24 hours. */
export const CERT_TRUSTED_FETCHES_PER_URL_PER_HOUR = 1;
export const CERT_TRUSTED_FETCHES_PER_URL_PER_DAY = 4;
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
      // the map is not empty here (size >= 8), so the first key is the least recently used
      while (entries.size >= CERT_CACHE_MAX_ENTRIES)
        entries.delete(entries.keys().next().value as string);
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
  /** fetches in the last hour, trusted and unknown together */
  fetches_in_window: number;
  /** unknown-URL fetches in the last 24 hours */
  unknown_fetches_today: number;
  /** trusted URLs, oldest first */
  trusted_urls: string[];
  /** fetch times kept for trusted URLs (at most 4 for each of at most 4 URLs) */
  trusted_fetch_records: number;
}
export interface CertificateSourceWithStats extends CertificateSource {
  trust(url: string): void;
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
  const unknownTimes: number[] = []; // unknown-URL fetches, last 24 h (at most 144 while cold)
  const trustedFetches = new Map<string, number[]>(); // per trusted URL, last 24 h (at most 4 each)
  const trusted = new Map<string, number>(); // url -> end of trust, oldest first
  const expected = d.expected_subjects ?? EXPECTED_CERT_SUBJECTS;
  const coldBudget = d.limits?.fetches_per_hour ?? CERT_FETCH_BUDGET_PER_HOUR;
  const failuresMax = d.limits?.failures_max ?? CERT_NEGATIVE_MAX_ENTRIES;

  /** drop the fetch times that have left a window of `length` ms (at exactly that age) */
  const dropOld = (times: number[], now: number, length: number) => {
    while (times.length > 0 && (times[0] as number) <= now - length) times.shift();
  };
  const purgeTrusted = (now: number) => {
    for (const [url, until] of trusted)
      if (now > until) {
        trusted.delete(url);
        trustedFetches.delete(url);
      }
  };
  const inLastHour = (times: number[], now: number) =>
    times.filter((t) => t > now - CERT_FETCH_WINDOW_MS).length;
  /** true and the fetch is counted, or false and nothing is counted */
  const admit = (url: string, now: number): boolean => {
    purgeTrusted(now);
    if (trusted.has(url)) {
      // a trusted URL has a budget of its own, so a dead one can only spend its own fetches
      const times = trustedFetches.get(url) ?? [];
      dropOld(times, now, CERT_DAY_MS);
      if (
        inLastHour(times, now) >= CERT_TRUSTED_FETCHES_PER_URL_PER_HOUR ||
        times.length >= CERT_TRUSTED_FETCHES_PER_URL_PER_DAY
      )
        return false;
      times.push(now);
      trustedFetches.set(url, times);
      return true;
    }
    dropOld(unknownTimes, now, CERT_DAY_MS);
    const lastHour = inLastHour(unknownTimes, now);
    const refused =
      trusted.size === 0
        ? lastHour >= coldBudget
        : lastHour >= CERT_UNKNOWN_FETCHES_PER_HOUR ||
          unknownTimes.length >= CERT_UNKNOWN_FETCHES_PER_DAY;
    if (refused) return false;
    unknownTimes.push(now);
    return true;
  };
  const purgeFailures = (now: number) => {
    for (const [url, f] of failures) if (now >= f.until) failures.delete(url);
  };
  const rememberFailure = (url: string, result: CertificateResult) => {
    const now = d.clock.now().getTime();
    purgeFailures(now);
    failures.delete(url);
    // failuresMax is at least 1, so the map is not empty here and the first key is the oldest
    while (failures.size >= failuresMax) failures.delete(failures.keys().next().value as string);
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
      if (!admit(url, now)) return unavailable('fetch');
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
    trust(raw) {
      const checked = guard({ ...requestFor(raw), path: raw }, 'sandbox');
      if (!checked.ok) return;
      const url = checked.url.href;
      const now = d.clock.now().getTime();
      purgeTrusted(now);
      // until the certificate's end date, or 7 days from now when it is not at hand, whichever is first
      const end = cache.get(url)?.valid_to.getTime() ?? now + CERT_TRUSTED_MAX_AGE_MS;
      trusted.delete(url);
      // the map is not empty here (size >= 4), so the first key is the oldest
      while (trusted.size >= CERT_TRUSTED_MAX_URLS) {
        const oldest = trusted.keys().next().value as string;
        trusted.delete(oldest);
        trustedFetches.delete(oldest);
      }
      trusted.set(url, Math.min(end, now + CERT_TRUSTED_MAX_AGE_MS));
    },
    stats() {
      const now = d.clock.now().getTime();
      dropOld(unknownTimes, now, CERT_DAY_MS);
      purgeFailures(now);
      purgeTrusted(now);
      let trustedInHour = 0;
      let trustedRecords = 0;
      for (const times of trustedFetches.values()) {
        dropOld(times, now, CERT_DAY_MS);
        trustedInHour += inLastHour(times, now);
        trustedRecords += times.length;
      }
      return {
        certificates: cache.size(),
        failures: failures.size,
        in_flight: inflight.size,
        fetches_in_window: inLastHour(unknownTimes, now) + trustedInHour,
        unknown_fetches_today: unknownTimes.length,
        trusted_urls: [...trusted.keys()],
        trusted_fetch_records: trustedRecords,
      };
    },
  };
}
