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
  outcome: 'enqueued' | 'no_op' | 'duplicate' | 'rejected' | 'unverifiable' | 'disabled';
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
}

export interface AllowedFacts {
  /** the webhook_enabled switch */
  switch_on: boolean;
  mode: 'offline' | 'sandbox';
  /** PAYPAL_WEBHOOK_ID; null when unset */
  webhook_id: string | null;
  /** the certificate pin (EXPECTED_CERT_SUBJECTS, ASM-64) is not empty */
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
