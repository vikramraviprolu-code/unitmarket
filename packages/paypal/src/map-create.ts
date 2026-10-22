import { ProviderOrderIdSchema, ProviderOrderStatusSchema } from '@umsbx/contracts';
import type { CreateOrderRes } from '@umsbx/contracts';
import { mapError } from './errors';
import { debugIdOf, isApprovalUrl, isRecord, linkHref } from './headers';
import type { Http, Mapped } from './shapes';

const unreadable: CreateOrderRes = { kind: 'unavailable', retry_after_ms: null };

/** `payer-action` first, else `approve`; refused unless https on the sandbox approval host. */
export function mapCreate(h: Http): Mapped<CreateOrderRes> {
  if (h.status < 200 || h.status > 299) return { result: mapError(h.status, h.body, h.headers) };
  if (h.status !== 200 && h.status !== 201 && h.status !== 202) return { result: unreadable };

  const body = h.body;
  const id = isRecord(body) ? ProviderOrderIdSchema.safeParse(body.id) : null;
  const status = isRecord(body) ? ProviderOrderStatusSchema.safeParse(body.status) : null;
  if (!id?.success || !status?.success) {
    // 202: accepted, handled asynchronously, nothing usable yet: unknown, retry with the same key
    return {
      result:
        h.status === 202
          ? { kind: 'in_progress', debug_id: debugIdOf(h.headers, body) }
          : unreadable,
    };
  }
  const debug_id = debugIdOf(h.headers, body);
  const href = linkHref(body, 'payer-action') ?? linkHref(body, 'approve');
  if (!isApprovalUrl(href)) {
    return {
      result: {
        kind: 'rejected',
        http: 422,
        name: 'APPROVE_LINK_INVALID',
        issue: href === undefined ? 'MISSING' : 'HOST_NOT_ALLOWED',
        debug_id,
      },
    };
  }
  return {
    result: {
      kind: 'created',
      provider_order_id: id.data,
      status: status.data,
      approve_url: href,
      debug_id,
    },
  };
}
