import { z } from 'zod';
import { GateVerdictSchema, OutboundRequestSchema } from '@umsbx/contracts';
import type {
  BlockReason,
  Clock,
  Logger,
  PayPalOperation,
  Transport,
  TransportResult,
} from '@umsbx/contracts';
import { guard } from './guard';
import { createFetchWire } from './wire-fetch';
import { MAX_RESPONSE_BYTES } from './wire-map';
import type { ScopedGate, Wire, WireRequest } from './wire';

// ---------------------------------------------------------------------------------------------
// The sealed stub (MVP-A behaviour, still what composition builds in this branch).
// ---------------------------------------------------------------------------------------------

// No code path through this function can reach a network.
export function createSandboxTransport(): Transport {
  return {
    kind: 'sandbox',
    send: async () => ({ kind: 'blocked', by: 'connect_off' }),
  };
}

// ---------------------------------------------------------------------------------------------
// The approved sandbox transport (lane B-L1). Built only from a gate that reports an active
// approval for the scope. Every request passes, in this order: schema, egress guard, header and
// body rules, outbound gate, and only then the Wire. It never retries. It never follows a
// redirect. It never records a credential.
// ---------------------------------------------------------------------------------------------

export class SandboxSealedError extends Error {
  constructor(reason: string) {
    super(`sandbox transport stays sealed: ${reason}`);
    this.name = 'SandboxSealedError';
  }
}

export interface SandboxCall {
  operation: PayPalOperation;
  method: 'GET' | 'POST';
  /** The guard-normalised href, or null when the request was refused before the guard passed. */
  url: string | null;
  /** The headers that went (or would have gone) to the Wire, with credentials redacted. */
  headers: Record<string, string>;
  status: number | null;
  outcome: 'response' | 'timeout' | `network_error:${string}` | `blocked:${BlockReason}`;
}

export interface SandboxTransport extends Transport {
  readonly kind: 'sandbox';
  /** A copy of the last calls (at most 500), oldest first. Credentials are redacted. */
  calls(): SandboxCall[];
}

export interface ApprovedSandboxOptions {
  gate: ScopedGate;
  /** The approval scope this transport serves, e.g. `mvp_b_polling`. */
  scope: string;
  clock: Clock;
  log: Logger;
  /** Tests inject a fake. Omitted: the production Wire. */
  wire?: Wire;
}

/** Hard total deadline per request (architecture 7 point 6). */
export const REQUEST_TIMEOUT_MS = 10_000;
/** Largest request body the transport will send. */
export const MAX_REQUEST_BODY_BYTES = 64 * 1024;
const MAX_KEPT_CALLS = 500;
const MAX_HEADER_VALUE = 4096;

// Headers the PayPal adapter needs. Everything else is dropped, including Host,
// X-HTTP-Method-Override, Cookie, Content-Length, Transfer-Encoding and Connection.
const ALLOWED_HEADERS: ReadonlySet<string> = new Set([
  'authorization',
  'accept',
  'content-type',
  'prefer',
  'paypal-request-id',
]);
const SENSITIVE_HEADERS: ReadonlySet<string> = new Set(['authorization']);
const HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/;
const HEADER_VALUE = /^[\x20-\x7e]*$/;

const WireResultSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('response'),
      status: z.number().int().min(100).max(599),
      headers: z.record(z.string(), z.string()),
      body: z.string(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('error'),
      error: z.enum([
        'timeout',
        'dns',
        'connect',
        'tls',
        'reset',
        'redirect',
        'too_large',
        'aborted',
        'other',
      ]),
    })
    .strict(),
]);

/** The headers to send, lower-cased, or null when the set is unsafe or ambiguous. */
function selectHeaders(h: Record<string, string>): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(h)) {
    if (!HEADER_NAME.test(name)) return null;
    const key = name.toLowerCase();
    if (!ALLOWED_HEADERS.has(key)) continue;
    if (!HEADER_VALUE.test(value) || value.length > MAX_HEADER_VALUE) return null;
    if (Object.hasOwn(out, key)) return null;
    out[key] = value;
  }
  return out;
}

function redactHeaders(h: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(h).map(([k, v]) => [k, SENSITIVE_HEADERS.has(k) ? '[redacted]' : v]),
  );
}

const refuse = (): TransportResult => ({ kind: 'blocked', by: 'egress' });

export async function createApprovedSandboxTransport(
  o: ApprovedSandboxOptions,
): Promise<SandboxTransport> {
  if (typeof o !== 'object' || o === null) throw new SandboxSealedError('no options');
  const gate: unknown = o.gate;
  if (
    typeof gate !== 'object' ||
    gate === null ||
    typeof (gate as { check?: unknown }).check !== 'function' ||
    typeof (gate as { activeApproval?: unknown }).activeApproval !== 'function'
  ) {
    throw new SandboxSealedError('no gate that reports an approval');
  }
  if (typeof o.scope !== 'string' || o.scope === '') throw new SandboxSealedError('no scope');
  let active: unknown;
  try {
    active = await o.gate.activeApproval();
  } catch {
    throw new SandboxSealedError('approval lookup failed');
  }
  const a = active as { scope?: unknown; approval_ref?: unknown } | null;
  if (
    typeof a !== 'object' ||
    a === null ||
    a.scope !== o.scope ||
    typeof a.approval_ref !== 'string' ||
    a.approval_ref === ''
  ) {
    throw new SandboxSealedError('no active approval for this scope');
  }

  const { gate: outbound, clock, log } = o;
  const wire = o.wire ?? createFetchWire();
  const kept: SandboxCall[] = [];

  const finish = (
    call: Omit<SandboxCall, 'outcome' | 'status'>,
    result: TransportResult,
  ): TransportResult => {
    const outcome: SandboxCall['outcome'] =
      result.kind === 'blocked'
        ? `blocked:${result.by}`
        : result.kind === 'network_error'
          ? `network_error:${result.code}`
          : result.kind;
    const status = result.kind === 'response' ? result.status : null;
    kept.push({ ...call, outcome, status });
    if (kept.length > MAX_KEPT_CALLS) kept.shift();
    log.log({
      msg: 'sandbox.send',
      level: 'info',
      fields: { operation: call.operation, outcome, status },
    });
    return result;
  };

  return {
    kind: 'sandbox',
    calls: () => kept.map((c) => ({ ...c, headers: { ...c.headers } })),
    async send(raw): Promise<TransportResult> {
      // One read of the caller's object: later changes to it cannot alter what was validated.
      const parsed = OutboundRequestSchema.safeParse(raw);
      if (!parsed.success) {
        log.log({ msg: 'sandbox.send', level: 'info', fields: { outcome: 'blocked:egress' } });
        return refuse();
      }
      const r = parsed.data;
      const base = { operation: r.operation, method: r.method, url: null, headers: {} };

      const checked = guard(r, 'sandbox');
      if (!checked.ok) return finish(base, refuse());
      const url = checked.url.href;

      const headers = selectHeaders(r.headers);
      const bodyOk =
        r.method === 'GET'
          ? r.body === null
          : r.body !== null && Buffer.byteLength(r.body) <= MAX_REQUEST_BODY_BYTES;
      if (headers === null || !bodyOk) return finish({ ...base, url }, refuse());
      const seen = { ...base, url, headers: redactHeaders(headers) };

      let verdict;
      try {
        verdict = GateVerdictSchema.safeParse(
          await outbound.check({ operation: r.operation, amount_minor: r.amount_minor }),
        );
      } catch {
        return finish(seen, { kind: 'blocked', by: 'kill_switch' });
      }
      if (!verdict.success) return finish(seen, { kind: 'blocked', by: 'kill_switch' });
      if (!verdict.data.allowed) return finish(seen, { kind: 'blocked', by: verdict.data.by });

      const out: WireRequest = {
        method: r.method,
        url,
        headers,
        body: r.body,
        timeout_ms: REQUEST_TIMEOUT_MS,
      };
      const started = clock.now().getTime();
      let answer;
      try {
        answer = WireResultSchema.safeParse(await wire.request(out));
      } catch {
        return finish(seen, { kind: 'network_error', code: 'wire_failure' });
      }
      if (!answer.success) return finish(seen, { kind: 'network_error', code: 'wire_failure' });
      const w = answer.data;

      if (w.kind === 'error') {
        if (w.error === 'timeout') return finish(seen, { kind: 'timeout' });
        const code = w.error === 'too_large' ? 'response_too_large' : w.error;
        return finish(seen, { kind: 'network_error', code });
      }
      // A redirect is never followed, whatever the Wire did.
      if (w.status >= 300 && w.status <= 399) {
        return finish(seen, { kind: 'network_error', code: 'redirect' });
      }
      if (Buffer.byteLength(w.body) > MAX_RESPONSE_BYTES) {
        return finish(seen, { kind: 'network_error', code: 'response_too_large' });
      }
      const responseHeaders = Object.fromEntries(
        Object.entries(w.headers).filter(([k]) => k.toLowerCase() !== 'set-cookie'),
      );
      return finish(seen, {
        kind: 'response',
        status: w.status,
        headers: responseHeaders,
        body: w.body,
        duration_ms: Math.max(0, clock.now().getTime() - started),
      });
    },
  };
}
