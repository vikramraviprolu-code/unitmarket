// The public webhook route's behaviour (CO-3; nfr.md P1, P2, COST-3, RLR-5). A webhook is a hint: the
// delivery is verified over its raw bytes, stored once, and makes one read-back due. It never sets
// paid, books money, grants access or calls PayPal. The composition root wires the three seams
// (verify, intake, allowed) to the PayPal adapter and to payments; this file imports contracts and
// the route wrapper's types only, so it can be tested without a database.
//
// What an answer says: 200 for a delivery that was verified (stored, duplicate or unknown order),
// 400 for one that was refused, 503 for one that could not be verified or while the webhook is off.
// The body is always empty and never says why a delivery was refused; the reason is in the audit
// row (hashed transmission id, no body) and in the log (class only).
//
// The learn window (CO-1d, D-038). While the owner's window is open (`learn.open()`), a delivery is
// answered 503 and ACTS ON NOTHING: it is not verified, not stored, not handed to intake and makes no
// read-back due. The only thing the app does is describe the certificate the delivery names and record
// its public facts (see createLearnRecorder). The window is checked before everything else, so an open
// window pauses webhook processing even if a complete pin exists; it ends by itself (config, 24 h cap).
import type { Clock, IsoUtc, Logger, WebhookVerdict } from '@umsbx/contracts';
import type { HttpResult } from '@umsbx/security';

export interface WebhookInput {
  /** The paypal-* request headers, as received (lower-case names). */
  headers: Record<string, string>;
  /** The body exactly as received: valid UTF-8, nothing parsed, nothing stripped. */
  raw_body: string;
}

/** Mirrors `WebhookResponse` of payments intake (domain/payments/src/webhooks.ts). */
export interface WebhookResponse {
  http: 200 | 400 | 503;
  outcome:
    | 'enqueued'
    | 'no_op'
    | 'duplicate'
    | 'rejected'
    | 'unverifiable'
    | 'disabled'
    /** CO-1d: answered during the learn window; nothing was verified or stored */
    | 'learning';
}

/** The public facts of a certificate that the learn window records, and nothing else (CO-1d). */
export interface LearnedFacts {
  host: string;
  path: string;
  subject: string;
  subject_cn: string | null;
  issuer: string;
  valid_from: string;
  valid_to: string;
  fingerprint_sha256: string;
}
export type LearnOutcome = 'recorded' | 'known' | 'nothing' | 'switch_off' | 'error';

export interface LearnWiring {
  /** true while the learn window is open (asked for every delivery, with the injected clock) */
  open(): boolean;
  /** Describe the delivery's certificate and record its facts. Receives the headers only, never the body. */
  record(headers: Record<string, string>): Promise<LearnOutcome>;
}

export interface WebhookWiring {
  clock: Clock;
  log: Logger;
  /** false: refuse before any verification, so a switched-off webhook fetches no certificate. */
  allowed(): Promise<boolean>;
  verify(w: WebhookInput): Promise<WebhookVerdict>;
  intake(i: {
    verdict: WebhookVerdict;
    transmission_id: string;
    received_at: IsoUtc;
  }): Promise<WebhookResponse>;
  /** CO-1d: absent when no window was configured. */
  learn?: LearnWiring;
}

export interface AllowedFacts {
  /** the webhook_enabled switch */
  switch_on: boolean;
  mode: 'offline' | 'sandbox';
  /** PAYPAL_WEBHOOK_ID; null when unset */
  webhook_id: string | null;
  /** the certificate pin (EXPECTED_CERT_PINS: exact host, subject and issuer, ASM-64) is complete */
  pin_set: boolean;
  /** a certificate source was injected (tests only; the app refuses it outside NODE_ENV=test) */
  injected_source: boolean;
}

/**
 * The webhook may verify a delivery only when the switch is on, a webhook id is configured and, in
 * sandbox mode with the real certificate source, the certificate pin is set (ASM-64: the webhook
 * stays disabled while the pin is empty). Otherwise the answer is 503 `disabled` before anything is
 * verified or fetched: PayPal retries for 3 days (RLR-5).
 */
export function webhookAllowed(f: AllowedFacts): boolean {
  if (!f.switch_on) return false;
  if (f.webhook_id === null || f.webhook_id === '') return false;
  if (f.mode === 'sandbox' && !f.injected_source && !f.pin_set) return false;
  return true;
}

const headerValue = (headers: Record<string, string>, name: string): string => {
  for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === name) return v;
  return '';
};

/** One delivery: check it may be verified, verify it over the raw bytes, hand the verdict to intake. */
export async function receiveWebhook(w: WebhookWiring, d: WebhookInput): Promise<WebhookResponse> {
  if (w.learn?.open() === true) {
    // Learn only. Nothing below this block runs: no allowed(), no verify(), no intake().
    let learn: LearnOutcome;
    try {
      learn = await w.learn.record(d.headers);
    } catch (e) {
      learn = 'error';
      w.log.log({
        msg: 'webhook.learn_error',
        level: 'error',
        fields: { err_name: e instanceof Error ? e.name : 'unknown' },
      });
    }
    const answer: WebhookResponse = { http: 503, outcome: 'learning' };
    w.log.log({
      msg: 'webhook.delivery',
      level: 'warn',
      fields: { ...answer, verdict: 'not_checked', learn },
    });
    return answer;
  }
  if (!(await w.allowed())) {
    const off: WebhookResponse = { http: 503, outcome: 'disabled' };
    w.log.log({
      msg: 'webhook.delivery',
      level: 'warn',
      fields: { ...off, verdict: 'not_checked' },
    });
    return off;
  }
  let verdict: WebhookVerdict;
  try {
    verdict = await w.verify(d);
  } catch (e) {
    // The verifier does not throw; if it ever does, the delivery is retried, never accepted.
    w.log.log({
      msg: 'webhook.verify_error',
      level: 'error',
      fields: { err_name: e instanceof Error ? e.name : 'unknown' },
    });
    verdict = { kind: 'unverifiable' };
  }
  const res = await w.intake({
    verdict,
    transmission_id: headerValue(d.headers, 'paypal-transmission-id'),
    received_at: w.clock.now().toISOString() as IsoUtc,
  });
  // Class only. Never the body, the signature, the transmission id or the certificate URL.
  w.log.log({
    msg: 'webhook.delivery',
    level: res.http === 200 ? 'info' : 'warn',
    fields: {
      http: res.http,
      outcome: res.outcome,
      verdict: verdict.kind,
      ...(verdict.kind === 'bad_signature' ? { why: verdict.why } : {}),
    },
  });
  return res;
}

/** The HTTP answer for a response. Empty body; one code per class, so a refusal never says why. */
export function answerFor(r: WebhookResponse): HttpResult<Record<string, never>> {
  if (r.http === 200) return { status: 200, body: {} };
  if (r.http === 400)
    return { status: 400, code: 'rejected', message: 'The delivery was refused.' };
  // 503 unverifiable and 503 disabled alike: both are charged to the limiter (no opt-out).
  return { status: 503, code: 'unavailable', message: 'Try again later.' };
}

/** At most this many distinct certificates are recorded per process (the audit log cannot be filled this way). */
export const LEARN_MAX_CERTIFICATES = 8;

export interface LearnPorts {
  log: Logger;
  /** the `webhook_enabled` switch: off means nothing is fetched and nothing is recorded */
  switchOn(): Promise<boolean>;
  /** describe the certificate named by the delivery's headers (null: nothing to describe) */
  lookup(headers: Record<string, string>): Promise<LearnedFacts | null>;
  /** one `audit_log` row, in a transaction of its own */
  audit(f: LearnedFacts): Promise<void>;
}

/**
 * The learn window's recorder (CO-1d). For a delivery: webhook switch on, a certificate described, not
 * yet recorded in this process -> one audit row, then one log line, both holding exactly the eight
 * facts. The same certificate again (same host, path and fingerprint) is `known`: no row. After
 * LEARN_MAX_CERTIFICATES rows nothing more is looked up. An audit failure is `error` and is retried by
 * the next delivery; the log line is written only after the row is.
 */
export function createLearnRecorder(
  p: LearnPorts,
): (headers: Record<string, string>) => Promise<LearnOutcome> {
  const recorded = new Set<string>();
  return async (headers) => {
    try {
      if (!(await p.switchOn())) return 'switch_off';
      if (recorded.size >= LEARN_MAX_CERTIFICATES) return 'nothing';
      const found = await p.lookup(headers);
      if (found === null) return 'nothing';
      // exactly the eight facts, whatever the lookup handed back
      const facts: LearnedFacts = {
        host: found.host,
        path: found.path,
        subject: found.subject,
        subject_cn: found.subject_cn,
        issuer: found.issuer,
        valid_from: found.valid_from,
        valid_to: found.valid_to,
        fingerprint_sha256: found.fingerprint_sha256,
      };
      const key = `${facts.host}${facts.path}|${facts.fingerprint_sha256}`;
      if (recorded.has(key)) return 'known';
      recorded.add(key); // before the first await below, so two deliveries at once write one row
      try {
        await p.audit(facts);
      } catch (e) {
        recorded.delete(key);
        throw e;
      }
      p.log.log({ msg: 'webhook.cert_learned', level: 'info', fields: { ...facts } });
      return 'recorded';
    } catch {
      return 'error';
    }
  };
}
