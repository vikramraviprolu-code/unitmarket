// The composition root (lane 15, architecture 2.3 rule Z1). The only file in apps/web that imports
// domain packages, the database, the config reader, the transport and the PayPal adapter. Pages and
// route handlers reach the engine only through `engine`, `securityDeps` and `getApp()` below.
//
// Everything here is lazy: importing this module opens nothing and reads no environment, so
// `next build` and route-module loading never boot the app. The first request does.
//
// UMS_MODE=offline (the default) is the dry run: no byte leaves the process. UMS_MODE=sandbox builds
// the outbound through src/server/outbound.server.ts (BU-2), which answers `blocked` until all five
// locks are open (mode, connect flag, active approval row, kill switch, credentials and Wire
// self-check) and then serves the approved sandbox transport. This file names none of the sealed
// identifiers; the test-only Wire is accepted only under NODE_ENV=test.
import { getSingleton, setSingleton } from './src/server/singleton';
import 'server-only';
import { createHash } from 'node:crypto';
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
  OutboundRequest,
  PayPalPort,
  PaymentsDeps,
  Receipt,
  Rights,
  Result,
  SqlExecutor,
  SwitchName,
  SwitchReader,
  Transport,
} from '@umsbx/contracts';
import { err, ok } from '@umsbx/contracts';
import {
  BOOT_REFUSAL_EXIT_CODE,
  loadConfig,
  loadConfigFromProcess,
  webhookLearnWindow,
  readMaintenanceFlag,
} from '@umsbx/config';
export { BOOT_REFUSAL_EXIT_CODE };
import type { Config } from '@umsbx/config';
import { migrate, openDatabase } from '@umsbx/db';
import type { SqlDriver } from '@umsbx/db';
import { cryptoIds, systemClock } from '@umsbx/runtime';
import { createAuditSink, createLogger, redact } from '@umsbx/obs';
import { createOutboundGate, createSwitchReader, readSafetyStatus, runStop } from '@umsbx/safety';
import { guard } from '@umsbx/transport';
import type { Wire } from '@umsbx/transport';
import {
  EXPECTED_CERT_PINS,
  createCertificateSource,
  createPayPalAdapter,
  learnWebhookCertificate,
  pinComplete,
} from '@umsbx/paypal';
import type { AdapterDeps } from '@umsbx/paypal';
import { createScriptedModel } from '@umsbx/model';
import {
  SEED_DATA,
  SEED_SUPPLEMENT_COMPOSITE,
  getOffer,
  seedCatalogue,
  seedSupplement,
} from '@umsbx/catalogue';
import { startFromOffer } from '@umsbx/offer-entry';
import { discover as discoverOffers, parseNeed } from '@umsbx/discovery';
import { requestApproval } from '@umsbx/approval';
import type { Selection } from '@umsbx/approval';
import { createPgContentStore, issueLink, planServe } from '@umsbx/delivery';
import type { ServePlan } from '@umsbx/delivery';
import {
  getReceiptForBuyer,
  paymentOutcome,
  receiptLabel,
  renderReceiptHtml,
} from '@umsbx/receipts';
import { sweepWindows } from '@umsbx/access-clock';
import {
  applyAutomaticRules,
  listCasesForBuyer,
  openCase as openRecoveryCase,
  resolve as resolveRecoveryCase,
} from '@umsbx/recovery';
import type { ResolveAction, ResolveDeps } from '@umsbx/recovery';
import {
  beginCheckout as beginPaymentsCheckout,
  checkInvariants,
  onBuyerReturn as onPaymentsReturn,
  placeOrder as placePaymentsOrder,
  handleWebhook,
  recoverOnStartup,
  cancelRefundRequest,
  executeRefund,
  requestRefund,
} from '@umsbx/payments';
import { health as jobsHealth, LEADER_LOCK_KEY, startLoop } from '@umsbx/jobs';
import type { CallBudget } from '@umsbx/jobs';
import { getLibrary } from '@umsbx/library';
import {
  SESSION_COOKIE,
  createSession,
  operatorSignIn,
  resolveSession,
  verifyPasscode,
} from '@umsbx/security';
import type { SecurityDeps } from '@umsbx/security';
import { DRYRUN_SCENARIOS, createDryRunModel, isScenarioId } from './src/server/dryrun-model';
import { buildOutbound } from './src/server/outbound.server';
import { createLearnRecorder, receiveWebhook, webhookAllowed } from './src/server/webhook';
import type { WebhookInput, WebhookResponse } from './src/server/webhook';
import type { Outbound } from './src/server/outbound.server';
import type { OpsGate } from './src/lib/gate-lines';
import { toBuyerReceipt } from './src/lib/receipt-view';
import type { ArticleFacts, BuyerReceipt } from './src/lib/receipt-view';
import { LINE_TEXT, lineKind, packBanner, windowMinutes } from './src/lib/composite-copy';
import type { LineKind } from './src/lib/composite-copy';
import {
  buyerRefundNote,
  buyerStatusText,
  isFullyRefunded,
  createRefundFacade,
  loadRefundOverview,
  orderRefundLine,
} from './src/server/refund';
import type { RefundFacade, RefundOverview, RefundUnitView } from './src/server/refund';
export type { RefundOverview, RefundUnitView };

type Env = Record<string, string | undefined>;
export interface AppOptions {
  /** Switch cache lifetime; tests pass 0. */
  switch_cache_ms?: number;
  log_sink?: (line: string) => void;
  /**
   * A Wire standing in for PayPal (tests). createApp refuses it unless NODE_ENV is test; without it
   * the sandbox outbound uses the production Wire.
   */
  test_wire?: Wire;
  /** Overrides of the domain config (tests). Refused unless NODE_ENV is test. */
  test_domain?: Partial<DomainConfig>;
  /**
   * A webhook certificate source standing in for the one fetched through the transport (CO-3 tests).
   * createApp refuses it unless NODE_ENV is test.
   */
  webhook_certificates?: NonNullable<AdapterDeps['certificates']>;
  /**
   * PG-2 (tests): `leader: 'off'` runs the job loop without the Postgres leader lock, to show what the
   * lock prevents; `leader_retry_ms` shortens the wait between two elections. Refused unless
   * NODE_ENV is test.
   */
  test_loop?: { leader?: 'off'; leader_retry_ms?: number };
  /**
   * DP-5 (tests): leave out the Quayside supplement (`supplement: false`) and/or the sandbox payee
   * step (`payees: false`) to build the disk an earlier release left. Refused unless NODE_ENV=test.
   */
  test_seed?: { supplement?: boolean; payees?: boolean };
}

// ---------------------------------------------------------------------------------------------
// Personas (demo sign-in, A11Y-6: a passcode, no cognitive test).
// ---------------------------------------------------------------------------------------------
/** The one publisher of MVP-B (ASM-03): its payee is the owner's own sandbox account (BU-7). */
const MVPB_PUBLISHER_SLUG = 'harbour-ledger';

export const PERSONAS = ['buyer-a', 'buyer-b', 'publisher', 'operator'] as const;
export type Persona = (typeof PERSONAS)[number];
const BUYER_IDS: Record<'buyer-a' | 'buyer-b', Id> = {
  'buyer-a': 'buy_persona_a',
  'buyer-b': 'buy_persona_b',
};

export const envLabel = (c: Config): EnvironmentLabel =>
  c.mode === 'sandbox' ? 'sandbox' : 'dryrun';

// ---------------------------------------------------------------------------------------------
// The payments seam (lane 05a). The facade binds the payments functions to their dependencies and
// turns their results into plain data for the routes: the approval error becomes an HTTP status.
// ---------------------------------------------------------------------------------------------
export type PlaceError =
  | { code: 'approval'; http: 403 | 404 | 409 | 410 }
  | { code: 'order_open'; http: 409 }
  | { code: 'already_owned'; http: 409 }
  | { code: 'payee_unavailable'; http: 409 }
  | { code: 'checkout_off'; http: 503 };
export type CheckoutError = {
  code: 'not_found' | 'wrong_state' | 'create_failed' | 'payments_paused';
};
export type ReturnError = {
  code:
    'not_found' | 'not_approved' | 'frozen' | 'not_charged_content_unavailable' | 'payments_paused';
};
/** Where the buyer goes next in a pack (OQ-5): which PayPal order, for which publisher, at which stored URL. */
export interface PackStep {
  step: number;
  of: number;
  publisher: string;
  approve_url: string;
}
export interface OrderView {
  order_id: Id;
  order_ref: Id;
  status: string;
  buyer_message: string;
  /**
   * `publisher`, `kind` and `line` are set for an order with several PayPal orders (a pack): one line per
   * item from stored data. A one-publisher order carries only the first three fields.
   */
  items: {
    article_id: Id;
    title: string;
    access: string;
    publisher?: string;
    kind?: LineKind;
    line?: string;
  }[];
  environment: EnvironmentLabel;
  /** The case opened for this order, if any (recovery rules or the buyer). */
  open_case: { case_id: Id; state: string; buyer_message: string } | null;
  /** What has been refunded of what was paid, from the stored units (CO-8); null when nothing. */
  refund_line: string | null;
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
  }): Promise<
    Result<{ approve_url: string; progress: { step: number; of: number } | null }, CheckoutError>
  >;
  onBuyerReturn(i: {
    order_ref: Id;
    actor: Actor;
    scenario?: string | null;
  }): Promise<Result<{ order_ref: Id; status: string; next: PackStep | null }, ReturnError>>;
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
  rights: Rights;
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
  /** One block per publisher, with its items and subtotal (DP-5). */
  blocks: {
    publisher: string;
    items: {
      article_id: Id;
      title: string;
      publisher: string;
      option: string;
      amount_minor: number;
      ai_scope: string;
    }[];
    subtotal_minor: number;
  }[];
  /** Set when the snapshot froze a per-publisher settlement: the buyer approves this many payments. */
  settlement: { payments: number } | null;
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
  /** CO-8: set for a partially refunded unit; says access to every item in the order continues. */
  refund_note: string | null;
  /** CO-8b L4: a full refund; the page shows the refund line and no window meter. */
  refunded: boolean;
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
  /** The gate block: mode, connect flag and, in sandbox mode, the five locks and the Wire self-check. */
  gate: OpsGate;
  orders: { order_ref: string; status: string; total_minor: number; currency: string }[];
  operations: { state: string; count: number }[];
  alerts: { kind: string; created_at: string }[];
  invariants: { id: string; ok: boolean; detail: string }[];
  /** The paypal_outbound switch (the kill switch) and the budget left under the active approval. */
  kill_switch: {
    outbound_on: boolean;
    changed_by: string;
    changed_at: string;
    reason: string;
    budget: { remaining_today: number; max_calls_per_day: number; valid_until: string } | null;
  };
  /** The job loop: when it last finished a pass and how much recovery work is due. */
  jobs: { last_pass_at: string | null; due: number };
  /**
   * D-041: publishers that share one payee account (the explicit payee_shared flag), from stored data.
   * Null when none do. Only the last 4 characters of the merchant id are given.
   */
  shared_payee: { publishers: number; last4: string } | null;
  /**
   * CO-8: the units an operator may refund. Null unless the session carries the second factor (P9):
   * the page shows the form only to such sessions, and the route refuses the others anyway.
   */
  refunds: RefundOverview | null;
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

export function orderMessage(
  status: string,
  unit_statuses: string[],
  po_states: readonly string[] = [],
): string {
  // A hold always wins (H1): a frozen PayPal order holds the order whether or not a capture was sent.
  if (unit_statuses.includes('mismatch') || status === 'frozen' || po_states.includes('frozen'))
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

/**
 * CO-7b (D-037): thrown by anything that would open the database or build the transport while the app
 * is in maintenance mode. The database is not opened, so the single-opener lock stays free for
 * `pnpm safety:approve` and `pnpm safety:resume` in the host shell.
 */
export class MaintenanceError extends Error {
  constructor() {
    super('the app is in maintenance mode: the database is not open');
    this.name = 'MaintenanceError';
  }
}

export interface App {
  readonly config: Config;
  readonly environment: EnvironmentLabel;
  /**
   * CO-7b (D-037): true when the host's maintenance flag file was there when the app was built. Decided
   * once and never changed while the process lives: the database is not opened, the job loop is not
   * started and no outbound or Wire is built; every route but the health check answers 503. Leaving the
   * mode takes a restart after the owner removed the flag in the host shell.
   */
  readonly maintenance: boolean;
  /** Resolves after the database is open, migrated and seeded. */
  ready(): Promise<void>;
  /**
   * Starts the job loop (lane 05b): recover what was in flight when the process last stopped, then
   * run due payments work and end access windows. The returned handle stops the loop.
   */
  startJobs(): Promise<{ stop(): Promise<void> }>;
  readonly db: Database;
  readonly engine: Engine;
  readonly security: SecurityDeps;
  /** The sandbox outbound (the five locks); null in offline mode. */
  readonly outbound: Outbound | null;
  close(): Promise<void>;
}

export interface Engine {
  personas(): readonly Persona[];
  /**
   * The passcode is checked first. For the operator persona, `operator` and `code` are the name and the
   * authenticator code (CO-6): a right pair gives `opr_<name>` with mfa; no keys configured, or no code,
   * gives the unverified operator without mfa; a wrong code gives null, like a wrong passcode.
   */
  signIn(i: {
    persona: string;
    passcode: string;
    operator?: string | undefined;
    code?: string | undefined;
  }): Promise<{ actor: Actor; cookie: string; csrf_token: string } | null>;
  actorFromCookie(cookie: string | null): Promise<Actor | null>;
  /**
   * The id of the live session behind a cookie header, for the actor that session belongs to.
   * Links are bound to it (delivery lane): a link issued in one session is not found in another.
   */
  sessionIdOf(cookie: string | null, actor: Actor): Promise<Id | null>;
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
  /** The pretend-PayPal outcomes a tester can pick on the dry-run page. Empty outside dry run. */
  dryRunScenarios(): readonly { id: string; label: string }[];
  /**
   * The buyer pressing "Approve payment (dry run)": marks the order approved at the pretend
   * PayPal with the chosen scenario. False when it is not this buyer's order or not dry run.
   */
  dryRunApprove(i: {
    order_ref: Id;
    actor: Actor;
    scenario: string | null;
    /** Which PayPal order of a pack (1..N). Default: the first one still awaiting the buyer. */
    position?: number;
  }): Promise<boolean>;
  /**
   * The PayPal orders of a buyer's order, by position, for the dry-run page and the step page: the
   * publisher's display name and our state for each. Null when it is not this buyer's order.
   */
  checkoutSteps(i: {
    order_ref: Id;
    actor: Actor;
  }): Promise<{ position: number; publisher: string; state: string }[] | null>;
  /** Whole minutes of the pack approval window (from the configured milliseconds, rounded down). */
  packWindowMinutes(): number;
  library(i: { actor: Actor }): Promise<LibraryEntry[]>;
  libraryItem(i: { entitlement_id: Id; actor: Actor }): Promise<LibraryEntry | null>;
  issueLink(i: { entitlement_id: Id; actor: Actor; session_id?: Id }): ReturnType<typeof issueLink>;
  serve(i: {
    token: string;
    actor: Actor;
    mode: 'download' | 'read';
    session_id?: Id;
  }): Promise<
    | { ok: true; headers: Record<string, string>; stream: ReadableStream<Uint8Array> }
    | { ok: false; code: string }
  >;
  receipt(i: { order_id: Id; actor: Actor }): Promise<Receipt | null>;
  /**
   * The receipt as a buyer sees it (UX-1A, items 45 and 54): titles and publisher names on the lines,
   * and no merchant id anywhere. The stored, hashed receipt is `receipt`; pages and routes use this.
   */
  buyerReceipt(i: { order_id: Id; actor: Actor }): Promise<BuyerReceipt | null>;
  receiptHtml(r: Receipt): string;
  openCase(i: {
    actor: Actor;
    order_id?: Id;
    entitlement_id?: Id;
    note?: string;
  }): Promise<Result<{ case_id: Id }, { code: 'not_found' | 'duplicate_open' }>>;
  opsSnapshot(actor: Actor): Promise<OpsSnapshot | null>;
  /**
   * The ops stop button (BU-2): paypal_outbound off, with a reason, by an operator session. It can
   * only turn the switch off; turning it on is `pnpm safety:resume` at the owner's terminal.
   */
  stopOutbound(i: {
    actor: Actor;
    reason: string;
  }): Promise<Result<void, 'operator_required' | 'reason_required'>>;
  health(): Promise<{
    ok: boolean;
    environment: EnvironmentLabel;
    db: boolean;
    /** True in maintenance mode: the app is up, the database is deliberately not open (CO-7b). */
    maintenance: boolean;
    last_pass_at: string | null;
    due: number;
  }>;
  /**
   * One PayPal webhook delivery (CO-3). Checks the webhook may be verified at all (switch on, webhook
   * id set, certificate pin set in sandbox mode), verifies it over the raw bytes, and hands the verdict
   * to payments intake: at most one stored event and one due read-back. It never sets paid, books
   * money or calls PayPal for the order.
   */
  webhook(i: WebhookInput): Promise<WebhookResponse>;
  /**
   * CO-8: the operator refund path. `request` is requestRefund then executeRefund for an operator with
   * the second factor; `cancel` withdraws a request that is still `requested`.
   */
  refund: RefundFacade;
  /** A fresh single-use key for an idempotent POST (the browser holds no randomness source). */
  newKey(): string;
  /** One pass of the access-window sweep and the automatic recovery rules (the job loop's sweep). */
  sweep(): Promise<{ ended: number }>;
  /** Operator only: resolve a case; offering a refund goes through the payments refund path. */
  resolveCase(i: {
    actor: Actor;
    case_id: Id;
    action: ResolveAction;
    reason: string;
  }): ReturnType<typeof resolveRecoveryCase>;
}

/** Sandbox polling cadence (ASM-52): a paid order is re-read every 6 h; at most 2 provider calls a second. */
export const SANDBOX_REREAD_PAID_EVERY_MS = 21_600_000;
export const SANDBOX_MIN_CALL_GAP_MS = 500;

export const PACK_APPROVAL_WINDOW_MS = 3_600_000;

export const DOMAIN_CONFIG = (c: Config): DomainConfig => ({
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
  // MVP-D (P17, ASM-75): how long after the first approval of a pack the rest must be approved.
  // Set here on purpose, not left to the engine's default.
  pack_approval_window_ms: PACK_APPROVAL_WINDOW_MS,
  ...(c.mode === 'sandbox'
    ? {
        reread_paid_every_ms: SANDBOX_REREAD_PAID_EVERY_MS,
        min_call_gap_ms: SANDBOX_MIN_CALL_GAP_MS,
      }
    : {}),
});

// ---------------------------------------------------------------------------------------------
// D-041 (OQ-1 option B), M-3: both fictional publishers are paid into the owner's own sandbox
// account. One transaction, two statements, Harbour first, so the payee guard of migration 0010 never
// sees a pair that is not flagged on both sides. A stored id is never overwritten: Harbour is only
// flagged where it already holds the owner's id, and Quayside is only set where it has no id. If
// Harbour stores another id, nothing is set and one refusal line is logged (no partial write).
// ---------------------------------------------------------------------------------------------
const FIRST_PAYEE_SLUG = MVPB_PUBLISHER_SLUG;
const SECOND_PAYEE_SLUG = 'quayside-gazette';

export async function seedSandboxPayees(
  d: { db: Database; clock: Clock; audit: AuditSink; log: Logger },
  own_merchant_id: string,
): Promise<void> {
  const last4 = own_merchant_id.slice(-4);
  const refused = await d.db.transaction(async (tx) => {
    const rows = (
      await tx.query<{
        id: string;
        slug: string;
        paypal_merchant_id: string | null;
        payee_shared: boolean;
      }>(
        'SELECT id, slug, paypal_merchant_id, payee_shared FROM publishers WHERE slug = $1 OR slug = $2',
        [FIRST_PAYEE_SLUG, SECOND_PAYEE_SLUG],
      )
    ).rows;
    const first = rows.find((r) => r.slug === FIRST_PAYEE_SLUG);
    const second = rows.find((r) => r.slug === SECOND_PAYEE_SLUG);
    if (first === undefined || second === undefined) return false;
    if (first.paypal_merchant_id !== null && first.paypal_merchant_id !== own_merchant_id)
      return true;
    const now = d.clock.now().toISOString();
    if (first.paypal_merchant_id === own_merchant_id && !first.payee_shared) {
      await tx.query(
        `UPDATE publishers SET payee_shared = true, updated_at = $1
          WHERE id = $2 AND paypal_merchant_id = $3 AND NOT payee_shared`,
        [now, first.id, own_merchant_id],
      );
      await d.audit.record(tx, {
        actor: { kind: 'system' },
        action: 'seed.payee_shared',
        target: first.id,
        reason: 'D-041: both publishers are paid into the owner account',
        detail: { slug: first.slug, merchant_last4: last4 },
      });
    }
    if (second.paypal_merchant_id === null) {
      await tx.query(
        `UPDATE publishers SET paypal_merchant_id = $3, payee_verified_at = $1, payee_shared = true, updated_at = $1
          WHERE id = $2 AND paypal_merchant_id IS NULL`,
        [now, second.id, own_merchant_id],
      );
      await d.audit.record(tx, {
        actor: { kind: 'system' },
        action: 'seed.payee_set',
        target: second.id,
        reason: 'D-041: both publishers are paid into the owner account',
        detail: { slug: second.slug, merchant_last4: last4 },
      });
    }
    return false;
  });
  if (refused)
    d.log.log({
      msg: 'seed.payee_refused',
      level: 'warn',
      fields: { publisher: FIRST_PAYEE_SLUG, why: 'stored_id_differs_from_owner_id' },
    });
}

/** Publishers that share one payee account through the explicit flag, from stored data (D-041). */
async function sharedPayee(db: Database): Promise<OpsSnapshot['shared_payee']> {
  const r = await db.query<{ paypal_merchant_id: string; n: string | number }>(
    `SELECT paypal_merchant_id, count(*) AS n FROM publishers
      WHERE payee_shared AND paypal_merchant_id IS NOT NULL
      GROUP BY paypal_merchant_id HAVING count(*) > 1 ORDER BY count(*) DESC LIMIT 1`,
  );
  const row = r.rows[0];
  return row === undefined
    ? null
    : { publishers: Number(row.n), last4: row.paypal_merchant_id.slice(-4) };
}

export function createApp(env: Env, opts: AppOptions = {}): App {
  const loaded = loadConfig(env);
  if (!loaded.ok) throw new Error(`boot refused: ${loaded.error.code} ${loaded.error.name}`);
  return buildApp(loaded.value, opts);
}

function buildApp(config: Config, opts: AppOptions): App {
  // Test doubles never reach a running server: a Wire standing in for PayPal, or a changed cadence,
  // is accepted only when NODE_ENV is test.
  if (config.node_env !== 'test') {
    if (opts.test_wire !== undefined)
      throw new Error('boot refused: test_wire outside NODE_ENV=test');
    if (opts.test_domain !== undefined)
      throw new Error('boot refused: test_domain outside NODE_ENV=test');
    if (opts.webhook_certificates !== undefined)
      throw new Error('boot refused: webhook_certificates outside NODE_ENV=test');
    if (opts.test_loop !== undefined)
      throw new Error('boot refused: test_loop outside NODE_ENV=test');
    if (opts.test_seed !== undefined)
      throw new Error('boot refused: test_seed outside NODE_ENV=test');
  }
  const environment = envLabel(config);
  const clock: Clock = systemClock();
  const ids: Ids = cryptoIds();
  // CO-1d (D-038): the learn window may end at most 24 h after this boot. Config only parsed the value
  // (sandbox mode, strict UTC time); the cap needs the clock. A longer window never starts.
  if (webhookLearnWindow(config.webhook_cert_learn_until, clock.now()) === 'too_far')
    throw new Error('boot refused: invalid_value UMS_WEBHOOK_CERT_LEARN_UNTIL');
  const sink =
    opts.log_sink ??
    (config.node_env === 'test'
      ? () => undefined
      : (line: string) => {
          process.stdout.write(`${line}\n`);
        });
  const log: Logger = createLogger(sink, { env_label: environment }, clock);
  // CO-7b (D-037): read once, here, and latched for the life of the process. Reading only; the owner
  // creates and removes the file in the host shell and nothing in the app writes it.
  const flag = readMaintenanceFlag(config.maintenance_flag);
  const maintenance = flag.on;
  if (flag.on) log.log({ msg: 'maintenance.on', level: 'warn', fields: { why: flag.why } });
  const audit: AuditSink = createAuditSink(ids, clock);

  // --- lazy database -------------------------------------------------------------------------
  let driver: Promise<SqlDriver> | null = null;
  const open = (): Promise<SqlDriver> => {
    if (maintenance) return Promise.reject(new MaintenanceError());
    driver ??= (async () => {
      // PG-2: the URL is a secret. It is revealed here, once, and handed to the driver, which never
      // logs it and scrubs it from every error it raises; nothing in this file prints it.
      const d = await openDatabase(
        config.db.kind === 'postgres'
          ? { kind: 'postgres', url: config.db.url.reveal() }
          : config.db.kind === 'pglite-disk'
            ? { kind: 'pglite-disk', dir: config.db.dir }
            : { kind: 'pglite-memory' },
      );
      try {
        await migrate(d, clock);
        await seed(d);
      } catch (e) {
        await d.close().catch(() => undefined);
        throw e;
      }
      return d;
    })();
    return driver;
  };
  const seed = async (d: SqlDriver): Promise<void> => {
    const n = await d.query<{ c: string | number }>('SELECT count(*) AS c FROM publishers');
    if (Number(n.rows[0]?.c ?? 0) === 0) await seedCatalogue(d, clock, ids, SEED_DATA);
    // DP-5: the second publisher of MVP-D. Every boot, after the base seed, so it reaches a disk that
    // already holds the base catalogue. Every row is looked up first: a second run adds nothing, and it
    // never sets a merchant id, a verification time or the payee_shared flag.
    if (opts.test_seed?.supplement !== false)
      await seedSupplement(d, clock, ids, SEED_SUPPLEMENT_COMPOSITE);
    const now = clock.now().toISOString();
    if (config.mode === 'offline') {
      // Dry run only: a synthetic payee label so approvals can be built. It is not a PayPal account.
      await d.query(
        `UPDATE publishers SET paypal_merchant_id = 'DRYRUN' || upper(left(md5(slug), 7)),
                payee_verified_at = $1, updated_at = $1
          WHERE paypal_merchant_id IS NULL`,
        [now],
      );
      // Dry run only: the migration seeds paypal_outbound off (fail closed). A dry run opens no
      // socket, and recovery and reconcile pause while the switch is off, so the offline seed turns it
      // on. Only the untouched migration row is changed: an operator stop survives a restart.
      // Sandbox mode never takes this path and keeps the switch off until the owner approves.
      await d.query(
        `UPDATE safety_switches SET "on" = true, changed_by = 'seed:dryrun', changed_at = $1,
                reason = 'seed: dry run opens no socket', updated_at = $1
          WHERE name = 'paypal_outbound' AND changed_by = 'seed'`,
        [now],
      );
    }
    if (config.mode === 'sandbox' && config.own_merchant_id !== null) {
      // BU-7 (D-028): the one MVP-B publisher is paid into the owner's own sandbox account. The id
      // comes from the owner's environment at setup time; none is committed. Only a publisher that has
      // no merchant id yet is set, so a stored value is never overwritten by a later start.
      await d.query(
        `UPDATE publishers SET paypal_merchant_id = $2, payee_verified_at = $1, updated_at = $1
          WHERE slug = $3 AND paypal_merchant_id IS NULL`,
        [now, config.own_merchant_id, MVPB_PUBLISHER_SLUG],
      );
      if (opts.test_seed?.payees !== false)
        await seedSandboxPayees({ db: d, clock, audit, log }, config.own_merchant_id);
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
    dialect: config.db.kind === 'postgres' ? 'pg' : 'pglite',
    query: async (sql, params) => (await open()).query(sql, params),
    exec: async (sql) => (await open()).exec(sql),
    transaction: async <T>(fn: (tx: SqlExecutor) => Promise<T>) => (await open()).transaction(fn),
  };

  const switches: SwitchReader = createSwitchReader(db, clock, opts.switch_cache_ms);
  const content: ContentStore = createPgContentStore(db);
  const gate = createOutboundGate({ db, clock, switches, config });

  // --- sandbox outbound (BU-2): built only in sandbox mode; it answers blocked until all locks open ---
  const outbound: Outbound | null =
    config.mode === 'sandbox' && !maintenance
      ? buildOutbound({
          config,
          db,
          clock,
          log,
          switches,
          wire: opts.test_wire === undefined ? null : opts.test_wire,
        })
      : null;
  let selfcheckLogged = false;
  const logSelfcheckOnce = (): void => {
    if (selfcheckLogged || outbound === null) return;
    selfcheckLogged = true;
    const c = outbound.selfcheck();
    log.log({
      msg: 'transport.selfcheck',
      level: c === null || (!c.env_override && c.builtins_intact) ? 'info' : 'warn',
      fields:
        c === null
          ? { wire_kind: 'injected' }
          : {
              wire_kind: 'production',
              impl: c.impl,
              env_override: c.env_override,
              builtins_intact: c.builtins_intact,
              global_fetch_changed: c.global_fetch_changed_since_load,
            },
    });
  };

  // --- transport and adapter (dry run: the order model; sandbox: the outbound above) ---
  // Dry run: the order model answers (see src/server/dryrun-model.ts). Like the fixture transport it
  // passes the egress guard and asks the outbound gate once per request; it opens no socket.
  const dryModel = createDryRunModel(clock, { own_merchant_id: config.own_merchant_id });
  let transport: Transport | null = null;
  const getTransport = async (): Promise<Transport> => {
    if (maintenance) throw new MaintenanceError();
    if (transport !== null) return transport;
    if (outbound !== null) {
      logSelfcheckOnce();
      transport = outbound.transport;
    } else {
      transport = {
        kind: 'dryrun',
        async send(r) {
          const checked = guard(r, 'dryrun');
          if (!checked.ok) return { kind: 'blocked', by: 'egress' };
          // The stop blocks every call, reads included (architecture 7.4). The gate answers
          // connect_off first in dry run, so the kill switch is read here, before it.
          if (!(await switches.isOn('paypal_outbound')))
            return { kind: 'blocked', by: 'kill_switch' };
          const verdict = await gate.check({
            operation: r.operation,
            amount_minor: r.amount_minor,
          });
          // The dry-run transport never connects, so a connect_off verdict does not apply to it.
          if (!verdict.allowed && verdict.by !== 'connect_off')
            return { kind: 'blocked', by: verdict.by };
          const out = dryModel.send(r);
          log.log({
            msg: 'dryrun.send',
            level: 'info',
            fields: { operation: r.operation, scenario: r.scenario ?? null, outcome: out.kind },
          });
          return out;
        },
      };
    }
    return transport;
  };
  const payTransport = {
    kind: config.mode === 'sandbox' ? 'sandbox' : 'dryrun',
    send: async (r: OutboundRequest) => (await getTransport()).send(r),
  } as Transport;
  // The certificate source is built here (the adapter would build the same one) so the learn window
  // (CO-1d) describes certificates through the very source, budgets and Transport that verification uses.
  const certificates: NonNullable<AdapterDeps['certificates']> =
    opts.webhook_certificates ?? createCertificateSource({ transport: payTransport, clock, log });
  const paypal: PayPalPort = createPayPalAdapter({
    transport: payTransport,
    clock,
    log,
    credentials: config.paypal === null ? null : config.paypal,
    own_merchant_id: config.own_merchant_id,
    // PAYPAL_WEBHOOK_ID (sandbox mode only; config reads it there). Unset: no webhook can be verified.
    webhook_id: config.paypal?.webhook_id ?? null,
    certificates,
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
    config: {
      ...DOMAIN_CONFIG(config),
      // The window is the one cadence a request path reads (the step page names it); tests may move it.
      pack_approval_window_ms: opts.test_domain?.pack_approval_window_ms ?? PACK_APPROVAL_WINDOW_MS,
    },
    environment,
  };
  const packWindowMs = core.config.pack_approval_window_ms ?? PACK_APPROVAL_WINDOW_MS;
  // CO-1d (D-038): the learn window's recorder. Built only when a window was configured; the window
  // itself is checked per delivery against the clock. It describes the certificate through the one
  // certificate source above and writes one audit row (actor system) per distinct certificate.
  const learnRecorder =
    config.webhook_cert_learn_until === null
      ? null
      : createLearnRecorder({
          log,
          switchOn: () => switches.isOn('webhook_enabled'),
          lookup: async (headers) => {
            const r = await learnWebhookCertificate(certificates, headers);
            return r.kind === 'facts' ? r.facts : null;
          },
          // F2: the audit sink and the logger redact. Facts redaction would change are not recorded.
          recordable: (f) => JSON.stringify(redact(f)) === JSON.stringify(f),
          audit: (f) =>
            db.transaction((tx) =>
              audit.record(tx, {
                actor: { kind: 'system' },
                action: 'webhook.cert_learned',
                target: null,
                reason: null,
                detail: { ...f },
              }),
            ),
        });
  const agent: AgentDeps = { ...core, model: createScriptedModel() };
  const paymentsDeps: PaymentsDeps = { ...core, paypal, content };
  // The loop's deps carry the cadence (the domain config); test_domain changes it in tests only.
  const loopDeps: PaymentsDeps = {
    ...paymentsDeps,
    config: { ...paymentsDeps.config, ...(opts.test_domain ?? {}) },
  };
  // The day's call budget for polling (BU-5), read from the active approval row. Never null in
  // sandbox mode: no active approval reads as 0 calls remaining.
  const callBudget: CallBudget = async () => {
    const st = await readSafetyStatus(db, clock.now(), config.outbound_approval_ref);
    return st.budget === null
      ? { remaining_today: 0, max_calls_per_day: 0 }
      : {
          remaining_today: st.budget.remaining_today,
          max_calls_per_day: st.budget.max_calls_per_day,
        };
  };
  // Lane 10 resolves cases; offering a refund goes through lane 05b's requestRefund (ASM-10-2).
  const recoveryDeps: ResolveDeps = {
    ...core,
    content,
    requestRefund: (i) => requestRefund(paymentsDeps, i),
    // CO-4 review: an offer over several units is all or none, so the resolver can undo its requests.
    cancelRefund: (i) => cancelRefundRequest(paymentsDeps, i.refund_request_id, i.actor),
  };
  // CO-8: the operator refund path. The payments functions are bound here; the behaviour is in
  // src/server/refund.ts.
  const refundFacade: RefundFacade = createRefundFacade({
    db,
    audit,
    log,
    requestRefund: (i) => requestRefund(paymentsDeps, i),
    executeRefund: (i) => executeRefund(paymentsDeps, i),
    cancelRefund: (i) => cancelRefundRequest(paymentsDeps, i.refund_request_id, i.actor),
  });
  // One pass of the loop's sweep: end access windows, then turn alerts into cases.
  const sweepAll = async (x: { max_items: number }): Promise<{ ended: number }> => {
    const swept = await sweepWindows(core, x);
    await applyAutomaticRules(core, x);
    return swept;
  };

  let loop: { stop(): Promise<void> } | null = null;

  const security: SecurityDeps = {
    db,
    clock,
    ids,
    log,
    audit,
    session_secret: config.session_secret,
    passcode_hash: config.passcode_hash,
    public_origin: config.public_origin,
    // UMS_TRUSTED_PROXIES (default 0): how many reverse proxies sit in front. With 0, X-Forwarded-For
    // is never read, a client cannot choose its own limiter bucket, and (route handlers receive no
    // socket address) every client shares one 'no-address' bucket; the login then refuses only
    // wrong passcodes once it is spent. A hosted deployment must set the proxy count.
    trusted_proxies: config.trusted_proxies,
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
        await db.query<{
          id: string;
          money_state: string;
          order_id: string | null;
          unit_status: string | null;
        }>(
          `SELECT e.id, e.money_state, u.order_id, u.status AS unit_status
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
      const fact = facts.get(v.entitlement_id);
      // CO-8: refund words come from stored facts (money state, unit status, window, option) here, not
      // in a page. The library read model keeps its own words for everything else.
      const refundFacts = {
        money: fact?.money_state ?? 'unknown',
        unit_status: fact?.unit_status ?? 'unknown',
      };
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
        status_text: buyerStatusText({
          base: v.status_text,
          ...refundFacts,
          window_state: v.window.state,
          option: v.option,
        }),
        refund_note: buyerRefundNote(refundFacts),
        refunded: isFullyRefunded(refundFacts),
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

    async signIn({ persona, passcode, operator, code }) {
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
        const r = await operatorSignIn(security, {
          keys: config.operator_totp_keys,
          operator,
          code,
        });
        if (!r.ok) return null;
        actor = { kind: 'operator', operator_id: r.operator_id, mfa: r.mfa };
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

    async sessionIdOf(cookie, actor) {
      // resolveSession checks the signature, expiry and revocation; only then is the id read.
      const live = await resolveSession(security, cookie);
      if (live === null || cookie === null) return null;
      if (JSON.stringify(live) !== JSON.stringify(actor)) return null;
      const m = new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=(ses_[0-9a-z]{26})\\.`).exec(cookie);
      return m?.[1] ?? null;
    },

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
        publishers?: { publisher_id: string; amount_minor: number }[];
        settlement?: { payments: number };
      };
      const items: ApprovalView['items'] = [];
      const itemPublisher: string[] = [];
      for (const it of snap.items) {
        itemPublisher.push(it.publisher_id);
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
      // One block per publisher, in the snapshot's own order; the subtotal is the sum of its items.
      const order: string[] = [];
      for (const pid of snap.publishers?.map((p) => p.publisher_id) ?? itemPublisher)
        if (!order.includes(pid)) order.push(pid);
      const blocks: ApprovalView['blocks'] = order.map((pid) => {
        const mine = items.filter((_, i) => itemPublisher[i] === pid);
        return {
          publisher: mine[0]?.publisher ?? 'Publisher',
          items: mine,
          subtotal_minor: mine.reduce((n, it) => n + it.amount_minor, 0),
        };
      });
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
        blocks,
        settlement: snap.settlement === undefined ? null : { payments: snap.settlement.payments },
      };
    },

    payments: {
      async placeOrder(i) {
        const r = await placePaymentsOrder(paymentsDeps, i);
        if (r.ok) return ok(r.value);
        const e = r.error;
        return err(e.code === 'approval' ? { code: 'approval', http: e.error.http } : e);
      },
      async beginCheckout(i) {
        const r = await beginPaymentsCheckout(paymentsDeps, i);
        if (!r.ok) return err(r.error);
        return ok({ approve_url: r.value.approve_url, progress: r.value.progress ?? null });
      },
      async onBuyerReturn(i) {
        const r = await onPaymentsReturn(paymentsDeps, i);
        if (!r.ok) return err(r.error);
        const v = r.value;
        // OQ-5: while a PayPal order of a pack still awaits the buyer, say which one and give its stored
        // approval link. The link and the publisher come from the stored PayPal order, never from the URL.
        let next: PackStep | null = null;
        if (v.status === 'awaiting_buyer' && v.progress !== null && v.approve_url !== null) {
          const po = v.provider_orders.find((p) => p.position === v.progress?.step);
          const name =
            po?.publisher_id == null
              ? null
              : (
                  await db.query<{ display_name: string }>(
                    'SELECT display_name FROM publishers WHERE id = $1',
                    [po.publisher_id],
                  )
                ).rows[0]?.display_name;
          next = {
            step: v.progress.step,
            of: v.progress.of,
            publisher: name ?? 'the publisher',
            approve_url: v.approve_url,
          };
        }
        return ok({ order_ref: v.order_ref, status: v.status, next });
      },
    },

    packWindowMinutes: () => windowMinutes(packWindowMs),

    async checkoutSteps({ order_ref, actor }) {
      const buyer = buyerOf(actor);
      if (buyer === null) return null;
      const rows = await db.query<{
        position: number | string;
        display_name: string;
        state: string;
      }>(
        `SELECT p.position, pub.display_name, p.state
           FROM provider_orders p JOIN orders o ON o.id = p.order_id
           LEFT JOIN publishers pub ON pub.id = p.publisher_id
          WHERE o.order_ref = $1 AND o.buyer_id = $2 ORDER BY p.position`,
        [order_ref, buyer],
      );
      if (rows.rows.length === 0) return null;
      return rows.rows.map((r) => ({
        position: Number(r.position),
        publisher: r.display_name ?? 'the publisher',
        state: r.state,
      }));
    },

    dryRunScenarios: () => (environment === 'dryrun' ? DRYRUN_SCENARIOS : []),

    async dryRunApprove({ order_ref, actor, scenario, position }) {
      const buyer = buyerOf(actor);
      if (buyer === null || environment !== 'dryrun') return false;
      if (scenario !== null && !isScenarioId(scenario)) return false;
      if (position !== undefined && (!Number.isInteger(position) || position < 1)) return false;
      // The PayPal order at `position`, else the first one still awaiting the buyer. Only an order that
      // awaits the buyer can be approved.
      const row = await db.query<{ provider_order_id: string | null }>(
        `SELECT p.provider_order_id FROM provider_orders p JOIN orders o ON o.id = p.order_id
          WHERE o.order_ref = $1 AND o.buyer_id = $2 AND o.status = 'awaiting_buyer'
            AND p.state = 'awaiting_buyer' AND ($3::int IS NULL OR p.position = $3::int)
          ORDER BY p.position LIMIT 1`,
        [order_ref, buyer, position ?? null],
      );
      const id = row.rows[0]?.provider_order_id;
      return id === undefined || id === null ? false : dryModel.approve(id, scenario);
    },

    async orderView({ order_ref, actor }) {
      const buyer = buyerOf(actor);
      if (buyer === null) return null;
      const o = (
        await db.query<{
          id: string;
          order_ref: string;
          status: string;
          environment: EnvironmentLabel;
          currency: string;
        }>(
          'SELECT id, order_ref, status, environment, currency FROM orders WHERE order_ref = $1 AND buyer_id = $2',
          [order_ref, buyer],
        )
      ).rows[0];
      if (o === undefined) return null;
      const units = await db.query<{
        status: string;
        amount_minor: string | number;
        refunded_minor: string | number;
      }>('SELECT status, amount_minor, refunded_minor FROM order_units WHERE order_id = $1', [
        o.id,
      ]);
      const ents = await db.query<{
        article_id: string;
        title: string;
        access_state: string;
        publisher: string | null;
        unit_status: string;
        po_state: string | null;
        verified: boolean;
        amount_minor: string | number;
        refunded_minor: string | number;
      }>(
        `SELECT e.article_id, a.title, e.access_state, pub.display_name AS publisher,
                u.status AS unit_status, p.state AS po_state,
                (u.captured_verified_at IS NOT NULL) AS verified, u.amount_minor, u.refunded_minor
           FROM entitlements e
           JOIN order_units u ON u.id = e.unit_id JOIN articles a ON a.id = e.article_id
           LEFT JOIN provider_orders p ON p.id = u.provider_order_ref
           LEFT JOIN publishers pub ON pub.id = u.publisher_id
          WHERE u.order_id = $1 AND e.buyer_id = $2 ORDER BY p.position NULLS LAST, e.id`,
        [o.id, buyer],
      );
      const poStates = (
        await db.query<{ state: string }>('SELECT state FROM provider_orders WHERE order_id = $1', [
          o.id,
        ])
      ).rows.map((r) => r.state);
      // An order with several PayPal orders is a pack: one line per item, from stored facts (DP-5).
      const pack = poStates.length > 1;
      const items: OrderView['items'] = ents.rows.map((e) => {
        const base = { article_id: e.article_id, title: e.title, access: e.access_state };
        if (!pack) return base;
        const kind = lineKind({
          outcome: paymentOutcome({
            unit_status: e.unit_status,
            po_state: e.po_state,
            verified: e.verified,
            amount_minor: Number(e.amount_minor),
            refunded_minor: Number(e.refunded_minor),
          }),
          access: e.access_state,
          po_state: e.po_state,
          unit_status: e.unit_status,
        });
        return { ...base, publisher: e.publisher ?? 'Publisher', kind, line: LINE_TEXT[kind] };
      });
      const unitStatuses = units.rows.map((u) => u.status);
      let message = orderMessage(o.status, unitStatuses, poStates);
      if (pack) {
        const held = message.includes('on hold');
        const banner = packBanner(
          items.flatMap((i) => (i.kind === undefined ? [] : [{ title: i.title, kind: i.kind }])),
        );
        // A hold from the order status or a unit stays a hold even if no item line says so.
        if (banner !== null && (!held || banner.includes('on hold'))) message = banner;
      }
      // Newest first; the buyer sees the latest case for this order, whatever its state.
      const open = (await listCasesForBuyer(db, { buyer_id: buyer })).find(
        (c) => c.order_id === o.id,
      );
      return {
        order_id: o.id,
        order_ref: o.order_ref,
        status: o.status,
        open_case:
          open === undefined
            ? null
            : { case_id: open.case_id, state: open.state, buyer_message: open.buyer_message },
        buyer_message: message,
        items,
        environment: o.environment,
        refund_line: orderRefundLine({
          total_minor: units.rows.reduce((n, u) => n + Number(u.amount_minor), 0),
          refunded_minor: units.rows.reduce((n, u) => n + Number(u.refunded_minor), 0),
          currency: o.currency,
        }),
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

    async buyerReceipt({ order_id, actor }) {
      const b = buyerOf(actor);
      if (b === null) return null;
      const r = await getReceiptForBuyer(db, { order_id, buyer_id: b });
      if (r === null) return null;
      const facts = new Map<string, ArticleFacts>();
      for (const l of r.lines) {
        const row = (
          await db.query<{ title: string; publisher: string }>(
            `SELECT a.title, p.display_name AS publisher FROM articles a
               JOIN publishers p ON p.id = a.publisher_id WHERE a.id = $1`,
            [l.article_id],
          )
        ).rows[0];
        if (row !== undefined) facts.set(l.article_id, row);
      }
      return toBuyerReceipt(r, facts);
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
      const safety = await readSafetyStatus(db, clock.now(), config.outbound_approval_ref);
      const outboundSwitch = safety.switches.find((x) => x.name === 'paypal_outbound');
      const jobs = await jobsHealth(core);
      logSelfcheckOnce();
      return {
        environment,
        switches: sw,
        gate: {
          mode: config.mode,
          connect: config.connect,
          approval_ref_set: config.outbound_approval_ref !== null,
          transport:
            outbound === null
              ? 'dry-run fixtures'
              : 'sandbox, approved transport behind five locks',
          outbound: outbound === null ? null : await outbound.status(),
          selfcheck: outbound?.selfcheck() ?? null,
        },
        orders: orders.rows.map((o) => ({
          order_ref: o.order_ref,
          status: o.status,
          total_minor: Number(o.total_minor),
          currency: o.currency,
        })),
        operations: ops.rows.map((o) => ({ state: o.state, count: Number(o.c) })),
        alerts: alerts.rows.map((a) => ({ kind: a.kind, created_at: iso(a.created_at) })),
        invariants: (await checkInvariants(db)).map((v) => ({
          id: v.id,
          ok: v.ok,
          detail: v.detail,
        })),
        kill_switch: {
          outbound_on: outboundSwitch?.on === true,
          changed_by: outboundSwitch?.changed_by ?? 'unknown',
          changed_at: outboundSwitch?.changed_at ?? '',
          reason: outboundSwitch?.reason ?? 'no switch row (counts as off)',
          budget:
            safety.budget === null
              ? null
              : {
                  remaining_today: safety.budget.remaining_today,
                  max_calls_per_day: safety.budget.max_calls_per_day,
                  valid_until: safety.budget.valid_until,
                },
        },
        jobs: { last_pass_at: jobs.last_pass_at, due: jobs.due },
        shared_payee: await sharedPayee(db),
        // P9: only a session with the second factor is shown the refund form.
        refunds:
          actor.mfa === true ? await loadRefundOverview(db, sw['refunds_enabled'] === true) : null,
      };
    },

    async stopOutbound({ actor, reason }) {
      // The web button is an operator session with CSRF behind the route, not a terminal: the
      // terminal rule of the CLI does not apply to a stop (it only makes the system safer).
      const r = await runStop({
        db,
        clock,
        audit,
        tty: { isTTY: true, env: {} },
        by: actor,
        reason,
      });
      if (r.ok) return ok(undefined);
      return err(r.error === 'operator_required' ? 'operator_required' : 'reason_required');
    },

    webhook: (i) =>
      receiveWebhook(
        {
          clock,
          log,
          // The switch is read BEFORE verification, so a switched-off webhook fetches no certificate.
          allowed: async () =>
            webhookAllowed({
              switch_on: await switches.isOn('webhook_enabled'),
              mode: config.mode,
              webhook_id: config.paypal?.webhook_id ?? null,
              // the FULL pin (exact host, subject and issuer), not a subject alone (CO-1d)
              pin_set: pinComplete(EXPECTED_CERT_PINS),
              injected_source: opts.webhook_certificates !== undefined,
            }),
          verify: (w) => paypal.verifyWebhook(w),
          intake: (x) => handleWebhook(core, x),
          ...(learnRecorder === null
            ? {}
            : {
                learn: {
                  open: () =>
                    webhookLearnWindow(config.webhook_cert_learn_until, clock.now()) === 'open',
                  record: learnRecorder,
                },
              }),
        },
        i,
      ),

    refund: refundFacade,

    newKey: () => ids.nonce(),

    // Lane 10: turn new alerts and delivery failures into cases; close restored ones.
    sweep: () => sweepAll({ max_items: 100 }),

    resolveCase: (i) =>
      resolveRecoveryCase(recoveryDeps, {
        case_id: i.case_id,
        action: i.action,
        by: i.actor,
        reason: i.reason,
      }),

    async health() {
      // CO-7b: the health check stays green so the host does not restart-loop, and says why.
      if (maintenance)
        return { ok: true, environment, db: false, maintenance: true, last_pass_at: null, due: 0 };
      const h = await jobsHealth(core);
      return {
        ok: h.db,
        environment,
        db: h.db,
        maintenance: false,
        last_pass_at: h.last_pass_at,
        due: h.due,
      };
    },
  };

  return {
    config,
    environment,
    maintenance,
    ready: async () => {
      if (maintenance) return;
      await open();
    },
    db,
    engine,
    security,
    outbound,
    startJobs: async () => {
      // CO-7b: no recovery pass, no loop, no database. Nothing to stop.
      if (maintenance) return { stop: async () => undefined };
      if (loop !== null) return loop;
      const drv = await open();
      logSelfcheckOnce();
      // PG-2 (D-049): on Postgres the loop runs only while this process holds the leader lock, so a
      // second process (a rollout overlap, a stray local run) never works beside the first. The test
      // seam can turn the lock off to show what it prevents.
      const lockOf = opts.test_loop?.leader === 'off' ? undefined : drv.tryAdvisoryLock?.bind(drv);
      const led = lockOf !== undefined;
      // Without the lock (PGlite is one process by its single-opener lock): recovery first, and
      // awaited: a boot that returns has already read what was in flight. It runs once per process:
      // the loop is told not to recover again. With the lock, recovery belongs to the leader: the
      // loop runs it at the start of each leadership term, so a process that is not the leader never
      // takes over operations of the live one.
      if (!led) await recoverOnStartup(paymentsDeps);
      // One loop per approval (ASM-67): `loop` above is the only one this app starts.
      let running: { stop(): Promise<void> };
      try {
        running = startLoop(
          { ...loopDeps, sweepWindows: sweepAll },
          {
            max_sleep_ms: config.node_env === 'test' ? 200 : 5_000,
            max_items: 100,
            recover_on_start: led,
            ...(led
              ? {
                  leader: { tryAcquire: () => lockOf(LEADER_LOCK_KEY) },
                  ...(opts.test_loop?.leader_retry_ms === undefined
                    ? {}
                    : { leader_retry_ms: opts.test_loop.leader_retry_ms }),
                }
              : {}),
            // Sandbox: the loop spends the approval's own call budget, and never reads null (a
            // missing approval is a reading of 0 remaining). Dry run counts nothing.
            ...(config.mode === 'sandbox' ? { callBudget } : {}),
          },
        );
      } catch (e) {
        // A bad cadence must not take the whole app down, /ops included: the app starts with the
        // loop off and says so loudly.
        log.log({
          msg: 'jobs.loop.not_started',
          level: 'error',
          fields: { error: e instanceof Error ? e.message : 'unknown' },
        });
        running = { stop: async () => undefined };
      }
      loop = {
        stop: async () => {
          loop = null;
          await running.stop();
        },
      };
      return loop;
    },
    close: async () => {
      await loop?.stop();
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
  get maintenance() {
    return getApp().maintenance;
  },
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
  get trusted_proxies() {
    return getApp().security.trusted_proxies ?? 0;
  },
};

/**
 * CO-7b: is the app in maintenance mode? Read by the page middleware. The middleware may be the first
 * caller and then builds the app (in sandbox mode that includes the outbound object; no socket is
 * opened); normally instrumentation has built it already. It opens no database in either case.
 */
export function maintenanceActive(): boolean {
  return getApp().maintenance;
}

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
