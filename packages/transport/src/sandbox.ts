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
import { AMOUNT_BOUND, canonicalMoneyBody } from './amount-binding';
import { isApprovalCapability } from './approval';
import type { ApprovalCapability } from './approval';
import { guard } from './guard';
import { createHttpsWire } from './wire-https';
import { MAX_RESPONSE_BYTES } from './wire-map';
import type { Wire, WireRequest } from './wire';

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

/**
 * Selects the production Wire in createApprovedSandboxTransport. A unique symbol, not a string: lint
 * (sbx/sealed-transport) bars every way of reaching it outside the pinned files, and a string
 * assembled at run time cannot stand in for it (FIX-MVPB-SEAL4 item 3).
 */
export const PRODUCTION_WIRE: unique symbol = Symbol('production-wire');

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
  /** Minted by `@umsbx/safety` createScopedGate from an active outbound_approvals row. */
  approval: ApprovalCapability;
  /** The approval scope this transport serves, e.g. `mvp_b_polling`. Must equal approval.scope. */
  scope: string;
  clock: Clock;
  log: Logger;
  /**
   * REQUIRED (FIX-MVPB-SEAL2 H2). Tests inject a fake Wire. The production Wire is built only for
   * the PRODUCTION_WIRE token (SEAL4): a unique symbol exported through the package index as a sealed
   * name, so a string (even one built at run time) selects nothing. Absent, undefined, null or
   * anything else throws.
   */
  wire: Wire | typeof PRODUCTION_WIRE;
}

/**
 * The operations each approval scope may ever send, enforced by the transport itself so a wide
 * approval row cannot widen a phase (FIX-BPREP M4). `mvp_b_polling` is the MVP-B phase: no refund
 * and no webhook operation. `mvp_c_refunds` is the later superset; no approval row exists for it.
 */
export const SCOPE_OPERATIONS: Readonly<Record<string, readonly PayPalOperation[]>> = {
  mvp_b_polling: ['oauth_token', 'create_order', 'get_order', 'capture_order', 'get_capture'],
  mvp_c_refunds: [
    'oauth_token',
    'create_order',
    'get_order',
    'capture_order',
    'get_capture',
    'refund_capture',
    'get_refund',
    'verify_webhook_postback',
    'fetch_webhook_cert',
  ],
};

/**
 * The currencies each approval scope may move (FIX-MVPB-SEAL2 LOW; D-023 picked USD first; MC-GBP added GBP
 * to the hosted scope; MC2-L3 / D-084 (1) allows USD, EUR and GBP in every scope, docs/specs/mc2-l3-transport-currencies.md).
 * The outbound gate sees only a minor-unit figure, so the transport checks the currency of the body it
 * binds. JPY (no minor unit) and XAU (not a fiat unit) are refused whatever the approval row says.
 */
export const SCOPE_CURRENCIES: Readonly<Record<string, readonly string[]>> = {
  mvp_b_polling: ['USD', 'EUR', 'GBP'],
  mvp_c_refunds: ['USD', 'EUR', 'GBP'],
};
/** Scopes whose create_order may name a `purchase_units[].payee`. MVP-B pays the owning account only. */
const PAYEE_SCOPES: ReadonlySet<string> = new Set(['mvp_c_refunds']);

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

/** A header value by case-insensitive name; null when absent or not a log-safe short token. */
function headerValue(h: Record<string, string>, name: string): string | null {
  for (const [k, v] of Object.entries(h)) {
    if (k.toLowerCase() === name && /^[A-Za-z0-9._-]{1,64}$/.test(v)) return v;
  }
  return null;
}

/** The Wire to use, or a throw: there is no default and no fallback to the platform fetch. */
function pickWire(w: unknown): Wire {
  if (w === PRODUCTION_WIRE) return createHttpsWire();
  if (typeof w === 'object' && w !== null && typeof (w as Wire).request === 'function')
    return w as Wire;
  throw new SandboxSealedError('no wire');
}

export async function createApprovedSandboxTransport(
  o: ApprovedSandboxOptions,
): Promise<SandboxTransport> {
  if (typeof o !== 'object' || o === null) throw new SandboxSealedError('no options');
  if (!isApprovalCapability(o.approval)) throw new SandboxSealedError('no approval capability');
  if (typeof o.scope !== 'string' || o.scope === '') throw new SandboxSealedError('no scope');
  if (o.approval.scope !== o.scope) throw new SandboxSealedError('approval is for another scope');
  if (!Object.hasOwn(SCOPE_OPERATIONS, o.scope)) throw new SandboxSealedError('unknown scope');
  const allowedOps: readonly PayPalOperation[] = SCOPE_OPERATIONS[o.scope] ?? [];

  const { approval, clock, log } = o;
  const outbound = approval.gate;
  const approvalRef = approval.approval_ref;
  const scope = approval.scope;
  const wire = pickWire(o.wire);
  let serial = 0;
  const kept: SandboxCall[] = [];

  const finish = (
    call: Omit<SandboxCall, 'outcome' | 'status'>,
    result: TransportResult,
    extra: { correlation_id: string; request_id: string | null; reason?: string },
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
    const debugId =
      result.kind === 'response' ? headerValue(result.headers, 'paypal-debug-id') : null;
    log.log({
      msg: 'sandbox.send',
      level: 'info',
      fields: {
        operation: call.operation,
        outcome,
        status,
        approval_ref: approvalRef,
        correlation_id: extra.correlation_id,
        request_id: extra.request_id,
        paypal_debug_id: debugId,
        ...(extra.reason === undefined ? {} : { reason: extra.reason }),
      },
    });
    return result;
  };

  return {
    kind: 'sandbox',
    calls: () => kept.map((c) => ({ ...c, headers: { ...c.headers } })),
    async send(raw): Promise<TransportResult> {
      serial += 1;
      const correlation = `sbx-${String(serial).padStart(6, '0')}-${clock.now().getTime().toString(36)}`;
      // One read of the caller's object: later changes to it cannot alter what was validated.
      const parsed = OutboundRequestSchema.safeParse(raw);
      if (!parsed.success) {
        log.log({
          msg: 'sandbox.send',
          level: 'info',
          fields: {
            outcome: 'blocked:egress',
            approval_ref: approvalRef,
            correlation_id: correlation,
            reason: 'schema',
          },
        });
        return refuse();
      }
      const r = parsed.data;
      const base = { operation: r.operation, method: r.method, url: null, headers: {} };
      const rid = headerValue(r.headers, 'paypal-request-id');
      const ex = (reason?: string) => ({
        correlation_id: correlation,
        request_id: rid,
        ...(reason === undefined ? {} : { reason }),
      });

      // The scope, not the approval row, caps the operations of this phase.
      if (!allowedOps.includes(r.operation))
        return finish(base, { kind: 'blocked', by: 'no_approval' }, ex('operation_not_in_scope'));

      const checked = guard(r, 'sandbox');
      if (!checked.ok) return finish(base, refuse(), ex('guard'));
      const url = checked.url.href;

      const headers = selectHeaders(r.headers);
      const bodyOk =
        r.method === 'GET'
          ? r.body === null
          : r.body !== null && Buffer.byteLength(r.body) <= MAX_REQUEST_BODY_BYTES;
      if (headers === null || !bodyOk) return finish({ ...base, url }, refuse(), ex('shape'));
      // A certificate fetch goes to a PayPal-controlled host and never carries our token.
      if (r.operation === 'fetch_webhook_cert') delete headers['authorization'];
      const seen = { ...base, url, headers: redactHeaders(headers) };

      // M4: the amount the gate caps is the amount the body asks for. SEAL2 M2: and the bytes sent
      // are the re-serialisation of exactly the value that was checked, never the caller's text.
      let sendBody = r.body;
      if (AMOUNT_BOUND.has(r.operation)) {
        const checkedBody = canonicalMoneyBody(r.operation, r.body);
        if (r.amount_minor === null || checkedBody === null || checkedBody.minor !== r.amount_minor)
          return finish(seen, refuse(), ex('amount_unbound'));
        if (!(SCOPE_CURRENCIES[scope] ?? []).includes(checkedBody.currency))
          return finish(seen, refuse(), ex('currency_not_allowed'));
        if (checkedBody.payee && !PAYEE_SCOPES.has(scope))
          return finish(seen, refuse(), ex('payee_not_allowed'));
        if (Buffer.byteLength(checkedBody.body) > MAX_REQUEST_BODY_BYTES)
          return finish(seen, refuse(), ex('shape'));
        sendBody = checkedBody.body;
      }

      let verdict;
      try {
        verdict = GateVerdictSchema.safeParse(
          await outbound.check({
            operation: r.operation,
            amount_minor: r.amount_minor,
            scope,
            approval_ref: approvalRef,
          }),
        );
      } catch {
        return finish(seen, { kind: 'blocked', by: 'kill_switch' }, ex('gate_error'));
      }
      if (!verdict.success)
        return finish(seen, { kind: 'blocked', by: 'kill_switch' }, ex('gate_verdict'));
      if (!verdict.data.allowed)
        return finish(seen, { kind: 'blocked', by: verdict.data.by }, ex());
      // M2: the verdict must stand on the same approval this transport was built from.
      if (verdict.data.approval_ref !== approvalRef)
        return finish(seen, { kind: 'blocked', by: 'no_approval' }, ex('approval_ref_mismatch'));

      const out: WireRequest = {
        method: r.method,
        url,
        headers,
        body: sendBody,
        timeout_ms: REQUEST_TIMEOUT_MS,
      };
      const started = clock.now().getTime();
      let answer;
      try {
        answer = WireResultSchema.safeParse(await wire.request(out));
      } catch {
        return finish(seen, { kind: 'network_error', code: 'wire_failure' }, ex());
      }
      if (!answer.success)
        return finish(seen, { kind: 'network_error', code: 'wire_failure' }, ex());
      const w = answer.data;

      if (w.kind === 'error') {
        if (w.error === 'timeout') return finish(seen, { kind: 'timeout' }, ex());
        const code = w.error === 'too_large' ? 'response_too_large' : w.error;
        return finish(seen, { kind: 'network_error', code }, ex());
      }
      // A redirect is never followed, whatever the Wire did.
      if (w.status >= 300 && w.status <= 399) {
        return finish(seen, { kind: 'network_error', code: 'redirect' }, ex());
      }
      if (Buffer.byteLength(w.body) > MAX_RESPONSE_BYTES) {
        return finish(seen, { kind: 'network_error', code: 'response_too_large' }, ex());
      }
      const responseHeaders = Object.fromEntries(
        Object.entries(w.headers).filter(([k]) => k.toLowerCase() !== 'set-cookie'),
      );
      return finish(
        seen,
        {
          kind: 'response',
          status: w.status,
          headers: responseHeaders,
          body: w.body,
          duration_ms: Math.max(0, clock.now().getTime() - started),
        },
        ex(),
      );
    },
  };
}
