// The owner-run sandbox subject (BU-6). Kept in its own file, free of TypeScript syntax that node's
// type stripping cannot read (parameter properties, enums), because the owner-run entry
// scripts/sandbox-conformance.mjs imports it in a plain node process. It imports no value from
// stack.ts for the same reason.
import { createPayPalAdapter } from '@umsbx/paypal';
import { guard } from '@umsbx/transport';
import {
  CaptureReadSchema,
  CaptureResSchema,
  CreateOrderResSchema,
  OrderReadSchema,
} from '@umsbx/contracts';
import type {
  BlockReason,
  Clock,
  CreateOrderReq,
  Logger,
  OrderRead,
  OutboundRequest,
  PayPalOperation,
  PayPalPort,
  ProviderOrderId,
  Secret,
  Transport,
  TransportResult,
} from '@umsbx/contracts';
import type { ConformanceHooks, ConformanceSubject } from './conformance';

type Json = Record<string, unknown>;
const isRec = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const headerOf = (h: Record<string, string>, name: string): string | null => {
  for (const [k, v] of Object.entries(h)) if (k.toLowerCase() === name) return v;
  return null;
};
const quietLog: Logger = { log: () => undefined, child: () => quietLog };

/** A valid one-unit create request in USD; the payee and amount are set by the subject. */
function baseRequest(tag: string): CreateOrderReq {
  return {
    request_id: `umsC-${tag}`,
    order_ref: `ord_${tag}`,
    units: [
      {
        reference_id: 'unit-1',
        payee_merchant_id: 'PLACEHOLDER',
        amount: { currency: 'USD', minor: 100 },
      },
    ],
    return_url: `https://shop.example.invalid/checkout/return?ref=ord_${tag}`,
    cancel_url: `https://shop.example.invalid/checkout/cancel?ref=ord_${tag}`,
    scenario: null,
  };
}

// ---------------------------------------------------------------------------------------------
// The sandbox subject (BU-6): owner-run, behind the five locks
// ---------------------------------------------------------------------------------------------
//
// The caller (scripts/sandbox-conformance.mjs, a plain Node process) builds the transport with the
// app's own outbound builder and hands it over with a real clock. This file never builds a
// transport, never reads the environment and never opens a socket. Around the transport the subject
// adds what a person running real money calls wants: the approval link on stderr, an automatic stop
// at the first blocked answer, a cap of 20 calls and 1.00 USD per order, a lost-answer switch for
// B-07, and a redacted call log in the input format of `pnpm record:fixtures`.
// Simulation tests prove the modelled cases only, not PayPal compatibility.

export const SANDBOX_LIMITS = {
  /** Calls forwarded for one order (one make()), the OAuth token request included. */
  max_calls_per_order: 20,
  /** Largest order: 1.00 USD, in minor units. */
  max_amount_minor: 100,
  currency: 'USD',
  /**
   * GET order while the owner approves. Not counted in max_calls_per_order; capped here instead.
   * Every 15 s, at most 24 reads (6 minutes): about 24 calls of the daily approval budget per wait.
   */
  poll_interval_ms: 15000,
  max_polls: 24,
} as const;

/** The five operations of the polling phase (ASM-32); nothing else goes through this subject. */
const SUBJECT_OPERATIONS: ReadonlySet<PayPalOperation> = new Set<PayPalOperation>([
  'oauth_token',
  'create_order',
  'get_order',
  'capture_order',
  'get_capture',
]);

export type SandboxStopCode = BlockReason | 'call_cap' | 'amount_cap' | 'operation';
export interface SandboxStop {
  code: SandboxStopCode;
  detail: string;
}

/** One exchange in the input format of `pnpm record:fixtures` (redacted). */
export interface CallExchange {
  scenario: string;
  operation: PayPalOperation;
  request: {
    method: 'GET' | 'POST';
    path: string;
    headers: Record<string, string>;
    body: unknown;
  };
  response: { status: number; headers: Record<string, string>; body: unknown } | { timeout: true };
}
/** One call as the summary needs it, whatever the outcome. No body. */
export interface CallEvent {
  case: string;
  operation: PayPalOperation;
  outcome: string;
  http: number | null;
  debug_id: string | null;
}

export interface SandboxSubjectOptions {
  /** The approved sandbox transport (kind `sandbox`). Required. */
  transport: Transport;
  /** The real clock. Required: the subject never invents time. */
  clock: Clock;
  /** The adapter's OAuth credentials. The subject never prints or logs them. */
  credentials: { client_id: Secret; client_secret: Secret };
  /** UMS_OWN_MERCHANT_ID: the payee of every order the subject creates. Null: orderRequest throws. */
  own_merchant_id: string | null;
  /** Where lines for the owner go, one per call, no newline. Default: process.stderr. */
  stderr?: (line: string) => void;
  /** Default: a timer. Tests inject. */
  sleep?: (ms: number) => Promise<void>;
}

export type SandboxSubject = Omit<ConformanceSubject, 'make'> & {
  make(): Promise<{ port: PayPalPort; hooks: ConformanceHooks; transport: Transport }>;
  /** The payee every created order names, or null when it is not set. */
  ownMerchantId(): string | null;
  /** One line to the owner (the same sink as the approval link). */
  say(line: string): void;
  /** Names the case the next calls belong to; used as the `scenario` of the call log. */
  label(name: string): void;
  /** The reason the suite stopped, or null. Sticky: once set, every later call is answered blocked. */
  stopped(): SandboxStop | null;
  /** Redacted exchanges, oldest first, in the input format of `pnpm record:fixtures`. */
  callLog(): CallExchange[];
  /** Every call, whatever the outcome (blocked ones included), without bodies. */
  events(): CallEvent[];
  /** The next capture's answer is thrown away after the call returned (B-07). Once. */
  discardNextCaptureAnswer(): void;
};

const APPROVAL_LINE =
  'Open this link in a browser signed in as the sandbox Personal account, approve, then come back: ';

const REDACTED = '[redacted]';
const OWN_PLACEHOLDER = 'OWNMERCHANT01';
const SECRET_KEY =
  /secret|password|passwd|passcode|assertion|credential|token|nonce|signature|^sig$|authorization|cookie|^client_?id$|^app_?id$|api_?key/i;
const PERSON_KEY =
  /^(given_name|surname|full_name|family_name|first_name|last_name|middle_name|nickname|display_name|business_name|recipient_name)$|email|phone|national_number|^address|address_line|admin_area|postal_code|^zip|street|^payer_id$|^payee_id$|^account_id$|^note_to_/i;
const KEPT_HEADERS_REQUEST = ['content-type', 'accept', 'prefer', 'paypal-request-id'];
const KEPT_HEADERS_RESPONSE = ['content-type', 'paypal-debug-id'];

/** Query parameters whose name ends in `token` (the approval link's `?token=`, `ba_token`): the value goes. */
const TOKEN_PARAM = /([?&][A-Za-z0-9_.-]*token=)[^&#\s"']*/gi;
const TOKEN_MASK = '<redacted>';
/** Keys that name a merchant account: only the last 4 characters may be recorded. */
const MERCHANT_KEY = /^(payee_)?merchant_id$/i;
const MERCHANT_MASK = 'MERCHANT-REDACTED';
/** A merchant id shorter than this shows no tail: 4 characters would be half of it or more. */
const MERCHANT_TAIL_FROM = 8;
const MAX_DEPTH = 30;

function maskMerchant(v: unknown, own: string | null): unknown {
  if (v === null) return null;
  if (typeof v !== 'string') return REDACTED;
  if (own !== null && v === own) return OWN_PLACEHOLDER;
  if (v === OWN_PLACEHOLDER || v.startsWith(MERCHANT_MASK)) return v;
  return v.length >= MERCHANT_TAIL_FROM ? `${MERCHANT_MASK}-${v.slice(-4)}` : MERCHANT_MASK;
}

/**
 * Redacts one parsed request or response body for the call log (BU-6b). Pure and total: it never
 * throws, never changes its input, and is idempotent. What it does, exactly:
 *  - keys `merchant_id` and `payee_merchant_id` at any depth: placeholder plus the last 4 characters
 *    (none when shorter than 8); our own merchant id becomes `OWNMERCHANT01`;
 *  - keys matching the secret pattern, the person pattern (names, email, phone, address fields,
 *    `payer_id`, `payee_id`, `account_id`, `note_to_*`) and a `name` object: `[redacted]`;
 *  - in every string, the value of a query parameter ending in `token`: `<redacted>`;
 *  - everything else, order and capture ids included, is kept for `pnpm record:fixtures`.
 */
export function redactCallBody(v: unknown, own: string | null, depth = 0): unknown {
  if (depth > MAX_DEPTH) return REDACTED;
  if (typeof v === 'string') {
    if (own !== null && v === own) return OWN_PLACEHOLDER;
    return v.replace(TOKEN_PARAM, `$1${TOKEN_MASK}`);
  }
  if (v === null || v === undefined || typeof v === 'number' || typeof v === 'boolean') return v;
  if (Array.isArray(v)) return v.map((x) => redactCallBody(x, own, depth + 1));
  if (isRec(v)) {
    // fromEntries defines own properties, so a JSON key named __proto__ stays data.
    return Object.fromEntries(
      Object.entries(v).map(([k, x]): [string, unknown] => {
        const personal = PERSON_KEY.test(k) || (k === 'name' && isRec(x));
        if (SECRET_KEY.test(k) || personal) return [k, REDACTED];
        if (MERCHANT_KEY.test(k)) return [k, maskMerchant(x, own)];
        return [k, redactCallBody(x, own, depth + 1)];
      }),
    );
  }
  return REDACTED;
}

/** The bytes of calls.json: two-space JSON and one newline. The log is already redacted. */
export function renderCallsJson(log: readonly CallExchange[]): string {
  return `${JSON.stringify(log, null, 2)}\n`;
}
function parseBody(text: string | null): unknown {
  if (text === null || text === '') return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}
function keepHeaders(h: Record<string, string>, keep: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h))
    if (keep.includes(k.toLowerCase())) out[k.toLowerCase()] = v;
  return out;
}
const debugIdOf = (h: Record<string, string>): string | null => {
  const v = headerOf(h, 'paypal-debug-id');
  return v !== null && /^[A-Za-z0-9._-]{1,64}$/.test(v) ? v : null;
};

/** Decimal string with at most 2 places to minor units, or null when it is not one. */
function toMinor(v: unknown): number | null {
  if (typeof v !== 'string' || !/^\d{1,9}(\.\d{1,2})?$/.test(v)) return null;
  const [whole = '0', frac = ''] = v.split('.');
  return Number(whole) * 100 + Number(frac.padEnd(2, '0'));
}
/** The order total the body asks for, in USD minor units; null when it cannot be read or is not USD. */
function bodyTotalMinor(body: string | null): number | null {
  const b = parseBody(body);
  if (!isRec(b) || !Array.isArray(b.purchase_units) || b.purchase_units.length === 0) return null;
  let total = 0;
  for (const u of b.purchase_units) {
    if (!isRec(u) || !isRec(u.amount)) return null;
    if (u.amount.currency_code !== SANDBOX_LIMITS.currency) return null;
    const m = toMinor(u.amount.value);
    if (m === null) return null;
    total += m;
  }
  return total;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const defaultStderr = (line: string): void => void process.stderr.write(`${line}\n`);

/**
 * The sandbox subject. Nothing is built or sent until make() is called and the port is used.
 * Refuses (throws) without a sandbox transport, a clock and credentials.
 */
export function sandboxSubject(o: SandboxSubjectOptions): SandboxSubject {
  if (typeof o !== 'object' || o === null)
    throw new TypeError('sandboxSubject: a transport is required');
  const given = o.transport as Transport | undefined;
  if (given === undefined || typeof given.send !== 'function')
    throw new TypeError('sandboxSubject: a transport is required');
  if (given.kind !== 'sandbox')
    throw new TypeError('sandboxSubject: the transport must be the sandbox transport');
  const transport: Transport = given;
  const clock = o.clock as Clock | undefined;
  if (clock === undefined || typeof clock.now !== 'function')
    throw new TypeError('sandboxSubject: a clock is required');
  const credentials = o.credentials as SandboxSubjectOptions['credentials'] | undefined;
  if (credentials === undefined || credentials === null)
    throw new TypeError('sandboxSubject: credentials are required');
  const own = o.own_merchant_id;
  const say = o.stderr ?? defaultStderr;
  const sleep = o.sleep ?? defaultSleep;

  let n = 0;
  let current = 'unlabelled';
  let stop: SandboxStop | null = null;
  let discardCapture = false;
  const log: CallExchange[] = [];
  const events: CallEvent[] = [];
  const sentUrls: string[] = [];
  const tripped = (s: SandboxStop): void => {
    stop ??= s;
  };
  const refusal = (): TransportResult => ({
    kind: 'blocked',
    by:
      stop === null
        ? 'budget'
        : stop.code === 'call_cap' || stop.code === 'amount_cap'
          ? 'budget'
          : stop.code === 'operation'
            ? 'egress'
            : stop.code,
  });

  function guarded(state: { calls: number; polling: number }): Transport {
    return {
      kind: transport.kind,
      async send(r: OutboundRequest): Promise<TransportResult> {
        const note = (outcome: string, http: number | null, debug: string | null): void => {
          events.push({ case: current, operation: r.operation, outcome, http, debug_id: debug });
        };
        if (stop !== null) {
          note(`refused:${stop.code}`, null, null);
          return refusal();
        }
        if (!SUBJECT_OPERATIONS.has(r.operation)) {
          tripped({ code: 'operation', detail: `operation ${r.operation} is outside the subset` });
          note('refused:operation', null, null);
          return refusal();
        }
        const poll = state.polling > 0 && r.operation === 'get_order';
        if (!poll) {
          if (state.calls >= SANDBOX_LIMITS.max_calls_per_order) {
            tripped({
              code: 'call_cap',
              detail: `more than ${SANDBOX_LIMITS.max_calls_per_order} calls for one order`,
            });
            note('refused:call_cap', null, null);
            return refusal();
          }
        }
        if (r.amount_minor !== null && r.amount_minor > SANDBOX_LIMITS.max_amount_minor) {
          tripped({ code: 'amount_cap', detail: 'amount above 1.00 USD' });
          note('refused:amount_cap', null, null);
          return refusal();
        }
        if (r.operation === 'create_order') {
          const total = bodyTotalMinor(r.body);
          if (total === null || total > SANDBOX_LIMITS.max_amount_minor) {
            tripped({ code: 'amount_cap', detail: 'order body above 1.00 USD or not USD' });
            note('refused:amount_cap', null, null);
            return refusal();
          }
        }
        if (!poll) state.calls += 1;
        const g = guard(r, 'sandbox');
        if (g.ok) sentUrls.push(g.url.href);

        let res: TransportResult;
        try {
          res = await transport.send(r);
        } catch {
          res = { kind: 'network_error', code: 'transport_threw' };
        }
        const request: CallExchange['request'] = {
          method: r.method,
          path: r.path,
          headers: {
            ...keepHeaders(r.headers, KEEP_REQ),
            ...(headerOf(r.headers, 'authorization') === null ? {} : { authorization: REDACTED }),
          },
          body: r.operation === 'oauth_token' ? REDACTED : redactCallBody(parseBody(r.body), own),
        };
        if (res.kind === 'response') {
          note('response', res.status, debugIdOf(res.headers));
          log.push({
            scenario: current,
            operation: r.operation,
            request,
            response: {
              status: res.status,
              headers: keepHeaders(res.headers, KEEP_RES),
              body:
                r.operation === 'oauth_token' ? REDACTED : redactCallBody(parseBody(res.body), own),
            },
          });
        } else if (res.kind === 'timeout') {
          note('timeout', null, null);
          log.push({
            scenario: current,
            operation: r.operation,
            request,
            response: { timeout: true },
          });
        } else if (res.kind === 'blocked') {
          note(`blocked:${res.by}`, null, null);
          tripped({ code: res.by, detail: `blocked by ${res.by}` });
        } else note(`network_error:${res.code}`, null, null);

        if (discardCapture && r.operation === 'capture_order' && res.kind === 'response') {
          discardCapture = false;
          return { kind: 'timeout' };
        }
        return res;
      },
    };
  }

  return {
    name: 'sandbox',
    ownMerchantId: () => own,
    say,
    label(name) {
      current = name;
    },
    stopped: () => stop,
    callLog: () => structuredClone(log),
    events: () => events.map((e) => ({ ...e })),
    discardNextCaptureAnswer() {
      discardCapture = true;
    },
    async make() {
      const state = { calls: 0, polling: 0 };
      const t = guarded(state);
      const adapter = createPayPalAdapter({
        transport: t,
        clock,
        log: quietLog,
        credentials,
        record: async () => undefined,
        // D-028: the adapter leaves the payee out of create_order when it equals our own merchant id.
        own_merchant_id: own,
      });
      const links = new Map<string, string>();
      const port: PayPalPort = {
        ...adapter,
        async createOrder(r) {
          const res = await adapter.createOrder(r);
          if (res.kind === 'created') links.set(res.provider_order_id, res.approve_url);
          return res;
        },
      };
      const hooks: ConformanceHooks = {
        async approve(id, approve_url) {
          const url = approve_url ?? links.get(id);
          if (url === undefined) throw new Error('no approval link is known for this order');
          say(`${APPROVAL_LINE}${url}`);
          state.polling += 1;
          try {
            for (let i = 0; i < SANDBOX_LIMITS.max_polls; i += 1) {
              const read = await port.getOrder(id);
              if (stop !== null) throw new Error(`suite stopped: ${stop.detail}`);
              if (read.kind === 'order' && read.status === 'APPROVED') return;
              if (read.kind === 'order' && read.status === 'VOIDED')
                throw new Error('the order was voided; create a new one');
              if (i < SANDBOX_LIMITS.max_polls - 1) await sleep(SANDBOX_LIMITS.poll_interval_ms);
            }
          } finally {
            state.polling -= 1;
          }
          throw new Error('the owner did not approve the order in time');
        },
        scenario: () => undefined,
        sentUrls: () => [...sentUrls],
      };
      return { port, hooks, transport: t };
    },
    orderRequest() {
      if (own === null) throw new Error('own_merchant_id is not set');
      n += 1;
      const tag = `SBX${clock.now().getTime().toString(36).toUpperCase()}${n}`;
      const base = baseRequest(tag);
      return {
        ...base,
        units: base.units.map((u) => ({
          ...u,
          payee_merchant_id: own,
          amount: { currency: 'USD' as const, minor: SANDBOX_LIMITS.max_amount_minor },
        })),
      };
    },
  };
}

const KEEP_REQ = KEPT_HEADERS_REQUEST;
const KEEP_RES = KEPT_HEADERS_RESPONSE;

// ---------------------------------------------------------------------------------------------
// The owner subset: the short list of cases the owner runs against the sandbox
// ---------------------------------------------------------------------------------------------

export type OwnerCaseId =
  | 'payee_echo'
  | 'create_replay'
  | 'capture_before_approval'
  | 'approve_capture_replay'
  | 'read_backs'
  | 'lost_answer';
export interface OwnerCaseResult {
  id: OwnerCaseId;
  title: string;
  pass: boolean;
  http: number | null;
  debug_id: string | null;
  order_id: string | null;
  capture_id: string | null;
  detail: string;
}
export interface OwnerRunReport {
  cases: OwnerCaseResult[];
  stopped: SandboxStop | null;
  /** D-028: does PayPal echo our own merchant id as payee on the created order. */
  payee_echo: 'own id' | 'STOP' | 'not run';
}

const TITLES: Record<OwnerCaseId, string> = {
  payee_echo: 'B-01 create, then D-028 payee echo',
  create_replay: 'B-02 create again with the same key',
  capture_before_approval: 'B-04 capture before approval',
  approve_capture_replay: 'B-03 approve, capture, capture again with the same key',
  read_backs: 'GET order and GET capture',
  lost_answer: 'B-07 lost capture answer, read-back',
};
const ORDER: OwnerCaseId[] = [
  'payee_echo',
  'create_replay',
  'capture_before_approval',
  'approve_capture_replay',
  'read_backs',
  'lost_answer',
];

type Made = Awaited<ReturnType<SandboxSubject['make']>>;
interface OrderState {
  made: Made;
  req: CreateOrderReq;
  id: ProviderOrderId;
  approve_url: string;
  capture_ids: string[];
}

/**
 * The steps of the owner run, in order. Each step makes a few calls through the subject and returns
 * a result; the first failed step ends the run (later steps are reported as not run). A blocked
 * answer anywhere stops the suite for good: the subject answers every later call without sending it.
 * No step retries, and none ever sends a second create with another body.
 */
export function ownerSubset(subject: SandboxSubject) {
  const results = new Map<OwnerCaseId, OwnerCaseResult>();
  let payee: OwnerRunReport['payee_echo'] = 'not run';
  let a: OrderState | null = null;
  let halted: string | null = null;

  const lastEvent = (label: string): CallEvent | undefined =>
    [...subject.events()].reverse().find((e) => e.case === label && e.http !== null);

  function finish(
    id: OwnerCaseId,
    pass: boolean,
    detail: string,
    ids: { order?: string | null; capture?: string | null } = {},
  ): OwnerCaseResult {
    const ev = lastEvent(id);
    const stopped = subject.stopped();
    const r: OwnerCaseResult = {
      id,
      title: TITLES[id],
      pass,
      http: ev?.http ?? null,
      debug_id: ev?.debug_id ?? null,
      order_id: ids.order ?? null,
      capture_id: ids.capture ?? null,
      detail:
        !pass &&
        stopped !== null &&
        !detail.includes(stopped.detail) &&
        !detail.includes(stopped.code)
          ? `${detail} (${stopped.detail})`
          : detail,
    };
    results.set(id, r);
    if (!pass) halted ??= `${id} failed`;
    return r;
  }

  async function newOrder(
    label: OwnerCaseId,
  ): Promise<{ ok: true; o: OrderState } | { ok: false; why: string }> {
    subject.label(label);
    const made = await subject.make();
    const req = subject.orderRequest();
    const res = CreateOrderResSchema.parse(await made.port.createOrder(req));
    if (res.kind !== 'created') {
      return {
        ok: false,
        why: `create answered ${res.kind}${res.kind === 'blocked' ? ` (${res.by})` : ''}`,
      };
    }
    return {
      ok: true,
      o: {
        made,
        req,
        id: res.provider_order_id,
        approve_url: res.approve_url,
        capture_ids: [],
      },
    };
  }

  async function readOrder(
    o: OrderState,
  ): Promise<Extract<OrderRead, { kind: 'order' }> | { fail: string }> {
    const res = OrderReadSchema.parse(await o.made.port.getOrder(o.id));
    return res.kind === 'order' ? res : { fail: `read answered ${res.kind}` };
  }

  const steps: Record<OwnerCaseId, () => Promise<OwnerCaseResult>> = {
    async payee_echo() {
      const id = 'payee_echo';
      const stop = (why: string, order: string | null = null): OwnerCaseResult => {
        payee = 'STOP';
        subject.say('payee echo: STOP');
        halted ??= 'payee echo STOP';
        return finish(id, false, why, { order });
      };
      const want = subject.ownMerchantId();
      if (want === null) return stop('UMS_OWN_MERCHANT_ID is not set; no call was made');
      const c = await newOrder(id);
      if (!c.ok) return stop(c.why);
      a = c.o;
      const read = await readOrder(c.o);
      if ('fail' in read) return stop(read.fail, c.o.id);
      const got = read.units[0]?.payee_merchant_id ?? null;
      if (got !== want) {
        return stop(
          got === null ? 'the order read names no payee' : 'the order read names another payee',
          c.o.id,
        );
      }
      payee = 'own id';
      subject.say('payee echo: own id');
      return finish(id, true, 'PayPal echoes our own merchant id as payee', { order: c.o.id });
    },

    async create_replay() {
      const id = 'create_replay';
      subject.label(id);
      if (a === null) return finish(id, false, 'no order from the first case');
      const res = CreateOrderResSchema.parse(await a.made.port.createOrder(a.req));
      if (res.kind !== 'created') return finish(id, false, `answered ${res.kind}`, { order: a.id });
      return res.provider_order_id === a.id
        ? finish(id, true, 'same key, same order id', { order: a.id })
        : finish(id, false, 'a different order id came back', { order: a.id });
    },

    async capture_before_approval() {
      const id = 'capture_before_approval';
      subject.label(id);
      if (a === null) return finish(id, false, 'no order from the first case');
      const res = CaptureResSchema.parse(
        await a.made.port.captureOrder({
          provider_order_id: a.id,
          request_id: `${a.req.request_id}:early`,
        }),
      );
      if (res.kind === 'rejected' && res.http === 422 && res.issue === 'ORDER_NOT_APPROVED') {
        return finish(id, true, '422 ORDER_NOT_APPROVED', { order: a.id });
      }
      return finish(id, false, `expected 422 ORDER_NOT_APPROVED, got ${res.kind}`, { order: a.id });
    },

    async approve_capture_replay() {
      const id = 'approve_capture_replay';
      subject.label(id);
      if (a === null) return finish(id, false, 'no order from the first case');
      try {
        await a.made.hooks.approve(a.id, a.approve_url);
      } catch (e) {
        return finish(id, false, e instanceof Error ? e.message : 'approval failed', {
          order: a.id,
        });
      }
      const key = `${a.req.request_id}:capture`;
      const first = CaptureResSchema.parse(
        await a.made.port.captureOrder({ provider_order_id: a.id, request_id: key }),
      );
      if (first.kind !== 'claim')
        return finish(id, false, `capture answered ${first.kind}`, { order: a.id });
      const ids = first.units.map((u) => u.capture_id);
      if (
        first.units.length !== 1 ||
        first.units.some((u) => u.status !== 'COMPLETED' || u.capture_id === null)
      )
        return finish(id, false, 'the capture is not one COMPLETED capture', { order: a.id });
      a.capture_ids = ids.filter((x): x is string => x !== null);
      const again = CaptureResSchema.parse(
        await a.made.port.captureOrder({ provider_order_id: a.id, request_id: key }),
      );
      if (again.kind !== 'claim' || again.units.map((u) => u.capture_id).join() !== ids.join())
        return finish(id, false, 'the same key did not give the same capture ids', {
          order: a.id,
          capture: a.capture_ids[0] ?? null,
        });
      return finish(id, true, 'one COMPLETED capture; the same key gave the same capture id', {
        order: a.id,
        capture: a.capture_ids[0] ?? null,
      });
    },

    async read_backs() {
      const id = 'read_backs';
      subject.label(id);
      if (a === null || a.capture_ids.length === 0)
        return finish(id, false, 'no captured order from the earlier cases');
      const cap = a.capture_ids[0] as string;
      const read = await readOrder(a);
      if ('fail' in read) return finish(id, false, read.fail, { order: a.id, capture: cap });
      const captures = read.units.flatMap((u) => (u.capture === null ? [] : [u.capture]));
      if (read.status !== 'COMPLETED' || captures.length !== 1 || captures[0]?.capture_id !== cap)
        return finish(id, false, 'the order read does not show the one capture', {
          order: a.id,
          capture: cap,
        });
      const c = CaptureReadSchema.parse(await a.made.port.getCapture(cap));
      if (c.kind !== 'capture' || c.capture.status !== 'COMPLETED')
        return finish(id, false, `the capture read answered ${c.kind}`, {
          order: a.id,
          capture: cap,
        });
      return finish(id, true, 'order COMPLETED with the one capture; the capture reads COMPLETED', {
        order: a.id,
        capture: cap,
      });
    },

    async lost_answer() {
      const id = 'lost_answer';
      const c = await newOrder(id);
      if (!c.ok) return finish(id, false, c.why);
      const o = c.o;
      try {
        await o.made.hooks.approve(o.id, o.approve_url);
      } catch (e) {
        return finish(id, false, e instanceof Error ? e.message : 'approval failed', {
          order: o.id,
        });
      }
      subject.discardNextCaptureAnswer();
      const res = CaptureResSchema.parse(
        await o.made.port.captureOrder({
          provider_order_id: o.id,
          request_id: `${o.req.request_id}:capture`,
        }),
      );
      if (res.kind !== 'timeout')
        return finish(id, false, `the lost answer was not lost (${res.kind})`, { order: o.id });
      const read = await readOrder(o);
      if ('fail' in read) return finish(id, false, read.fail, { order: o.id });
      const captures = read.units.flatMap((u) => (u.capture === null ? [] : [u.capture]));
      return read.status === 'COMPLETED' && captures.length === 1
        ? finish(id, true, 'the read-back shows exactly one capture', {
            order: o.id,
            capture: captures[0]?.capture_id ?? null,
          })
        : finish(
            id,
            false,
            `the read-back shows ${captures.length} captures, status ${read.status}`,
            {
              order: o.id,
            },
          );
    },
  };

  function report(only: readonly OwnerCaseId[] = ORDER): OwnerRunReport {
    return {
      cases: only.map(
        (id) =>
          results.get(id) ?? {
            id,
            title: TITLES[id],
            pass: false,
            http: null,
            debug_id: null,
            order_id: null,
            capture_id: null,
            detail: `not run${halted === null ? '' : `: ${halted}`}`,
          },
      ),
      stopped: subject.stopped(),
      payee_echo: payee,
    };
  }

  return {
    steps,
    report,
    /** Runs the steps in order. `only: 'payee-echo'` runs the first case alone. */
    async runAll(o: { only?: 'payee-echo' } = {}): Promise<OwnerRunReport> {
      const todo = o.only === 'payee-echo' ? ORDER.slice(0, 1) : ORDER;
      for (const id of todo) {
        if (halted !== null) break;
        try {
          await steps[id]();
        } catch (e) {
          const why = e instanceof Error ? e.message : 'step failed';
          if (id === 'payee_echo') {
            payee = 'STOP';
            subject.say('payee echo: STOP');
          }
          finish(id, false, why);
        }
      }
      return report(todo);
    },
  };
}

const tail6 = (id: string | null): string => (id === null ? '' : `…${id.slice(-6)}`);

/** The summary the owner brings back: case, result, HTTP status, debug id, ids cut to 6 characters. */
export function renderOwnerSummary(report: OwnerRunReport, o: { date: string }): string {
  const rows = report.cases.map(
    (c) =>
      `| ${c.title} | ${c.pass ? 'PASS' : 'FAIL'} | ${c.http ?? ''} | ${c.debug_id ?? ''} | ${tail6(c.order_id)} | ${tail6(c.capture_id)} | ${c.detail.replace(/\|/g, '/')} |`,
  );
  return [
    `# Sandbox owner run ${o.date}`,
    '',
    `Payee echo (D-028): ${report.payee_echo}`,
    report.stopped === null
      ? 'Stopped: no'
      : `Stopped: yes, ${report.stopped.code} (${report.stopped.detail})`,
    '',
    '| Case | Result | HTTP | Debug id | Order | Capture | Detail |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...rows,
    '',
    'Simulation and rehearsal results prove the modelled cases only. This run is the real check.',
    '',
  ].join('\n');
}
