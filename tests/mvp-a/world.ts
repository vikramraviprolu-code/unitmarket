// MVP-A gate world (lane 18). Offline only: a migrated in-memory database, the seeded fictional
// catalogue, a fake clock, and a scripted PayPalPort written here from the PayPalPort contract
// (packages/contracts/src/paypal.ts). No network, no credentials, no PayPal account.
// The fake follows what the adopted requirements say PayPal does: a repeated PayPal-Request-Id gets
// the first definitive answer, one capture per order, a lost response still captures.
import { approveRowsFor } from './world-rows';
import { requestApproval } from '@umsbx/approval';
import { SEED_DATA } from '@umsbx/catalogue';
import { startFromOffer } from '@umsbx/offer-entry';
import { beginCheckout, onBuyerReturn, placeOrder } from '@umsbx/payments';
import { seedTestCatalogue, testDeps, T0 } from '@umsbx/testkit';
import type { TestDeps } from '@umsbx/testkit';
import type {
  Actor,
  CaptureRes,
  CaptureStatus,
  CreateOrderReq,
  CreateOrderRes,
  Id,
  OrderRead,
  PaymentsDeps,
  PayPalPort,
  Quote,
} from '@umsbx/contracts';

export { T0 };
export const HOUR = 3_600_000;
export const DAY = 86_400_000;
export const BUYER_A: Actor = { kind: 'buyer', buyer_id: 'buy_A' };
export const BUYER_B: Actor = { kind: 'buyer', buyer_id: 'buy_B' };
export const CONSENT = { terms: true, identity_share: false } as const;

export interface FakeCall {
  op: 'create' | 'get' | 'capture';
  provider_order_id: string | null;
  request_id: string | null;
}
interface FakeOrder {
  id: string;
  req: CreateOrderReq;
  status: 'CREATED' | 'APPROVED' | 'COMPLETED';
  capture: { id: string; status: CaptureStatus; reason: string | null } | null;
}

export interface Tamper {
  amount_delta?: number;
  payee?: string;
  currency?: string;
  custom_id?: string | null;
}

export class FakePayPal implements PayPalPort {
  readonly environment = 'dryrun' as const;
  readonly calls: FakeCall[] = [];
  readonly orders = new Map<string, FakeOrder>();
  /** order_ref -> provider order id */
  readonly byRef = new Map<string, string>();
  tamper: Tamper = {};
  /** Behaviour of the next capture the provider performs. */
  next: {
    status: CaptureStatus;
    reason: string | null;
    claim_http: 200 | 201 | 202;
    lose_response: boolean;
  } = { status: 'COMPLETED', reason: null, claim_http: 201, lose_response: false };
  /** When set, order reads answer `unavailable` (the read-back cannot be done). */
  readsUnavailable = false;
  /** When set, order reads answer `unavailable` once a capture exists (the read-back after capture). */
  readsUnavailableAfterCapture = false;
  /** When set, order reads answer normally but show no capture, whatever the provider did (stale read). */
  readsShowNoCapture = false;
  /** Runs when a create call reaches the provider: the database can be inspected here (A-10). */
  onCreate: (() => Promise<void>) | null = null;
  /** Holds capture calls until released (A-15). */
  hold: Promise<void> | null = null;
  private seq = 0;
  private createdBy = new Map<string, CreateOrderRes>();
  private capturedBy = new Map<string, CaptureRes>();

  private readonly nowIso: () => string;
  constructor(nowIso: () => string) {
    this.nowIso = nowIso;
  }

  count(op: FakeCall['op']): number {
    return this.calls.filter((c) => c.op === op).length;
  }
  approve(order_ref: string): string {
    const id = this.byRef.get(order_ref);
    const o = id === undefined ? undefined : this.orders.get(id);
    if (o === undefined) throw new Error(`no provider order for ${order_ref}`);
    if (o.status === 'CREATED') o.status = 'APPROVED';
    return o.id;
  }

  async createOrder(req: CreateOrderReq): Promise<CreateOrderRes> {
    this.calls.push({ op: 'create', provider_order_id: null, request_id: req.request_id });
    if (this.onCreate !== null) await this.onCreate();
    const seen = this.createdBy.get(req.request_id);
    if (seen !== undefined) return seen;
    this.seq += 1;
    const id = `SBXGATEORD${String(this.seq).padStart(5, '0')}`;
    this.orders.set(id, { id, req, status: 'CREATED', capture: null });
    this.byRef.set(req.order_ref, id);
    const res: CreateOrderRes = {
      kind: 'created',
      provider_order_id: id,
      status: 'CREATED',
      approve_url: `https://www.sandbox.paypal.com/checkoutnow?token=${id}`,
      debug_id: 'DBGGATE',
    };
    this.createdBy.set(req.request_id, res);
    return res;
  }

  async getOrder(id: string): Promise<OrderRead> {
    this.calls.push({ op: 'get', provider_order_id: id, request_id: null });
    if (this.readsUnavailable) return { kind: 'unavailable', retry_after_ms: null };
    const o = this.orders.get(id);
    if (this.readsUnavailableAfterCapture && o?.capture !== null && o !== undefined)
      return { kind: 'unavailable', retry_after_ms: null };
    if (o === undefined) return { kind: 'not_found', debug_id: null };
    const t = this.tamper;
    return {
      kind: 'order',
      provider_order_id: o.id,
      status: o.status,
      custom_id: t.custom_id === undefined ? o.req.order_ref : t.custom_id,
      read_at: this.nowIso() as OrderRead extends { read_at: infer R } ? R : never,
      debug_id: `DBGREAD${o.id}`.slice(0, 40),
      units: o.req.units.map((u, k) => ({
        reference_id: u.reference_id,
        payee_merchant_id: t.payee ?? u.payee_merchant_id,
        amount: {
          currency: t.currency ?? u.amount.currency,
          minor: u.amount.minor + (t.amount_delta ?? 0),
        },
        capture:
          o.capture === null || this.readsShowNoCapture
            ? null
            : {
                capture_id: `${o.capture.id}${k === 0 ? '' : `U${k}`}`,
                status: o.capture.status,
                status_reason: o.capture.reason,
                amount: {
                  currency: t.currency ?? u.amount.currency,
                  minor: u.amount.minor + (t.amount_delta ?? 0),
                },
                paypal_fee_minor: 45,
                refunded_minor: 0,
              },
      })),
    } as OrderRead;
  }

  async captureOrder(r: {
    provider_order_id: string;
    request_id: string;
    scenario?: string | null;
  }): Promise<CaptureRes> {
    this.calls.push({
      op: 'capture',
      provider_order_id: r.provider_order_id,
      request_id: r.request_id,
    });
    if (this.hold !== null) await this.hold;
    const seen = this.capturedBy.get(r.request_id);
    if (seen !== undefined) return seen;
    const o = this.orders.get(r.provider_order_id);
    if (o === undefined) return { kind: 'not_found', debug_id: null };
    if (o.status !== 'APPROVED') {
      return {
        kind: 'rejected',
        http: 422,
        name: 'UNPROCESSABLE_ENTITY',
        issue: o.capture === null ? 'ORDER_NOT_APPROVED' : 'ORDER_ALREADY_CAPTURED',
        debug_id: 'DBGCAPREJ',
      };
    }
    this.seq += 1;
    o.capture = {
      id: `SBXGATECAP${String(this.seq).padStart(5, '0')}`,
      status: this.next.status,
      reason: this.next.reason,
    };
    o.status = 'COMPLETED';
    const claim: CaptureRes = {
      kind: 'claim',
      http: this.next.claim_http,
      provider_order_id: o.id,
      units: o.req.units.map((u, k) => ({
        reference_id: u.reference_id,
        capture_id: `${o.capture?.id ?? ''}${k === 0 ? '' : `U${k}`}`,
        status: this.next.claim_http === 202 ? null : (o.capture?.status ?? null),
      })),
      debug_id: 'DBGCAP',
    };
    this.capturedBy.set(r.request_id, claim);
    if (this.next.lose_response) return { kind: 'timeout' };
    return claim;
  }

  async getCapture(): Promise<never> {
    throw new Error('getCapture is not used by the MVP-A gate');
  }
  async refundCapture(): Promise<never> {
    throw new Error('refundCapture is not used by the MVP-A gate');
  }
  async getRefund(): Promise<never> {
    throw new Error('getRefund is not used by the MVP-A gate');
  }
  async verifyWebhook(): Promise<never> {
    throw new Error('verifyWebhook is not used by the MVP-A gate');
  }
}

export interface World {
  td: TestDeps;
  deps: PaymentsDeps;
  paypal: FakePayPal;
  offerIds: Id[];
}

/** A fresh world: migrated database, seeded catalogue, two buyers, verified payees. */
export async function makeWorld(o: { start?: string } = {}): Promise<World> {
  const td = await testDeps(o.start === undefined ? {} : { start: o.start as typeof T0 });
  const seeded = await seedTestCatalogue(td.db);
  await approveRowsFor(td.db, td.clock.now().toISOString());
  const paypal = new FakePayPal(() => td.clock.now().toISOString());
  const deps: PaymentsDeps = { ...td, paypal };
  return { td, deps, paypal, offerIds: seeded.offer_ids };
}

export const offerRef = (publisher_slug: string, offer_code: string) =>
  ({ publisher_slug, offer_code }) as const;
export const HARBOUR = 'harbour-ledger';

export const PRICES = Object.fromEntries(
  SEED_DATA.offers.map((o) => [o.code, o.options.map((p) => p.price_minor)]),
) as Record<string, number[]>;

export async function quoteFor(
  w: World,
  buyer: Actor,
  code: string,
  extra: {
    option?: 'keep_retrieve' | 'online_read';
    ceiling_minor?: number;
    proposed_minor?: number;
  } = {},
): Promise<Quote> {
  const r = await startFromOffer(w.deps, {
    offer: offerRef(HARBOUR, code),
    actor: buyer,
    source: 'direct',
    option: extra.option ?? 'keep_retrieve',
    ...(extra.ceiling_minor === undefined ? {} : { ceiling_minor: extra.ceiling_minor }),
    ...(extra.proposed_minor === undefined ? {} : { proposed_minor: extra.proposed_minor }),
  });
  if (!r.ok || r.value.kind !== 'quote') {
    throw new Error(`no quote for ${code}: ${JSON.stringify(r.ok ? r.value : r.error)}`);
  }
  return r.value;
}

export async function approvalFor(w: World, buyer: Actor, code: string, option = 'keep_retrieve') {
  const q = await quoteFor(w, buyer, code, { option: option as 'keep_retrieve' });
  const g = await requestApproval(w.deps, {
    actor: buyer,
    selection: { kind: 'quote', quote_id: q.quote_id },
    consent: CONSENT,
  });
  if (!g.ok) throw new Error(`no approval for ${code}: ${g.error.code}`);
  return g.value;
}

/** Quote, approval, order, checkout (create call). Stops before the buyer approves at PayPal. */
export async function placeAndCheckout(
  w: World,
  buyer: Actor,
  code: string,
  option = 'keep_retrieve',
) {
  const g = await approvalFor(w, buyer, code, option);
  const placed = await placeOrder(w.deps, {
    approval_id: g.approval_id,
    token: g.token,
    actor: buyer,
  });
  if (!placed.ok) throw new Error(`place: ${JSON.stringify(placed.error)}`);
  const co = await beginCheckout(w.deps, { order_id: placed.value.order_id, actor: buyer });
  if (!co.ok) throw new Error(`checkout: ${co.error.code}`);
  return { ...placed.value, approval: g };
}

/** The whole journey up to and including the buyer's return. */
export async function buy(w: World, buyer: Actor, code: string, option = 'keep_retrieve') {
  const order = await placeAndCheckout(w, buyer, code, option);
  w.paypal.approve(order.order_ref);
  const ret = await onBuyerReturn(w.deps, { order_ref: order.order_ref, actor: buyer });
  return { ...order, ret };
}

export async function one<T = Record<string, unknown>>(
  w: World,
  sql: string,
  params: unknown[] = [],
): Promise<T> {
  const r = await w.td.db.query<T>(sql, params);
  const row = r.rows[0];
  if (row === undefined) throw new Error(`no row: ${sql}`);
  return row;
}
export async function rows<T = Record<string, unknown>>(
  w: World,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  return (await w.td.db.query<T>(sql, params)).rows;
}
