// The composition root (lane 15, architecture 2.3 rule Z1). The only file in apps/web that imports
// domain packages, the database, the config reader, the transport and the PayPal adapter. Pages and
// route handlers reach the engine only through `engine`, `securityDeps` and `getApp()` below.
//
// Everything here is lazy: importing this module opens nothing and reads no environment, so
// `next build` and route-module loading never boot the app. The first request does.
//
// Dry-run only. UMS_MODE=sandbox builds the sealed sandbox transport stub (MVP-A): no byte leaves
// the process either way.
import { getSingleton, setSingleton } from './src/server/singleton';
import 'server-only';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type {
  Actor,
  AgentDeps,
  AuditSink,
  Brief,
  CaseView,
  Clock,
  ContentStore,
  CoreDeps,
  Database,
  DomainConfig,
  EnvironmentLabel,
  Id,
  Ids,
  Logger,
  PayPalPort,
  PaymentsDeps,
  Receipt,
  Result,
  SqlExecutor,
  SwitchName,
  SwitchReader,
  Transport,
} from '@umsbx/contracts';
import { err, ok } from '@umsbx/contracts';
import { BOOT_REFUSAL_EXIT_CODE, loadConfig, loadConfigFromProcess } from '@umsbx/config';
import type { Config } from '@umsbx/config';
import { migrate, openDatabase } from '@umsbx/db';
import type { SqlDriver } from '@umsbx/db';
import { cryptoIds, systemClock } from '@umsbx/runtime';
import { createAuditSink, createLogger } from '@umsbx/obs';
import { createOutboundGate, createSwitchReader } from '@umsbx/safety';
import { createDryRunTransport, createSandboxTransport, loadFixtures } from '@umsbx/transport';
import { createPayPalAdapter } from '@umsbx/paypal';
import { createScriptedModel } from '@umsbx/model';
import { SEED_DATA, getOffer, seedCatalogue } from '@umsbx/catalogue';
import { startFromOffer } from '@umsbx/offer-entry';
import { discover as discoverOffers, parseNeed } from '@umsbx/discovery';
import { requestApproval } from '@umsbx/approval';
import type { Selection } from '@umsbx/approval';
import { createPgContentStore, issueLink, planServe } from '@umsbx/delivery';
import type { ServePlan } from '@umsbx/delivery';
import { getReceiptForBuyer, receiptLabel, renderReceiptHtml } from '@umsbx/receipts';
import { sweepWindows } from '@umsbx/access-clock';
import { applyAutomaticRules, openCase as openRecoveryCase } from '@umsbx/recovery';
import { getLibrary } from '@umsbx/library';
import { resolveSession, createSession, verifyPasscode } from '@umsbx/security';
import type { SecurityDeps } from '@umsbx/security';

type Env = Record<string, string | undefined>;
export interface AppOptions {
  /** Switch cache lifetime; tests pass 0. */
  switch_cache_ms?: number;
  log_sink?: (line: string) => void;
}

// ---------------------------------------------------------------------------------------------
// Personas (demo sign-in, A11Y-6: a passcode, no cognitive test).
// ---------------------------------------------------------------------------------------------
export const PERSONAS = ['buyer-a', 'buyer-b', 'publisher', 'operator'] as const;
export type Persona = (typeof PERSONAS)[number];
const BUYER_IDS: Record<'buyer-a' | 'buyer-b', Id> = {
  'buyer-a': 'buy_persona_a',
  'buyer-b': 'buy_persona_b',
};
const OPERATOR_ID: Id = 'opr_demo';

export const envLabel = (c: Config): EnvironmentLabel =>
  c.mode === 'sandbox' ? 'sandbox' : 'dryrun';

// ---------------------------------------------------------------------------------------------
// TEMP-until-05a: the payments seam. Same names and argument shapes as docs/design/lanes/
// 05a-payments-order-capture.md, so the swap is one import. This stub moves no money, writes no
// order and calls no provider; it answers `payments_not_wired`.
// ---------------------------------------------------------------------------------------------
export type PlaceError =
  | { code: 'payments_not_wired' }
  | { code: 'approval'; http: 403 | 404 | 409 | 410 }
  | { code: 'order_open'; http: 409 }
  | { code: 'checkout_off'; http: 503 };
export type CheckoutError = { code: 'payments_not_wired' | 'not_found' | 'wrong_state' };
export interface OrderView {
  order_id: Id;
  order_ref: Id;
  status: string;
  buyer_message: string;
  items: { article_id: Id; title: string; access: string }[];
  environment: EnvironmentLabel;
}
export interface PaymentsFacade {
  placeOrder(i: {
    approval_id: Id;
    token: string;
    actor: Actor;
  }): Promise<Result<{ order_id: Id; order_ref: Id; status: string }, PlaceError>>;
  beginCheckout(i: {
    order_id: Id;
    actor: Actor;
    scenario?: string | null;
  }): Promise<Result<{ approve_url: string }, CheckoutError>>;
  onBuyerReturn(i: {
    order_ref: Id;
    actor: Actor;
    scenario?: string | null;
  }): Promise<Result<OrderView, CheckoutError>>;
}
function paymentsStub(): PaymentsFacade {
  // TEMP-until-05a
  const notWired = <T>(): Promise<Result<T, { code: 'payments_not_wired' }>> =>
    Promise.resolve(err({ code: 'payments_not_wired' as const }));
  return {
    placeOrder: () => notWired(),
    beginCheckout: () => notWired(),
    onBuyerReturn: () => notWired(),
  };
}

// ---------------------------------------------------------------------------------------------
// Views returned by the engine facade. Plain data for pages and routes.
// ---------------------------------------------------------------------------------------------
export interface OfferPage {
  offer_id: Id;
  title: string;
  abstract: string;
  publisher: string;
  publisher_slug: string;
  offer_code: string;
  currency: string;
  options: { option: 'keep_retrieve' | 'online_read'; price_minor: number }[];
  renegotiation_allowed: boolean;
  floor_minor: number | null;
  rights: { scope: string; ai_scope: string; redistribution: boolean };
}
export interface ApprovalView {
  approval_id: Id;
  expires_at: string;
  now: string;
  used: boolean;
  total_minor: number;
  currency: string;
  environment: EnvironmentLabel;
  content_hash: string;
  items: {
    article_id: Id;
    title: string;
    publisher: string;
    option: string;
    amount_minor: number;
    ai_scope: string;
  }[];
}
export interface LibraryEntry {
  entitlement_id: Id;
  article_id: Id;
  title: string;
  publisher: string;
  option: string;
  access: string;
  money: string;
  window: {
    state: string;
    started_at: string | null;
    ends_at: string | null;
    days_left: number | null;
  };
  status_text: string;
  can_open: boolean;
  order_id: Id | null;
  /** Receipt versions of the order, oldest first (lane 10). */
  receipt_versions: number[];
  /** The case still being worked on for this item, if any (lane 10). */
  open_case: CaseView | null;
  environment: EnvironmentLabel;
}
export interface OpsSnapshot {
  environment: EnvironmentLabel;
  switches: Record<SwitchName, boolean>;
  gate: { mode: string; connect: boolean; approval_ref_set: boolean; transport: string };
  orders: { order_ref: string; status: string; total_minor: number; currency: string }[];
  operations: { state: string; count: number }[];
  alerts: { kind: string; created_at: string }[];
  invariants: { id: string; ok: boolean; detail: string }[];
}

const SWITCHES: SwitchName[] = [
  'paypal_outbound',
  'checkout_enabled',
  'refunds_enabled',
  'unlock_enabled',
  'ai_enabled',
  'webhook_enabled',
];

const DAY_MS = 86_400_000;
const iso = (v: unknown): string => new Date(v as string | number | Date).toISOString();

export function orderMessage(status: string, unit_statuses: string[]): string {
  if (unit_statuses.includes('mismatch') || status === 'frozen')
    return 'Your order is on hold while we check it. You have not been charged twice. We opened a case and will write to you.';
  if (unit_statuses.includes('pending')) return 'Payment pending at PayPal';
  switch (status) {
    case 'paid':
    case 'paid_partial':
      return 'Paid. Your item is in your library.';
    case 'capture_requested':
    case 'capture_claimed':
    case 'unresolved':
      return 'Confirming payment';
    case 'failed':
      return 'Not charged. The order did not complete.';
    case 'abandoned':
      return 'Not completed. Nothing was charged.';
    default:
      return 'Waiting for your approval at PayPal';
  }
}

export interface App {
  readonly config: Config;
  readonly environment: EnvironmentLabel;
  /** Resolves after the database is open, migrated and seeded. */
  ready(): Promise<void>;
  readonly db: Database;
  readonly engine: Engine;
  readonly security: SecurityDeps;
  close(): Promise<void>;
}

export interface Engine {
  personas(): readonly Persona[];
  signIn(i: {
    persona: string;
    passcode: string;
  }): Promise<{ actor: Actor; cookie: string; csrf_token: string } | null>;
  actorFromCookie(cookie: string | null): Promise<Actor | null>;
  offerPage(i: { publisher: string; offer: string }): Promise<OfferPage | null>;
  listOffers(): Promise<OfferPage[]>;
  quote: typeof startFromOffer extends (d: never, i: infer I) => infer R ? (i: I) => R : never;
  aiEnabled(): Promise<boolean>;
  parseNeed(i: { actor: Actor; text: string }): ReturnType<typeof parseNeed>;
  discover(i: { actor: Actor; text: string }): Promise<
    | { ai_off: true }
    | {
        ai_off: false;
        result: Awaited<ReturnType<typeof discoverOffers>> | { parse_error: string };
      }
  >;
  requestApproval(i: {
    actor: Actor;
    selection: Selection;
    consent: { terms: boolean; identity_share: boolean };
  }): ReturnType<typeof requestApproval>;
  approvalView(i: { approval_id: Id; actor: Actor }): Promise<ApprovalView | null>;
  payments: PaymentsFacade;
  orderView(i: { order_ref: Id; actor: Actor }): Promise<OrderView | null>;
  library(i: { actor: Actor }): Promise<LibraryEntry[]>;
  libraryItem(i: { entitlement_id: Id; actor: Actor }): Promise<LibraryEntry | null>;
  issueLink(i: { entitlement_id: Id; actor: Actor }): ReturnType<typeof issueLink>;
  serve(i: {
    token: string;
    actor: Actor;
    mode: 'download' | 'read';
  }): Promise<
    | { ok: true; headers: Record<string, string>; stream: ReadableStream<Uint8Array> }
    | { ok: false; code: string }
  >;
  receipt(i: { order_id: Id; actor: Actor }): Promise<Receipt | null>;
  receiptHtml(r: Receipt): string;
  openCase(i: {
    actor: Actor;
    order_id?: Id;
    entitlement_id?: Id;
    note?: string;
  }): Promise<Result<{ case_id: Id }, { code: 'not_found' | 'duplicate_open' }>>;
  opsSnapshot(actor: Actor): Promise<OpsSnapshot | null>;
  health(): Promise<{ ok: boolean; environment: EnvironmentLabel; db: boolean }>;
  /** A fresh single-use key for an idempotent POST (the browser holds no randomness source). */
  newKey(): string;
  /** TEMP-until-05b: window sweep and recovery rules for the in-process loop (lane 05b owns the full job loop). */
  sweep(): Promise<{ ended: number }>;
}

// ---------------------------------------------------------------------------------------------
// Fixtures and migrations are located from the working directory (the bundle moves import.meta).
// ---------------------------------------------------------------------------------------------
function findUp(rel: string, from: string): string | null {
  let dir = resolve(from);
  for (let i = 0; i < 8; i += 1) {
    const p = join(dir, rel);
    if (existsSync(p)) return p;
    const up = resolve(dir, '..');
    if (up === dir) break;
    dir = up;
  }
  return null;
}

const DOMAIN_CONFIG = (c: Config): DomainConfig => ({
  reconcile_window_ms: DAY_MS,
  reconcile_backoff_ms: [30_000, 120_000, 600_000, 3_600_000],
  idem_safe_window_ms: 18_000_000,
  abandoned_checkout_ms: DAY_MS,
  operation_lease_ms: 60_000,
  max_capture_retries: 1,
  link_ttl_ms: 600_000,
  public_origin: c.public_origin,
  approval_secret: c.approval_secret,
  link_secret: c.link_secret,
  rule_version: 'rules-1',
  pricing_rule_version: 'pricing-1',
});

export function createApp(env: Env, opts: AppOptions = {}): App {
  const loaded = loadConfig(env);
  if (!loaded.ok) throw new Error(`boot refused: ${loaded.error.code} ${loaded.error.name}`);
  return buildApp(loaded.value, opts);
}

function buildApp(config: Config, opts: AppOptions): App {
  const environment = envLabel(config);
  const clock: Clock = systemClock();
  const ids: Ids = cryptoIds();
  const sink =
    opts.log_sink ??
    (config.node_env === 'test'
      ? () => undefined
      : (line: string) => {
          process.stdout.write(`${line}\n`);
        });
  const log: Logger = createLogger(sink, { env_label: environment }, clock);
  const audit: AuditSink = createAuditSink(ids, clock);

  // --- lazy database -------------------------------------------------------------------------
  let driver: Promise<SqlDriver> | null = null;
  const open = (): Promise<SqlDriver> => {
    driver ??= (async () => {
      if (config.db.kind === 'postgres') throw new Error('postgres is not wired in MVP-A');
      const d = await openDatabase(
        config.db.kind === 'pglite-disk'
          ? { kind: 'pglite-disk', dir: config.db.dir }
          : { kind: 'pglite-memory' },
      );
      await migrate(d, clock);
      await seed(d);
      return d;
    })();
    return driver;
  };
  const seed = async (d: SqlDriver): Promise<void> => {
    const n = await d.query<{ c: string | number }>('SELECT count(*) AS c FROM publishers');
    if (Number(n.rows[0]?.c ?? 0) === 0) await seedCatalogue(d, clock, ids, SEED_DATA);
    const now = clock.now().toISOString();
    if (config.mode === 'offline') {
      // Dry run only: a synthetic payee label so approvals can be built. It is not a PayPal account.
      await d.query(
        `UPDATE publishers SET paypal_merchant_id = 'DRYRUN' || upper(left(md5(slug), 7)),
                payee_verified_at = $1, updated_at = $1
          WHERE paypal_merchant_id IS NULL`,
        [now],
      );
    }
    for (const [persona, id] of Object.entries(BUYER_IDS)) {
      await d.query(
        `INSERT INTO buyers (id, display_name, auth_subject, country, created_at, updated_at)
         VALUES ($1, $2, $3, 'US', $4, $4) ON CONFLICT (auth_subject) DO NOTHING`,
        [
          id,
          persona === 'buyer-a' ? 'Buyer A (demo)' : 'Buyer B (demo)',
          `persona:${persona}`,
          now,
        ],
      );
    }
  };
  const db: Database = {
    dialect: 'pglite',
    query: async (sql, params) => (await open()).query(sql, params),
    exec: async (sql) => (await open()).exec(sql),
    transaction: async <T>(fn: (tx: SqlExecutor) => Promise<T>) => (await open()).transaction(fn),
  };

  const switches: SwitchReader = createSwitchReader(db, clock, opts.switch_cache_ms);
  const content: ContentStore = createPgContentStore(db);
  const gate = createOutboundGate({ db, clock, switches, config });

  // --- transport and adapter (dry-run only; the sandbox transport is the sealed MVP-A stub) ---
  let transport: Transport | null = null;
  const getTransport = async (): Promise<Transport> => {
    if (transport !== null) return transport;
    if (config.mode === 'sandbox') {
      transport = createSandboxTransport();
    } else {
      const dir = findUp(join('fixtures', 'paypal'), process.cwd());
      const fixtures = dir === null ? [] : await loadFixtures(dir);
      transport = createDryRunTransport({
        fixtures,
        gate,
        clock,
        default_scenario: 'happy',
        log,
      });
    }
    return transport;
  };
  const paypal: PayPalPort = createPayPalAdapter({
    transport: {
      kind: config.mode === 'sandbox' ? 'sandbox' : 'dryrun',
      send: async (r) => (await getTransport()).send(r),
    } as Transport,
    clock,
    log,
    credentials: config.paypal === null ? null : config.paypal,
    record: async (c) => {
      await db.query(
        `INSERT INTO provider_calls (id, operation_id, operation, method, path_template, http_status, outcome, debug_id, duration_ms, transport_kind, request_redacted, response_redacted, environment, created_at, updated_at)
         VALUES ($1, NULL, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $9, $12, $12)`,
        [
          ids.next('pcl'),
          c.operation,
          c.method,
          c.path_template,
          c.http_status,
          c.outcome,
          c.debug_id,
          c.duration_ms,
          c.transport_kind,
          JSON.stringify(c.request_redacted ?? {}),
          JSON.stringify(c.response_redacted ?? {}),
          clock.now().toISOString(),
        ],
      );
    },
  });

  const core: CoreDeps = {
    db,
    clock,
    ids,
    log,
    audit,
    switches,
    config: DOMAIN_CONFIG(config),
    environment,
  };
  const agent: AgentDeps = { ...core, model: createScriptedModel() };
  // Built so the 05a swap is one line; not used by the TEMP stub.
  const paymentsDeps: PaymentsDeps = { ...core, paypal, content };
  void paymentsDeps;

  const security: SecurityDeps = {
    db,
    clock,
    ids,
    log,
    audit,
    session_secret: config.session_secret,
    passcode_hash: config.passcode_hash,
    public_origin: config.public_origin,
  };

  // --- engine --------------------------------------------------------------------------------
  const offerPageOf = (v: NonNullable<Awaited<ReturnType<typeof getOffer>>>): OfferPage => ({
    offer_id: v.offer.id,
    title: v.article.title,
    abstract: v.article.abstract,
    publisher: v.publisher.display_name,
    publisher_slug: v.publisher.slug,
    offer_code: v.offer.id.startsWith(`ofr_${v.publisher.slug}_`)
      ? v.offer.id.slice(`ofr_${v.publisher.slug}_`.length)
      : v.offer.id,
    currency: v.offer.currency,
    options: v.offer.options.map((o) => ({ option: o.option, price_minor: o.price_minor })),
    renegotiation_allowed: v.offer.affordability.renegotiation_allowed,
    floor_minor: v.offer.affordability.floor_minor,
    rights: v.offer.rights,
  });

  const entitlementRows = async (buyer_id: Id, only: Id | null): Promise<LibraryEntry[]> => {
    // Lane 10 owns the read model (words, window, receipts, open case). The two extra columns are
    // payment facts the item page shows beside it.
    const items = await getLibrary(db, { buyer_id, now: clock.now() });
    const facts = new Map(
      (
        await db.query<{ id: string; money_state: string; order_id: string | null }>(
          `SELECT e.id, e.money_state, u.order_id
             FROM entitlements e LEFT JOIN order_units u ON u.id = e.unit_id
            WHERE e.buyer_id = $1`,
          [buyer_id],
        )
      ).rows.map((r) => [r.id, r] as const),
    );
    const out: LibraryEntry[] = [];
    for (const v of items) {
      if (only !== null && v.entitlement_id !== only) continue;
      const ends = v.window.ends_at;
      const running = v.window.state === 'running' && ends !== null;
      const days =
        running && ends !== null
          ? Math.max(0, Math.ceil((Date.parse(ends) - clock.now().getTime()) / DAY_MS))
          : null;
      out.push({
        entitlement_id: v.entitlement_id,
        article_id: v.article_id,
        title: v.title,
        publisher: v.publisher,
        option: v.option,
        access: v.access,
        money: facts.get(v.entitlement_id)?.money_state ?? 'unknown',
        window: {
          state: v.window.state,
          started_at: v.window.started_at,
          ends_at: ends,
          days_left: days,
        },
        status_text: v.status_text,
        can_open: v.can_open,
        order_id: facts.get(v.entitlement_id)?.order_id ?? null,
        receipt_versions: v.receipt_versions,
        open_case: v.open_case,
        environment: v.environment,
      });
    }
    return out;
  };

  const buyerOf = (a: Actor): Id | null => (a.kind === 'buyer' ? a.buyer_id : null);

  const engine: Engine = {
    personas: () => PERSONAS,

    async signIn({ persona, passcode }) {
      if (config.passcode_hash === null) return null;
      if (!(PERSONAS as readonly string[]).includes(persona)) {
        // Same cost for an unknown persona, so the answer does not reveal the persona list.
        await verifyPasscode(config.passcode_hash, passcode);
        return null;
      }
      if (!(await verifyPasscode(config.passcode_hash, passcode))) return null;
      let actor: Actor;
      if (persona === 'buyer-a' || persona === 'buyer-b') {
        actor = { kind: 'buyer', buyer_id: BUYER_IDS[persona] };
      } else if (persona === 'operator') {
        actor = { kind: 'operator', operator_id: OPERATOR_ID, mfa: false };
      } else {
        const p = await db.query<{ id: string }>('SELECT id FROM publishers ORDER BY slug LIMIT 1');
        const id = p.rows[0]?.id;
        if (id === undefined) return null;
        actor = { kind: 'publisher', publisher_id: id };
      }
      const s = await createSession(security, actor);
      return { actor, cookie: s.cookie, csrf_token: s.csrf_token };
    },

    actorFromCookie: (cookie) => resolveSession(security, cookie),

    async offerPage({ publisher, offer }) {
      const v = await getOffer(db, { publisher_slug: publisher, offer_code: offer });
      return v === null ? null : offerPageOf(v);
    },

    async listOffers() {
      const rows = await db.query<{ slug: string; id: string }>(
        `SELECT p.slug, o.id FROM offers o JOIN publishers p ON p.id = o.publisher_id
          WHERE o.status = 'authorised' AND o.superseded_by IS NULL ORDER BY o.id`,
      );
      const out: OfferPage[] = [];
      for (const r of rows.rows) {
        const v = await getOffer(db, { offer_id: r.id });
        if (v !== null && v.offer.currency === 'USD') out.push(offerPageOf(v));
      }
      return out;
    },

    quote: ((i: Parameters<typeof startFromOffer>[1]) =>
      startFromOffer(core, i)) as Engine['quote'],

    aiEnabled: () => switches.isOn('ai_enabled'),

    async parseNeed(i) {
      return parseNeed(agent, i);
    },

    async discover({ actor, text }) {
      // docs/READINESS.md: discovery refuses when the ai_enabled switch is off.
      if (!(await switches.isOn('ai_enabled'))) return { ai_off: true };
      const brief = await parseNeed(agent, { actor, text });
      if (!brief.ok) return { ai_off: false, result: { parse_error: brief.error.code } };
      const r = await discoverOffers(agent, { actor, brief_id: (brief.value as Brief).brief_id });
      return { ai_off: false, result: r };
    },

    requestApproval: (i) => requestApproval(core, i),

    async approvalView({ approval_id, actor }) {
      const buyer = buyerOf(actor);
      if (buyer === null) return null;
      const r = await db.query<{
        id: string;
        snapshot: unknown;
        content_hash: string;
        expires_at: unknown;
        used_at: unknown;
        environment: EnvironmentLabel;
      }>(
        `SELECT id, snapshot, content_hash, expires_at, used_at, environment
           FROM approvals WHERE id = $1 AND buyer_id = $2`,
        [approval_id, buyer],
      );
      const row = r.rows[0];
      if (row === undefined) return null;
      const snap = (typeof row.snapshot === 'string' ? JSON.parse(row.snapshot) : row.snapshot) as {
        items: {
          article_id: string;
          option: string;
          amount_minor: number;
          rights: { ai_scope: string };
          publisher_id: string;
        }[];
        total_minor: number;
        currency: string;
      };
      const items: ApprovalView['items'] = [];
      for (const it of snap.items) {
        const a = await db.query<{ title: string; publisher: string }>(
          `SELECT a.title, p.display_name AS publisher FROM articles a
             JOIN publishers p ON p.id = a.publisher_id WHERE a.id = $1`,
          [it.article_id],
        );
        items.push({
          article_id: it.article_id,
          title: a.rows[0]?.title ?? 'Article',
          publisher: a.rows[0]?.publisher ?? 'Publisher',
          option: it.option,
          amount_minor: it.amount_minor,
          ai_scope: it.rights.ai_scope,
        });
      }
      return {
        approval_id: row.id,
        expires_at: iso(row.expires_at),
        now: clock.now().toISOString(),
        used: row.used_at !== null,
        total_minor: snap.total_minor,
        currency: snap.currency,
        environment: row.environment,
        content_hash: row.content_hash,
        items,
      };
    },

    payments: paymentsStub(),

    async orderView({ order_ref, actor }) {
      const buyer = buyerOf(actor);
      if (buyer === null) return null;
      const o = (
        await db.query<{
          id: string;
          order_ref: string;
          status: string;
          environment: EnvironmentLabel;
        }>(
          'SELECT id, order_ref, status, environment FROM orders WHERE order_ref = $1 AND buyer_id = $2',
          [order_ref, buyer],
        )
      ).rows[0];
      if (o === undefined) return null;
      const units = await db.query<{ status: string }>(
        'SELECT status FROM order_units WHERE order_id = $1',
        [o.id],
      );
      const ents = await db.query<{ article_id: string; title: string; access_state: string }>(
        `SELECT e.article_id, a.title, e.access_state FROM entitlements e
           JOIN order_units u ON u.id = e.unit_id JOIN articles a ON a.id = e.article_id
          WHERE u.order_id = $1 AND e.buyer_id = $2 ORDER BY e.id`,
        [o.id, buyer],
      );
      return {
        order_id: o.id,
        order_ref: o.order_ref,
        status: o.status,
        buyer_message: orderMessage(
          o.status,
          units.rows.map((u) => u.status),
        ),
        items: ents.rows.map((e) => ({
          article_id: e.article_id,
          title: e.title,
          access: e.access_state,
        })),
        environment: o.environment,
      };
    },

    library: ({ actor }) => {
      const b = buyerOf(actor);
      return b === null ? Promise.resolve([]) : entitlementRows(b, null);
    },

    async libraryItem({ entitlement_id, actor }) {
      const b = buyerOf(actor);
      if (b === null) return null;
      return (await entitlementRows(b, entitlement_id))[0] ?? null;
    },

    issueLink: (i) => issueLink({ ...core, content }, i),

    async serve(i) {
      const planned = await planServe({ ...core, content }, i);
      if (!planned.ok) return { ok: false, code: planned.error.code };
      const plan: ServePlan = planned.value;
      const hash = createHash('sha256');
      let bytes = 0;
      const it = plan.body[Symbol.asyncIterator]();
      const stream = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const n = await it.next();
            if (n.done === true) {
              controller.close();
              await plan.onFinish({ bytes, sha256: hash.digest('hex') });
              return;
            }
            bytes += n.value.byteLength;
            hash.update(n.value);
            controller.enqueue(n.value);
          } catch (e) {
            controller.error(e);
          }
        },
        async cancel() {
          await plan.onAbort(bytes);
        },
      });
      return { ok: true, headers: plan.headers, stream };
    },

    async receipt({ order_id, actor }) {
      const b = buyerOf(actor);
      return b === null ? null : getReceiptForBuyer(db, { order_id, buyer_id: b });
    },

    receiptHtml: (r) => renderReceiptHtml(r, receiptLabel(r.environment)),

    // Lane 10 (recovery) owns openCase. A buyer names an item or an order; the kind follows from
    // which: an item is a delivery problem, an order is a payment question.
    async openCase({ actor, order_id, entitlement_id, note }) {
      if (actor.kind !== 'buyer') return err({ code: 'not_found' as const });
      const r = await openRecoveryCase(core, {
        kind: entitlement_id !== undefined ? 'delivery_failed' : 'payment_unresolved',
        ...(entitlement_id !== undefined ? { entitlement_id } : {}),
        ...(order_id !== undefined ? { order_id } : {}),
        opened_by: 'buyer',
        actor,
        ...(note !== undefined ? { note } : {}),
      });
      if (r.ok) return ok({ case_id: r.value.case_id });
      return err({
        code:
          r.error.code === 'duplicate_open' ? ('duplicate_open' as const) : ('not_found' as const),
      });
    },

    async opsSnapshot(actor) {
      if (actor.kind !== 'operator') return null;
      const sw = {} as Record<SwitchName, boolean>;
      for (const name of SWITCHES) sw[name] = await switches.isOn(name);
      const orders = await db.query<{
        order_ref: string;
        status: string;
        total_minor: string | number;
        currency: string;
      }>(
        'SELECT order_ref, status, total_minor, currency FROM orders ORDER BY created_at DESC, id LIMIT 20',
      );
      const ops = await db.query<{ state: string; c: string | number }>(
        'SELECT state, count(*) AS c FROM operations GROUP BY state ORDER BY state',
      );
      const alerts = await db.query<{ kind: string; created_at: unknown }>(
        'SELECT kind, created_at FROM alerts ORDER BY created_at DESC, id LIMIT 20',
      );
      return {
        environment,
        switches: sw,
        gate: {
          mode: config.mode,
          connect: config.connect,
          approval_ref_set: config.outbound_approval_ref !== null,
          transport: config.mode === 'sandbox' ? 'sandbox (sealed stub)' : 'dry-run fixtures',
        },
        orders: orders.rows.map((o) => ({
          order_ref: o.order_ref,
          status: o.status,
          total_minor: Number(o.total_minor),
          currency: o.currency,
        })),
        operations: ops.rows.map((o) => ({ state: o.state, count: Number(o.c) })),
        alerts: alerts.rows.map((a) => ({ kind: a.kind, created_at: iso(a.created_at) })),
        // TEMP-until-05b: checkInvariants (INV1 to INV4) is lane 05b's export.
        invariants: [{ id: 'INV', ok: true, detail: 'not wired until lane 05b' }],
      };
    },

    newKey: () => ids.nonce(),

    async sweep() {
      const swept = await sweepWindows(core, { max_items: 100 });
      // Lane 10: turn new alerts and delivery failures into cases; close restored ones.
      await applyAutomaticRules(core, { max_items: 100 });
      return swept;
    },

    async health() {
      try {
        await db.query('SELECT 1');
        return { ok: true, environment, db: true };
      } catch {
        return { ok: false, environment, db: false };
      }
    },
  };

  return {
    config,
    environment,
    ready: async () => {
      await open();
    },
    db,
    engine,
    security,
    close: async () => {
      if (driver !== null) await (await driver).close();
      driver = null;
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Process-wide singleton. Kept on globalThis so route bundles, pages and instrumentation share one
// app even when the bundler duplicates this module.
// ---------------------------------------------------------------------------------------------
export function installApp(app: App): void {
  setSingleton<App>(app);
}

export function getApp(): App {
  const existing = getSingleton<App>();
  if (existing !== undefined) return existing;
  const loaded = loadConfigFromProcess();
  if (!loaded.ok) {
    process.stderr.write(
      `boot refused: ${loaded.error.code} (${loaded.error.name}); nothing was started\n`,
    );
    process.exit(BOOT_REFUSAL_EXIT_CODE);
  }
  const built = buildApp(loaded.value, {});
  setSingleton<App>(built);
  return built;
}

/**
 * SecurityDeps for withRoute(...)(securityDeps). Every field is a getter, so nothing boots at
 * import time: the app (and its config) is created by the first request.
 */
export const securityDeps: SecurityDeps = {
  get db() {
    return getApp().security.db;
  },
  get clock() {
    return getApp().security.clock;
  },
  get ids() {
    return getApp().security.ids;
  },
  get log() {
    return getApp().security.log;
  },
  get audit() {
    return getApp().security.audit;
  },
  get session_secret() {
    return getApp().security.session_secret;
  },
  get passcode_hash() {
    return getApp().security.passcode_hash;
  },
  get public_origin() {
    return getApp().security.public_origin;
  },
};

/** Ready app for a page or handler. */
export async function app(): Promise<App> {
  const a = getApp();
  await a.ready();
  return a;
}

/** A fresh nonce for the page CSP (middleware), without booting the database. */
let nonceIds: Ids | null = null;
export function newNonce(): string {
  nonceIds ??= cryptoIds();
  return nonceIds.nonce();
}
