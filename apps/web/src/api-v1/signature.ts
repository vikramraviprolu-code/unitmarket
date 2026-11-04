// API-C (E2): the webhook signature. Every delivery carries
//   UnitMarket-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>
// The key is the subscription's signing secret as text (the whole "whsec_..." string, UTF-8). The time is
// part of the signed message, so an old delivery cannot be replayed with a new time. verifySignature is
// what a receiver runs; it is here so tests and docs show the exact rule. It never throws, refuses a
// malformed header, compares in constant time and only buffers of equal length, and rejects a time outside
// the tolerance before it compares anything.
import { createHmac, timingSafeEqual } from 'node:crypto';

export const SIGNATURE_HEADER = 'UnitMarket-Signature';
export const EVENT_ID_HEADER = 'UnitMarket-Event-Id';
/** How far the signed time may be from the receiver's clock, in seconds, either way. */
export const DEFAULT_TOLERANCE_S = 300;

const MAC_BYTES = 32;
const HEX_MAC = /^[0-9a-f]{64}$/;
const DIGITS = /^[0-9]{1,15}$/;

function mac(secret: string, t: number, body: string): Buffer {
  return createHmac('sha256', Buffer.from(secret, 'utf8'))
    .update(`${String(t)}.${body}`)
    .digest();
}

/** The hex HMAC-SHA256 over "<t>.<body>" keyed by the secret text. */
export function signPayload(secret: string, t: number, body: string): string {
  return mac(secret, t, body).toString('hex');
}

/** The header value: `t=<t>,v1=<hex>`. */
export function signatureHeader(secret: string, t: number, body: string): string {
  return `t=${String(t)},v1=${signPayload(secret, t, body)}`;
}

/**
 * Does `header` sign `raw_body` with `secret`, at a time within `tolerance_s` seconds of `now`? A header may
 * hold several v1 values (key rotation); any one that matches is enough. Unknown fields are ignored.
 */
export function verifySignature(
  secret: string,
  header: string,
  raw_body: string,
  now: Date,
  tolerance_s: number = DEFAULT_TOLERANCE_S,
): boolean {
  try {
    // Fail closed: a clock or tolerance that is not a usable number would make every comparison
    // below false and skip the time check, so refuse before reading the header.
    if (!Number.isFinite(now.getTime())) return false;
    if (!Number.isFinite(tolerance_s) || tolerance_s < 0) return false;
    let t: number | null = null;
    const candidates: string[] = [];
    for (const part of String(header).split(',')) {
      const cut = part.indexOf('=');
      if (cut < 0) continue;
      const key = part.slice(0, cut).trim();
      const value = part.slice(cut + 1).trim();
      if (key === 't') {
        if (t !== null || !DIGITS.test(value)) return false;
        t = Number(value);
      } else if (key === 'v1') {
        candidates.push(value);
      }
    }
    if (t === null || candidates.length === 0) return false;
    if (Math.abs(Math.floor(now.getTime() / 1000) - t) > tolerance_s) return false;
    const expected = mac(secret, t, raw_body);
    let matched = false;
    for (const hex of candidates) {
      if (!HEX_MAC.test(hex)) continue;
      const given = Buffer.from(hex, 'hex');
      if (given.length === MAC_BYTES && timingSafeEqual(given, expected)) matched = true;
    }
    return matched;
  } catch {
    return false;
  }
}
