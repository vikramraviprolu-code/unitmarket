// Idempotency keys (nfr.md P3, architecture 5). A key is derived from the order reference, which
// is persisted before the call and reused on every retry; the same reference always gives the same
// key. PayPal-Request-Id allows 108 characters.
import type { Id } from '@umsbx/contracts';

export const MAX_REQUEST_ID_LENGTH = 108;
const PREFIX = { create: 'umsC-', capture: 'umsK-', refund: 'umsR-' } as const;

export function requestIdFor(kind: 'create' | 'capture' | 'refund', ref: Id): string {
  if (ref.length === 0) throw new RangeError('requestIdFor: empty reference');
  const key = `${PREFIX[kind]}${ref}`;
  if (key.length > MAX_REQUEST_ID_LENGTH) {
    throw new RangeError(`requestIdFor: key longer than ${MAX_REQUEST_ID_LENGTH} characters`);
  }
  return key;
}

/** Request id of the internal read-back operation row. It is never sent to PayPal. */
export function readbackKeyFor(ref: Id): string {
  return `umsB-${ref}`;
}
