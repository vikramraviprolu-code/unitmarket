// Error map (architecture 9.1). Maps by HTTP status first, then by the documented `issue` name.
// Never by message or description text: the docs warn they can change.
import type { PayPalFail } from '@umsbx/contracts';
import { debugIdOf, getHeader, isApprovalUrl, isRecord, linkHref } from './headers';

// 422 issues that send the buyer back to PayPal on the same order.
const PAYER_ACTION = new Set([
  'PAYER_ACTION_REQUIRED',
  'INSTRUMENT_DECLINED',
  'REDIRECT_PAYER_FOR_ALTERNATE_FUNDING',
]);

const NAME = /^[A-Za-z0-9_.: -]{1,128}$/;
const ISSUE = /^[A-Za-z0-9_.:-]{1,128}$/;
const MAX_RETRY_MS = 24 * 60 * 60 * 1000;

/** Retry-After in whole seconds to milliseconds; anything else is null (dates are not parsed). */
function retryAfterMs(headers: Record<string, string>): number | null {
  const v = getHeader(headers, 'retry-after');
  if (v === null || !/^[0-9]{1,9}$/.test(v.trim())) return null;
  return Math.min(Number(v.trim()) * 1000, MAX_RETRY_MS);
}

function issuesOf(body: unknown): string[] {
  if (!isRecord(body) || !Array.isArray(body.details)) return [];
  const out: string[] = [];
  for (const d of body.details as unknown[]) {
    if (isRecord(d) && typeof d.issue === 'string' && ISSUE.test(d.issue)) out.push(d.issue);
  }
  return out;
}

function nameOf(status: number, body: unknown): string {
  if (isRecord(body)) {
    if (typeof body.name === 'string' && NAME.test(body.name)) return body.name;
    if (typeof body.error === 'string' && NAME.test(body.error)) return body.error;
  }
  return `HTTP_${status}`;
}

export function mapError(
  status: number,
  body: unknown,
  headers: Record<string, string>,
): PayPalFail {
  const debug_id = debugIdOf(headers, body);

  // Retry later: auth failure (after the adapter's one refresh), timeouts, rate limit, server errors.
  if (status === 401 || status === 408) return { kind: 'unavailable', retry_after_ms: null };
  if (status === 429 || (status >= 500 && status <= 599)) {
    return { kind: 'unavailable', retry_after_ms: retryAfterMs(headers) };
  }
  if (status === 404) return { kind: 'not_found', debug_id };
  if (status === 409) return { kind: 'in_progress', debug_id };

  if (status === 400 || status === 403 || status === 422) {
    const issues = issuesOf(body);
    if (status === 422 && issues.some((i) => PAYER_ACTION.has(i))) {
      const pa = linkHref(body, 'payer-action');
      const rd = linkHref(body, 'redirect');
      const chosen = isApprovalUrl(pa) ? pa : isApprovalUrl(rd) ? rd : null;
      return { kind: 'payer_action', redirect_url: chosen, debug_id };
    }
    return {
      kind: 'rejected',
      http: status,
      name: nameOf(status, body),
      issue: issues[0] ?? null,
      debug_id,
    };
  }

  // Any other 4xx is a client error we did not send on purpose: treat like a malformed request.
  if (status >= 400 && status <= 499) {
    return {
      kind: 'rejected',
      http: 400,
      name: nameOf(status, body),
      issue: issuesOf(body)[0] ?? null,
      debug_id,
    };
  }

  // 1xx, 2xx, 3xx and anything else are not answers we understand: outcome unknown.
  return { kind: 'unavailable', retry_after_ms: null };
}
