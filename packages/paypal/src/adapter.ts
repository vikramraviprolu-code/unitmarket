// PayPalPort over Transport (architecture 9.1). The adapter builds requests, keeps the OAuth
// token, maps every answer to one contract result and writes one call record per transport call.
// It never decides money state, never retries a POST and never touches the network itself.
import type {
  CaptureRead,
  CaptureRes,
  Clock,
  CreateOrderReq,
  CreateOrderRes,
  EnvironmentLabel,
  Logger,
  OrderRead,
  OutboundRequest,
  PayPalFail,
  PayPalOperation,
  PayPalPort,
  RefundReq,
  RefundRes,
  Secret,
  Transport,
  TransportResult,
} from '@umsbx/contracts';
import { PATHS } from '@umsbx/transport';
import { buildCreateBody, checkCreate } from './build-create';
import { buildHeaders, checkRequestId, debugIdOf, isPathId } from './headers';
import type { Http, Mapped } from './shapes';
import { mapCapture } from './map-capture';
import { mapCreate } from './map-create';
import { mapCaptureRead, mapOrder } from './map-order';
import { mapRefund } from './map-refund';
import { minorUnitsFor, toDecimalString } from './money';
import { createTokenCache } from './oauth';
import type { TokenCache } from './oauth';
import { buildRecord } from './redact-call';
import { createCertificateSource } from './webhook-cert';
import type { CertificateSource } from './webhook-cert';
import { verifyWebhook } from './webhook-verify';

export interface ProviderCallRecord {
  operation: PayPalOperation;
  method: 'GET' | 'POST';
  path_template: string;
  http_status: number | null;
  outcome: string;
  debug_id: string | null;
  duration_ms: number;
  transport_kind: EnvironmentLabel;
  request_redacted: unknown;
  response_redacted: unknown;
}

export interface AdapterDeps {
  transport: Transport;
  clock: Clock;
  log: Logger;
  /** null in dry-run: fixtures ignore the token, so no OAuth call is made. */
  credentials: { client_id: Secret; client_secret: Secret } | null;
  record: (c: ProviderCallRecord) => Promise<void>;
  /**
   * PAYPAL_WEBHOOK_ID. null or omitted: no webhook can be verified, every well-formed delivery is
   * `unverifiable` (503). Optional so the callers written before MVP-C keep compiling.
   */
  webhook_id?: string | null;
  /** Where signing certificates come from. Default: fetched through `transport` and cached. */
  certificates?: CertificateSource;
}

// Placeholder bearer value for a dry-run transport without credentials. Not a credential.
const DRYRUN_TOKEN = 'dryrun-no-token';
const NOTE_MAX = 255;

const refuse = (name: string, issue: string): PayPalFail => ({
  kind: 'rejected',
  http: 400,
  name,
  issue,
  debug_id: null,
});

interface Spec<T> {
  operation: PayPalOperation;
  id: string | null;
  body: unknown;
  requestId: string | null;
  scenario: string | null;
  order_ref: string | null;
  amount_minor: number | null;
  map: (h: Http) => Mapped<T | PayPalFail>;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function describe(r: { kind: string }, notes: string[]): string {
  const f = r as Partial<PayPalFail> & { kind: string; name?: string; issue?: string | null };
  const detail =
    f.kind === 'rejected'
      ? `:${f.name ?? ''}:${f.issue ?? ''}`
      : f.kind === 'blocked'
        ? `:${(f as { by?: string }).by ?? ''}`
        : '';
  return [`${f.kind}${detail}`, ...notes].join(';');
}

export function createPayPalAdapter(d: AdapterDeps): PayPalPort {
  const tokens: TokenCache | null =
    d.credentials === null
      ? null
      : createTokenCache({
          transport: d.transport,
          clock: d.clock,
          credentials: d.credentials,
          record: d.record,
        });

  async function write(rec: ProviderCallRecord): Promise<void> {
    try {
      await d.record(rec);
    } catch {
      d.log.log({
        msg: 'paypal.record_failed',
        level: 'warn',
        fields: { operation: rec.operation },
      });
    }
  }

  async function bearer(): Promise<{ token: string } | { fail: PayPalFail }> {
    if (tokens === null) {
      // dry-run needs no token; a sandbox transport without credentials must not be called
      return d.transport.kind === 'dryrun'
        ? { token: DRYRUN_TOKEN }
        : { fail: { kind: 'unavailable', retry_after_ms: null } };
    }
    const t = await tokens.get();
    return t.ok ? { token: t.value } : { fail: t.error };
  }

  async function sendOnce<T extends { kind: string }>(
    s: Spec<T>,
    token: string,
  ): Promise<{ result: T | PayPalFail; status: number | null }> {
    const pathSpec = PATHS[s.operation];
    const path = pathSpec.template.replace('{id}', s.id ?? '');
    const headers = buildHeaders({ method: pathSpec.method, token, requestId: s.requestId });
    const req: OutboundRequest = {
      operation: s.operation,
      method: pathSpec.method,
      path,
      headers,
      body: pathSpec.method === 'POST' ? JSON.stringify(s.body ?? {}) : null,
      order_ref: s.order_ref,
      amount_minor: s.amount_minor,
      scenario: s.scenario,
    };
    const started = d.clock.now().getTime();
    let tr: TransportResult;
    try {
      tr = await d.transport.send(req);
    } catch {
      tr = { kind: 'network_error', code: 'transport_threw' };
    }

    let result: T | PayPalFail;
    let notes: string[] = [];
    let status: number | null = null;
    let debug: string | null = null;
    let duration = Math.max(0, d.clock.now().getTime() - started);
    let responseView: unknown = null;
    if (tr.kind === 'response') {
      status = tr.status;
      duration = tr.duration_ms;
      const body = parseJson(tr.body);
      debug = debugIdOf(tr.headers, body);
      responseView = {
        headers: tr.headers,
        body: body ?? (tr.body.length > 0 ? '[non-json body]' : null),
      };
      let mapped: Mapped<T | PayPalFail>;
      try {
        mapped = s.map({ status: tr.status, headers: tr.headers, body });
      } catch {
        mapped = { result: { kind: 'unavailable', retry_after_ms: null }, notes: ['mapper_error'] };
      }
      result = mapped.result;
      notes = mapped.notes ?? [];
    } else if (tr.kind === 'blocked') {
      result = { kind: 'blocked', by: tr.by };
    } else if (tr.kind === 'timeout') {
      result = { kind: 'timeout' };
    } else {
      result = { kind: 'timeout' }; // sent or not is unknown: same as no answer
      responseView = { network_error: tr.code };
    }

    await write(
      buildRecord({
        operation: s.operation,
        method: pathSpec.method,
        path_template: pathSpec.template,
        http_status: status,
        outcome: describe(result, notes),
        debug_id: debug,
        duration_ms: duration,
        transport_kind: d.transport.kind,
        request: { headers, body: s.body ?? null },
        response: responseView,
      }),
    );
    return { result, status };
  }

  async function call<T extends { kind: string }>(s: Spec<T>): Promise<T | PayPalFail> {
    if (s.id !== null && !isPathId(s.id)) return refuse('INVALID_ID', 'PATH_ID_REJECTED');
    if (s.requestId !== null) {
      const bad = checkRequestId(s.requestId);
      if (bad !== null) return bad;
    }
    const b = await bearer();
    if ('fail' in b) return b.fail;

    let out = await sendOnce(s, b.token);
    if (out.status === 401 && tokens !== null) {
      tokens.invalidate();
      // One refresh and one retry, for reads only. A POST is never sent twice by the adapter.
      if (PATHS[s.operation].method === 'GET') {
        const again = await bearer();
        if ('fail' in again) return again.fail;
        out = await sendOnce(s, again.token);
        if (out.status === 401) tokens.invalidate();
      }
    }
    return out.result;
  }

  const certificates =
    d.certificates ??
    createCertificateSource({ transport: d.transport, clock: d.clock, log: d.log });

  return {
    environment: d.transport.kind,

    async createOrder(r: CreateOrderReq): Promise<CreateOrderRes> {
      const bad = checkCreate(r);
      if (bad !== null) return bad;
      return call<CreateOrderRes>({
        operation: 'create_order',
        id: null,
        body: buildCreateBody(r),
        requestId: r.request_id,
        scenario: r.scenario,
        order_ref: r.order_ref,
        amount_minor: r.units.reduce((n, u) => n + u.amount.minor, 0),
        map: mapCreate,
      }) as Promise<CreateOrderRes>;
    },

    getOrder(id, scenario = null): Promise<OrderRead> {
      return call<OrderRead>({
        operation: 'get_order',
        id,
        body: null,
        requestId: null,
        scenario,
        order_ref: null,
        amount_minor: null,
        map: (h) => mapOrder(h, d.clock.now()),
      }) as Promise<OrderRead>;
    },

    captureOrder(r): Promise<CaptureRes> {
      return call<CaptureRes>({
        operation: 'capture_order',
        id: r.provider_order_id,
        body: {},
        requestId: r.request_id,
        scenario: r.scenario ?? null,
        order_ref: null,
        amount_minor: null,
        map: (h) => mapCapture(h, r.provider_order_id),
      }) as Promise<CaptureRes>;
    },

    getCapture(capture_id, scenario = null): Promise<CaptureRead> {
      return call<CaptureRead>({
        operation: 'get_capture',
        id: capture_id,
        body: null,
        requestId: null,
        scenario,
        order_ref: null,
        amount_minor: null,
        map: (h) => mapCaptureRead(h, d.clock.now()),
      }) as Promise<CaptureRead>;
    },

    async refundCapture(r: RefundReq): Promise<RefundRes> {
      const bad = checkRequestId(r.request_id);
      if (bad !== null) return bad;
      if (r.note.length > NOTE_MAX) return refuse('REQUEST_INVALID', 'NOTE_TOO_LONG');
      const body: Record<string, unknown> = {};
      if (r.amount !== null) {
        body.amount = {
          currency_code: r.amount.currency,
          value: toDecimalString(r.amount, minorUnitsFor(r.amount.currency)),
        };
      }
      if (r.note.length > 0) body.note_to_payer = r.note;
      return call<RefundRes>({
        operation: 'refund_capture',
        id: r.capture_id,
        body,
        requestId: r.request_id,
        scenario: null,
        order_ref: null,
        amount_minor: r.amount?.minor ?? null,
        map: mapRefund,
      }) as Promise<RefundRes>;
    },

    getRefund(refund_id): Promise<RefundRes> {
      return call<RefundRes>({
        operation: 'get_refund',
        id: refund_id,
        body: null,
        requestId: null,
        scenario: null,
        order_ref: null,
        amount_minor: null,
        map: mapRefund,
      }) as Promise<RefundRes>;
    },

    verifyWebhook: (w) =>
      verifyWebhook({ clock: d.clock, webhook_id: d.webhook_id ?? null, certificates }, w),
  };
}
