/* eslint-disable no-restricted-imports -- test-only helper (imported by *.test.ts files only): node:async_hooks tracks "inside a transaction" per async flow for the provider-call spy; node:crypto hashes the seeded article bytes. S1 bars node:* in domain helpers (change request in the lane 05a hand-off). */
// Test world for lane 05a. Synthetic rows only; no real merchant or payer data, no network.
// A PGlite database with every migration, the supply rows an approval needs, a scripted PayPalPort
// (in memory, no transport) and a ContentStore double. The spy: any provider call made while a
// database transaction is open on the same async flow throws and is logged in `violations`.
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { requestApproval } from '@umsbx/approval';
import type { ApprovalGranted } from '@umsbx/approval';
import { migrate, openDatabase } from '@umsbx/db';
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
  status: 'CREATED' | 'APPROVED' | 'COMPLETED';
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
  /** Overrides consumed in order, one per call of that kind. */
  queue: { create: CreateOrderRes[]; get: (OrderRead | 'real')[]; capture: CaptureRes[] };
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
}

// PayPal gives each purchase unit its own capture: the first keeps the base id.
const captureIdOf = (o: { capture: { capture_id: string } | null }, k: number): string =>
  `${o.capture?.capture_id ?? ''}${k === 0 ? '' : `U${k}`}`;

export function makeFakePayPal(inTx: () => boolean, clock: { now(): Date }): FakePayPal {
  const calls: FakeCall[] = [];
  const violations: string[] = [];
  const orders = new Map<string, FakeOrder>();
  let n = 0;
  const guard = (op: string): void => {
    if (inTx()) {
      violations.push(op);
      throw new Error(`PayPal call "${op}" made inside a database transaction`);
    }
  };

  const read = (o: FakeOrder, t: Tamper): OrderRead => {
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
    next: { status: 'COMPLETED', reason: null, fee: 45, lose_response: false },
    tamper: {},
    captureIdSeed: 0,
    beforeGet: null,
    beforeCreate: null,
    crashAfterCapture: false,
    hold: null,
    count: (op) => calls.filter((c) => c.op === op).length,
    approve(id) {
      const o = orders.get(id);
      if (o === undefined) throw new Error(`unknown provider order ${id}`);
      o.status = 'APPROVED';
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
      const forced = fake.queue.create.shift();
      if (forced !== undefined) return forced;
      // Idempotent on the request id.
      for (const o of orders.values()) {
        if (o.req.request_id === req.request_id) {
          return {
            kind: 'created',
            provider_order_id: o.id,
            status: 'CREATED',
            approve_url: `https://www.sandbox.paypal.com/checkoutnow?token=${o.id}`,
            debug_id: 'DBGCREATE',
          };
        }
      }
      n += 1;
      const id = `SBXFAKEORD${String(n).padStart(5, '0')}`;
      orders.set(id, { id, req, status: 'CREATED', capture: null, capture_request_id: null });
      return {
        kind: 'created',
        provider_order_id: id,
        status: 'CREATED',
        approve_url: `https://www.sandbox.paypal.com/checkoutnow?token=${id}`,
        debug_id: 'DBGCREATE',
      };
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
      const forced = fake.queue.capture.shift();
      if (forced !== undefined) return forced;
      const o = orders.get(r.provider_order_id);
      if (o === undefined) return { kind: 'not_found', debug_id: null };
      if (o.capture !== null && o.capture_request_id === r.request_id) {
        return claimOf(o, 200);
      }
      if (o.status !== 'APPROVED') {
        return {
          kind: 'rejected',
          http: 422,
          name: 'UNPROCESSABLE_ENTITY',
          issue: o.capture === null ? 'ORDER_NOT_APPROVED' : 'ORDER_ALREADY_CAPTURED',
          debug_id: 'DBGCAP',
        };
      }
      n += 1;
      o.capture = {
        capture_id: `SBXFAKECAP${String(n).padStart(5, '0')}`,
        status: fake.next.status,
        reason: fake.next.reason,
        fee: fake.next.fee,
      };
      o.capture_request_id = r.request_id;
      o.status = 'COMPLETED';
      if (fake.crashAfterCapture) throw new Error('process died after the capture');
      if (fake.next.lose_response) return { kind: 'timeout' };
      return claimOf(o, 201);
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
export async function place(
  w: World,
  o: Parameters<World['approval']>[0] & { actor?: typeof BUYER_A | typeof BUYER_B } = {},
): Promise<Placed> {
  const approval = await w.approval(o);
  const r = await placeOrder(w.deps, {
    approval_id: approval.approval_id,
    token: approval.token,
    actor: o.actor ?? { kind: 'buyer', buyer_id: o.buyer_id ?? 'buy_A' },
  });
  if (!r.ok) throw new Error(`placeOrder refused: ${JSON.stringify(r.error)}`);
  return { approval, order_id: r.value.order_id, order_ref: r.value.order_ref };
}
export interface Awaiting extends Placed {
  approve_url: string;
  provider_order_id: string;
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
  const rows = await w.rows<{ provider_order_id: string }>(
    'SELECT provider_order_id FROM provider_orders WHERE order_id = $1',
    [p.order_id],
  );
  return { ...p, approve_url: c.value.approve_url, provider_order_id: rows[0]!.provider_order_id };
}
/** ... and the buyer has approved at PayPal. */
export async function approved(
  w: World,
  o: Parameters<typeof awaiting>[1] = {},
): Promise<Awaiting> {
  const a = await awaiting(w, o);
  w.paypal.approve(a.provider_order_id);
  return a;
}
/** What the reconciler of lane 05b does: read, gather the gates, apply in one transaction. */
export async function reapply(
  w: World,
  order_id: Id,
  trigger: 'poll' | 'webhook' | 'return' | 'capture' = 'poll',
  gates = true,
): Promise<ApplyReport> {
  const o = (
    await w.rows<{ provider_order_id: string }>(
      'SELECT provider_order_id FROM provider_orders WHERE order_id = $1',
      [order_id],
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
