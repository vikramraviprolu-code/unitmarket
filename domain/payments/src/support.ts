// Test world for lane 05a. Synthetic rows only; no real merchant or payer data, no network.
// A PGlite database with every migration, the supply rows an approval needs, a scripted PayPalPort
// (in memory, no transport) and a ContentStore double. The spy: any provider call made while a
// database transaction is open on the same async flow throws and is logged in `violations`.
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { requestApproval } from '@umsbx/approval';
import type { ApprovalGranted } from '@umsbx/approval';
import { migrate, openDatabase } from '@umsbx/db';
import { createPayPalAdapter } from '@umsbx/paypal';
import { createDryRunTransport, loadFixtures } from '@umsbx/transport';
import type { FixtureFile } from '@umsbx/transport';
import { resetDatabase } from '@umsbx/db/testing';
import { afterAll } from 'vitest';
import { fakeClock, seededIds } from '@umsbx/runtime';
import { applyReadback, beginCheckout, placeOrder, readApplyGates } from './index';
import type { ApplyReport } from './index';
import type {
  CaptureRes,
  CaptureStatus,
  CreateOrderReq,
  CreateOrderRes,
  ContentHead,
  ContentStore,
  Database,
  Id,
  Ids,
  OrderRead,
  PaymentsDeps,
  PayPalPort,
  Secret,
  SqlExecutor,
  SwitchName,
} from '@umsbx/contracts';

export const START = '2026-10-22T10:00:00.000Z';
export const SEED_TIME = '2026-10-01T00:00:00Z';
export const FIVE_DAYS_MS = 432_000_000;
export const BUYER_A = { kind: 'buyer', buyer_id: 'buy_A' } as const;
export const BUYER_B = { kind: 'buyer', buyer_id: 'buy_B' } as const;

const secret = (v: string): Secret => ({
  reveal: () => v,
  toString: () => '[redacted]',
  toJSON: () => '[redacted]',
});

// ---------- the scripted PayPal ----------
export interface FakeCall {
  op: 'create' | 'get' | 'capture';
  provider_order_id: string | null;
  request_id: string | null;
  scenario: string | null;
}
interface FakeOrder {
  id: string;
  req: CreateOrderReq;
  status: 'CREATED' | 'APPROVED' | 'COMPLETED' | 'VOIDED';
  capture: {
    capture_id: string;
    status: CaptureStatus;
    reason: string | null;
    fee: number | null;
  } | null;
  capture_request_id: string | null;
}
export interface Tamper {
  amount_delta?: number;
  /** Only the captured amount differs; the purchase-unit amount stays as ordered (M1). */
  capture_amount_delta?: number;
  capture_currency?: string;
  payee?: string;
  currency?: string;
  custom_id?: string | null;
  extra_unit?: boolean;
  drop_unit?: boolean;
  provider_order_id?: string;
  capture_id?: string;
  /** a different unit reference id */
  reference_id?: string;
}
export interface FakePayPal extends PayPalPort {
  readonly calls: FakeCall[];
  readonly violations: string[];
  readonly orders: Map<string, FakeOrder>;
  count(op: FakeCall['op']): number;
  /** The buyer approves at PayPal. */
  approve(provider_order_id: string): void;
  /** PayPal voids the order (it lapsed). */
  void(provider_order_id: string): void;
  /**
   * Overrides consumed in order, one per call of that kind. 'real' lets one call through unchanged,
   * so a scripted answer can be aimed at the second capture of a pack.
   */
  queue: {
    create: (CreateOrderRes | 'real')[];
    get: (OrderRead | 'real')[];
    capture: (CaptureRes | 'real')[];
  };
  /** Per PayPal order, replaces fields of `next` for the capture of that order only (MVP-D). */
  nextBy: Map<string, Partial<FakePayPal['next']>>;
  /** Per PayPal order, replaces fields of `tamper` for every read of that order only (MVP-D). */
  tamperBy: Map<string, Tamper>;
  /** Per PayPal order, applied to the reads of that order once a capture exists (MVP-D). */
  tamperAfterCapture: Map<string, Tamper>;
  /** What a capture does at PayPal. */
  next: {
    status: CaptureStatus;
    reason: string | null;
    fee: number | null;
    lose_response: boolean;
  };
  /** Applied to every order read. */
  tamper: Tamper;
  /** Capture ids already used by the provider (for the foreign-id test). */
  captureIdSeed: number;
  /** Test hook: runs before each get, so a test can interleave work. */
  beforeGet: (() => Promise<void>) | null;
  /** Test hook: runs when a create reaches the provider (the database can be inspected there). */
  beforeCreate: (() => Promise<void>) | null;
  /** The provider performs the capture, then the process "dies": the call throws. */
  crashAfterCapture: boolean;
  /** Holds every capture call until released (concurrency tests). */
  hold: Promise<void> | null;
  /**
   * Like PayPal, the fake remembers the definitive answer to a PayPal-Request-Id for 6 hours and
   * answers a second call with the same id from that memory (a resent capture is not executed
   * again, and a resent create gives the same order). Transport-level answers (timeout, 5xx, 409,
   * blocked) are not remembered. After the retention the id is a new request.
   */
  readonly retention_ms: number;
}

/** PayPal keeps an idempotency key for 6 hours (nfr.md P3, VERIFIED). */
export const RETENTION_MS = 21_600_000;

// PayPal gives each purchase unit its own capture: the first keeps the base id.
const captureIdOf = (o: { capture: { capture_id: string } | null }, k: number): string =>
  `${o.capture?.capture_id ?? ''}${k === 0 ? '' : `U${k}`}`;

export function makeFakePayPal(inTx: () => boolean, clock: { now(): Date }): FakePayPal {
  const calls: FakeCall[] = [];
  const violations: string[] = [];
  const orders = new Map<string, FakeOrder>();
  const storedCreate = new Map<string, { at: number; res: CreateOrderRes }>();
  const storedCapture = new Map<string, { at: number; res: CaptureRes }>();
  let n = 0;
  const guard = (op: string): void => {
    if (inTx()) {
      violations.push(op);
      throw new Error(`PayPal call "${op}" made inside a database transaction`);
    }
  };

  const read = (o: FakeOrder, base: Tamper): OrderRead => {
    const t: Tamper = {
      ...base,
      ...fake.tamperBy.get(o.id),
      ...(o.capture === null ? {} : fake.tamperAfterCapture.get(o.id)),
    };
    const units = o.req.units.map((u, k) => ({
      reference_id: t.reference_id ?? u.reference_id,
      payee_merchant_id: t.payee ?? u.payee_merchant_id,
      amount: {
        currency: t.currency ?? u.amount.currency,
        minor: u.amount.minor + (t.amount_delta ?? 0),
      },
      capture:
        o.capture === null
          ? null
          : {
              capture_id: t.capture_id ?? captureIdOf(o, k),
              status: o.capture.status,
              status_reason: o.capture.reason,
              amount: {
                currency: t.capture_currency ?? t.currency ?? u.amount.currency,
                minor: u.amount.minor + (t.amount_delta ?? 0) + (t.capture_amount_delta ?? 0),
              },
              paypal_fee_minor: o.capture.fee,
              refunded_minor: 0,
            },
    }));
    if (t.extra_unit) {
      units.push({
        reference_id: 'unit-extra',
        payee_merchant_id: 'MERCHX',
        amount: { currency: 'USD', minor: 1 },
        capture: null,
      });
    }
    if (t.drop_unit) units.pop();
    return {
      kind: 'order',
      provider_order_id: t.provider_order_id ?? o.id,
      status: o.status,
      custom_id: t.custom_id === undefined ? o.req.order_ref : t.custom_id,
      read_at: clock.now().toISOString(),
      debug_id: `DBG${o.id}`,
      units,
    };
  };

  const fake: FakePayPal = {
    environment: 'dryrun',
    calls,
    violations,
    orders,
    queue: { create: [], get: [], capture: [] },
    nextBy: new Map(),
    tamperBy: new Map(),
    tamperAfterCapture: new Map(),
    next: { status: 'COMPLETED', reason: null, fee: 45, lose_response: false },
    tamper: {},
    captureIdSeed: 0,
    beforeGet: null,
    beforeCreate: null,
    crashAfterCapture: false,
    hold: null,
    retention_ms: RETENTION_MS,
    count: (op) => calls.filter((c) => c.op === op).length,
    approve(id) {
      const o = orders.get(id);
      if (o === undefined) throw new Error(`unknown provider order ${id}`);
      o.status = 'APPROVED';
    },
    void(id) {
      const o = orders.get(id);
      if (o === undefined) throw new Error(`unknown provider order ${id}`);
      o.status = 'VOIDED';
    },
    async createOrder(req) {
      guard('create');
      calls.push({
        op: 'create',
        provider_order_id: null,
        request_id: req.request_id,
        scenario: req.scenario,
      });
      if (fake.beforeCreate !== null) await fake.beforeCreate();
      const nowMs = clock.now().getTime();
      const seen = storedCreate.get(req.request_id);
      if (seen !== undefined && nowMs - seen.at < RETENTION_MS) return seen.res;
      const remember = (res: CreateOrderRes): CreateOrderRes => {
        if (res.kind === 'created' || res.kind === 'rejected') {
          storedCreate.set(req.request_id, { at: nowMs, res });
        }
        return res;
      };
      const forced = fake.queue.create.shift();
      if (forced !== undefined && forced !== 'real') return remember(forced);
      n += 1;
      const id = `SBXFAKEORD${String(n).padStart(5, '0')}`;
      orders.set(id, { id, req, status: 'CREATED', capture: null, capture_request_id: null });
      return remember({
        kind: 'created',
        provider_order_id: id,
        status: 'CREATED',
        approve_url: `https://www.sandbox.paypal.com/checkoutnow?token=${id}`,
        debug_id: 'DBGCREATE',
      });
    },
    async getOrder(id, scenario = null) {
      guard('get');
      calls.push({ op: 'get', provider_order_id: id, request_id: null, scenario });
      if (fake.beforeGet !== null) await fake.beforeGet();
      const forced = fake.queue.get.shift();
      if (forced !== undefined && forced !== 'real') return forced;
      const o = orders.get(id);
      if (o === undefined) return { kind: 'not_found', debug_id: null };
      return read(o, fake.tamper);
    },
    async captureOrder(r) {
      guard('capture');
      calls.push({
        op: 'capture',
        provider_order_id: r.provider_order_id,
        request_id: r.request_id,
        scenario: r.scenario ?? null,
      });
      if (fake.hold !== null) await fake.hold;
      const nowMs = clock.now().getTime();
      const seen = storedCapture.get(r.request_id);
      if (seen !== undefined && nowMs - seen.at < RETENTION_MS) return seen.res;
      const remember = (res: CaptureRes): CaptureRes => {
        if (res.kind === 'rejected' || res.kind === 'payer_action') {
          storedCapture.set(r.request_id, { at: nowMs, res });
        } else if (res.kind === 'claim' && res.http !== 202) {
          storedCapture.set(r.request_id, { at: nowMs, res: { ...res, http: 200 } });
        }
        return res;
      };
      const forced = fake.queue.capture.shift();
      if (forced !== undefined && forced !== 'real') return remember(forced);
      const o = orders.get(r.provider_order_id);
      if (o === undefined) return { kind: 'not_found', debug_id: null };
      if (o.status !== 'APPROVED') {
        return remember({
          kind: 'rejected',
          http: 422,
          name: 'UNPROCESSABLE_ENTITY',
          issue: o.capture === null ? 'ORDER_NOT_APPROVED' : 'ORDER_ALREADY_CAPTURED',
          debug_id: 'DBGCAP',
        });
      }
      n += 1;
      const next = { ...fake.next, ...fake.nextBy.get(o.id) };
      o.capture = {
        capture_id: `SBXFAKECAP${String(n).padStart(5, '0')}`,
        status: next.status,
        reason: next.reason,
        fee: next.fee,
      };
      o.capture_request_id = r.request_id;
      o.status = 'COMPLETED';
      const claim = remember(claimOf(o, 201));
      if (fake.crashAfterCapture) throw new Error('process died after the capture');
      if (next.lose_response) return { kind: 'timeout' };
      return claim;
    },
    getCapture: () => Promise.reject(new Error('getCapture is not used by lane 05a')),
    refundCapture: () => Promise.reject(new Error('refundCapture is not used by lane 05a')),
    getRefund: () => Promise.reject(new Error('getRefund is not used by lane 05a')),
    verifyWebhook: () => Promise.reject(new Error('verifyWebhook is not used by lane 05a')),
  };

  function claimOf(o: FakeOrder, http: 200 | 201): CaptureRes {
    return {
      kind: 'claim',
      http,
      provider_order_id: o.id,
      units: o.req.units.map((u, k) => ({
        reference_id: u.reference_id,
        capture_id: o.capture === null ? null : captureIdOf(o, k),
        status: o.capture?.status ?? null,
      })),
      debug_id: 'DBGCAP',
    };
  }
  return fake;
}

// ---------- content ----------
export interface FakeContent extends ContentStore {
  /** article content_key -> head */
  heads: Map<string, ContentHead>;
  healthy: boolean;
}
function makeContent(): FakeContent {
  const heads = new Map<string, ContentHead>();
  const c: FakeContent = {
    heads,
    healthy: true,
    head: (key) => Promise.resolve(heads.get(key) ?? null),
    open: () => Promise.resolve(null),
    health: () => Promise.resolve(c.healthy),
  };
  return c;
}

// ---------- the world ----------
export interface World {
  db: Database & { close(): Promise<void> };
  clock: ReturnType<typeof fakeClock>;
  deps: PaymentsDeps;
  paypal: FakePayPal;
  content: FakeContent;
  switches: Record<SwitchName, boolean>;
  insert(table: string, row: Record<string, unknown>): Promise<void>;
  /** A fresh approval for the buyer: offers like ['ofr_1'] (keep_retrieve) in one go. */
  approval(o?: {
    buyer_id?: string;
    offers?: string[];
    option?: 'keep_retrieve' | 'online_read';
  }): Promise<ApprovalGranted>;
  /** Place the order and run beginCheckout through the given functions. */
  rows<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  close(): Promise<void>;
}

export const sha256Of = (text: string): string => createHash('sha256').update(text).digest('hex');
export const sha256ForArticle = (id: string): string => sha256Of(`bytes of ${id}`);

export interface WorldOptions {
  ids?: Ids;
  publicOrigin?: string;
  merchants?: { pub_1: string; pub_2: string };
  /** price in minor units of keep_retrieve for every seeded offer */
  price?: number;
}

// One migrated in-memory database per test file; every world starts from emptied tables plus the
// seed rows the migrations insert. Building a database per test would take minutes.
let shared: Promise<Awaited<ReturnType<typeof openDatabase>>> | null = null;
function sharedDatabase(): Promise<Awaited<ReturnType<typeof openDatabase>>> {
  shared ??= (async () => {
    const db = await openDatabase({ kind: 'pglite-memory' });
    await migrate(db, fakeClock(START));
    return db;
  })();
  return shared;
}
afterAll(async () => {
  if (shared !== null) await (await shared).close();
  shared = null;
});

export async function makeWorld(opts: WorldOptions = {}): Promise<World> {
  const raw = await sharedDatabase();
  await resetDatabase(raw);
  await raw.exec(`
    INSERT INTO corridors (id, currency, minor_units, buyer_countries, payee_countries, domestic_supported, min_charge_minor, enabled, created_at, updated_at)
      VALUES ('us-usd', 'USD', 2, ARRAY['US'], ARRAY['US'], true, NULL, true, '1970-01-01T00:00:00Z', '1970-01-01T00:00:00Z');
    INSERT INTO access_policies (id, version, option, window_ms, start_rule, created_at, updated_at) VALUES
      ('keep_retrieve', '1', 'keep_retrieve', 432000000, 'payment_verified_and_delivery_ready', '1970-01-01T00:00:00Z', '1970-01-01T00:00:00Z'),
      ('online_read', '1', 'online_read', 432000000, 'payment_verified_and_delivery_ready', '1970-01-01T00:00:00Z', '1970-01-01T00:00:00Z');
  `);
  const clock = fakeClock(START);
  const als = new AsyncLocalStorage<true>();
  const db = {
    dialect: raw.dialect,
    query: raw.query,
    exec: raw.exec,
    transaction: <T>(fn: (tx: SqlExecutor) => Promise<T>) =>
      raw.transaction((tx) => als.run(true, () => fn(tx))),
    close: () => Promise.resolve(),
  } as unknown as Database & { close(): Promise<void> };
  const paypal = makeFakePayPal(() => als.getStore() === true, clock);
  const content = makeContent();
  const switches: Record<SwitchName, boolean> = {
    paypal_outbound: true,
    checkout_enabled: true,
    refunds_enabled: true,
    unlock_enabled: true,
    ai_enabled: true,
    webhook_enabled: true,
  };
  const log = { log: () => undefined, child: () => log };
  const deps: PaymentsDeps = {
    db,
    clock,
    ids: opts.ids ?? seededIds('payments-tests'),
    log,
    audit: { record: () => Promise.resolve() },
    switches: { isOn: (name) => Promise.resolve(switches[name]) },
    config: {
      reconcile_window_ms: 86_400_000,
      reconcile_backoff_ms: [30_000, 120_000, 600_000, 3_600_000],
      idem_safe_window_ms: 18_000_000,
      abandoned_checkout_ms: 86_400_000,
      operation_lease_ms: 60_000,
      max_capture_retries: 1,
      link_ttl_ms: 600_000,
      public_origin: opts.publicOrigin ?? 'http://localhost:3000',
      approval_secret: secret('a'.repeat(32)),
      link_secret: secret('b'.repeat(32)),
      rule_version: 'rules-1',
      pricing_rule_version: 'pricing-1',
    },
    environment: 'dryrun',
    paypal,
    content,
  };

  const insert = async (table: string, row: Record<string, unknown>): Promise<void> => {
    const r: Record<string, unknown> = { created_at: SEED_TIME, updated_at: SEED_TIME, ...row };
    const cols = Object.keys(r);
    await raw.query(
      `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`,
      cols.map((c) => r[c]),
    );
  };
  const j = (v: unknown): string => JSON.stringify(v);
  const price = opts.price ?? 400;

  await insert('buyers', { id: 'buy_A', display_name: 'A', auth_subject: 'sub-a', country: 'US' });
  await insert('buyers', { id: 'buy_B', display_name: 'B', auth_subject: 'sub-b', country: 'US' });
  const merchants = opts.merchants ?? { pub_1: 'MERCH1', pub_2: 'MERCH2' };
  for (const [id, slug, merchant] of [
    ['pub_1', 'p1', merchants.pub_1],
    ['pub_2', 'p2', merchants.pub_2],
  ] as const) {
    await insert('publishers', {
      id,
      slug,
      display_name: `Publisher ${slug}`,
      country: 'US',
      paypal_merchant_id: merchant,
      payee_verified_at: SEED_TIME,
    });
  }
  const arts: [string, string][] = [
    ['art_1', 'pub_1'],
    ['art_2', 'pub_1'],
    ['art_3', 'pub_2'],
  ];
  for (const [id, publisher_id] of arts) {
    const sha = sha256ForArticle(id);
    await insert('articles', {
      id,
      publisher_id,
      title: `Title ${id}`,
      abstract: 'abstract',
      language: 'en',
      topics: ['x'],
      published_at: SEED_TIME,
      sha256: sha,
      content_key: `key-${id}`,
      bytes: 10,
      mime: 'text/plain',
    });
    content.heads.set(`key-${id}`, { bytes: 10, sha256: sha, mime: 'text/plain' });
    await insert('offers', {
      id: `ofr_${id.slice(4)}`,
      version: '1',
      publisher_id,
      article_id: id,
      status: 'authorised',
      currency: 'USD',
      options: j([
        {
          option: 'keep_retrieve',
          price_minor: price,
          policy_id: 'keep_retrieve',
          policy_version: '1',
        },
        { option: 'online_read', price_minor: 250, policy_id: 'online_read', policy_version: '1' },
      ]),
      affordability: j({ renegotiation_allowed: false, floor_minor: null }),
      terms_version: 'terms-1',
      rights: j({ scope: 'personal_use', ai_scope: 'review', redistribution: false }),
      valid_from: SEED_TIME,
      valid_until: null,
      superseded_by: null,
    });
  }

  let quoteN = 0;
  const world: World = {
    db,
    clock,
    deps,
    paypal,
    content,
    switches,
    insert,
    async approval(o = {}) {
      const buyer_id = o.buyer_id ?? 'buy_A';
      const offers = o.offers ?? ['ofr_1'];
      const option = o.option ?? 'keep_retrieve';
      const ids: string[] = [];
      for (const offer_id of offers) {
        quoteN += 1;
        const id = `quo_t${quoteN}`;
        await insert('quotes', {
          id,
          buyer_id,
          offer_id,
          offer_version: '1',
          option,
          price_minor: option === 'keep_retrieve' ? price : 250,
          currency: 'USD',
          corridor_id: 'us-usd',
          source: 'direct',
          expires_at: '2026-10-22T12:00:00.000Z',
        });
        ids.push(id);
      }
      let granted: ApprovalGranted | undefined;
      if (ids.length === 1) {
        const r = await requestApproval(deps, {
          actor: { kind: 'buyer', buyer_id },
          selection: { kind: 'quote', quote_id: ids[0] as string },
          consent: { terms: true, identity_share: true },
        });
        if (!r.ok) throw new Error(`approval refused: ${r.error.code}`);
        granted = r.value;
      } else {
        await insert('briefs', {
          id: `brf_t${quoteN}`,
          buyer_id,
          raw_text: 'need',
          structured: j({}),
          version: '1',
          confirmed_at: SEED_TIME,
        });
        await insert('proposals', {
          id: `prp_t${quoteN}`,
          brief_id: `brf_t${quoteN}`,
          buyer_id,
          items: j(offers.map((offer_id, k) => ({ quote: { offer_id, quote_id: ids[k] } }))),
          fit: j([]),
        });
        const r = await requestApproval(deps, {
          actor: { kind: 'buyer', buyer_id },
          selection: { kind: 'proposal', proposal_id: `prp_t${quoteN}`, offer_ids: offers },
          consent: { terms: true, identity_share: true },
        });
        if (!r.ok) throw new Error(`approval refused: ${r.error.code}`);
        granted = r.value;
      }
      return granted;
    },
    async rows<T>(sql: string, params: unknown[] = []) {
      const r = await raw.query<T>(sql, params);
      return r.rows;
    },
    close: () => Promise.resolve(),
  };
  return world;
}

// ---------- journeys ----------
export interface Placed {
  approval: ApprovalGranted;
  order_id: Id;
  order_ref: Id;
}
export interface PlaceOptions {
  /**
   * D1 dormant (MVP-D, DP-2a). Before MVP-D an approval of two publishers was one PayPal order with
   * two purchase units. D2 now places one PayPal order per publisher; this option rewrites the
   * placed rows back into the old single-route shape (one provider order, every unit on it) so the
   * tests of the engine's one-order-many-units paths keep their meaning. The route is dormant: no
   * product code creates this shape any more.
   */
  d1?: boolean;
}
/** The rows of one placed order, by position. */
export interface ProviderOrderInfo {
  position: number;
  po_ref: string;
  provider_order_id: string | null;
  approve_url: string | null;
  publisher_id: string | null;
  state: string;
}
export const providerOrdersOf = (w: World, order_id: Id): Promise<ProviderOrderInfo[]> =>
  w.rows<ProviderOrderInfo>(
    `SELECT position, po_ref, provider_order_id, approve_url, publisher_id, state
       FROM provider_orders WHERE order_id = $1 ORDER BY position`,
    [order_id],
  );

/** D1 dormant: one provider order for every unit of the order, the old single-route rows. */
export async function collapseToD1Dormant(w: World, order_id: Id): Promise<void> {
  const pos = await w.rows<{ id: string; position: number }>(
    'SELECT id, position FROM provider_orders WHERE order_id = $1 ORDER BY position',
    [order_id],
  );
  const keep = pos[0];
  if (keep === undefined) throw new Error('collapseToD1Dormant: no provider order');
  for (const extra of pos.slice(1)) {
    await w.rows('UPDATE order_units SET provider_order_ref = $2 WHERE provider_order_ref = $1', [
      extra.id,
      keep.id,
    ]);
    await w.rows('DELETE FROM operations WHERE provider_order_ref = $1', [extra.id]);
    await w.rows('DELETE FROM provider_orders WHERE id = $1', [extra.id]);
  }
  await w.rows(
    `UPDATE provider_orders SET route = 'single', publisher_id = NULL, position = 1,
            po_ref = (SELECT order_ref FROM orders WHERE id = $2)
      WHERE id = $1`,
    [keep.id, order_id],
  );
  await w.rows(
    `UPDATE operations SET request_id = 'umsC-' || (SELECT order_ref FROM orders WHERE id = $2)
      WHERE provider_order_ref = $1 AND kind = 'create'`,
    [keep.id, order_id],
  );
}
export async function place(
  w: World,
  o: Parameters<World['approval']>[0] & {
    actor?: typeof BUYER_A | typeof BUYER_B;
  } & PlaceOptions = {},
): Promise<Placed> {
  const approval = await w.approval(o);
  const r = await placeOrder(w.deps, {
    approval_id: approval.approval_id,
    token: approval.token,
    actor: o.actor ?? { kind: 'buyer', buyer_id: o.buyer_id ?? 'buy_A' },
  });
  if (!r.ok) throw new Error(`placeOrder refused: ${JSON.stringify(r.error)}`);
  if (o.d1 === true) await collapseToD1Dormant(w, r.value.order_id);
  return { approval, order_id: r.value.order_id, order_ref: r.value.order_ref };
}
export interface Awaiting extends Placed {
  approve_url: string;
  /** The first PayPal order (position 1); the only one unless the approval has two publishers. */
  provider_order_id: string;
  /** Every PayPal order of the order, by position. */
  provider_orders: ProviderOrderInfo[];
}
/** placeOrder + beginCheckout; the order waits for the buyer at PayPal. */
export async function awaiting(
  w: World,
  o: Parameters<typeof place>[1] & { scenario?: string | null } = {},
): Promise<Awaiting> {
  const p = await place(w, o);
  const c = await beginCheckout(w.deps, {
    order_id: p.order_id,
    actor: o.actor ?? { kind: 'buyer', buyer_id: o.buyer_id ?? 'buy_A' },
    scenario: o.scenario ?? null,
  });
  if (!c.ok) throw new Error(`beginCheckout refused: ${JSON.stringify(c.error)}`);
  const provider_orders = await providerOrdersOf(w, p.order_id);
  return {
    ...p,
    approve_url: c.value.approve_url,
    provider_order_id: provider_orders[0]!.provider_order_id as string,
    provider_orders,
  };
}
/** The buyer approves one PayPal order (position 1 unless said). */
export function approvePo(w: World, a: Awaiting, position = 1): void {
  const po = a.provider_orders.find((x) => x.position === position);
  if (po?.provider_order_id === null || po === undefined) throw new Error('no such PayPal order');
  w.paypal.approve(po.provider_order_id);
}
/** ... and the buyer has approved at PayPal (every PayPal order of the order). */
export async function approved(
  w: World,
  o: Parameters<typeof awaiting>[1] = {},
): Promise<Awaiting> {
  const a = await awaiting(w, o);
  for (const po of a.provider_orders) w.paypal.approve(po.provider_order_id as string);
  // The engine only moves a PayPal order to `approved` when a read shows APPROVED (the return does
  // that); a test that calls the capture gate directly needs the state the return would have set.
  await w.rows(
    `UPDATE provider_orders SET state = 'approved', status = 'APPROVED', first_approved_at = $2
      WHERE order_id = $1 AND state = 'awaiting_buyer'`,
    [a.order_id, w.clock.now().toISOString()],
  );
  return { ...a, provider_orders: await providerOrdersOf(w, a.order_id) };
}
/**
 * What the reconciler of lane 05b does: read, gather the gates, apply in one transaction. The
 * PayPal order is the one at `position` (1 unless the order has two).
 */
export async function reapply(
  w: World,
  order_id: Id,
  trigger: 'poll' | 'webhook' | 'return' | 'capture' = 'poll',
  gates = true,
  position = 1,
): Promise<ApplyReport> {
  const o = (
    await w.rows<{ provider_order_id: string }>(
      'SELECT provider_order_id FROM provider_orders WHERE order_id = $1 AND position = $2',
      [order_id, position],
    )
  )[0]!;
  const read = await w.paypal.getOrder(o.provider_order_id);
  if (read.kind !== 'order') throw new Error(`read failed: ${read.kind}`);
  const g = gates ? await readApplyGates(w.deps, order_id) : undefined;
  return w.db.transaction((tx) =>
    applyReadback(tx, w.deps, {
      order_id,
      read,
      trigger,
      ...(g === undefined ? {} : { gates: g }),
    }),
  );
}
export const count = async (w: World, table: string, where = 'true'): Promise<number> =>
  Number(
    (await w.rows<{ n: string }>(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`))[0]!.n,
  );

// ---------- the real adapter over the dry-run transport (CO-4 integration) ----------
export type DryRunFixture = FixtureFile;
/**
 * The real PayPal adapter over the dry-run transport and the synthetic fixtures under `root`, for
 * the integration tests. `derive` may add or drop fixtures in memory (nothing on disk changes).
 * The scenario named is the default of every call. Nothing is sent anywhere.
 */
export async function dryRunDeps(
  w: World,
  o: {
    root: string;
    scenario: string;
    derive?: (all: DryRunFixture[]) => DryRunFixture[];
  },
) {
  const loaded = await loadFixtures(o.root);
  const transport = createDryRunTransport({
    fixtures: o.derive === undefined ? loaded : o.derive(loaded),
    gate: { check: () => Promise.resolve({ allowed: true, approval_ref: 'test-approval' }) },
    clock: w.clock,
    default_scenario: o.scenario,
    log: {
      log: () => undefined,
      child: () => ({ log: () => undefined, child: () => undefined as never }),
    },
  });
  const adapter = createPayPalAdapter({
    transport,
    clock: w.clock,
    log: { log: () => undefined, child: () => undefined as never },
    credentials: null,
    record: () => Promise.resolve(),
  });
  const deps: PaymentsDeps = { ...w.deps, paypal: adapter };
  return { transport, deps };
}
