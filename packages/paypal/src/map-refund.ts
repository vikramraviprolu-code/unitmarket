import { RefundStatusSchema } from '@umsbx/contracts';
import type { RefundRes } from '@umsbx/contracts';
import { mapError } from './errors';
import { debugIdOf, isRecord } from './headers';
import type { Http, Mapped } from './shapes';
import { moneyOf } from './map-order';

const unreadable: RefundRes = { kind: 'unavailable', retry_after_ms: null };

function captureIdFromUp(body: Record<string, unknown>): string | null {
  if (!Array.isArray(body.links)) return null;
  for (const l of body.links as unknown[]) {
    if (isRecord(l) && l.rel === 'up' && typeof l.href === 'string') {
      const m = /\/v2\/payments\/captures\/([A-Z0-9]{1,36})$/.exec(l.href);
      if (m?.[1]) return m[1];
    }
  }
  return null;
}

/** Refund create (200 or 201) and refund read (200) share one shape. */
export function mapRefund(h: Http): Mapped<RefundRes> {
  if (h.status !== 200 && h.status !== 201) {
    return {
      result:
        h.status >= 200 && h.status <= 299 ? unreadable : mapError(h.status, h.body, h.headers),
    };
  }
  const b = h.body;
  const status = isRecord(b) ? RefundStatusSchema.safeParse(b.status) : null;
  const amount = isRecord(b) ? moneyOf(b.amount) : null;
  if (
    !isRecord(b) ||
    typeof b.id !== 'string' ||
    !/^[A-Za-z0-9]{1,64}$/.test(b.id) ||
    !status?.success ||
    amount === null
  ) {
    return { result: unreadable, notes: ['malformed_response'] };
  }
  return {
    result: {
      kind: 'refund',
      refund_id: b.id,
      status: status.data,
      amount,
      capture_id: captureIdFromUp(b),
      debug_id: debugIdOf(h.headers, b),
    },
  };
}
