// Builds the provider_calls row: request and response go through `redact` from @umsbx/obs, after
// a pre-pass that drops the payer-side blocks and the PayPal account id, which the shared
// redactor does not know by name. Tokens, secrets and emails never reach a record (nfr.md P7).
import { redact } from '@umsbx/obs';
import type { EnvironmentLabel, PayPalOperation } from '@umsbx/contracts';
import type { ProviderCallRecord } from './adapter';
import { isRecord } from './headers';

const DROP_KEYS: ReadonlySet<string> = new Set([
  'payment_source',
  'account_id',
  'payer_id',
  'payer',
]);
const MAX_TEXT = 8_000;

function scrub(v: unknown, depth = 0): unknown {
  if (depth > 12) return '[deep]';
  if (Array.isArray(v)) return v.map((x) => scrub(x, depth + 1));
  if (isRecord(v)) {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) {
      out[k] = DROP_KEYS.has(k.toLowerCase()) ? '[redacted]' : scrub(val, depth + 1);
    }
    return out;
  }
  if (typeof v === 'string' && v.length > MAX_TEXT) return `${v.slice(0, MAX_TEXT)}[truncated]`;
  return v;
}

const clean = (v: unknown): unknown => redact(scrub(v));

export function buildRecord(o: {
  operation: PayPalOperation;
  method: 'GET' | 'POST';
  path_template: string;
  http_status: number | null;
  outcome: string;
  debug_id: string | null;
  duration_ms: number;
  transport_kind: EnvironmentLabel;
  request: { headers: Record<string, string>; body: unknown };
  response: unknown;
}): ProviderCallRecord {
  return {
    operation: o.operation,
    method: o.method,
    path_template: o.path_template,
    http_status: o.http_status,
    outcome: o.outcome,
    debug_id: o.debug_id,
    duration_ms: o.duration_ms,
    transport_kind: o.transport_kind,
    request_redacted: clean(o.request),
    response_redacted: clean(o.response),
  };
}
