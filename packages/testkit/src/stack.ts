// The dry-run PayPal stack for tests (lane 16): a transport that plays the recorded fixtures or, for
// stateful flows, a small PayPal order model; the adapter on top; and testDeps(), which wires the
// whole dependency bundle with a fake clock, seeded ids and a migrated database.
//
// Nothing here opens a socket or reads the environment. The owner-run sandbox subject lives in
// sandbox-subject.ts (BU-6).
//
// Two answer sources, one transport:
//  - fixtures: a request whose scenario is one of the fixture scenarios (fixtures/paypal) is
//    answered by the dry-run transport from lane 03, step by step.
//  - model: any other request is answered by ModelPayPal below. It exists because the portable
//    cases P2, P6, P7 and P10 need state (idempotent replay, one capture per order, approval)
//    that one-shot fixtures cannot give. Its rules are the verified facts named in
//    conformance.ts, not the adapter's behaviour. Model answers are synthetic, not PayPal evidence.
import { fileURLToPath } from 'node:url';
import { createAuditSink, createLogger } from '@umsbx/obs';
import { createScriptedModel } from '@umsbx/model';
import { createPayPalAdapter } from '@umsbx/paypal';
import { createSwitchReader } from '@umsbx/safety';
import { createDryRunTransport, guard, loadFixtures } from '@umsbx/transport';
import { makeSecret } from '@umsbx/config';
import { DomainConfigSchema } from '@umsbx/contracts';
import type {
  Clock,
  ContentStore,
  CreateOrderReq,
  Database,
  IsoUtc,
  Logger,
  OutboundRequest,
  PayPalPort,
  PaymentsDeps,
  AgentDeps,
  ProviderOrderId,
  Transport,
  TransportResult,
} from '@umsbx/contracts';
import { T0, fakeClock, seededIds } from './clock';
import { testDb } from './db';
import type { ConformanceHooks, ConformanceSubject } from './conformance';

const FIXTURE_ROOT = fileURLToPath(new URL('../../../fixtures/paypal/', import.meta.url));

// ---------------------------------------------------------------------------------------------
// The order model
// ---------------------------------------------------------------------------------------------

type Json = Record<string, unknown>;
const isRec = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

interface ModelCapture {
  id: string;
  status: 'COMPLETED' | 'PENDING' | 'DECLINED';
}
interface ModelUnit {
  reference_id: string;
  custom_id: string;
  amount: { currency_code: string; value: string };
  payee: { merchant_id: string } | null;
  capture: ModelCapture | null;
}
interface ModelOrder {
  id: string;
  status: 'CREATED' | 'APPROVED' | 'COMPLETED';
  scenario: string | null;
  units: ModelUnit[];
  created: string;
  updated: string;
  readsSinceCapture: number;
}
interface Stored {
  status: number;
  body: unknown;
}

const headerOf = (h: Record<string, string>, name: string): string | null => {
  for (const [k, v] of Object.entries(h)) if (k.toLowerCase() === name) return v;
  return null;
};

const ERR_LINK = [
  { href: '/api/rest/reference/orders/v2/errors/', rel: 'information_link', method: 'GET' },
];

class ModelPayPal {
  private orders = new Map<string, ModelOrder>();
  private replays = new Map<string, Stored>();
  private n = 0;
  private debug = 0;

  constructor(private readonly clock: Clock) {}

  private stamp(): string {
    return this.clock
      .now()
      .toISOString()
      .replace(/\.\d{3}Z$/, 'Z');
  }
  private res(status: number, body: unknown): TransportResult {
    this.debug += 1;
    return {
      kind: 'response',
      status,
      headers: {
        'content-type': 'application/json',
        'paypal-debug-id': `sbxmodel${String(this.debug).padStart(4, '0')}`,
      },
      body: JSON.stringify(body),
      duration_ms: 1,
    };
  }
  private err(status: number, name: string, issue: string, description: string): TransportResult {
    return this.res(status, {
      name,
      message: 'Synthetic model answer, not PayPal evidence.',
      debug_id: `sbxmodel${String(this.debug + 1).padStart(4, '0')}`,
      details: [{ issue, description }],
      links: ERR_LINK,
    });
  }

  /** Buyer approval, the one step a port cannot do. Unknown ids are ignored. */
  approve(id: string): void {
    const o = this.orders.get(id);
    if (o !== undefined && o.status === 'CREATED') {
      o.status = 'APPROVED';
      o.updated = this.stamp();
    }
  }

  private captureBody(c: ModelCapture, u: ModelUnit, o: ModelOrder): Json {
    return {
      id: c.id,
      status: c.status,
      amount: u.amount,
      final_capture: true,
      create_time: o.updated,
      update_time: o.updated,
      ...(c.status === 'PENDING' ? { status_details: { reason: 'PENDING_REVIEW' } } : {}),
    };
  }
  private orderBody(o: ModelOrder): Json {
    return {
      id: o.id,
      status: o.status,
      intent: 'CAPTURE',
      purchase_units: o.units.map((u) => ({
        reference_id: u.reference_id,
        custom_id: u.custom_id,
        amount: u.amount,
        ...(u.payee === null ? {} : { payee: u.payee }),
        ...(u.capture === null
          ? {}
          : { payments: { captures: [this.captureBody(u.capture, u, o)] } }),
      })),
      create_time: o.created,
      update_time: o.updated,
      links: [{ href: `/v2/checkout/orders/${o.id}`, rel: 'self', method: 'GET' }],
    };
  }
  // pending_then_declined (D2): the first read after capture still shows PENDING, the next one
  // shows DECLINED. The capture id never changes.
  private settle(o: ModelOrder): void {
    if (o.scenario !== 'pending_then_declined' || o.status !== 'COMPLETED') return;
    if (o.readsSinceCapture >= 1) {
      for (const u of o.units) if (u.capture !== null) u.capture.status = 'DECLINED';
    }
    o.readsSinceCapture += 1;
  }

  send(r: OutboundRequest): TransportResult {
    const path = r.path.replace(/^https?:\/\/[^/]+/, '');
    const parts = path.split('/').filter((p) => p.length > 0);
    const rid = headerOf(r.headers, 'paypal-request-id');
    let body: unknown = null;
    try {
      body = r.body === null ? null : JSON.parse(r.body);
    } catch {
      body = null;
    }

    if (r.operation === 'create_order') return this.create(r, body, rid);
    if (r.operation === 'get_order') return this.get(parts[3] ?? '');
    if (r.operation === 'capture_order') return this.capture(parts[3] ?? '', rid);
    if (r.operation === 'get_capture') return this.getCapture(parts[3] ?? '');
    return { kind: 'blocked', by: 'dry_run_miss' };
  }

  private create(r: OutboundRequest, body: unknown, rid: string | null): TransportResult {
    const key = `create|${rid ?? ''}`;
    const prior = rid === null ? undefined : this.replays.get(key);
    if (prior !== undefined) return this.res(prior.status, prior.body);
    const units = isRec(body) && Array.isArray(body.purchase_units) ? body.purchase_units : [];
    if (units.length === 0) {
      return this.err(400, 'INVALID_REQUEST', 'MISSING_REQUIRED_PARAMETER', 'purchase_units');
    }
    this.n += 1;
    const id = `SBXMODELORD${String(this.n).padStart(6, '0')}`;
    const now = this.stamp();
    const order: ModelOrder = {
      id,
      status: 'CREATED',
      scenario: r.scenario,
      created: now,
      updated: now,
      readsSinceCapture: 0,
      units: units.filter(isRec).map((u) => {
        const amount = isRec(u.amount) ? u.amount : {};
        const payee = isRec(u.payee) && typeof u.payee.merchant_id === 'string' ? u.payee : null;
        return {
          reference_id: typeof u.reference_id === 'string' ? u.reference_id : 'default',
          custom_id: typeof u.custom_id === 'string' ? u.custom_id : '',
          amount: {
            currency_code: String(amount.currency_code ?? ''),
            value: String(amount.value ?? ''),
          },
          payee: payee === null ? null : { merchant_id: String(payee.merchant_id) },
          capture: null,
        };
      }),
    };
    this.orders.set(id, order);
    const answer = {
      id,
      status: 'CREATED',
      links: [
        { href: `/v2/checkout/orders/${id}`, rel: 'self', method: 'GET' },
        {
          href: `https://www.sandbox.paypal.com/checkoutnow?token=${id}`,
          rel: 'approve',
          method: 'GET',
        },
        { href: `/v2/checkout/orders/${id}/capture`, rel: 'capture', method: 'POST' },
      ],
    };
    if (rid !== null) this.replays.set(key, { status: 201, body: answer });
    return this.res(201, answer);
  }

  private get(id: string): TransportResult {
    const o = this.orders.get(id);
    if (o === undefined) return this.notFound();
    this.settle(o);
    return this.res(200, this.orderBody(o));
  }

  private notFound(): TransportResult {
    return this.err(
      404,
      'RESOURCE_NOT_FOUND',
      'INVALID_RESOURCE_ID',
      'Specified resource ID does not exist. Please check the resource ID and try again.',
    );
  }

  private capture(id: string, rid: string | null): TransportResult {
    const o = this.orders.get(id);
    if (o === undefined) return this.notFound();
    const key = `capture|${id}|${rid ?? ''}`;
    const prior = rid === null ? undefined : this.replays.get(key);
    if (prior !== undefined) return this.res(200, prior.body);
    if (o.status === 'COMPLETED') {
      return this.err(
        422,
        'UNPROCESSABLE_ENTITY',
        'ORDER_ALREADY_CAPTURED',
        'Order already captured. If intent=CAPTURE only one capture per order is allowed.',
      );
    }
    if (o.status !== 'APPROVED') {
      return this.err(
        422,
        'UNPROCESSABLE_ENTITY',
        'ORDER_NOT_APPROVED',
        'Payer has not yet approved the Order for payment. Please redirect the payer to the approve url returned as part of the response.',
      );
    }
    o.status = 'COMPLETED';
    o.updated = this.stamp();
    o.units.forEach((u, i) => {
      u.capture = {
        id: `${o.id}CAP${i + 1}`,
        status: o.scenario === 'pending_then_declined' ? 'PENDING' : 'COMPLETED',
      };
    });
    const answer = this.orderBody(o);
    if (rid !== null) this.replays.set(key, { status: 201, body: answer });
    return this.res(201, answer);
  }

  private getCapture(id: string): TransportResult {
    for (const o of this.orders.values()) {
      for (const u of o.units) {
        if (u.capture?.id === id) {
          this.settle(o);
          return this.res(200, this.captureBody(u.capture, u, o));
        }
      }
    }
    return this.notFound();
  }
}

// ---------------------------------------------------------------------------------------------
// The dry-run stack: recorder, router, hooks
// ---------------------------------------------------------------------------------------------

export interface DryRunStack {
  transport: Transport & { readonly kind: 'dryrun' };
  /** Every request handed to the transport, in order, including blocked ones. */
  calls(): OutboundRequest[];
  /** Guard-accepted request URLs, in order: where each call would have gone. */
  urls(): string[];
  approve(provider_order_id: string): void;
}

const openGate = {
  check: async () => ({ allowed: true as const, approval_ref: 'testkit-dryrun' }),
};
const quietLog: Logger = { log: () => undefined, child: () => quietLog };

/**
 * @param default_scenario scenario for requests that carry none. A fixture scenario name
 *   (for example `happy`) plays the recorded exchange; null uses the order model.
 */
export async function createDryRunStack(o: {
  clock: Clock;
  default_scenario?: string | null;
}): Promise<DryRunStack> {
  const fixtures = await loadFixtures(FIXTURE_ROOT);
  const names = new Set(fixtures.map((f) => f.meta.scenario));
  const fallback = o.default_scenario ?? null;
  const played = createDryRunTransport({
    fixtures,
    gate: openGate,
    clock: o.clock,
    default_scenario: fallback ?? 'happy',
    log: quietLog,
  });
  const model = new ModelPayPal(o.clock);
  const calls: OutboundRequest[] = [];
  const urls: string[] = [];
  const transport: DryRunStack['transport'] = {
    kind: 'dryrun',
    async send(r: OutboundRequest): Promise<TransportResult> {
      calls.push({ ...r, headers: { ...r.headers } });
      const g = guard(r, 'dryrun');
      if (!g.ok) return { kind: 'blocked', by: 'egress' };
      urls.push(g.url.href);
      const scenario = r.scenario ?? fallback;
      return scenario !== null && names.has(scenario) ? played.send(r) : model.send(r);
    },
  };
  return {
    transport,
    calls: () => calls.map((c) => ({ ...c, headers: { ...c.headers } })),
    urls: () => [...urls],
    approve: (id) => model.approve(id),
  };
}

// ---------------------------------------------------------------------------------------------
// Requests and subjects
// ---------------------------------------------------------------------------------------------

/** A valid one-unit create request. Fixture scenarios ignore the amounts; the model echoes them. */
export function createReqFor(scenario: string | null = null, tag = 'SBX0001'): CreateOrderReq {
  return {
    request_id: `umsC-${tag}-0123456789abcdef0123456789abcdef`,
    order_ref: `ord_${tag}`,
    units: [
      {
        reference_id: 'unit-1',
        payee_merchant_id: 'SBXMERCHANT01',
        amount: { currency: 'USD', minor: 500 },
      },
    ],
    return_url: `https://shop.example.invalid/checkout/return?ref=ord_${tag}`,
    cancel_url: `https://shop.example.invalid/checkout/cancel?ref=ord_${tag}`,
    scenario,
  };
}

// Puts the current dry-run scenario on every call that names none, so a case sets it once.
function withScenario(port: PayPalPort, current: () => string | null): PayPalPort {
  return {
    environment: port.environment,
    createOrder: (r) => port.createOrder(r.scenario === null ? { ...r, scenario: current() } : r),
    getOrder: (id, sc) => port.getOrder(id, sc ?? current()),
    captureOrder: (r) => port.captureOrder({ ...r, scenario: r.scenario ?? current() }),
    getCapture: (id, sc) => port.getCapture(id, sc ?? current()),
    refundCapture: (r) => port.refundCapture(r),
    getRefund: (id) => port.getRefund(id),
    verifyWebhook: (w) => port.verifyWebhook(w),
  };
}

/** The dry-run subject for the conformance suite: model for P1 to P15, fixtures for D1 to D6. */
export function dryRunSubject(): ConformanceSubject {
  let n = 0;
  return {
    name: 'dry-run',
    async make() {
      const clock = fakeClock(T0);
      const stack = await createDryRunStack({ clock });
      let current: string | null = null;
      const adapter = createPayPalAdapter({
        transport: stack.transport,
        clock,
        log: quietLog,
        credentials: null,
        record: async () => undefined,
      });
      const hooks: ConformanceHooks = {
        approve: async (id: ProviderOrderId) => stack.approve(id),
        scenario: (name) => {
          current = name;
        },
        sentUrls: () => stack.urls(),
      };
      return { port: withScenario(adapter, () => current), hooks };
    },
    orderRequest() {
      n += 1;
      return createReqFor(null, `SBX${String(n).padStart(4, '0')}`);
    },
  };
}

// ---------------------------------------------------------------------------------------------
// testDeps
// ---------------------------------------------------------------------------------------------

export type TestDeps = PaymentsDeps &
  AgentDeps & {
    db: Database & { close(): Promise<void> };
    clock: ReturnType<typeof fakeClock>;
    transport: Transport;
    calls(): OutboundRequest[];
  };

function dbContent(db: Database): ContentStore {
  return {
    async head(key) {
      const r = await db.query<{ bytes: number | string; sha256: string; mime: string }>(
        'SELECT bytes, sha256, mime FROM content_blobs WHERE content_key = $1',
        [key],
      );
      const row = r.rows[0];
      return row === undefined
        ? null
        : { bytes: Number(row.bytes), sha256: row.sha256, mime: row.mime };
    },
    async open(key) {
      const r = await db.query<{ data: Uint8Array }>(
        'SELECT data FROM content_blobs WHERE content_key = $1',
        [key],
      );
      const row = r.rows[0];
      if (row === undefined) return null;
      const data = row.data;
      return (async function* () {
        yield data;
      })();
    },
    health: async () => true,
  };
}

/**
 * The full dependency bundle over a fresh migrated database: fake clock, seeded ids, the real
 * switch reader (no cache), audit sink, scripted model, a db-backed content store, and the PayPal
 * adapter over the dry-run stack. `scenario` is the default fixture scenario (default `happy`).
 * Nothing leaves the process: transport.kind is `dryrun` and calls() lists every request.
 */
export async function testDeps(o: { start?: IsoUtc; scenario?: string } = {}): Promise<TestDeps> {
  const clock = fakeClock(o.start ?? T0);
  const db = await testDb();
  const ids = seededIds('testkit-deps');
  const stack = await createDryRunStack({ clock, default_scenario: o.scenario ?? 'happy' });
  const log = createLogger(() => undefined, {}, clock);
  const config = DomainConfigSchema.parse({
    reconcile_window_ms: 86_400_000,
    reconcile_backoff_ms: [30_000, 120_000, 600_000, 3_600_000],
    idem_safe_window_ms: 18_000_000,
    abandoned_checkout_ms: 86_400_000,
    operation_lease_ms: 60_000,
    max_capture_retries: 1,
    link_ttl_ms: 600_000,
    public_origin: 'http://localhost:3000',
    approval_secret: makeSecret('testkit-approval-secret-not-real-0123456789'),
    link_secret: makeSecret('testkit-link-secret-not-real-0123456789abc'),
    rule_version: 'rules-test',
    pricing_rule_version: 'pricing-test',
  });
  const paypal = createPayPalAdapter({
    transport: stack.transport,
    clock,
    log,
    credentials: null,
    record: async () => undefined,
  });
  return {
    db,
    clock,
    ids,
    log,
    audit: createAuditSink(ids, clock),
    switches: createSwitchReader(db, clock, 0),
    config,
    environment: 'dryrun',
    paypal,
    content: dbContent(db),
    model: createScriptedModel(),
    transport: stack.transport,
    calls: stack.calls,
  };
}
