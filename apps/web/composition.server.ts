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
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  Actor,
  AgentDeps,
  AuditSink,
  Brief,
  CaseView,
  Clock,
  EventOutbox,
  ContentStore,
  CoreDeps,
  Database,
  TraceContext,
  DomainConfig,
  EnvironmentLabel,
  Id,
  Ids,
  Logger,
  ModelPort,
  ModelSpendStore,
  ModelWire,
  OutboundRequest,
  PayPalPort,
  PaymentsDeps,
  Receipt,
  Rights,
  Result,
  RuleSettingRow,
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
// API-A (A0): the catalogue text search, re-exported for the v1 handlers (they reach domain code only here).
export { searchOffers } from '@umsbx/catalogue';
import type { Config } from '@umsbx/config';
import { migrate, openDatabase, withTraceDb } from '@umsbx/db';
import type { SqlDriver } from '@umsbx/db';
import { cryptoIds, cryptoSecretSource, systemClock } from '@umsbx/runtime';
import {
  bindTraceMandate,
  createAuditSink,
  createLogger,
  currentTraceContext,
  redact,
} from '@umsbx/obs';
import {
  createOutboundGate,
  createSwitchReader,
  findActiveApproval,
  readSafetyStatus,
  resumeOutbound,
  runStop,
  setSwitch,
} from '@umsbx/safety';
import type { ResumeCoreError } from '@umsbx/safety';
import { createEcbFetch, createFeedFetcher, createModelHttps, guard } from '@umsbx/transport';
import type { Wire } from '@umsbx/transport';
import {
  EXPECTED_CERT_PINS,
  createCertificateSource,
  createPayPalAdapter,
  learnWebhookCertificate,
  pinComplete,
} from '@umsbx/paypal';
import type { AdapterDeps } from '@umsbx/paypal';
import {
  CLAUDE_MODEL_ID,
  createClaudeModel,
  createScriptedModel,
  parseClaudeEvalResult,
  runEvalCases,
  tally,
  BRIEF_CASES,
  LISTING_CASES,
} from '@umsbx/model';
import type { CaseResult } from '@umsbx/model';
import {
  SEED_DATA,
  SEED_SUPPLEMENT_COMPOSITE,
  SEED_SUPPLEMENT_DE,
  NEW_OFFER_TERMS,
  applyDemoPrices,
  createOffer,
  decidePayeeRequest,
  getOffer,
  getOwnOffer,
  listOfferableArticles,
  listOpenRequests,
  listOwnOffers,
  offerCurrencyFor,
  payeeView,
  requestPayeeChange,
  reviseOffer,
  seedCatalogue,
  seedSupplement,
  setPublisherStatus,
  touchVisit,
  withdrawOffer,
  addApplicant,
  applicationReference,
  applicationStatus,
  checkApplicationInput,
  decideApplicant,
  listApplicants,
  submitApplication,
  listAgreements,
  ownAgreement,
  seedAgreements,
  // POB-I1: the web import.
  ZERO_FEE_POLICY,
  checkDomain as importCheckDomain,
  editItem as importEditItem,
  getBatch as importGetBatch,
  listBatches as importListBatches,
  listDomains as importListDomains,
  publishBatch as importPublishBatch,
  recoverImports,
  requestDomain as importRequestDomain,
  runNextBatch as importRunNext,
  startVerifiedImport,
} from '@umsbx/catalogue';
import type {
  BatchView as ImportBatchView,
  DomainView as ImportDomainView,
  ImportDeps,
  ImportError,
  ImportFeePolicy,
  ImportFetcherPort,
  ItemView as ImportItemView,
  PublishSummary as ImportPublishSummary,
  Agreement,
  Applicant,
  ApplicantError,
  ApplicationState,
  OfferWriteError,
  OfferableArticle,
  OpenRequest,
  OwnOffer,
  OwnOfferDetail,
  PayeeError,
  PayeeView,
  PriceInput,
  StatusError,
} from '@umsbx/catalogue';
import { startFromOffer } from '@umsbx/offer-entry';
import { discover as discoverOffers, parseNeed } from '@umsbx/discovery';
import {
  convert as fxConvert,
  getRates as fxGetRates,
  refreshIfStale as fxRefreshIfStale,
} from '@umsbx/fx';
import type { ConvertResult, FetchedRates, FxCurrency, FxRates, RefreshResult } from '@umsbx/fx';
import { requestApproval } from '@umsbx/approval';
import { activeRows, addRuleSetting, listRuleHistory } from '@umsbx/rules';
import type {
  RuleHistoryFilter,
  RuleSettingInput,
  RuleStoreError,
  RulesContext,
} from '@umsbx/rules';
import {
  attachOrder as attachMandateOrder,
  checkBudget as checkMandateBudget,
  createMandate,
  getMandate,
  release as releaseMandate,
  reserve as reserveMandate,
  revokeMandate,
} from '@umsbx/mandates';
import type {
  BudgetResult,
  CreateError,
  CreateMandateInput,
  MandateDeps,
  MandateView,
} from '@umsbx/mandates';
import type { Selection } from '@umsbx/approval';
import { createPgContentStore, issueLink, planServe } from '@umsbx/delivery';
import type { ServePlan } from '@umsbx/delivery';
import { MAX_READER_BYTES, isReadableMime, splitParagraphs } from './src/lib/reader-view';
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
  cancelOrder as cancelPaymentsOrder,
  checkInvariants,
  onBuyerReturn as onPaymentsReturn,
  placeOrder as placePaymentsOrder,
  handleWebhook,
  recoverOnStartup,
  cancelRefundRequest,
  executeRefund,
  requestRefund,
  SELLER_ACCEPTANCE_REASON,
  pendingReasonKind,
  pendingReasonLabel,
} from '@umsbx/payments';
import type { OrderHold } from '@umsbx/payments';
import {
  health as jobsHealth,
  LEADER_LOCK_KEY,
  runDeliveryPass,
  startLoop,
  type DeliverCounts,
} from '@umsbx/jobs';
import type { CallBudget } from '@umsbx/jobs';
import { getLibrary } from '@umsbx/library';
import {
  countsSince,
  opsTotalsFor,
  payeeSettlement,
  publisherExposure,
  refundsFor,
  salesExport,
  salesFor,
  statementExport,
  statementFor,
} from '@umsbx/publisher-console';
import type {
  OpsTotalsRow,
  PublisherExposure,
  PublisherStatement,
  RefundRow,
  SaleRow,
  Settlement,
  SinceCounts,
} from '@umsbx/publisher-console';

// PUB-C: the money words of the publisher pages live with the code that decides them; the golden test
// of the page copy pins them through this re-export.
export {
  COMMISSION_LINE,
  NOTHING_SOLD_SENTENCE,
  PAYEE_DIRECT_SENTENCE,
  SETTLEMENT_SENTENCE,
  UNIT_STATUS_TEXT,
  salesTotals,
  settlementMode,
} from '@umsbx/publisher-console';
export type { SalesTotal } from '@umsbx/publisher-console';

// INT-SR1 (Z1): the route handlers of the search lanes reach the search and library-filter code through here.
// The views-seed names are test data for the SR1 suites; nothing in the product reads them.
export {
  TxnSearchError,
  VIEWS_EXPECTED,
  VIEWS_MEMBERS,
  buyerLine,
  checkScope,
  exportName,
  exportTransactions,
  isPlainQuery,
  isViewId,
  listTransactions,
  opsLine,
  principalKey,
  queryHash,
  quickFind,
  scopeQuery,
  seedViewsWorld,
  sellerLine,
  txnCsv,
} from '@umsbx/txn-search';
export type { FindResult } from '@umsbx/txn-search';
// INT-OPS-B: the in-process journal verifier of TR0, for the Invariants tile (read only).
export { formatTraceFinding, verifyTrace } from '@umsbx/db';
export { filterLibrary, isPlainLibraryQuery, parseLibraryQuery } from '@umsbx/library';
export type { LibraryFacts, LibraryQuery } from '@umsbx/library';
import {
  DEFAULT_RATES,
  SESSION_COOKIE,
  createSession,
  operatorSignIn,
  resolveSession,
  revokeSession,
  clearSessionCookie,
  changePassword as changeAccountPassword,
  checkNewAccount,
  createAccount,
  revokeBuyerSessions,
  takeToken,
  verifyAccountLogin,
  verifyPasscode,
} from '@umsbx/security';
import type { ApiKeyDeps } from '@umsbx/security';
import {
  activityPage,
  buyerTimeline,
  evidenceHtml,
  evidencePack,
  opsTimeline,
  sellerTimeline,
  verifyJournal,
} from '@umsbx/trace';
import type { AgentFacade, BuyerFacade, OpsFacade, SellerFacade } from './src/api-v1/facades';
import {
  createAgentFacade,
  createBuyerFacade,
  createOpsFacade,
  createSellerFacade,
} from './src/api-v1/facades';
import { createEventOutbox } from './src/api-v1/outbox';
import {
  createEventsService,
  createInProcessSink,
  type EventsService,
  type InProcessSink,
} from './src/api-v1/events';
import { signatureHeader } from './src/api-v1/signature';
import type { PasswordRefusal, SecurityDeps } from '@umsbx/security';
import { ACCOUNT_CONSENT_VERSION } from './src/lib/account-copy';
import { DRYRUN_SCENARIOS, createDryRunModel, isScenarioId } from './src/server/dryrun-model';
import { buildOutbound } from './src/server/outbound.server';
import { createLearnRecorder, receiveWebhook, webhookAllowed } from './src/server/webhook';
import type { WebhookInput, WebhookResponse } from './src/server/webhook';
import type { Outbound } from './src/server/outbound.server';
import type { OpsGate } from './src/lib/gate-lines';
import { AGREEMENT_SEED_LABEL } from './src/lib/agreement-copy';
import { PUBLISHER_TERMS_VERSION } from './src/lib/legal-copy';
import { PUBLISHER_PERSONAS } from './src/lib/publisher-copy';
import { toBuyerReceipt } from './src/lib/receipt-view';
import type { ArticleFacts, BuyerReceipt } from './src/lib/receipt-view';
import { LINE_TEXT, lineKind, packBanner, windowMinutes } from './src/lib/composite-copy';
import { NOT_PAID_YET } from './src/lib/buyer-copy';
import { pendingBuyerText, pendingItemLine } from './src/lib/pending-copy';
import type { PendingKind, PendingUnitRow } from './src/lib/pending-copy';
import { offerOnSale } from './src/lib/offer-flow-view';
import { publisherSlugOf } from './src/lib/publisher-copy';
import type { PublisherStatus } from './src/lib/publisher-copy';
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
   * PUB-B: `demo_prices: true` runs the demo price step (decision 37) at boot. Outside NODE_ENV=test the
   * step always runs; in tests it is off unless asked for, so the seed prices (40, 90, 300, 450) hold.
   */
  test_seed?: {
    supplement?: boolean;
    payees?: boolean;
    demo_prices?: boolean;
    agreements?: boolean;
    /**
     * MC2-L2: the German corridor block (de-eur, off, and one fictional German publisher). Outside
     * NODE_ENV=test it always runs; in tests it is off unless `de_corridor: true`, so older counts hold.
     */
    de_corridor?: boolean;
  };
  /**
   * AI-A (tests): a ModelWire standing in for the Claude egress. Used only when UMS_AI_ADAPTER=claude and a
   * key is set; no socket is opened and no real key is needed. Refused unless NODE_ENV=test.
   */
  test_model_wire?: ModelWire;
  /**
   * MC2-L4 (tests): the exchange-rate fetch, standing in for the ECB egress. No socket is opened. Refused
   * unless NODE_ENV=test.
   */
  test_fx_fetch?: () => Promise<FetchedRates>;
  /**
   * AI-B (tests): the path of the stored Claude evaluation result, instead of the committed
   * packages/model/test-data/claude-eval-result.json. Refused unless NODE_ENV is test.
   */
  test_claude_eval_file?: string;
  /**
   * POB-I1 (tests): the fetcher of the web import, standing in for the guarded transport fetcher. No socket is
   * opened. Refused unless NODE_ENV=test; in tests without it the import is off.
   */
  test_import_fetcher?: ImportFetcherPort;
  /**
   * POB-I1: the fee shown at review on top of the publisher's price (the ImportFeePolicy port of the web
   * import). Default: no fee. The coordinator wires the real policy after the fee lane merges.
   */
  import_fee?: ImportFeePolicy;
}

// ---------------------------------------------------------------------------------------------
// Personas (demo sign-in, A11Y-6: a passcode, no cognitive test).
// ---------------------------------------------------------------------------------------------
/** The one publisher of MVP-B (ASM-03): its payee is the owner's own sandbox account (BU-7). */
const MVPB_PUBLISHER_SLUG = 'harbour-ledger';

// PUB-A1: one sign-in persona per publisher; the slug each maps to is in lib/publisher-copy.ts.
export const PERSONAS = [
  'buyer-a',
  'buyer-b',
  'publisher-harbour-ledger',
  'publisher-quayside-gazette',
  'publisher-northfield-quarterly',
  'operator',
] as const;
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
  | { code: 'checkout_off'; http: 503 }
  // API-B: an agent purchase its mandate did not take; `reason` is the mandate's own code.
  | { code: 'mandate_refused'; reason: string; http: 409 };
export type CheckoutError = {
  code: 'not_found' | 'wrong_state' | 'create_failed' | 'payments_paused';
};
export type CancelError = {
  code: 'not_found' | 'wrong_state' | 'payment_started' | 'unavailable';
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
    /** API-B: an agent purchase. The order books this mandate in its own transaction or is not placed. */
    mandate?: { mandate_id: Id; agent_key_id: Id };
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
  /** ORDER-A: the buyer cancels an unpaid order (the abandon transition, with stricter guards). */
  cancelOrder(i: {
    order_id: Id;
    actor: Actor;
  }): Promise<Result<{ order_ref: Id; status: 'abandoned'; already: boolean }, CancelError>>;
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
  /** PUB-E5: read only article facts for the buyer: the stored language code and size in bytes. No hash. */
  language: string;
  bytes: number;
  currency: string;
  options: { option: 'keep_retrieve' | 'online_read'; price_minor: number }[];
  renegotiation_allowed: boolean;
  floor_minor: number | null;
  rights: Rights;
  /** GATEFIX2 item 7: from stored data, the tests startFromOffer applies. False shows "Not on sale" and no prices. */
  on_sale: boolean;
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
  /** GATEFIX2 item 3: the order's reference, for a link to the order page; null when there is no order. */
  order_ref: string | null;
  /** Receipt versions of the order, oldest first (lane 10). */
  receipt_versions: number[];
  /** The case still being worked on for this item, if any (lane 10). */
  open_case: CaseView | null;
  environment: EnvironmentLabel;
}
/**
 * AI-B: what /ops/evals shows. Counts come from the committed injection cases, the baseline from running
 * the scripted model over them, `claude` from a stored result file or `not_run`. Rows hold an id, a kind
 * and a verdict of fixed codes; no model free text is ever copied in.
 */
export interface EvalsSummary {
  environment: EnvironmentLabel;
  listing_cases: number;
  brief_cases: number;
  baseline: { passed: number; total: number };
  cases: CaseResult[];
  claude:
    | { state: 'not_run' }
    | { state: 'recorded'; recorded_on: string; passed: number; total: number };
  /** The model discovery uses: `claude` only when the adapter is built (UMS_AI_ADAPTER=claude and a key). */
  model_in_use: 'scripted' | 'claude';
}

export interface ReaderMeta {
  title: string;
  publisher: string;
  option: string;
  environment: EnvironmentLabel;
  window: { state: string; ends_at: string | null; days_left: number | null };
}
export type ReaderViewResult =
  | ({ ok: true; kind: 'text'; paragraphs: string[] } & ReaderMeta)
  | ({ ok: true; kind: 'download' } & ReaderMeta)
  | {
      ok: false;
      code:
        | 'not_found'
        | 'window_ended'
        | 'not_available'
        | 'expired'
        | 'store_unavailable'
        | 'refunded'
        | 'rate_limited';
    };
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
    /** The scope of the active approval row for the configured reference, or null when there is none (the Start hint). */
    active_scope: string | null;
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
  /**
   * MC2-L7 (D-084 item 5): booked sales, refunds and exposure per stored environment and currency, summed
   * over all publishers. Read only, never converted here; the page converts through `engine.fx`.
   */
  totals: OpsTotalsRow[];
}

const SWITCHES: SwitchName[] = [
  'paypal_outbound',
  'checkout_enabled',
  'refunds_enabled',
  'unlock_enabled',
  'ai_enabled',
  'webhook_enabled',
  'agent_buy_enabled',
];

const DAY_MS = 86_400_000;
const iso = (v: unknown): string => new Date(v as string | number | Date).toISOString();

/** MC2-L6 (D-083): the operator's count of units PayPal holds for a seller to accept. */
export interface AwaitingExposure {
  publisher_id: Id;
  currency: string;
  environment: EnvironmentLabel;
  count: number;
  minor: number;
}

export function orderMessage(
  status: string,
  unit_statuses: string[],
  po_states: readonly string[] = [],
  pending_kinds: readonly PendingKind[] = [],
): string {
  // A hold always wins (H1): a frozen PayPal order holds the order whether or not a capture was sent.
  if (unit_statuses.includes('mismatch') || status === 'frozen' || po_states.includes('frozen'))
    return 'Your order is on hold while we check it. You have not been charged twice. We opened a case and will write to you.';
  // MC2-L6 (D-083): a capture PayPal holds for the seller to accept is worded as that; any other pending
  // reason keeps the generic words. The kind is a closed value; the stored reason is never shown.
  if (unit_statuses.includes('pending'))
    return pendingBuyerText(
      pending_kinds.includes('awaiting_seller_acceptance')
        ? 'awaiting_seller_acceptance'
        : 'payment_pending',
    );
  switch (status) {
    case 'paid':
    case 'paid_partial':
      // D-051: the noun agrees with the number of items (a pack from one publisher is one PayPal order).
      return unit_statuses.length > 1
        ? 'Paid. Your items are in your library.'
        : 'Paid. Your item is in your library.';
    case 'capture_requested':
    case 'capture_claimed':
    case 'unresolved':
      return 'Confirming payment';
    case 'failed':
      return 'Not charged. The order did not complete.';
    case 'abandoned':
      return 'Not completed. Nothing was charged.';
    case 'awaiting_buyer':
      // FIX-FLOW D4: with no PayPal order approved, nothing was received. Say so, in words that do not
      // suggest a payment is being confirmed. An approved one (a pack between its two approvals) keeps
      // the waiting line.
      return po_states.includes('approved') ? 'Waiting for your approval at PayPal' : NOT_PAID_YET;
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
  /** INT-TR1: the journal reads. */
  readonly trace: TraceReads;
  readonly security: SecurityDeps;
  /** The sandbox outbound (the five locks); null in offline mode. */
  readonly outbound: Outbound | null;
  /**
   * AI-A: the id of the model discovery uses: `scripted-v1` by default, `claude-haiku-5-5` only when
   * UMS_AI_ADAPTER=claude, a key is set and the app is not in maintenance.
   */
  readonly model_id: string;
  /** API-C: where MVP 1 webhook deliveries go. It records each request and opens no socket. */
  readonly webhook_sink: InProcessSink;
  /** API-C: one webhook delivery pass (the job loop calls it each pass; tests call it directly). */
  deliverWebhooks(o: { max_items: number }): Promise<DeliverCounts>;
  close(): Promise<void>;
}

/** INT-TR1: the journal reads (timelines, activity, evidence, verify), bound to the app database. Read only. */
export function traceReads(db: SqlExecutor) {
  return {
    buyerTimeline: (o: Parameters<typeof buyerTimeline>[1]) => buyerTimeline(db, o),
    sellerTimeline: (o: Parameters<typeof sellerTimeline>[1]) => sellerTimeline(db, o),
    opsTimeline: (o: Parameters<typeof opsTimeline>[1]) => opsTimeline(db, o),
    activityPage: (o: Parameters<typeof activityPage>[1]) => activityPage(db, o),
    evidencePack: (o: Parameters<typeof evidencePack>[1]) => evidencePack(db, o),
    evidenceHtml,
    verifyJournal: () => verifyJournal(db),
  };
}
export type TraceReads = ReturnType<typeof traceReads>;

/** What a publisher sees on /publisher (PUB-A1). The payee is the last 4 characters and the verification time. */
export interface PublisherHome {
  display_name: string;
  status: PublisherStatus;
  offers_live: number;
  payee: { last4: string | null; verified_at: string | null };
  /** SETTLE-A: the one settlement sentence for the account as it is now, from stored facts. */
  settlement: Settlement;
}

/** ID-ACCOUNTS: what the account page shows about a buyer who signed up with a username and password. */
export interface AccountView {
  username: string;
  display_name: string;
  country: string;
}

/** ID-ACCOUNTS: the answer to a signup. A honeypot gets `ok` with no cookie, like a success, and stores nothing. */
export type SignUpResult =
  | { ok: true; csrf_token: string; cookie: string | null }
  | {
      ok: false;
      code: 'invalid_input' | 'busy' | 'rate_limited' | 'taken' | 'weak_password';
      reason?: PasswordRefusal;
    };

export interface Engine {
  personas(): readonly Persona[];
  /**
   * MC2-L4 (D-084 items 4, 5 and 8, D-085): exchange rates. The engine only; no screen shows them yet.
   * Every figure is approximate and carries the ECB rate date. `refreshIfStale` fetches at most once per
   * 6 hours, never throws, and keeps the stored rate on any failure. In offline mode and in tests the
   * fetch is a fake that never touches the network.
   */
  fx: {
    /** The latest stored EUR to USD and EUR to GBP rates with their ECB date and age; null if none. */
    getRates(): Promise<FxRates | null>;
    refreshIfStale(): Promise<RefreshResult>;
    /** Pure. `at` defaults to now. Null when there is no usable rate (none, or over 7 days old). */
    convert(i: {
      minor: number;
      from: FxCurrency;
      to: FxCurrency;
      rates: FxRates | null;
      at?: Date;
    }): ConvertResult | null;
  };
  /**
   * MC2-L5 (D-084 item 4): the buyer's display currency. `get` is the buyer's country and the currency chosen
   * in the account (null until chosen); the screens derive the rest. `set` stores a choice, or null for
   * "automatic". A display preference only: no order, approval, quote or ledger entry reads it.
   */
  displayCurrency: {
    get(actor: Actor): Promise<{ country: string; chosen: string | null } | null>;
    set(i: { actor: Actor; currency: 'USD' | 'EUR' | 'GBP' | null }): Promise<boolean>;
  };
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
   * ID-ACCOUNTS: buyer accounts (a username and a password, no email). Every sign in and every signup makes
   * a new session and ends `previous`, the session of the browser's own cookie, if there is one.
   */
  accounts: {
    /**
     * Signup. An unknown client address answers busy and spends nothing; 5 a hour per hashed address; a
     * filled honeypot answers ok and stores nothing; a taken name answers `taken`.
     */
    signUp(i: {
      display_name: string;
      username: string;
      country: string;
      password: string;
      trap: string;
      ip_hash: string;
      ip_known: boolean;
      previous: { id: Id; actor: Actor } | null;
    }): Promise<SignUpResult>;
    /** Null for an unknown name, a wrong password and a locked account alike. */
    signIn(i: {
      username: string;
      password: string;
      previous: { id: Id; actor: Actor } | null;
    }): Promise<{ actor: Actor; cookie: string; csrf_token: string } | null>;
    changePassword(i: {
      actor: Actor;
      session_id: Id | null;
      current_password: string;
      new_password: string;
    }): Promise<
      | { ok: true }
      | { ok: false; code: 'no_account' | 'wrong_password' }
      | { ok: false; code: 'weak_password'; reason: PasswordRefusal }
    >;
    /** Ends every session of the signed in account buyer (this one too). Null for a buyer with no account. */
    signOutEverywhere(i: { actor: Actor }): Promise<{ cookie: string } | null>;
    view(actor: Actor): Promise<AccountView | null>;
  };
  /**
   * FIX-FLOW D1: sign out. Ends the one live session `session_id` of `actor` (never the actor's other
   * sessions) and returns the Set-Cookie value that clears the cookie. With no session it only clears.
   */
  signOut(i: { actor: Actor; session_id: Id | null }): Promise<{ cookie: string }>;
  /**
   * PUB-A1: the read only home of the publisher behind this session: name, status, live offers and the
   * payee state (last 4 only). Every query filters by `actor.publisher_id`. Null for any other actor kind
   * and for a publisher id that names no row.
   */
  publisherHome(actor: Actor): Promise<PublisherHome | null>;
  /**
   * AGREE-1: the seeded, read only record that the publisher behind this session accepted the publisher
   * terms (method seeded_demo). Own record only; null for any other actor kind and for no record. Nothing
   * in the engine writes it: only the boot seed does.
   */
  publisherAgreement(actor: Actor): Promise<Agreement | null>;
  /**
   * PUB-C (S4): the units the publisher behind this session sold, newest first, from stored rows. No buyer
   * identity. Every query filters by `actor.publisher_id`; no id comes from the caller. Null for any other
   * actor kind.
   */
  publisherSales(actor: Actor): Promise<SaleRow[] | null>;
  /**
   * MC2-L6 (D-083): the units of the publisher behind this session that PayPal holds pending, newest
   * first, each with one of the closed labels (never the stored reason). Read only; every query filters
   * by `actor.publisher_id`. No buyer identity. Null for any other actor kind.
   */
  publisherPending(actor: Actor): Promise<PendingUnitRow[] | null>;
  /**
   * PUB-C (S5): the statement of the publisher behind this session, one block per currency and stored
   * environment, summed from its ledger rows with the ledger package. Null for any other actor kind.
   */
  publisherStatement(actor: Actor): Promise<PublisherStatement | null>;
  /**
   * PUB-E1: the refunds of the publisher behind this session: refunded, partly refunded, held and reversed
   * units, with the sums of the stored refund and reversal ledger rows. Null for any other actor kind.
   */
  publisherRefunds(actor: Actor): Promise<RefundRow[] | null>;
  /**
   * PUB-E1: "Since your last visit". Records this visit in the publisher's own cursor row (migration 0014)
   * and counts the rows written since the last visit. The first visit has no counts. Null for any other
   * actor kind.
   */
  publisherSince(actor: Actor): Promise<{
    first_visit: boolean;
    since: string | null;
    counts: SinceCounts | null;
  } | null>;
  /**
   * PUB-E1: the statement or the sales of the publisher behind this session as CSV text with its file name.
   * Built from the same read models as the pages. Null for any other actor kind.
   */
  publisherExport(i: {
    actor: Actor;
    kind: 'statement' | 'sales';
  }): Promise<{ filename: string; csv: string; truncated: boolean } | null>;
  /**
   * The id of the live session behind a cookie header, for the actor that session belongs to.
   * Links are bound to it (delivery lane): a link issued in one session is not found in another.
   */
  sessionIdOf(cookie: string | null, actor: Actor): Promise<Id | null>;
  offerPage(i: { publisher: string; offer: string }): Promise<OfferPage | null>;
  /**
   * GATEFIX2 item 3: the reference of the buyer's open unpaid order for the article this offer sells, or null.
   * Only a buyer's own order is ever returned.
   */
  unpaidOrderRef(i: { publisher: string; offer: string; actor: Actor }): Promise<string | null>;
  listOffers(): Promise<OfferPage[]>;
  quote: typeof startFromOffer extends (d: never, i: infer I) => infer R ? (i: I) => R : never;
  aiEnabled(): Promise<boolean>;
  /** API-B: the agent_buy_enabled switch, read now. Off until an operator with the second factor turns it on. */
  agentBuyEnabled(): Promise<boolean>;
  /**
   * API-B: the operator's agent_buy_enabled switch. Turning it on needs the second factor; turning it off
   * needs only an operator (a stop can never be blocked by a missing code). A reason is always needed.
   */
  setAgentBuy(i: {
    actor: Actor;
    on: boolean;
    reason: string;
  }): Promise<Result<void, 'operator_required' | 'mfa_required' | 'reason_required'>>;
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
    /** API-B: the mandate an agent buys under; frozen into the snapshot. */
    mandate_id?: Id;
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
  /**
   * READER-A: the article read inside the app. It issues a link and serves it with mode `read` through the
   * same issueLink and planServe as the content route, reads the stream to the end here, and so writes the
   * same evidence (link_issued, then reader_rendered with the byte count and hash). Only text/plain and
   * text/markdown up to 200 KB come back as paragraphs; anything else is `kind: 'download'` and nothing is
   * served. Refusals use the content route's reason codes.
   */
  readerView(i: { entitlement_id: Id; actor: Actor; session_id?: Id }): Promise<ReaderViewResult>;
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
   * BR-2: the rule settings. `add` is for an operator with the second factor (the domain checks it again);
   * `history` is newest first, 200 rows by default and 5000 at most. No existing caller reads the rows:
   * BR-3 and BR-4 are the lanes that will use `rules.activeRows`.
   */
  opsRules: {
    add(
      i: Omit<RuleSettingInput, 'actor'> & { actor: Actor },
    ): Promise<Result<{ id: Id }, RuleStoreError>>;
    history(filter?: RuleHistoryFilter, limit?: number): Promise<RuleSettingRow[]>;
  };
  rules: {
    activeRows(ctx: RulesContext, at: string): Promise<RuleSettingRow[]>;
  };
  /** AI-B: the operator evals page. Null for anyone but an operator. Runs the scripted model only. */
  evalsSummary(actor: Actor): Promise<EvalsSummary | null>;
  /**
   * The ops stop button (BU-2): paypal_outbound off, with a reason, by an operator session. It can
   * only turn the switch off.
   */
  stopOutbound(i: {
    actor: Actor;
    reason: string;
  }): Promise<Result<void, 'operator_required' | 'reason_required'>>;
  /**
   * The ops start button (WEB-OPS-START): paypal_outbound on, by an operator session that signed in WITH
   * the authenticator code, only while an active approval row covers it. It runs the same check as
   * `pnpm safety:resume` (`resumeOutbound`). It cannot insert an approval and cannot set the connect flag
   * (UMS_PAYPAL_CONNECT is only read, to tell the page whether the flag is on).
   */
  startOutbound(i: { actor: Actor; reason: string; confirm_scope: string }): Promise<
    Result<
      {
        outbound_on: true;
        connect_flag: 'on' | 'off';
        calls_left: number;
        valid_until: string;
      },
      ResumeCoreError
    >
  >;
  /** The stored paypal_outbound switch, read now (no cache), or null when it cannot be read. For an operator only. */
  outboundSwitchOn(actor: Actor): Promise<boolean | null>;
  health(): Promise<{
    ok: boolean;
    environment: EnvironmentLabel;
    /** The Cloud Run revision name (K_REVISION), or null off Cloud Run. */
    revision: string | null;
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
  /**
   * POB-I1 (D-089, J7 to J9): the web import. A publisher proves a domain (`addDomain` gives the token once,
   * `checkDomain` looks for it on the two fixed paths), `begin` proves it again and queues a batch, a
   * background run (the job loop, or `runPending` in tests) reads the source into a staging list, `review`
   * lists it with the buyer price through the fee port, `edit` changes the title, the price and whether the
   * item is hidden in one step, and `publish` makes articles and offers of the chosen items. Every method
   * works for the signed-in publisher only. Nothing is fetched from a host that is not the verified domain.
   */
  webImport: {
    domains(actor: Actor): Promise<{ domains: ImportDomainView[] } | null>;
    addDomain(i: {
      actor: Actor;
      host: string;
    }): Promise<
      Result<{ host: string; state: 'pending' | 'verified'; token: string | null }, ImportError>
    >;
    checkDomain(i: {
      actor: Actor;
      host: string;
    }): Promise<Result<{ host: string; state: 'verified' }, ImportError>>;
    begin(i: {
      actor: Actor;
      source_url: string;
    }): Promise<Result<{ batch_id: string }, ImportError>>;
    batches(
      actor: Actor,
    ): Promise<{ batches: ImportBatchView[]; environment: EnvironmentLabel } | null>;
    review(i: { actor: Actor; batch_id: string }): Promise<{
      batch: ImportBatchView;
      items: ImportItemView[];
      environment: EnvironmentLabel;
      offer_max_minor: number;
    } | null>;
    edit(i: {
      actor: Actor;
      item_id: string;
      title?: string;
      price_minor?: number;
      hidden?: boolean;
    }): Promise<Result<{ item: ImportItemView }, ImportError>>;
    publish(i: {
      actor: Actor;
      batch_id: string;
      attestation: boolean;
      item_ids?: string[];
    }): Promise<Result<ImportPublishSummary, ImportError>>;
    /** Runs the queued batches now (tests; the job loop does the same in the background). */
    runPending(): Promise<{ ran: number }>;
  };
  /**
   * PUB-A2: where a publisher gets paid. `view` is the S6 page data (last 4 only, newest request first);
   * `request` stores a change request and changes nothing else; `openRequests` and `decide` are the
   * operator side and need the second factor. A verify is refused with `owner_command_required` when
   * the app runs in sandbox mode (D-062). The whole merchant id is never returned by any method.
   */
  payee: {
    view(
      actor: Actor,
    ): Promise<(PayeeView & { environment: EnvironmentLabel; settlement: Settlement }) | null>;
    request(i: {
      actor: Actor;
      merchant_id: string;
      note: string;
    }): Promise<Result<{ request_id: Id }, PayeeError>>;
    openRequests(
      actor: Actor,
    ): Promise<
      Result<
        { requests: (OpenRequest & { age_ms: number })[]; environment: EnvironmentLabel },
        PayeeError
      >
    >;
    decide(i: {
      actor: Actor;
      request_id: string;
      merchant_id_retyped: string;
      decision: 'verified' | 'rejected';
      reason: string;
    }): Promise<Result<{ decision: 'verified' | 'rejected' }, PayeeError>>;
  };
  /**
   * PUB-B: the signed-in publisher's own offers. `list` and `get` filter every query by the actor's
   * publisher id and answer null for any other actor; `get` answers null for another publisher's offer
   * and for an id that does not exist. `revise` and `withdraw` each write a new offer version with its own
   * authorisation row and audit row (never an in-place price update). The cap is UMS_OFFER_MAX_MINOR.
   */
  offers: {
    list(actor: Actor): Promise<{
      offers: OwnOffer[];
      environment: EnvironmentLabel;
      offer_max_minor: number;
    } | null>;
    get(
      actor: Actor,
      offer_id: string,
    ): Promise<
      (OwnOfferDetail & { environment: EnvironmentLabel; offer_max_minor: number }) | null
    >;
    /**
     * PUB-E1: the own articles that have no current offer, the cap and the terms a new offer carries. Null
     * for any other actor kind.
     */
    offerable(actor: Actor): Promise<{
      articles: OfferableArticle[];
      environment: EnvironmentLabel;
      offer_max_minor: number;
      terms_version: string;
      currency: string | null;
    } | null>;
    /** PUB-E1: version 1 of an offer for an own article that has none on sale. */
    create(i: {
      actor: Actor;
      article_id: string;
      options: PriceInput[];
      attestation: boolean;
    }): Promise<Result<{ offer_id: Id; version: string }, OfferWriteError>>;
    revise(i: {
      actor: Actor;
      offer_id: string;
      expected_version: string;
      options: PriceInput[];
      attestation: boolean;
    }): Promise<Result<{ offer_id: Id; version: string }, OfferWriteError>>;
    withdraw(i: {
      actor: Actor;
      offer_id: string;
      expected_version: string;
      reason: string;
    }): Promise<Result<{ offer_id: Id; version: string }, OfferWriteError>>;
  };
  /**
   * PUB-D: the operator's publishers page (S7). Both methods need an operator with the second factor.
   * `list` answers what each publisher holds or is owed (counts and sums of stored rows, the payee as the
   * last 4 only); `setStatus` suspends or reactivates one publisher with a reason and one audit row.
   * Suspending takes the publisher's offers off sale and ends its open quotes; paid orders are untouched.
   */
  opsPublishers: {
    list(actor: Actor): Promise<
      Result<
        {
          publishers: PublisherExposure[];
          environment: EnvironmentLabel;
          /** MC2-L6: units held for the seller to accept, per publisher, currency and stored environment. */
          awaiting: AwaitingExposure[];
        },
        StatusError
      >
    >;
    setStatus(i: {
      actor: Actor;
      publisher_id: Id;
      status: 'suspended' | 'active';
      reason: string;
    }): Promise<Result<{ status: 'suspended' | 'active' }, StatusError>>;
  };
  /**
   * PUB-E2, operator only (second factor required). `list` shows applicants waiting or turned down; `add`
   * records an applicant (status applied, no payee, no offers, no sign in); `decide` approves it (active)
   * or rejects it (stays applied, a decision row). This is not signup and it adds no persona.
   */
  opsApplicants: {
    list(actor: Actor): Promise<Result<{ applicants: Applicant[] }, ApplicantError>>;
    add(i: {
      actor: Actor;
      slug: string;
      display_name: string;
      country: string;
      reason: string;
    }): Promise<Result<{ publisher_id: Id }, ApplicantError>>;
    decide(i: {
      actor: Actor;
      publisher_id: Id;
      decision: 'approve' | 'reject';
      reason: string;
    }): Promise<Result<{ state: 'active' | 'rejected' }, ApplicantError>>;
  };
  /**
   * PUB-APPLY, public (no actor, no session). `applyToPublish` leaves one application: an applicant record
   * (status applied, no payee, no offers, no account, no sign in) and the reference the applicant keeps. A
   * filled honeypot answers the same success and stores nothing. 5 per hour per hashed address (never the
   * raw address). `applicationStatus` answers only pending, approved, rejected or unknown.
   */
  applyToPublish(i: {
    display_name: string;
    country: string;
    note: string;
    /** The honeypot field, which a person leaves empty. */
    trap: string;
    ip_hash: string;
    /** False when no client address is known: the application is then refused as busy, no token spent. */
    ip_known: boolean;
  }): Promise<
    { ok: true; reference: string } | { ok: false; code: 'invalid_input' | 'busy' | 'rate_limited' }
  >;
  applicationStatus(i: { ref: string }): Promise<ApplicationState>;
  /**
   * AGREE-1, operator only (second factor required): the latest publisher terms record of every publisher
   * that has one. Read only. Applicants have no record.
   */
  opsAgreements: {
    list(actor: Actor): Promise<Result<{ agreements: Agreement[] }, ApplicantError>>;
  };
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

/** PUB-APPLY: each well formed call to applyToPublish spends one token of the address's bucket. */
export const APPLY_RATE = { name: 'apply', per: 'ip', limit: 5, window_ms: 3_600_000 } as const;

/** ID-ACCOUNTS: each well formed signup spends one token of the address's bucket (5 an hour). */
export const ACCOUNT_SIGNUP_RATE = {
  name: 'account-signup',
  per: 'ip',
  limit: 5,
  window_ms: 3_600_000,
} as const;

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
// MC2-L2 (D-084 item 6): the fictional German publisher is paid into the same owner account, by the same rule
// as Quayside: only set where it holds no id, never overwritten, flagged payee_shared, one audit row.
const THIRD_PAYEE_SLUG = 'rheinwerft-kurier';

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
        'SELECT id, slug, paypal_merchant_id, payee_shared FROM publishers WHERE slug = $1 OR slug = $2 OR slug = $3',
        [FIRST_PAYEE_SLUG, SECOND_PAYEE_SLUG, THIRD_PAYEE_SLUG],
      )
    ).rows;
    const first = rows.find((r) => r.slug === FIRST_PAYEE_SLUG);
    const second = rows.find((r) => r.slug === SECOND_PAYEE_SLUG);
    const third = rows.find((r) => r.slug === THIRD_PAYEE_SLUG);
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
    // The German publisher comes last, so the guard sees the owner id flagged on Harbour and Quayside
    // before a third row takes it. It is absent on a database that has not run the MC2-L2 block yet.
    if (third !== undefined && third.paypal_merchant_id === null) {
      const set3 = await tx.query(
        `UPDATE publishers SET paypal_merchant_id = $3, payee_verified_at = $1, payee_shared = true, updated_at = $1
          WHERE id = $2 AND paypal_merchant_id IS NULL RETURNING id`,
        [now, third.id, own_merchant_id],
      );
      // Audit only a write that happened: two racing boots must not both record it.
      if (set3.rows.length === 1)
        await d.audit.record(tx, {
          actor: { kind: 'system' },
          action: 'seed.payee_set',
          target: third.id,
          reason: 'D-041: all demo publishers are paid into the owner account',
          detail: { slug: third.slug, merchant_last4: last4 },
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

/**
 * AI-A: the spend ledger of the Claude adapter, kept in audit_log (action `model.spend`, detail
 * `micro_usd`, actor system). No migration: the sum is read back from the same rows, and the table is
 * append-only, so a spend record cannot be edited away. A read or write error propagates; the spend
 * guard treats it as a refusal.
 */
export function createModelSpendStore(db: Database, audit: AuditSink): ModelSpendStore {
  return {
    async spentMicroUsd(since_iso) {
      const sum = `SELECT COALESCE(SUM((detail->>'micro_usd')::bigint), 0) AS s FROM audit_log WHERE action = 'model.spend'`;
      const r =
        since_iso === null
          ? await db.query<{ s: string | number }>(sum)
          : await db.query<{ s: string | number }>(`${sum} AND created_at >= $1::timestamptz`, [
              since_iso,
            ]);
      return Number(r.rows[0]?.s ?? 0);
    },
    async charge(micro_usd, note) {
      await db.transaction((tx) =>
        audit.record(tx, {
          actor: { kind: 'system' },
          action: 'model.spend',
          target: null,
          reason: note,
          detail: { micro_usd },
        }),
      );
    },
  };
}

/** AI-A: which ModelPort discovery gets. Scripted unless the config says claude and holds a key. */
export function chooseModel(
  c: Pick<Config, 'ai_adapter' | 'ai_api_key'>,
  d: {
    db: Database;
    audit: AuditSink;
    clock: Clock;
    maintenance: boolean;
    /** The kill switch: the paypal_outbound switch, so one stop (safety:stop, /api/ops/stop) ends AI calls too. */
    switches: SwitchReader;
    wire?: ModelWire;
  },
): ModelPort {
  const scripted = createScriptedModel();
  if (c.ai_adapter !== 'claude' || c.ai_api_key === null || d.maintenance) return scripted;
  return createClaudeModel({
    wire: d.wire ?? createModelHttps({ apiKey: c.ai_api_key }),
    spend: createModelSpendStore(d.db, d.audit),
    clock: d.clock,
    fallback: scripted,
    live: () => d.switches.isOn('paypal_outbound'),
  });
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
    if (opts.test_model_wire !== undefined)
      throw new Error('boot refused: test_model_wire outside NODE_ENV=test');
    if (opts.test_claude_eval_file !== undefined)
      throw new Error('boot refused: test_claude_eval_file outside NODE_ENV=test');
    if (opts.test_fx_fetch !== undefined)
      throw new Error('boot refused: test_fx_fetch outside NODE_ENV=test');
    if (opts.test_import_fetcher !== undefined)
      throw new Error('boot refused: test_import_fetcher outside NODE_ENV=test');
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
  const seed = async (raw: SqlDriver): Promise<void> => {
    // INT-TR0: the boot seed and the demo seed write as system on the seed channel, each under its own context.
    const seedContext = (job: string): TraceContext => ({
      id: `ctx_seed_${job}_${ids.nonce()}`,
      at: clock.now().toISOString(),
      channel: 'seed',
      actor_kind: 'system',
      actor_id: null,
      on_behalf_of: null,
      mandate_id: null,
      mfa: false,
      req_id: null,
      ip_hash: null,
      ua_family: null,
      api_key_id: null,
      job,
      tool: null,
    });
    const bootCtx = seedContext('boot');
    const demoCtx = seedContext('demo');
    const d = withTraceDb(raw, () => bootCtx, clock);
    const demo = withTraceDb(raw, () => demoCtx, clock);
    const n = await d.query<{ c: string | number }>('SELECT count(*) AS c FROM publishers');
    if (Number(n.rows[0]?.c ?? 0) === 0) await seedCatalogue(d, clock, ids, SEED_DATA);
    // DP-5: the second publisher of MVP-D. Every boot, after the base seed, so it reaches a disk that
    // already holds the base catalogue. Every row is looked up first: a second run adds nothing, and it
    // never sets a merchant id, a verification time or the payee_shared flag.
    if (opts.test_seed?.supplement !== false)
      await seedSupplement(d, clock, ids, SEED_SUPPLEMENT_COMPOSITE);
    // MC2-L2 (D-084 item 6): the German euro corridor (switched off) and one fictional German publisher.
    // Every boot, after the composite block and its own lock, so it reaches a disk that holds the older
    // seed. Rows are looked up first and the corridor insert is DO NOTHING: a second run adds nothing and
    // never changes the corridor switch. No merchant id is set here; the payee step below does that.
    if (config.node_env !== 'test' || opts.test_seed?.de_corridor === true)
      await seedSupplement(d, clock, ids, SEED_SUPPLEMENT_DE);
    // AGREE-1: the seeded, read only publisher terms record for the demo publishers (method seeded_demo).
    // Every boot; a publisher that already has a record is left alone, so a second run adds nothing and a
    // later terms version shows as changed, not re-accepted.
    if (opts.test_seed?.agreements !== false)
      await seedAgreements(d, clock, ids, {
        terms_version: PUBLISHER_TERMS_VERSION,
        accepted_by_label: AGREEMENT_SEED_LABEL,
        publisher_slugs: PUBLISHER_PERSONAS.map((x) => x.slug),
      });
    // PUB-B (decision 37): demo prices 1.00 to 2.50 USD as audited offer revisions, not a seed edit. Every
    // boot, after the seed; an offer that was already revised (by this step or by its publisher) is not
    // touched again, so a second run, and a later boot on the hosted disk, revise nothing. Tests keep the
    // seed prices unless they ask for the step.
    // A convenience for the demo: a failure here (a refused write is already skipped inside the step; this
    // catches a thrown database error) must never stop the app from starting. One line, no values.
    if (config.node_env !== 'test' || opts.test_seed?.demo_prices === true) {
      try {
        await applyDemoPrices({
          db: demo,
          clock,
          ids,
          audit,
          offer_max_minor: config.offer_max_minor,
        });
      } catch (e) {
        log.log({
          msg: 'demo_prices.failed',
          level: 'warn',
          fields: { err_name: e instanceof Error ? e.name : 'unknown' },
        });
      }
    }
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
    // Any conflict is skipped: a demo buyer whose personal data was removed (scripts/privacy.mjs delete) keeps
    // its id but has a new auth_subject, so only the id can collide on the next start. The persona stays as is.
    for (const [persona, id] of Object.entries(BUYER_IDS)) {
      await d.query(
        `INSERT INTO buyers (id, display_name, auth_subject, country, created_at, updated_at)
         VALUES ($1, $2, $3, 'US', $4, $4) ON CONFLICT DO NOTHING`,
        [
          id,
          persona === 'buyer-a' ? 'Buyer A (demo)' : 'Buyer B (demo)',
          `persona:${persona}`,
          now,
        ],
      );
    }
  };
  // INT-TR0: every write through this handle carries the context of the request, job pass or webhook that made it.
  const db: Database = withTraceDb(
    {
      dialect: config.db.kind === 'postgres' ? 'pg' : 'pglite',
      query: async (sql, params) => (await open()).query(sql, params),
      exec: async (sql) => (await open()).exec(sql),
      transaction: async <T>(fn: (tx: SqlExecutor) => Promise<T>) => (await open()).transaction(fn),
    },
    currentTraceContext,
    clock,
  );

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
    // API-C: domain state changes append their events to the outbox in their own transaction.
    outbox: createEventOutbox({ ids, clock }),
  };
  // PUB-B: what the offer writes need; the price cap is the configured one (UMS_OFFER_MAX_MINOR).
  const offerDeps = { db, clock, ids, audit, offer_max_minor: config.offer_max_minor };
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
  // AI-A (D-067): the scripted model unless UMS_AI_ADAPTER=claude AND a key is set (config refuses a
  // claude adapter without a key). The Claude adapter reaches the model API only through the one
  // egress in packages/transport, with hard spend caps; any failure falls back to the scripted model.
  const model: ModelPort = chooseModel(config, {
    db,
    audit,
    clock,
    maintenance,
    switches,
    ...(opts.test_model_wire === undefined ? {} : { wire: opts.test_model_wire }),
  });
  const agent: AgentDeps = { ...core, model };
  const paymentsDeps: PaymentsDeps = { ...core, paypal, content };
  // API-B: what the mandate store needs. The outbox is the one of /api/v1: an event commits with its change.
  const mandateDeps: MandateDeps = {
    clock,
    ids,
    outbox: createEventOutbox({ ids, clock }),
    audit,
  };
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
  // POB-I1: the web import. The fetcher is the guarded transport fetcher outside tests (one fixed rule: the
  // caller names the one host of each call, the publisher's verified domain) and the test double in tests; in
  // tests without a double, and in maintenance, the import is off. The may-fetch check is asked before EVERY
  // fetch: the paypal_outbound switch (one stop ends every outbound call) and maintenance.
  const importDeps: ImportDeps = {
    db,
    clock,
    ids,
    audit,
    offer_max_minor: config.offer_max_minor,
    fetcher:
      opts.test_import_fetcher ??
      (config.node_env !== 'test' && !maintenance ? createFeedFetcher() : null),
    mayFetch: async () => !maintenance && (await switches.isOn('paypal_outbound')),
    get fee() {
      return opts.import_fee ?? ZERO_FEE_POLICY;
    },
  };
  let kickImports: () => void = () => undefined;

  // One pass of the loop's sweep: end access windows, then turn alerts into cases.
  const sweepAll = async (x: { max_items: number }): Promise<{ ended: number }> => {
    const swept = await sweepWindows(core, x);
    await applyAutomaticRules(core, x);
    return swept;
  };

  // API-C: webhook delivery. MVP 1 sends nothing over the network: the sender is an in-process sink that
  // records each request. A real HTTP sender comes later through packages/transport.
  const webhook_sink = createInProcessSink();
  const deliverWebhooks = (o: { max_items: number }): Promise<DeliverCounts> =>
    runDeliveryPass(
      {
        db,
        clock,
        ids,
        log,
        sender: webhook_sink,
        sign: (secret, t, body) => signatureHeader(secret, t, body),
      },
      o,
    );

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
  const offerPageOf = async (
    v: NonNullable<Awaited<ReturnType<typeof getOffer>>>,
  ): Promise<OfferPage> => ({
    offer_id: v.offer.id,
    title: v.article.title,
    abstract: v.article.abstract,
    publisher: v.publisher.display_name,
    publisher_slug: v.publisher.slug,
    offer_code: v.offer.id.startsWith(`ofr_${v.publisher.slug}_`)
      ? v.offer.id.slice(`ofr_${v.publisher.slug}_`.length)
      : v.offer.id,
    language: v.article.language,
    // PUB-E5: the size of the offer's own article, read by the article id the offer carries.
    bytes: Number(
      (
        await db.query<{ bytes: number }>('SELECT bytes FROM articles WHERE id = $1', [
          v.article.id,
        ])
      ).rows[0]?.bytes ?? 0,
    ),
    currency: v.offer.currency,
    options: v.offer.options.map((o) => ({ option: o.option, price_minor: o.price_minor })),
    renegotiation_allowed: v.offer.affordability.renegotiation_allowed,
    floor_minor: v.offer.affordability.floor_minor,
    rights: v.offer.rights,
    on_sale: offerOnSale({
      status: v.offer.status,
      superseded_by: v.offer.superseded_by,
      publisher_status:
        (
          await db.query<{ status: string }>('SELECT status FROM publishers WHERE id = $1', [
            v.offer.publisher_id,
          ])
        ).rows[0]?.status ?? 'unknown',
      valid_from: v.offer.valid_from,
      valid_until: v.offer.valid_until,
      now_ms: clock.now().getTime(),
    }),
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
          order_ref: string | null;
          unit_status: string | null;
          status_reason: string | null;
          order_status: string | null;
          po_state: string | null;
        }>(
          `SELECT e.id, e.money_state, u.order_id, o.order_ref, u.status AS unit_status,
                  u.status_reason, o.status AS order_status, p.state AS po_state
             FROM entitlements e
             LEFT JOIN order_units u ON u.id = e.unit_id
             LEFT JOIN orders o ON o.id = u.order_id
             LEFT JOIN provider_orders p ON p.id = u.provider_order_ref
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
      // FIX-FLOW D4: the order and its PayPal order, so an unpaid order is not worded as a payment
      // being confirmed.
      const orderFacts = {
        order_status: fact?.order_status ?? null,
        po_state: fact?.po_state ?? null,
      };
      // MC2-L6 (D-083): a payment PayPal holds for the seller to accept. The library read model words every
      // pending unit alike; this replaces only that line, and only for the closed kind.
      const heldKind: PendingKind =
        fact?.unit_status === 'pending' ? pendingReasonKind(fact.status_reason) : 'payment_pending';
      const baseText = buyerStatusText({
        base: v.status_text,
        ...refundFacts,
        ...orderFacts,
        window_state: v.window.state,
        option: v.option,
      });
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
        status_text:
          heldKind === 'awaiting_seller_acceptance' &&
          baseText === pendingBuyerText('payment_pending')
            ? pendingBuyerText(heldKind)
            : baseText,
        refund_note: buyerRefundNote(refundFacts),
        refunded: isFullyRefunded(refundFacts),
        can_open: v.can_open,
        order_id: facts.get(v.entitlement_id)?.order_id ?? null,
        order_ref: facts.get(v.entitlement_id)?.order_ref ?? null,
        receipt_versions: v.receipt_versions,
        open_case: v.open_case,
        environment: v.environment,
      });
    }
    return out;
  };

  const buyerOf = (a: Actor): Id | null => (a.kind === 'buyer' ? a.buyer_id : null);

  // MC2-L4 (D-085): the one place the ECB egress is chosen. Only a sandbox-mode server outside NODE_ENV=test
  // builds the real fetch (packages/transport, one fixed host, GET only); offline mode and tests get a fake
  // that answers `offline` and opens nothing.
  const fetchFx: () => Promise<FetchedRates> =
    opts.test_fx_fetch ??
    (config.mode === 'sandbox' && config.node_env !== 'test'
      ? createEcbFetch()
      : async () => ({ ok: false, kind: 'offline' }));

  const engine: Engine = {
    personas: () => PERSONAS,

    fx: {
      getRates: () => fxGetRates(db, clock).catch(() => null),
      refreshIfStale: () => fxRefreshIfStale({ db, clock, fetchRates: fetchFx }),
      convert: (i) => fxConvert({ ...i, at: i.at ?? clock.now() }),
    },

    displayCurrency: {
      async get(actor) {
        const buyer = buyerOf(actor);
        if (buyer === null) return null;
        const r = await db.query<{ country: string; display_currency: string | null }>(
          'SELECT country, display_currency FROM buyers WHERE id = $1',
          [buyer],
        );
        const row = r.rows[0];
        return row === undefined ? null : { country: row.country, chosen: row.display_currency };
      },
      async set({ actor, currency }) {
        const buyer = buyerOf(actor);
        if (buyer === null) return false;
        const r = await db.query(
          'UPDATE buyers SET display_currency = $2, updated_at = $3 WHERE id = $1 RETURNING id',
          [buyer, currency, clock.now().toISOString()],
        );
        return r.rows.length === 1;
      },
    },

    async signIn({ persona, passcode, operator, code }) {
      if (config.passcode_hash === null) return null;
      // PUB-A1: a publisher persona verifies against the publisher hash only; every other persona against
      // the demo hash only. With the publisher hash unset, or an unknown persona, the answer costs one
      // verification against the demo hash and is null, so neither shows in the time.
      // JUDGE-A: a buyer persona also verifies against the judge hash when it is set. Both checks always
      // run (no early return), so the demo, the judge and a wrong passcode cost the same. The operator and
      // the publisher personas never see the judge hash, so a judge passcode cannot open them.
      const publisherSlug = publisherSlugOf(persona);
      const hash =
        publisherSlug === undefined ? config.passcode_hash : config.publisher_passcode_hash;
      if (!(PERSONAS as readonly string[]).includes(persona) || hash === null) {
        await verifyPasscode(config.passcode_hash, passcode);
        return null;
      }
      if (persona === 'buyer-a' || persona === 'buyer-b') {
        const demoOk = await verifyPasscode(hash, passcode);
        const judgeOk =
          config.judge_passcode_hash !== null &&
          (await verifyPasscode(config.judge_passcode_hash, passcode));
        if (!demoOk && !judgeOk) return null;
      } else if (!(await verifyPasscode(hash, passcode))) return null;
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
        const p = await db.query<{ id: string }>('SELECT id FROM publishers WHERE slug = $1', [
          publisherSlug ?? '',
        ]);
        const id = p.rows[0]?.id;
        if (id === undefined) return null;
        actor = { kind: 'publisher', publisher_id: id };
      }
      const s = await createSession(security, actor);
      return { actor, cookie: s.cookie, csrf_token: s.csrf_token };
    },

    actorFromCookie: (cookie) => resolveSession(security, cookie),

    // ID-ACCOUNTS. Routes call these; the rules live in @umsbx/security (accounts.ts).
    accounts: {
      async signUp(i) {
        // No known address: every visitor would share one bucket. Refuse before anything is read or spent.
        if (!i.ip_known) return { ok: false, code: 'busy' };
        // Shape and password policy first: a refused submission spends nothing and stores nothing.
        const username = i.username;
        const checked = checkNewAccount(i);
        if (!checked.ok)
          return checked.code === 'weak_password'
            ? { ok: false, code: 'weak_password', reason: checked.reason }
            : { ok: false, code: 'invalid_input' };
        const v = await takeToken({ db, clock }, ACCOUNT_SIGNUP_RATE, i.ip_hash);
        if (!v.allowed) return { ok: false, code: 'rate_limited' };
        if (i.trap.trim() !== '') {
          // The honeypot: the shape of a success, no cookie, nothing stored.
          return { ok: true, csrf_token: ids.nonce(), cookie: null };
        }
        const made = await createAccount(security, {
          display_name: i.display_name,
          username,
          country: i.country,
          password: i.password,
          consent_version: ACCOUNT_CONSENT_VERSION,
        });
        if (!made.ok)
          return made.code === 'weak_password'
            ? { ok: false, code: 'weak_password', reason: made.reason }
            : { ok: false, code: made.code };
        const actor: Actor = { kind: 'buyer', buyer_id: made.buyer_id };
        const s = await createSession(security, actor);
        if (i.previous !== null) await revokeSession(security, i.previous);
        return { ok: true, csrf_token: s.csrf_token, cookie: s.cookie };
      },

      async signIn({ username, password, previous }) {
        const r = await verifyAccountLogin(security, { username, password });
        if (!r.ok) return null;
        const actor: Actor = { kind: 'buyer', buyer_id: r.buyer_id };
        const s = await createSession(security, actor);
        if (previous !== null) await revokeSession(security, previous);
        return { actor, cookie: s.cookie, csrf_token: s.csrf_token };
      },

      async changePassword({ actor, session_id, current_password, new_password }) {
        if (actor.kind !== 'buyer') return { ok: false, code: 'no_account' };
        const r = await changeAccountPassword(security, {
          buyer_id: actor.buyer_id,
          current_password,
          new_password,
          keep_session_id: session_id,
        });
        return r.ok ? { ok: true } : r;
      },

      async signOutEverywhere({ actor }) {
        if (actor.kind !== 'buyer') return null;
        const own = await db.query('SELECT 1 FROM buyer_accounts WHERE buyer_id = $1', [
          actor.buyer_id,
        ]);
        if (own.rows.length === 0) return null;
        await revokeBuyerSessions(security, { buyer_id: actor.buyer_id, keep_session_id: null });
        return { cookie: clearSessionCookie() };
      },

      async view(actor) {
        if (actor.kind !== 'buyer') return null;
        const r = await db.query<AccountView>(
          `SELECT a.username, b.display_name, b.country FROM buyer_accounts a
             JOIN buyers b ON b.id = a.buyer_id WHERE a.buyer_id = $1`,
          [actor.buyer_id],
        );
        return r.rows[0] ?? null;
      },
    },

    async signOut({ actor, session_id }) {
      if (session_id !== null) await revokeSession(security, { id: session_id, actor });
      return { cookie: clearSessionCookie() };
    },

    // AGREE-1: the publisher's own seeded record, read only.
    publisherAgreement: (actor) => ownAgreement(db, actor),

    // PUB-A1: the publisher home. Every query below filters by the actor's publisher id.
    async publisherHome(actor) {
      if (actor.kind !== 'publisher') return null;
      const p = await db.query<{
        display_name: string;
        status: PublisherStatus;
        country: string;
        paypal_merchant_id: string | null;
        payee_verified_at: Date | string | null;
        payee_shared: boolean;
      }>(
        'SELECT display_name, status, country, paypal_merchant_id, payee_verified_at, payee_shared FROM publishers WHERE id = $1',
        [actor.publisher_id],
      );
      const row = p.rows[0];
      if (row === undefined) return null;
      // Live: authorised, the newest version of its offer, not superseded, inside its validity dates and
      // covered by an enabled corridor (what a buyer can buy; same rule as discovery, gate 12 D9).
      const now = clock.now().toISOString();
      const live = await db.query<{ n: string | number }>(
        `SELECT count(*) AS n FROM offers o
          WHERE o.publisher_id = $1 AND o.status = 'authorised' AND o.superseded_by IS NULL
            AND o.valid_from <= $2 AND (o.valid_until IS NULL OR o.valid_until > $2)
            AND EXISTS (SELECT 1 FROM publisher_authorisations pa
                         WHERE pa.offer_id = o.id AND pa.offer_version = o.version)
            AND NOT EXISTS (SELECT 1 FROM offers n WHERE n.id = o.id AND n.publisher_id = $1
                             AND (n.created_at, n.version) > (o.created_at, o.version))
            AND EXISTS (SELECT 1 FROM corridors c
                         WHERE c.enabled AND c.currency = o.currency AND $3 = ANY (c.payee_countries))`,
        [actor.publisher_id, now, row.country],
      );
      return {
        display_name: row.display_name,
        status: row.status,
        // A suspended or unapproved publisher sells nothing (the same rule as the buyer side, PUB-D).
        offers_live: row.status === 'active' ? Number(live.rows[0]?.n ?? 0) : 0,
        payee: {
          last4: row.paypal_merchant_id === null ? null : row.paypal_merchant_id.slice(-4),
          verified_at: row.payee_verified_at === null ? null : iso(row.payee_verified_at),
        },
        settlement: payeeSettlement({
          merchant_id: row.paypal_merchant_id,
          payee_shared: row.payee_shared,
          environment,
          own_merchant_id: config.own_merchant_id,
        }),
      };
    },

    // PUB-C: the publisher's own sales and statement. Read only; the id is the actor's.
    async publisherSales(actor) {
      if (actor.kind !== 'publisher') return null;
      return salesFor(db, actor);
    },
    // MC2-L6 (D-083): pending units with a closed label. The stored reason is mapped here and goes no further.
    async publisherPending(actor) {
      if (actor.kind !== 'publisher') return null;
      const r = await db.query<{
        order_ref: string;
        currency: string;
        environment: EnvironmentLabel;
        amount_minor: string | number;
        status_reason: string | null;
        at: string;
      }>(
        `SELECT o.order_ref, o.currency, o.environment, u.amount_minor, u.status_reason,
                to_char(COALESCE(u.captured_verified_at, u.created_at) AT TIME ZONE 'UTC',
                        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at
           FROM order_units u JOIN orders o ON o.id = u.order_id
          WHERE u.publisher_id = $1 AND u.status = 'pending'
          ORDER BY COALESCE(u.captured_verified_at, u.created_at) DESC, u.id DESC`,
        [actor.publisher_id],
      );
      return r.rows.map((u) => ({
        at: u.at,
        order_ref6: u.order_ref.slice(-6),
        amount_minor: Number(u.amount_minor),
        currency: u.currency,
        environment: u.environment,
        kind: pendingReasonKind(u.status_reason),
        label: pendingReasonLabel(u.status_reason),
      }));
    },
    async publisherStatement(actor) {
      if (actor.kind !== 'publisher') return null;
      return statementFor(db, actor, {
        own_merchant_id: config.own_merchant_id,
        environment,
      });
    },

    // PUB-E1: refunds, the visit cursor and the CSV files. Each filters by the actor's publisher id.
    async publisherRefunds(actor) {
      if (actor.kind !== 'publisher') return null;
      return refundsFor(db, actor);
    },
    async publisherSince(actor) {
      if (actor.kind !== 'publisher') return null;
      const visit = await touchVisit(db, actor, clock.now().toISOString());
      if (visit === null) return null;
      if (visit.since === null) return { first_visit: true, since: null, counts: null };
      return {
        first_visit: false,
        since: visit.since,
        counts: await countsSince(db, actor, visit.since),
      };
    },
    async publisherExport({ actor, kind }) {
      if (actor.kind !== 'publisher') return null;
      if (kind === 'sales') {
        return { filename: 'unitmarket-sales.csv', ...salesExport(await salesFor(db, actor)) };
      }
      const statement = await statementFor(db, actor, {
        own_merchant_id: config.own_merchant_id,
        environment,
      });
      return { filename: 'unitmarket-statement.csv', ...statementExport(statement) };
    },

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
      return v === null ? null : await offerPageOf(v);
    },

    async listOffers() {
      const rows = await db.query<{ slug: string; id: string }>(
        `SELECT p.slug, o.id FROM offers o JOIN publishers p ON p.id = o.publisher_id
          WHERE o.status = 'authorised' AND o.superseded_by IS NULL AND p.status = 'active'
          ORDER BY o.id`,
      );
      // MC-GBP: an offer is listed when its currency has an enabled corridor (with the seed that is USD only).
      const enabled = new Set(
        (
          await db.query<{ currency: string }>(
            'SELECT DISTINCT currency FROM corridors WHERE enabled',
          )
        ).rows.map((c) => c.currency),
      );
      const out: OfferPage[] = [];
      for (const r of rows.rows) {
        const v = await getOffer(db, { offer_id: r.id });
        if (v !== null && enabled.has(v.offer.currency)) out.push(await offerPageOf(v));
      }
      return out;
    },

    async unpaidOrderRef({ publisher, offer, actor }) {
      const b = buyerOf(actor);
      if (b === null) return null;
      const found = await getOffer(db, { publisher_slug: publisher, offer_code: offer });
      if (found === null) return null;
      // The same test as startFromOffer step 6 and buyerStatusText: an order waiting for its buyer, no
      // approved PayPal order, nothing paid. Scoped to this buyer by the query.
      const r = await db.query<{ order_ref: string }>(
        `SELECT o.order_ref
           FROM entitlements e
           JOIN order_units u ON u.id = e.unit_id
           JOIN orders o ON o.id = u.order_id
           LEFT JOIN provider_orders p ON p.id = u.provider_order_ref
          WHERE e.buyer_id = $1 AND e.article_id = $2
            AND e.money_state IN ('unknown', 'pending')
            AND e.access_state IN ('locked', 'available')
            AND o.status IN ('awaiting_buyer', 'created')
            AND COALESCE(p.state, '') <> 'approved'
            AND u.status <> 'pending'
          ORDER BY e.created_at DESC
          LIMIT 1`,
        [b, found.article.id],
      );
      return r.rows[0]?.order_ref ?? null;
    },

    quote: ((i: Parameters<typeof startFromOffer>[1]) =>
      startFromOffer(core, i)) as Engine['quote'],

    aiEnabled: () => switches.isOn('ai_enabled'),

    agentBuyEnabled: () => switches.isOn('agent_buy_enabled'),

    opsRules: {
      add: (i) => addRuleSetting(core, i),
      history: (filter, limit) => listRuleHistory(db, filter, limit),
    },

    rules: {
      activeRows: (ctx, at) => activeRows(db, ctx, at),
    },

    async setAgentBuy({ actor, on, reason }) {
      if (actor.kind !== 'operator') return err('operator_required');
      // Turning agent buying ON needs the second factor; turning it OFF never does.
      if (on && !actor.mfa) return err('mfa_required');
      const r = await setSwitch(db, audit, clock, {
        name: 'agent_buy_enabled',
        on,
        by: actor,
        reason,
        approval_ref: null,
      });
      if (r.ok) return ok(undefined);
      return err(r.error === 'operator_required' ? 'operator_required' : 'reason_required');
    },

    async parseNeed(i) {
      return parseNeed(agent, i);
    },

    async discover({ actor, text }) {
      // docs/READINESS.md: discovery refuses when the ai_enabled switch is off.
      if (!(await switches.isOn('ai_enabled'))) return { ai_off: true };
      const brief = await parseNeed(agent, { actor, text });
      if (!brief.ok) return { ai_off: false, result: { parse_error: brief.error.code } };
      // MC2-L5: a ceiling in another currency than an offer is compared on the converted price at the stored
      // rate. No usable rate (none stored, a read that failed, or one over 7 days old) means no convert
      // function, and discovery compares only offers in the ceiling's own currency, as before.
      const rates = await fxGetRates(db, clock).catch(() => null);
      const convert =
        rates === null
          ? undefined
          : (c: { minor: number; from: string; to: string }): number | null => {
              const isFx = (x: string): x is FxCurrency =>
                x === 'USD' || x === 'EUR' || x === 'GBP';
              if (!isFx(c.from) || !isFx(c.to)) return null;
              return (
                fxConvert({ minor: c.minor, from: c.from, to: c.to, rates, at: clock.now() })
                  ?.minor ?? null
              );
            };
      const r = await discoverOffers(agent, {
        actor,
        brief_id: (brief.value as Brief).brief_id,
        ...(convert !== undefined ? { convert } : {}),
      });
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
        const { mandate, ...plain } = i;
        const buyer_id = plain.actor.kind === 'buyer' ? plain.actor.buyer_id : '';
        // API-B: an agent purchase books its mandate in the order's own transaction (see OrderHold).
        const hold: OrderHold | undefined =
          mandate === undefined
            ? undefined
            : {
                mandate_id: mandate.mandate_id,
                async reserve(tx, x) {
                  const held = await reserveMandate(tx, mandateDeps, {
                    mandate_id: mandate.mandate_id,
                    buyer_id,
                    agent_key_id: mandate.agent_key_id,
                    amount_minor: x.amount_minor,
                    currency: x.currency,
                  });
                  return held.ok
                    ? { ok: true, reservation_id: held.value.reservation_id }
                    : { ok: false, reason: held.error };
                },
                async attach(tx, reservation_id, order_id) {
                  await attachMandateOrder(tx, reservation_id, order_id);
                },
                async release(tx, reservation_id) {
                  await releaseMandate(tx, mandateDeps, reservation_id);
                },
              };
        const r = await placePaymentsOrder(paymentsDeps, {
          ...plain,
          ...(hold === undefined ? {} : { hold }),
        });
        if (r.ok) return ok(r.value);
        const e = r.error;
        return err(e.code === 'approval' ? { code: 'approval', http: e.error.http } : e);
      },
      async beginCheckout(i) {
        const r = await beginPaymentsCheckout(paymentsDeps, i);
        if (!r.ok) return err(r.error);
        return ok({ approve_url: r.value.approve_url, progress: r.value.progress ?? null });
      },
      async cancelOrder(i) {
        const r = await cancelPaymentsOrder(paymentsDeps, i);
        return r.ok ? ok(r.value) : err(r.error);
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
        status_reason: string | null;
        amount_minor: string | number;
        refunded_minor: string | number;
      }>(
        'SELECT status, status_reason, amount_minor, refunded_minor FROM order_units WHERE order_id = $1',
        [o.id],
      );
      const ents = await db.query<{
        article_id: string;
        title: string;
        access_state: string;
        publisher: string | null;
        unit_status: string;
        status_reason: string | null;
        po_state: string | null;
        verified: boolean;
        amount_minor: string | number;
        refunded_minor: string | number;
      }>(
        `SELECT e.article_id, a.title, e.access_state, pub.display_name AS publisher,
                u.status AS unit_status, u.status_reason, p.state AS po_state,
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
        // MC2-L6: a pending item held for the seller to accept says so; the kind stays `pending`.
        const line =
          kind === 'pending' && e.unit_status === 'pending'
            ? (pendingItemLine(pendingReasonKind(e.status_reason)) ?? LINE_TEXT[kind])
            : LINE_TEXT[kind];
        return { ...base, publisher: e.publisher ?? 'Publisher', kind, line };
      });
      const unitStatuses = units.rows.map((u) => u.status);
      const pendingKinds = units.rows
        .filter((u) => u.status === 'pending')
        .map((u) => pendingReasonKind(u.status_reason));
      let message = orderMessage(o.status, unitStatuses, poStates, pendingKinds);
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

    // READER-A engine block. The page is a server component, so the stream is read here to its last byte
    // and onFinish is awaited: the reader_rendered evidence exists before the paragraphs are returned.
    async readerView({ entitlement_id, actor, session_id }) {
      const b = buyerOf(actor);
      if (b === null) return { ok: false, code: 'not_found' };
      const item = (await entitlementRows(b, entitlement_id))[0];
      if (item === undefined) return { ok: false, code: 'not_found' };
      // The content route's bucket: one token per read, so a reload loop cannot fill the evidence log.
      if (!(await takeToken(core, DEFAULT_RATES.content, b)).allowed) {
        return { ok: false, code: 'rate_limited' };
      }
      const who = session_id !== undefined ? { session_id } : {};
      const meta: ReaderMeta = {
        title: item.title,
        publisher: item.publisher,
        option: item.option,
        environment: item.environment,
        window: {
          state: item.window.state,
          ends_at: item.window.ends_at,
          days_left: item.window.days_left,
        },
      };
      const article = (
        await db.query<{ content_key: string }>('SELECT content_key FROM articles WHERE id = $1', [
          item.article_id,
        ])
      ).rows[0];
      let head: Awaited<ReturnType<ContentStore['head']>> = null;
      try {
        head = article === undefined ? null : await content.head(article.content_key);
      } catch {
        head = null;
      }
      if (head !== null && (!isReadableMime(head.mime) || head.bytes > MAX_READER_BYTES)) {
        // A download answer serves nothing and issues no link; the library's own reading of the same
        // stored state decides whether the item can be opened at all.
        if (!item.can_open) {
          return {
            ok: false,
            code: item.refunded
              ? 'refunded'
              : item.window.state === 'ended' || item.access === 'ended'
                ? 'window_ended'
                : 'not_available',
          };
        }
        return { ok: true, kind: 'download', ...meta };
      }
      const issued = await issueLink({ ...core, content }, { entitlement_id, actor, ...who });
      if (!issued.ok) {
        if (issued.error.code === 'not_available' && item.refunded) {
          return { ok: false, code: 'refunded' };
        }
        return { ok: false, code: issued.error.code };
      }
      const planned = await planServe(
        { ...core, content },
        { token: issued.value.url.slice('/c/'.length), actor, mode: 'read', ...who },
      );
      if (!planned.ok) {
        const code = planned.error.code;
        return {
          ok: false,
          code:
            code === 'window_ended' ||
            code === 'not_available' ||
            code === 'expired' ||
            code === 'store_unavailable'
              ? code
              : 'not_found',
        };
      }
      const plan: ServePlan = planned.value;
      const hash = createHash('sha256');
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        for await (const chunk of plan.body) {
          bytes += chunk.byteLength;
          hash.update(chunk);
          chunks.push(chunk);
        }
      } catch {
        return { ok: false, code: 'store_unavailable' };
      }
      await plan.onFinish({ bytes, sha256: hash.digest('hex') });
      const all = new Uint8Array(bytes);
      let at = 0;
      for (const c of chunks) {
        all.set(c, at);
        at += c.byteLength;
      }
      return {
        ok: true,
        kind: 'text',
        paragraphs: splitParagraphs(new TextDecoder().decode(all)),
        ...meta,
      };
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

    async evalsSummary(actor) {
      if (actor.kind !== 'operator') return null;
      // The scripted model over the committed cases: no network, no key, no spend.
      const cases = await runEvalCases(createScriptedModel());
      let stored: string | null = null;
      try {
        // Built as a plain string, not `new URL(literal, import.meta.url)`: the bundler would treat that as an
        // asset and fail the production build while the (optional) result file is not committed.
        stored = readFileSync(
          opts.test_claude_eval_file ??
            join(
              dirname(fileURLToPath(import.meta.url)),
              '..',
              '..',
              'packages',
              'model',
              'test-data',
              'claude-eval-result.json',
            ),
          'utf8',
        );
      } catch {
        stored = null; // no file: the cases have not been run against Claude
      }
      const result = stored === null ? null : parseClaudeEvalResult(stored);
      return {
        environment,
        listing_cases: LISTING_CASES.length,
        brief_cases: BRIEF_CASES.length,
        baseline: tally(cases),
        cases,
        claude: result === null ? { state: 'not_run' } : { state: 'recorded', ...result },
        model_in_use: model.model_id === CLAUDE_MODEL_ID ? 'claude' : 'scripted',
      };
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
          active_scope:
            config.outbound_approval_ref === null
              ? null
              : ((await findActiveApproval(db, config.outbound_approval_ref, clock.now()))?.scope ??
                null),
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
        totals: (await opsTotalsFor(db, actor)) ?? [],
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
      if (!r.ok)
        return err(r.error === 'operator_required' ? 'operator_required' : 'reason_required');
      // API-B: the stop button is the one control that works without the second factor, so it also turns
      // agent buying off. It only ever makes the system do less; turning agent buying on stays MFA-only.
      await setSwitch(db, audit, clock, {
        name: 'agent_buy_enabled',
        on: false,
        by: actor,
        reason,
        approval_ref: null,
      });
      return ok(undefined);
    },

    async outboundSwitchOn(actor) {
      if (actor.kind !== 'operator') return null;
      try {
        const r = await db.query<{ on: boolean }>(
          `SELECT "on" FROM safety_switches WHERE name = 'paypal_outbound'`,
        );
        return r.rows[0]?.on === true;
      } catch {
        return null;
      }
    },

    async startOutbound({ actor, reason, confirm_scope }) {
      const r = await resumeOutbound({
        db,
        clock,
        audit,
        by: actor,
        reason,
        approval_ref: config.outbound_approval_ref,
        scope: config.outbound_scope,
        refuse_if_on: true,
        confirm: (row) => confirm_scope.trim() === row.scope,
      });
      if (!r.ok) return err(r.error);
      return ok({
        outbound_on: true as const,
        // Only read, to tell the page; the flag is a Cloud Run setting the owners change.
        connect_flag: config.connect ? ('on' as const) : ('off' as const),
        calls_left: r.value.calls_left,
        valid_until: r.value.valid_until,
      });
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

    webImport: {
      async domains(actor) {
        const d = await importListDomains(db, actor);
        return d === null ? null : { domains: d };
      },
      addDomain: ({ actor, host }) => importRequestDomain(importDeps, actor, { host }),
      checkDomain: ({ actor, host }) => importCheckDomain(importDeps, actor, { host }),
      async begin({ actor, source_url }) {
        const r = await startVerifiedImport(importDeps, actor, { source_url });
        if (r.ok) kickImports();
        return r;
      },
      async batches(actor) {
        const b = await importListBatches(db, actor);
        return b === null ? null : { batches: b, environment };
      },
      async review({ actor, batch_id }) {
        const v = await importGetBatch(importDeps, actor, batch_id);
        return v === null ? null : { ...v, environment, offer_max_minor: config.offer_max_minor };
      },
      edit: ({ actor, ...i }) => importEditItem(importDeps, actor, i),
      publish: ({ actor, ...i }) => importPublishBatch(importDeps, actor, i),
      async runPending() {
        let ran = 0;
        for (let n = 0; n < 20; n += 1) {
          if (!(await importRunNext(importDeps)).ran) break;
          ran += 1;
        }
        return { ran };
      },
    },

    payee: {
      async view(actor) {
        const v = await payeeView(db, actor);
        if (v === null || actor.kind !== 'publisher') return null;
        const p = await db.query<{ paypal_merchant_id: string | null; payee_shared: boolean }>(
          'SELECT paypal_merchant_id, payee_shared FROM publishers WHERE id = $1',
          [actor.publisher_id],
        );
        const row = p.rows[0];
        return {
          ...v,
          environment,
          settlement: payeeSettlement({
            merchant_id: row?.paypal_merchant_id ?? null,
            payee_shared: row?.payee_shared ?? false,
            environment,
            own_merchant_id: config.own_merchant_id,
          }),
        };
      },
      request: (i) =>
        requestPayeeChange(core, i.actor, { merchant_id: i.merchant_id, note: i.note }),
      async openRequests(actor) {
        const r = await listOpenRequests(db, actor);
        if (!r.ok) return r;
        const now = clock.now().getTime();
        return {
          ok: true,
          value: {
            requests: r.value.map((x) => ({
              ...x,
              age_ms: Math.max(0, now - Date.parse(x.created_at)),
            })),
            environment,
          },
        };
      },
      decide: (i) =>
        decidePayeeRequest(core, i.actor, {
          request_id: i.request_id,
          merchant_id_retyped: i.merchant_id_retyped,
          decision: i.decision,
          reason: i.reason,
        }),
    },

    offers: {
      async list(actor) {
        const offers = await listOwnOffers(db, actor);
        return offers === null
          ? null
          : { offers, environment, offer_max_minor: config.offer_max_minor };
      },
      async get(actor, offer_id) {
        const o = await getOwnOffer(db, actor, offer_id);
        return o === null ? null : { ...o, environment, offer_max_minor: config.offer_max_minor };
      },
      async offerable(actor) {
        const articles = await listOfferableArticles(db, actor);
        return articles === null
          ? null
          : {
              articles,
              environment,
              offer_max_minor: config.offer_max_minor,
              terms_version: NEW_OFFER_TERMS,
              currency: await offerCurrencyFor(db, actor),
            };
      },
      async create(i) {
        const r = await createOffer(offerDeps, i.actor, {
          article_id: i.article_id,
          options: i.options,
          attestation: i.attestation,
        });
        return r.ok
          ? { ok: true, value: { offer_id: r.value.offer_id, version: r.value.version } }
          : r;
      },
      async revise(i) {
        const r = await reviseOffer(offerDeps, i.actor, {
          offer_id: i.offer_id,
          expected_version: i.expected_version,
          options: i.options,
          attestation: i.attestation,
        });
        return r.ok ? { ok: true, value: { offer_id: i.offer_id, version: r.value.version } } : r;
      },
      async withdraw(i) {
        const r = await withdrawOffer(offerDeps, i.actor, {
          offer_id: i.offer_id,
          expected_version: i.expected_version,
          reason: i.reason,
        });
        return r.ok ? { ok: true, value: { offer_id: i.offer_id, version: r.value.version } } : r;
      },
    },

    opsPublishers: {
      async list(actor) {
        if (actor.kind !== 'operator') return { ok: false, error: { code: 'not_operator' } };
        if (!actor.mfa) return { ok: false, error: { code: 'mfa_required' } };
        const publishers = await publisherExposure(db, actor, clock.now().toISOString(), {
          own_merchant_id: config.own_merchant_id,
          environment,
        });
        if (publishers === null) return { ok: false, error: { code: 'not_operator' } };
        const held = await db.query<{
          publisher_id: Id;
          currency: string;
          environment: EnvironmentLabel;
          n: string | number;
          total: string | number;
        }>(
          `SELECT u.publisher_id, o.currency, o.environment, count(*) AS n,
                  COALESCE(sum(u.amount_minor), 0) AS total
             FROM order_units u JOIN orders o ON o.id = u.order_id
            WHERE u.status = 'pending' AND u.status_reason = $1
            GROUP BY u.publisher_id, o.currency, o.environment
            ORDER BY u.publisher_id, o.currency, o.environment`,
          [SELLER_ACCEPTANCE_REASON],
        );
        const awaiting: AwaitingExposure[] = held.rows.map((h) => ({
          publisher_id: h.publisher_id,
          currency: h.currency,
          environment: h.environment,
          count: Number(h.n),
          minor: Number(h.total),
        }));
        return { ok: true, value: { publishers, environment, awaiting } };
      },
      setStatus: (i) =>
        setPublisherStatus(offerDeps, i.actor, {
          publisher_id: i.publisher_id,
          status: i.status,
          reason: i.reason,
        }),
    },

    opsApplicants: {
      async list(actor) {
        if (actor.kind !== 'operator') return { ok: false, error: { code: 'not_operator' } };
        if (!actor.mfa) return { ok: false, error: { code: 'mfa_required' } };
        const applicants = await listApplicants(db, actor);
        if (applicants === null) return { ok: false, error: { code: 'not_operator' } };
        return { ok: true, value: { applicants } };
      },
      add: (i) =>
        addApplicant(offerDeps, i.actor, {
          slug: i.slug,
          display_name: i.display_name,
          country: i.country,
          reason: i.reason,
        }),
      decide: (i) =>
        decideApplicant(offerDeps, i.actor, {
          publisher_id: i.publisher_id,
          decision: i.decision,
          reason: i.reason,
        }),
    },

    async applyToPublish(i) {
      // No known address means every visitor would share one bucket and one could fill it for all: refuse
      // before anything is read, checked or spent.
      if (!i.ip_known) return { ok: false, code: 'busy' };
      const ref_nonce = ids.nonce().slice(0, 12);
      // Check first: a refused submission spends nothing and stores nothing.
      const checked = checkApplicationInput({
        display_name: i.display_name,
        country: i.country,
        note: i.note,
        ref_nonce,
      });
      if (checked === null) return { ok: false, code: 'invalid_input' };
      // One token for a well formed submission, honeypot included, so a bot cannot probe for free.
      const v = await takeToken({ db, clock }, APPLY_RATE, i.ip_hash);
      if (!v.allowed) return { ok: false, code: 'rate_limited' };
      if (i.trap.trim() !== '') {
        // The honeypot. Same shape as a success; nothing is stored and the reference is not known.
        return { ok: true, reference: applicationReference(checked.name, ref_nonce) };
      }
      const r = await submitApplication(offerDeps, {
        display_name: i.display_name,
        country: i.country,
        note: i.note,
        ref_nonce,
      });
      if (r.ok) return { ok: true, reference: r.value.reference };
      return { ok: false, code: r.error.code === 'busy' ? 'busy' : 'invalid_input' };
    },
    applicationStatus: (i) => applicationStatus(db, i.ref),

    opsAgreements: {
      async list(actor) {
        if (actor.kind !== 'operator') return { ok: false, error: { code: 'not_operator' } };
        if (!actor.mfa) return { ok: false, error: { code: 'mfa_required' } };
        const agreements = await listAgreements(db, actor);
        if (agreements === null) return { ok: false, error: { code: 'not_operator' } };
        return { ok: true, value: { agreements } };
      },
    },

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
        return {
          ok: true,
          environment,
          revision: config.revision,
          db: false,
          maintenance: true,
          last_pass_at: null,
          due: 0,
        };
      const h = await jobsHealth(core);
      return {
        ok: h.db,
        environment,
        revision: config.revision,
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
    trace: traceReads(db),
    security,
    outbound,
    model_id: model.model_id,
    webhook_sink,
    deliverWebhooks: async (o) => {
      // CO-7b: no database in maintenance mode, so nothing to deliver.
      if (maintenance) return { fanned_out: 0, attempted: 0, delivered: 0, failed: 0, dead: 0 };
      await open();
      return deliverWebhooks(o);
    },
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
      let running: { stop(): Promise<void>; kickImports(): void };
      try {
        running = startLoop(
          { ...loopDeps, sweepWindows: sweepAll },
          {
            max_sleep_ms: config.node_env === 'test' ? 200 : 5_000,
            max_items: 100,
            recover_on_start: led,
            deliver: () => deliverWebhooks({ max_items: 100 }),
            // POB-I1: boot recovery marks queued and running batches interrupted; the worker runs the
            // queued ones off the pass.
            imports: {
              recover: () => recoverImports(importDeps),
              runNext: async () => ({ ran: (await importRunNext(importDeps)).ran }),
            },
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
        running = { stop: async () => undefined, kickImports: () => undefined };
      }
      kickImports = () => running.kickImports();
      loop = {
        stop: async () => {
          loop = null;
          kickImports = () => undefined;
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

// ---------- /api/v1 (API-W0) ----------
/** The facades of /api/v1, one per stakeholder, and the event outbox. Wired once per app. */
export interface ApiV1 {
  buyer: BuyerFacade;
  seller: SellerFacade;
  ops: OpsFacade;
  agent: AgentFacade;
  events: EventOutbox;
  /** API-B: agent spending caps. Every method names the buyer; another buyer's mandate is "not found". */
  mandates: MandateService;
  /** API-B: the claim a buy_unit call makes with its idempotency key, so a retry buys once. */
  claims: PurchaseClaims;
  /** API-C: the webhook subscription service behind /api/v1/webhook-subscriptions. */
  webhooks: EventsService;
}

export interface MandateService {
  create(i: CreateMandateInput): Promise<Result<MandateView, CreateError>>;
  get(buyer_id: Id, id: Id): Promise<MandateView | null>;
  revoke(buyer_id: Id, id: Id): Promise<Result<MandateView, 'not_found'>>;
  /** What the agent key has left (a paid or ended order settles first), or the words to ask its buyer with. */
  budget(i: { buyer_id: Id; agent_key_id: Id }): Promise<BudgetResult>;
}

export type ClaimStart =
  | { kind: 'new' }
  | { kind: 'done'; result: unknown }
  | { kind: 'in_progress' }
  | { kind: 'reused' };

export interface PurchaseClaims {
  /** `fingerprint` is the canonical text of the arguments (without the key); only its hash is stored. */
  begin(i: { agent_key_id: Id; idempotency_key: string; fingerprint: string }): Promise<ClaimStart>;
  finish(i: { agent_key_id: Id; idempotency_key: string; result: unknown }): Promise<void>;
  /** Drops a claim that did not buy anything, so the same key may be tried again. */
  abandon(i: { agent_key_id: Id; idempotency_key: string }): Promise<void>;
}
const apiV1Cache = new WeakMap<App, ApiV1>();
export function createApiV1(a: App): ApiV1 {
  const cached = apiV1Cache.get(a);
  if (cached !== undefined) return cached;
  const buyer = createBuyerFacade(a.engine);
  const events = createEventOutbox({ ids: a.security.ids, clock: a.security.clock });
  const made: ApiV1 = {
    buyer,
    seller: createSellerFacade(a.engine),
    ops: createOpsFacade(a.engine),
    agent: createAgentFacade(buyer),
    events,
    mandates: createMandateService(a, events),
    claims: createPurchaseClaims(a),
    webhooks: createEventsService({
      db: a.db,
      clock: a.security.clock,
      ids: a.security.ids,
      secrets: cryptoSecretSource(),
    }),
  };
  apiV1Cache.set(a, made);
  return made;
}

function createMandateService(a: App, events: EventOutbox): MandateService {
  const deps: MandateDeps = {
    clock: a.security.clock,
    ids: a.security.ids,
    outbox: events,
    audit: a.security.audit,
  };
  return {
    create: (i) => createMandate(a.db, deps, i),
    get: (buyer_id, id) => getMandate(a.db, buyer_id, id),
    revoke: (buyer_id, id) => revokeMandate(a.db, deps, { buyer_id, id }),
    budget: async (i) => {
      const r = await checkMandateBudget(a.db, deps, i);
      // INT-TR0: from here the agent's writes in this request are journaled under this mandate.
      if (r.status === 'active') bindTraceMandate(r.mandate_id);
      return r;
    },
  };
}

function createPurchaseClaims(a: App): PurchaseClaims {
  const sha = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');
  return {
    async begin({ agent_key_id, idempotency_key, fingerprint }) {
      const at = a.security.clock.now().toISOString();
      const hash = sha(fingerprint);
      const made = await a.db.query(
        `INSERT INTO agent_purchases (agent_key_id, idempotency_key, request_hash, state, result, created_at, updated_at)
         VALUES ($1, $2, $3, 'pending', NULL, $4, $4)
         ON CONFLICT (agent_key_id, idempotency_key) DO NOTHING RETURNING idempotency_key`,
        [agent_key_id, idempotency_key, hash, at],
      );
      if (made.rows.length === 1) return { kind: 'new' };
      const r = await a.db.query<{ request_hash: string; state: string; result: unknown }>(
        'SELECT request_hash, state, result FROM agent_purchases WHERE agent_key_id = $1 AND idempotency_key = $2',
        [agent_key_id, idempotency_key],
      );
      const row = r.rows[0];
      if (row === undefined) return { kind: 'in_progress' };
      if (row.request_hash !== hash) return { kind: 'reused' };
      if (row.state === 'done') {
        const result =
          typeof row.result === 'string' ? (JSON.parse(row.result) as unknown) : row.result;
        return { kind: 'done', result };
      }
      return { kind: 'in_progress' };
    },
    async finish({ agent_key_id, idempotency_key, result }) {
      await a.db.query(
        `UPDATE agent_purchases SET state = 'done', result = $3::jsonb, updated_at = $4
          WHERE agent_key_id = $1 AND idempotency_key = $2`,
        [
          agent_key_id,
          idempotency_key,
          JSON.stringify(result),
          a.security.clock.now().toISOString(),
        ],
      );
    },
    async abandon({ agent_key_id, idempotency_key }) {
      await a.db.query(
        `DELETE FROM agent_purchases WHERE agent_key_id = $1 AND idempotency_key = $2 AND state = 'pending'`,
        [agent_key_id, idempotency_key],
      );
    },
  };
}

/** What the key service needs: the database, the clock, the ids, real secret bytes and the audit sink. */
const keyDepsCache = new WeakMap<App, ApiKeyDeps>();
export function apiKeyDeps(a: App): ApiKeyDeps {
  const cached = keyDepsCache.get(a);
  if (cached !== undefined) return cached;
  const made: ApiKeyDeps = {
    db: a.db,
    clock: a.security.clock,
    ids: a.security.ids,
    secrets: cryptoSecretSource(),
    audit: a.security.audit,
  };
  keyDepsCache.set(a, made);
  return made;
}

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
