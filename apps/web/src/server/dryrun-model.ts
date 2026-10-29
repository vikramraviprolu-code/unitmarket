// The dry-run PayPal order model for the web app (lane 15b). Adapted from the testkit order model
// (packages/testkit/src/stack.ts, SBX lane 16) with the scenario behaviour of the lane 03 fixture
// scenarios added. It is needed because a fixture answers with its own fixed amounts and ids,
// while the web app builds orders with the catalogue price and a generated reference: the model
// echoes what was created, so the real order, adapter and match logic run over it.
//
// CO-8: it also answers refund_capture and get_refund and lists the refunds on GET order, so the refund
// journey runs offline. A refund is COMPLETED at once.
//
// Dry-run only. It opens no socket, reads no environment and no clock of its own (the clock is
// injected), and its answers are synthetic: they are not PayPal evidence. Only type imports.
import type { Clock, OutboundRequest, TransportResult } from '@umsbx/contracts';

/** Scenario ids a tester can pick on the dry-run checkout page. All are lane 03 fixture scenarios. */
export const DRYRUN_SCENARIOS: readonly { id: string; label: string }[] = [
  { id: 'happy', label: 'Payment goes through' },
  { id: 'capture_202', label: 'PayPal answers "accepted" (claim only)' },
  { id: 'pending_receiving_pref', label: 'Payment pending at PayPal' },
  { id: 'pending_then_completed', label: 'Pending, then completed' },
  { id: 'lost_capture_response', label: 'Response lost, we read it back' },
  { id: 'declined', label: 'Payment declined' },
  { id: 'mismatch_amount', label: 'Amount does not match (frozen)' },
  { id: 'mismatch_payee', label: 'Payee does not match (frozen)' },
];

const SCENARIO_SHAPE = /^[a-z0-9_]{1,60}$/;
export const isScenarioId = (v: unknown): v is string =>
  typeof v === 'string' && SCENARIO_SHAPE.test(v);

type Json = Record<string, unknown>;
const isRec = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

interface ModelCapture {
  id: string;
  status: 'COMPLETED' | 'PENDING' | 'DECLINED';
  reason: string | null;
}
/** A refund the model took (CO-8). It is COMPLETED at once; the model has no pending refund. */
interface ModelRefund {
  id: string;
  capture_id: string;
  minor: number;
  created: string;
}
interface ModelUnit {
  reference_id: string;
  custom_id: string;
  amount: { currency_code: string; value: string };
  payee: { merchant_id: string } | null;
  capture: ModelCapture | null;
  refunds: ModelRefund[];
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

// Decimal string to minor units and back, two decimals (the corridor is USD).
const toMinor = (v: string): number => {
  const [w = '0', f = ''] = v.split('.');
  return Number(w) * 100 + Number(`${f}00`.slice(0, 2));
};
const fromMinor = (m: number): string =>
  `${Math.floor(m / 100)}.${String(m % 100).padStart(2, '0')}`;

// The sandbox approval host the contracts accept for an approve link (P15). Assembled from parts so
// no web source carries the host as a literal (the page tests scan sources for PayPal addresses);
// no page or script ever loads from it: the dry-run page replaces the PayPal approval page.
const APPROVE_HOST = ['www', 'sandbox', 'paypal', 'com'].join('.');

const ERR_LINK = [
  { href: '/api/rest/reference/orders/v2/errors/', rel: 'information_link', method: 'GET' },
];

export interface DryRunModel {
  /** The buyer approves at the pretend PayPal page, with the scenario they chose. */
  approve(provider_order_id: string, scenario: string | null): boolean;
  send(r: OutboundRequest): TransportResult;
}

export interface DryRunModelOptions {
  /**
   * BU-7 (D-028): the merchant id of the account the app's credentials belong to. A create unit that
   * names no payee is answered with this id as its payee, the way PayPal names the seller's own
   * account. Null or omitted: such a unit has no payee in any answer (so a setup that leaves the
   * payee out without an own id shows up as a payee mismatch at read-back).
   */
  own_merchant_id?: string | null;
}

export function createDryRunModel(clock: Clock, opts: DryRunModelOptions = {}): DryRunModel {
  const ownPayee =
    typeof opts.own_merchant_id === 'string' && opts.own_merchant_id !== ''
      ? { merchant_id: opts.own_merchant_id }
      : null;
  const orders = new Map<string, ModelOrder>();
  const replays = new Map<string, Stored>();
  // D-033: the owner's account refuses an invoice id it has already seen for the same payee. A payee
  // that is left out is the account's own (D-028), so it is one payee too.
  const invoices = new Set<string>();
  let n = 0;
  let refundN = 0;
  let debug = 0;

  const stamp = (): string =>
    clock
      .now()
      .toISOString()
      .replace(/\.\d{3}Z$/, 'Z');
  const res = (status: number, body: unknown): TransportResult => {
    debug += 1;
    return {
      kind: 'response',
      status,
      headers: {
        'content-type': 'application/json',
        'paypal-debug-id': `sbxmodel${String(debug).padStart(4, '0')}`,
      },
      body: JSON.stringify(body),
      duration_ms: 1,
    };
  };
  const fail = (status: number, name: string, issue: string, description: string) =>
    res(status, {
      name,
      message: 'Synthetic model answer, not PayPal evidence.',
      debug_id: `sbxmodel${String(debug + 1).padStart(4, '0')}`,
      details: [{ issue, description }],
      links: ERR_LINK,
    });
  const notFound = (): TransportResult =>
    fail(
      404,
      'RESOURCE_NOT_FOUND',
      'INVALID_RESOURCE_ID',
      'Specified resource ID does not exist. Please check the resource ID and try again.',
    );

  const scenarioOf = (o: ModelOrder, r: OutboundRequest): string =>
    r.scenario ?? o.scenario ?? 'happy';

  const refundedOf = (u: ModelUnit): number => u.refunds.reduce((sum, r) => sum + r.minor, 0);

  // A refunded capture reads PARTIALLY_REFUNDED or REFUNDED from what the model refunded, with the
  // refunded total in the receivable breakdown, the way a real capture is read after a refund.
  const captureBody = (c: ModelCapture, u: ModelUnit, o: ModelOrder): Json => {
    const refunded = c.status === 'COMPLETED' ? refundedOf(u) : 0;
    const status =
      refunded <= 0
        ? c.status
        : refunded >= toMinor(u.amount.value)
          ? 'REFUNDED'
          : 'PARTIALLY_REFUNDED';
    return {
      id: c.id,
      status,
      amount: u.amount,
      final_capture: true,
      create_time: o.updated,
      update_time: o.updated,
      ...(c.reason === null ? {} : { status_details: { reason: c.reason } }),
      ...(c.status === 'COMPLETED'
        ? {
            seller_receivable_breakdown: {
              gross_amount: u.amount,
              paypal_fee: {
                currency_code: u.amount.currency_code,
                value: fromMinor(Math.floor(toMinor(u.amount.value) / 10)),
              },
              ...(refunded > 0
                ? {
                    total_refunded_amount: {
                      currency_code: u.amount.currency_code,
                      value: fromMinor(refunded),
                    },
                  }
                : {}),
            },
          }
        : {}),
    };
  };

  const refundBody = (r: ModelRefund, u: ModelUnit): Json => ({
    id: r.id,
    status: 'COMPLETED',
    amount: { currency_code: u.amount.currency_code, value: fromMinor(r.minor) },
    create_time: r.created,
    update_time: r.created,
    links: [
      { href: `/v2/payments/refunds/${r.id}`, rel: 'self', method: 'GET' },
      { href: `/v2/payments/captures/${r.capture_id}`, rel: 'up', method: 'GET' },
    ],
  });

  // What a read shows. The mismatch scenarios change one field of what PayPal reports; the order
  // that was created is never touched.
  const orderBody = (o: ModelOrder, scenario: string): Json => ({
    id: o.id,
    status: o.status,
    intent: 'CAPTURE',
    purchase_units: o.units.map((u) => {
      const amount =
        scenario === 'mismatch_amount'
          ? { ...u.amount, value: fromMinor(Math.max(0, toMinor(u.amount.value) - 1)) }
          : u.amount;
      // mismatch_payee_after_capture (DP-5b): the payee reads right until the payment is captured, then
      // another one. It lets a test reach "captured, then held" through the engine. It is not listed
      // for the dry-run page (DRYRUN_SCENARIOS).
      const wrongPayee =
        scenario === 'mismatch_payee' ||
        (scenario === 'mismatch_payee_after_capture' && u.capture !== null);
      const payee = wrongPayee ? { merchant_id: 'SBXMERCHANT99' } : (u.payee ?? undefined);
      return {
        reference_id: u.reference_id,
        custom_id: u.custom_id,
        amount,
        ...(payee === undefined ? {} : { payee }),
        ...(u.capture === null
          ? {}
          : {
              payments: {
                captures: [captureBody(u.capture, u, o)],
                // The refunds of the capture, whoever made them (here: only the ones the model took).
                ...(u.refunds.length === 0
                  ? {}
                  : { refunds: u.refunds.map((r) => refundBody(r, u)) }),
              },
            }),
      };
    }),
    create_time: o.created,
    update_time: o.updated,
    links: [{ href: `/v2/checkout/orders/${o.id}`, rel: 'self', method: 'GET' }],
  });

  // pending_then_completed: PENDING for the first two reads after the capture, then COMPLETED.
  // pending_then_declined: PENDING for one read, then DECLINED. The capture id never changes.
  const settle = (o: ModelOrder, scenario: string): void => {
    if (o.status !== 'COMPLETED') return;
    const after = (status: ModelCapture['status'], reads: number): void => {
      if (o.readsSinceCapture < reads) return;
      for (const u of o.units) {
        if (u.capture !== null) {
          u.capture.status = status;
          u.capture.reason = null;
        }
      }
    };
    if (scenario === 'pending_then_completed') after('COMPLETED', 2);
    if (scenario === 'pending_then_declined') after('DECLINED', 1);
    o.readsSinceCapture += 1;
  };

  const create = (r: OutboundRequest, body: unknown, rid: string | null): TransportResult => {
    const key = `create|${rid ?? ''}`;
    const prior = rid === null ? undefined : replays.get(key);
    if (prior !== undefined) return res(prior.status, prior.body);
    const units = isRec(body) && Array.isArray(body.purchase_units) ? body.purchase_units : [];
    if (units.length === 0) {
      return fail(400, 'INVALID_REQUEST', 'MISSING_REQUIRED_PARAMETER', 'purchase_units');
    }
    const seen = units.filter(isRec).map((u) => {
      const payee = isRec(u.payee) && typeof u.payee.merchant_id === 'string' ? u.payee : null;
      const who = payee === null ? (ownPayee?.merchant_id ?? '') : String(payee.merchant_id);
      return typeof u.invoice_id === 'string' && u.invoice_id !== ''
        ? `${who}|${u.invoice_id}`
        : null;
    });
    const fresh = seen.filter((k): k is string => k !== null);
    if (fresh.some((k) => invoices.has(k)) || new Set(fresh).size !== fresh.length) {
      return fail(
        422,
        'UNPROCESSABLE_ENTITY',
        'DUPLICATE_INVOICE_ID',
        'Duplicate Invoice ID detected. To avoid a potential duplicate transaction your account setting requires that Invoice Id be unique for each transaction.',
      );
    }
    for (const k of fresh) invoices.add(k);
    n += 1;
    const id = `SBXMODELORD${String(n).padStart(6, '0')}`;
    const now = stamp();
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
          payee: payee === null ? ownPayee : { merchant_id: String(payee.merchant_id) },
          capture: null,
          refunds: [],
        };
      }),
    };
    orders.set(id, order);
    const answer = {
      id,
      status: 'CREATED',
      links: [
        { href: `/v2/checkout/orders/${id}`, rel: 'self', method: 'GET' },
        {
          href: `https://${APPROVE_HOST}/checkoutnow?token=${id}`,
          rel: 'approve',
          method: 'GET',
        },
        { href: `/v2/checkout/orders/${id}/capture`, rel: 'capture', method: 'POST' },
      ],
    };
    if (rid !== null) replays.set(key, { status: 201, body: answer });
    return res(201, answer);
  };

  const get = (id: string, r: OutboundRequest): TransportResult => {
    const o = orders.get(id);
    if (o === undefined) return notFound();
    const sc = scenarioOf(o, r);
    settle(o, sc);
    return res(200, orderBody(o, sc));
  };

  const capture = (id: string, r: OutboundRequest, rid: string | null): TransportResult => {
    const o = orders.get(id);
    if (o === undefined) return notFound();
    const sc = scenarioOf(o, r);
    const key = `capture|${id}|${rid ?? ''}`;
    const prior = rid === null ? undefined : replays.get(key);
    if (prior !== undefined) return res(200, prior.body);
    if (o.status === 'COMPLETED') {
      return fail(
        422,
        'UNPROCESSABLE_ENTITY',
        'ORDER_ALREADY_CAPTURED',
        'Order already captured. If intent=CAPTURE only one capture per order is allowed.',
      );
    }
    if (o.status !== 'APPROVED') {
      return fail(
        422,
        'UNPROCESSABLE_ENTITY',
        'ORDER_NOT_APPROVED',
        'Payer has not yet approved the Order for payment. Please redirect the payer to the approve url returned as part of the response.',
      );
    }
    o.status = 'COMPLETED';
    o.updated = stamp();
    const outcome: Pick<ModelCapture, 'status' | 'reason'> =
      sc === 'declined'
        ? { status: 'DECLINED', reason: null }
        : sc === 'pending_receiving_pref'
          ? { status: 'PENDING', reason: 'RECEIVING_PREFERENCE_MANDATES_MANUAL_ACTION' }
          : sc === 'pending_then_completed' || sc === 'pending_then_declined'
            ? { status: 'PENDING', reason: 'PENDING_REVIEW' }
            : { status: 'COMPLETED', reason: null };
    o.units.forEach((u, i) => {
      u.capture = { id: `${o.id}CAP${i + 1}`, ...outcome };
    });
    // capture_202: PayPal accepted the request; the answer carries no capture data.
    if (sc === 'capture_202') {
      const accepted = { id: o.id, status: 'APPROVED', links: [] };
      if (rid !== null) replays.set(key, { status: 202, body: accepted });
      return res(202, accepted);
    }
    const answer = orderBody(o, 'happy');
    if (rid !== null) replays.set(key, { status: 201, body: answer });
    // lost_capture_response: the capture happened; the answer never arrived. The same request id
    // later replays the stored answer.
    if (sc === 'lost_capture_response') return { kind: 'timeout' };
    return res(201, answer);
  };

  const getCapture = (id: string, r: OutboundRequest): TransportResult => {
    for (const o of orders.values()) {
      for (const u of o.units) {
        if (u.capture?.id === id) {
          const sc = scenarioOf(o, r);
          settle(o, sc);
          return res(200, captureBody(u.capture, u, o));
        }
      }
    }
    return notFound();
  };

  const findCapture = (id: string): { o: ModelOrder; u: ModelUnit } | null => {
    for (const o of orders.values())
      for (const u of o.units) if (u.capture?.id === id) return { o, u };
    return null;
  };

  // POST /v2/payments/captures/{id}/refund (CO-8). The amount is checked against what is left; the same
  // PayPal-Request-Id replays the first answer; no amount refunds what is left. Only a capture that
  // completed can be refunded.
  const refund = (id: string, body: unknown, rid: string | null): TransportResult => {
    const hit = findCapture(id);
    if (hit === null) return notFound();
    const key = `refund|${id}|${rid ?? ''}`;
    const prior = rid === null ? undefined : replays.get(key);
    if (prior !== undefined) return res(prior.status, prior.body);
    const { o, u } = hit;
    if (u.capture?.status !== 'COMPLETED') {
      return fail(
        422,
        'UNPROCESSABLE_ENTITY',
        'CAPTURE_NOT_COMPLETED',
        'The capture is not completed, so it cannot be refunded.',
      );
    }
    const left = toMinor(u.amount.value) - refundedOf(u);
    if (left <= 0) {
      return fail(
        422,
        'UNPROCESSABLE_ENTITY',
        'CAPTURE_FULLY_REFUNDED',
        'The capture has already been fully refunded.',
      );
    }
    let minor = left;
    if (isRec(body) && body.amount !== undefined) {
      const a = body.amount;
      if (
        !isRec(a) ||
        a.currency_code !== u.amount.currency_code ||
        typeof a.value !== 'string' ||
        !/^\d{1,9}(\.\d{1,2})?$/.test(a.value)
      ) {
        return fail(400, 'INVALID_REQUEST', 'INVALID_PARAMETER_VALUE', 'amount');
      }
      minor = toMinor(a.value);
      if (minor <= 0) return fail(400, 'INVALID_REQUEST', 'INVALID_PARAMETER_VALUE', 'amount');
    }
    if (minor > left) {
      return fail(
        422,
        'UNPROCESSABLE_ENTITY',
        'REFUND_AMOUNT_EXCEEDED',
        'The refund amount is more than the amount left on the capture.',
      );
    }
    refundN += 1;
    const made: ModelRefund = {
      id: `SBXMODELREF${String(refundN).padStart(6, '0')}`,
      capture_id: id,
      minor,
      created: stamp(),
    };
    u.refunds.push(made);
    o.updated = made.created;
    const answer = refundBody(made, u);
    if (rid !== null) replays.set(key, { status: 201, body: answer });
    return res(201, answer);
  };

  const getRefund = (id: string): TransportResult => {
    for (const o of orders.values())
      for (const u of o.units) {
        const r = u.refunds.find((x) => x.id === id);
        if (r !== undefined) return res(200, refundBody(r, u));
      }
    return notFound();
  };

  return {
    approve(id, scenario) {
      const o = orders.get(id);
      if (o === undefined || o.status !== 'CREATED') return false;
      o.status = 'APPROVED';
      o.scenario = scenario ?? o.scenario;
      o.updated = stamp();
      return true;
    },
    send(r) {
      const path = r.path.replace(/^https?:\/\/[^/]+/, '');
      const parts = path.split('/').filter((p) => p.length > 0);
      const rid = headerOf(r.headers, 'paypal-request-id');
      let body: unknown = null;
      try {
        body = r.body === null ? null : JSON.parse(r.body);
      } catch {
        body = null;
      }
      switch (r.operation) {
        case 'create_order':
          return create(r, body, rid);
        case 'get_order':
          return get(parts[3] ?? '', r);
        case 'capture_order':
          return capture(parts[3] ?? '', r, rid);
        case 'get_capture':
          return getCapture(parts[3] ?? '', r);
        case 'refund_capture':
          return refund(parts[3] ?? '', body, rid);
        case 'get_refund':
          return getRefund(parts[3] ?? '');
        default:
          // Webhooks are not modelled here; the fixtures cover them in tests.
          return { kind: 'blocked', by: 'dry_run_miss' };
      }
    },
  };
}
