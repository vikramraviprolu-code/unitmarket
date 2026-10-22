// Idempotency keys (nfr.md P3, architecture 5). A key is derived from the order reference, which
// is persisted before the call and reused on every retry; the same reference always gives the same
// key. PayPal-Request-Id allows 108 characters.
import type { Id } from '@umsbx/contracts';

export const MAX_REQUEST_ID_LENGTH = 108;
const PREFIX = { create: 'umsC-', capture: 'umsK-', refund: 'umsR-' } as const;

/**
 * The key of the nth capture attempt. The first attempt keeps the plain key; a later attempt gets
 * a suffix. PayPal replays the stored answer for a key it has seen (6 h), so a new try after a
 * definitive answer such as payer_action needs a new key (D-014).
 */
export function requestIdFor(kind: 'create' | 'capture' | 'refund', ref: Id, attempt = 1): string {
  if (ref.length === 0) throw new RangeError('requestIdFor: empty reference');
  if (!Number.isInteger(attempt) || attempt < 1) throw new RangeError('requestIdFor: attempt');
  const key = `${PREFIX[kind]}${ref}${attempt === 1 ? '' : `-${attempt}`}`;
  if (key.length > MAX_REQUEST_ID_LENGTH) {
    throw new RangeError(`requestIdFor: key longer than ${MAX_REQUEST_ID_LENGTH} characters`);
  }
  return key;
}

/** Request id of the internal read-back operation row. It is never sent to PayPal. */
export function readbackKeyFor(ref: Id): string {
  return `umsB-${ref}`;
}
