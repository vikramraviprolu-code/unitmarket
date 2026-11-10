// API-W0 (F1): the /api/v1 contracts shared by every public API lane: the error envelope, pagination,
// the API key shapes, the payload of each event, and the route registry the OpenAPI document is built
// from. Lanes A, B and C add their request and response schemas and their routes here (additive).
import { z } from 'zod';
import type { ZodType } from 'zod';
import { AccessOptionSchema, RightsSchema } from './catalogue';
import { BriefSchema, FitCardSchema } from './fit';
import { SwitchNameSchema } from './ports';
import {
  CurrencyCodeSchema,
  EnvironmentLabelSchema,
  IdSchema,
  IsoUtcSchema,
  MinorUnitsSchema,
  MoneySchema,
} from './primitives';
import { KeyKindSchema, SCOPES, ScopeSchema } from './principal';
import type { Scope } from './principal';
import { NoMatchReasonSchema, QuoteSchema } from './quote';
import { CaseViewSchema } from './recovery';
import { TxnExportSchema, TxnLinePageSchema, TxnQueryMapSchema } from './txn-query';
import { AGENT_ROUTES } from './v1-agent';
import { ALERT_ROUTES } from './v1-alerts';
import { TRACE_ROUTES } from './v1-trace';

// ---------- error envelope and pagination ----------
/** The existing error body, `{ error: { code, message, support_code, fields? } }` (packages/security errors.ts). */
export const ErrorEnvelopeSchema = z
  .object({
    error: z
      .object({
        code: z.string().min(1).max(100),
        message: z.string().min(1).max(500),
        support_code: z.string().min(1).max(100),
        fields: z.array(z.string().max(200)).max(50).optional(),
      })
      .strict(),
  })
  .strict();

/** `{ items, next_cursor }`; a null cursor means the last page. */
export const pageOf = <T extends ZodType>(item: T) =>
  z
    .object({
      items: z.array(item),
      next_cursor: z.string().min(1).max(500).nullable(),
    })
    .strict();

// ---------- API keys ----------
export const ApiKeyIssueRequestSchema = z
  .object({
    key_kind: KeyKindSchema,
    scopes: z
      .array(ScopeSchema)
      .min(1)
      .max(SCOPES.length)
      .refine((s) => new Set(s).size === s.length, { message: 'scopes must be distinct' }),
  })
  .strict();
export type ApiKeyIssueRequest = z.infer<typeof ApiKeyIssueRequestSchema>;

/** What a list shows about a key. Never the hash and never the secret. */
export const ApiKeyViewSchema = z
  .object({
    id: IdSchema,
    key_kind: KeyKindSchema,
    owner_kind: z.enum(['buyer', 'publisher', 'operator']),
    scopes: z.array(ScopeSchema).min(1),
    created_at: IsoUtcSchema,
    revoked_at: IsoUtcSchema.nullable(),
    last_used_at: IsoUtcSchema.nullable(),
  })
  .strict();
export type ApiKeyView = z.infer<typeof ApiKeyViewSchema>;

/** The answer to an issue: the view plus the token, shown this once and never stored in clear. */
export const ApiKeyIssuedSchema = z
  .object({
    id: IdSchema,
    key_kind: KeyKindSchema,
    owner_kind: z.enum(['buyer', 'publisher', 'operator']),
    scopes: z.array(ScopeSchema).min(1),
    created_at: IsoUtcSchema,
    revoked_at: IsoUtcSchema.nullable(),
    last_used_at: IsoUtcSchema.nullable(),
    token: z.string().min(1).max(200),
  })
  .strict();
export type ApiKeyIssued = z.infer<typeof ApiKeyIssuedSchema>;

// ---------- events ----------
export const EVENT_TYPES = [
  'order.paid',
  'entitlement.granted',
  'sale.recorded',
  'refund.completed',
  'mandate.exhausted',
  'settlement.completed',
] as const;
export const EventTypeSchema = z.enum(EVENT_TYPES);
export type EventType = z.infer<typeof EventTypeSchema>;

// Ids, amounts and times only. No name, address, email or secret ever goes into a payload.
const OrderPaid = z
  .object({
    order_id: IdSchema,
    buyer_id: IdSchema,
    total: MoneySchema,
    paid_at: IsoUtcSchema,
  })
  .strict();
const EntitlementGranted = z
  .object({
    entitlement_id: IdSchema,
    order_id: IdSchema,
    buyer_id: IdSchema,
    unit_id: IdSchema,
    granted_at: IsoUtcSchema,
  })
  .strict();
const SaleRecorded = z
  .object({
    order_id: IdSchema,
    unit_id: IdSchema,
    publisher_id: IdSchema,
    gross: MoneySchema,
    recorded_at: IsoUtcSchema,
  })
  .strict();
const RefundCompleted = z
  .object({
    refund_id: IdSchema,
    order_id: IdSchema,
    unit_id: IdSchema,
    publisher_id: IdSchema,
    amount: MoneySchema,
    completed_at: IsoUtcSchema,
  })
  .strict();
const MandateExhausted = z
  .object({
    mandate_id: IdSchema,
    buyer_id: IdSchema,
    agent_key_id: IdSchema,
    reason: z.enum(['money', 'count']),
    exhausted_at: IsoUtcSchema,
  })
  .strict();
/**
 * A reconciler pass finished over captured PayPal orders: counts checked and fixed. It is not a ledger
 * settlement and carries no amount (the micro-ledger and payouts are never part of this repository).
 */
const SettlementCompleted = z
  .object({
    pass_id: IdSchema,
    checked: MinorUnitsSchema,
    fixed: MinorUnitsSchema,
    completed_at: IsoUtcSchema,
  })
  .strict();

export const EVENT_PAYLOAD_SCHEMAS = {
  'order.paid': OrderPaid,
  'entitlement.granted': EntitlementGranted,
  'sale.recorded': SaleRecorded,
  'refund.completed': RefundCompleted,
  'mandate.exhausted': MandateExhausted,
  'settlement.completed': SettlementCompleted,
} as const satisfies Record<EventType, ZodType>;

const envelope = <T extends EventType>(type: T) =>
  z
    .object({
      id: IdSchema,
      type: z.literal(type),
      payload: EVENT_PAYLOAD_SCHEMAS[type],
      occurred_at: IsoUtcSchema,
    })
    .strict();

/** One event as stored and as delivered: the payload is the one that belongs to the type. */
export const EventEnvelopeSchema = z.discriminatedUnion('type', [
  envelope('order.paid'),
  envelope('entitlement.granted'),
  envelope('sale.recorded'),
  envelope('refund.completed'),
  envelope('mandate.exhausted'),
  envelope('settlement.completed'),
]);
export type EventEnvelope = z.infer<typeof EventEnvelopeSchema>;

// ---------- API-A: buyer, seller and operator endpoints ----------
// Every body below is the body of the matching existing route or Engine function (same fields, same
// meaning); the v1 routes add no business logic. Request bodies are strict, and so are the answers.
const PathId = z.string().min(1).max(200);
const Limit = z.coerce.number().int().min(1).max(50);
const CursorText = z.string().min(1).max(500);

/** The offer a buyer sees. Never the renegotiation floor: that stays the seller's. */
export const OfferSummarySchema = z
  .object({
    offer_id: IdSchema,
    title: z.string(),
    abstract: z.string(),
    publisher: z.string(),
    publisher_slug: z.string(),
    offer_code: z.string(),
    language: z.string(),
    bytes: MinorUnitsSchema,
    currency: CurrencyCodeSchema,
    options: z.array(
      z.object({ option: AccessOptionSchema, price_minor: MinorUnitsSchema }).strict(),
    ),
    min_price_minor: MinorUnitsSchema,
    renegotiation_allowed: z.boolean(),
    rights: RightsSchema,
  })
  .strict();
export type OfferSummary = z.infer<typeof OfferSummarySchema>;

/** `max_price` is the highest lowest-option price, in minor units of the offer currency. */
export const CatalogueSearchQuerySchema = z
  .object({
    q: z.string().max(200).optional(),
    publisher: z.string().min(1).max(64).optional(),
    max_price: z.coerce.number().int().min(0).max(100_000_000).optional(),
    limit: Limit.optional(),
    cursor: CursorText.optional(),
  })
  .strict();
export const CatalogueSearchResponseSchema = pageOf(OfferSummarySchema);

export const OfferIdParamSchema = z.object({ id: PathId }).strict();

export const BriefCreateRequestSchema = z.object({ need: z.string().min(1).max(2000) }).strict();
export const BriefIdParamSchema = z.object({ id: PathId }).strict();

const CeilingCheckSchema = z.object({ ceiling: MoneySchema, price: MoneySchema }).strict();
export const DiscoverResponseSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('proposal'),
      proposal_id: IdSchema,
      items: z.array(
        z
          .object({
            quote: QuoteSchema,
            fit: FitCardSchema,
            title: z.string(),
            publisher: z.string(),
            ceiling_check: CeilingCheckSchema.optional(),
            // CAT-2: the named collection of the offer (with the size of it at the publisher) and, when copies
            // of the same file were collapsed into this item, how many.
            collection: z
              .object({
                name: z.string(),
                size: z.number().int().nonnegative(),
                // True when the cover of the collection is an image (the screen then says photos).
                images: z.boolean(),
              })
              .strict()
              .optional(),
            duplicates_hidden: z.number().int().positive().optional(),
          })
          .strict(),
      ),
    })
    .strict(),
  z
    .object({
      kind: z.literal('no_match'),
      reasons: z.array(NoMatchReasonSchema),
      rate_missing: z.literal(true).optional(),
    })
    .strict(),
]);

export const QuoteRequestSchema = z
  .object({
    publisher: z.string().min(1).max(64),
    offer: z.string().min(1).max(64),
    option: AccessOptionSchema.optional(),
    ceiling_minor: MinorUnitsSchema.optional(),
    proposed_minor: MinorUnitsSchema.optional(),
  })
  .strict();
export const QuoteResponseSchema = z.discriminatedUnion('kind', [
  QuoteSchema,
  z
    .object({
      kind: z.literal('no_match'),
      reason: NoMatchReasonSchema,
      order_ref: IdSchema.optional(),
    })
    .strict(),
]);

export const ApprovalRequestSchema = z
  .object({
    quote_id: z.string().min(1).max(200).optional(),
    proposal_id: z.string().min(1).max(200).optional(),
    offer_ids: z.array(z.string().min(1).max(200)).min(1).max(5).optional(),
    consent: z.object({ terms: z.boolean(), identity_share: z.boolean() }).strict(),
  })
  .strict();
/** The token is in the body, never in a cookie. It is shown here and used once, by POST /orders. */
export const ApprovalIssuedSchema = z
  .object({
    approval_id: IdSchema,
    token: z.string().min(20).max(400),
    expires_at: IsoUtcSchema,
    total_minor: MinorUnitsSchema,
    currency: CurrencyCodeSchema,
    environment: EnvironmentLabelSchema,
    content_hash: z.string().min(1).max(200),
  })
  .strict();

export const OrderPlaceRequestSchema = z
  .object({ approval_id: z.string().min(1).max(200), token: z.string().min(20).max(400) })
  .strict();
export const OrderPlacedSchema = z
  .object({ order_id: IdSchema, order_ref: IdSchema, status: z.string().min(1).max(40) })
  .strict();

/**
 * INT-SR1: the order list takes the raw query map. `limit` and `cursor` alone keep the old paging; any
 * TxnQuery key switches to keyset paging (`parseTxnQuery` drops bad values, so none of them answers 422).
 */
export const OrderListQuerySchema = TxnQueryMapSchema;
export const OrderSummarySchema = z
  .object({
    order_ref: IdSchema,
    status: z.string().min(1).max(40),
    environment: EnvironmentLabelSchema,
    currency: CurrencyCodeSchema,
    total_minor: MinorUnitsSchema,
    created_at: IsoUtcSchema,
  })
  .strict();
export const OrderListSchema = pageOf(OrderSummarySchema);

export const OrderRefParamSchema = z.object({ ref: PathId }).strict();
export const OrderViewSchema = z
  .object({
    order_id: IdSchema,
    order_ref: IdSchema,
    status: z.string(),
    buyer_message: z.string(),
    items: z.array(
      z
        .object({
          article_id: IdSchema,
          title: z.string(),
          access: z.string(),
          publisher: z.string().optional(),
          kind: z.string().optional(),
          line: z.string().optional(),
        })
        .strict(),
    ),
    environment: EnvironmentLabelSchema,
    open_case: z
      .object({ case_id: IdSchema, state: z.string(), buyer_message: z.string() })
      .strict()
      .nullable(),
    refund_line: z.string().nullable(),
  })
  .strict();
export const OrderCancelledSchema = z
  .object({ order_ref: IdSchema, status: z.literal('abandoned'), already: z.boolean() })
  .strict();

export const LibraryEntrySchema = z
  .object({
    entitlement_id: IdSchema,
    article_id: IdSchema,
    title: z.string(),
    publisher: z.string(),
    option: z.string(),
    access: z.string(),
    money: z.string(),
    window: z
      .object({
        state: z.string(),
        started_at: IsoUtcSchema.nullable(),
        ends_at: IsoUtcSchema.nullable(),
        days_left: z.number().int().nullable(),
      })
      .strict(),
    status_text: z.string(),
    refund_note: z.string().nullable(),
    refunded: z.boolean(),
    can_open: z.boolean(),
    order_id: IdSchema.nullable(),
    order_ref: IdSchema.nullable(),
    receipt_versions: z.array(z.number().int()),
    open_case: CaseViewSchema.nullable(),
    environment: EnvironmentLabelSchema,
  })
  .strict();
export const LibraryListSchema = pageOf(LibraryEntrySchema);
export const EntitlementIdParamSchema = z.object({ id: PathId }).strict();
export const LinkIssuedSchema = z
  .object({ url: z.string().min(1).max(500), expires_at: IsoUtcSchema })
  .strict();

// ----- seller -----
const OfferPriceSchema = z.object({ option: AccessOptionSchema, price_minor: z.number() }).strict();
export const SellerOfferSchema = z
  .object({
    offer_id: IdSchema,
    version: z.string(),
    status: z.enum(['draft', 'authorised', 'withdrawn']),
    currency: CurrencyCodeSchema,
    article_id: IdSchema,
    article_title: z.string(),
    article_abstract: z.string(),
    article_language: z.string(),
    article_bytes: MinorUnitsSchema,
    article_sha256: z.string(),
    options: z.array(
      z.object({ option: AccessOptionSchema, price_minor: MinorUnitsSchema }).strict(),
    ),
    valid_until: IsoUtcSchema.nullable(),
    created_at: IsoUtcSchema,
  })
  .strict();
export const SellerOfferListSchema = z
  .object({
    items: z.array(SellerOfferSchema),
    next_cursor: z.null(),
    environment: EnvironmentLabelSchema,
    offer_max_minor: MinorUnitsSchema,
  })
  .strict();
export const SellerOfferCreateRequestSchema = z
  .object({
    article_id: z.string().min(1).max(200),
    options: z.array(OfferPriceSchema).min(1).max(2),
    attestation: z.literal(true),
    /** OFFER-CUR: the currency of the new offer. Absent: USD, then EUR, then GBP, whichever the country is covered in. */
    currency: z.enum(['USD', 'EUR', 'GBP']).optional(),
  })
  .strict();
export const SellerOfferReviseRequestSchema = z
  .object({
    expected_version: z.string().min(1).max(20),
    options: z.array(OfferPriceSchema).min(1).max(2),
    attestation: z.literal(true),
  })
  .strict();
/** DELETE has no body: the version and the reason travel in the query string. */
export const SellerOfferWithdrawQuerySchema = z
  .object({
    expected_version: z.string().min(1).max(20),
    reason: z.string().trim().min(3).max(200),
  })
  .strict();
export const SellerOfferIdParamSchema = z.object({ id: PathId }).strict();
export const SellerOfferResultSchema = z
  .object({ offer_id: IdSchema, version: z.string().min(1).max(20) })
  .strict();
export const SaleRowSchema = z
  .object({
    at: IsoUtcSchema,
    order_ref6: z.string(),
    items: z.array(z.object({ title: z.string(), option: AccessOptionSchema }).strict()),
    amount_minor: MinorUnitsSchema,
    currency: CurrencyCodeSchema,
    paypal_fee_minor: MinorUnitsSchema.nullable(),
    status: z.enum([
      'expected',
      'captured_verified',
      'pending',
      'declined',
      'mismatch',
      'partially_refunded',
      'refunded',
      'reversal_suspected',
      'reversed',
    ]),
    status_text: z.string(),
    environment: EnvironmentLabelSchema,
  })
  .strict();
export const SellerSalesSchema = z
  .object({ items: z.array(SaleRowSchema), next_cursor: z.null() })
  .strict();

// ----- operator (reads only) -----
const OpsOperationCountSchema = z.object({ state: z.string(), count: MinorUnitsSchema }).strict();
const OpsAlertSchema = z.object({ kind: z.string(), created_at: IsoUtcSchema }).strict();
export const OpsOverviewSchema = z
  .object({
    environment: EnvironmentLabelSchema,
    orders: z.array(
      z
        .object({
          order_ref: IdSchema,
          status: z.string(),
          total_minor: MinorUnitsSchema,
          currency: CurrencyCodeSchema,
        })
        .strict(),
    ),
    operations: z.array(OpsOperationCountSchema),
    alerts: z.array(OpsAlertSchema),
    invariants: z.array(z.object({ id: z.string(), ok: z.boolean(), detail: z.string() }).strict()),
    jobs: z.object({ last_pass_at: IsoUtcSchema.nullable(), due: MinorUnitsSchema }).strict(),
  })
  .strict();
export const OpsReconcilerSchema = z
  .object({
    last_pass_at: IsoUtcSchema.nullable(),
    due: MinorUnitsSchema,
    operations: z.array(OpsOperationCountSchema),
    alerts: z.array(OpsAlertSchema),
  })
  .strict();
export const OpsOrderRefParamSchema = z.object({ ref: PathId }).strict();
export const OpsOrderDetailSchema = z
  .object({
    order_ref: IdSchema,
    status: z.string(),
    environment: EnvironmentLabelSchema,
    currency: CurrencyCodeSchema,
    total_minor: MinorUnitsSchema,
    mismatch: z.boolean(),
    created_at: IsoUtcSchema,
    updated_at: IsoUtcSchema,
    units: z.array(
      z
        .object({
          status: z.string(),
          amount_minor: MinorUnitsSchema,
          refunded_minor: MinorUnitsSchema,
        })
        .strict(),
    ),
    provider_orders: z.array(
      z.object({ position: z.number().int().nullable(), state: z.string().nullable() }).strict(),
    ),
    operations: z.array(
      z.object({ kind: z.string(), state: z.string(), attempt: MinorUnitsSchema }).strict(),
    ),
  })
  .strict();
/** Read only. Booleans and words: no scope name, no reference, no credential, no way to change a switch. */
export const OpsSwitchesSchema = z
  .object({
    environment: EnvironmentLabelSchema,
    switches: z.record(SwitchNameSchema, z.boolean()),
    kill_switch: z.object({ outbound_on: z.boolean(), changed_at: z.string() }).strict(),
    gate: z
      .object({
        mode: z.string(),
        connect: z.boolean(),
        approval_ref_set: z.boolean(),
        /** The five locks, or null when the app runs on the dry-run transport (no lock block). */
        locks: z
          .object({
            l1_mode_sandbox: z.boolean(),
            l2_connect_on: z.boolean(),
            l3_approval_active: z.boolean(),
            l4_switch_on: z.boolean(),
            l5_credentials_and_wire_ok: z.boolean(),
          })
          .strict()
          .nullable(),
        open: z.boolean().nullable(),
        blocked_by: z.string().nullable(),
      })
      .strict(),
  })
  .strict();
/**
 * Is the service up (INT-CL1). `revision` is the Cloud Run revision name, null anywhere else; `db` is
 * "up" when the database is open and "closed" in maintenance mode. Nothing here is a secret.
 */
export const StatusSchema = z
  .object({
    ok: z.literal(true),
    environment: EnvironmentLabelSchema,
    revision: z.string().nullable(),
    db: z.enum(['up', 'closed']),
    maintenance: z.literal(true).optional(),
  })
  .strict();
// ---------- webhooks (API-C) ----------
/** Which events each owner kind may subscribe to. The database repeats this as a CHECK. */
export const WEBHOOK_OWNER_EVENTS: Record<
  'buyer' | 'publisher' | 'operator',
  readonly EventType[]
> = {
  buyer: ['order.paid', 'entitlement.granted', 'refund.completed', 'mandate.exhausted'],
  publisher: ['sale.recorded', 'refund.completed'],
  operator: ['settlement.completed'],
};

const MAX_WEBHOOK_URL = 2048;
const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const IPV4 = /^\d+\.\d+\.\d+\.\d+$/;

/** Any whitespace, C0 or C1 control character, or DEL. Such a character would split a header or a log line. */
function hasControlOrSpace(text: string): boolean {
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f) || /\s/.test(ch)) return true;
  }
  return false;
}

/**
 * May this URL be stored as a webhook target? https only, a real DNS name (no IP literal in any
 * spelling, no localhost, no single-label host), no credentials in it, at most 2048 characters. Checked
 * now so that no unsafe target waits for a future HTTP sender. Never throws.
 */
export function isAllowedWebhookUrl(raw: unknown): boolean {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_WEBHOOK_URL) return false;
  if (hasControlOrSpace(raw)) return false;
  if (!/^https:\/\//i.test(raw)) return false;
  const authority = raw.slice('https://'.length).split(/[/?#]/, 1)[0] ?? '';
  if (authority === '' || authority.includes('@')) return false;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') return false;
  const host = url.hostname.replace(/\.$/, '');
  if (host === '' || host.startsWith('[') || IPV4.test(host)) return false;
  if (host === 'localhost' || host.endsWith('.localhost')) return false;
  const labels = host.split('.');
  if (labels.length < 2) return false;
  return labels.every((l) => HOST_LABEL.test(l));
}

export const WebhookUrlSchema = z
  .string()
  .max(MAX_WEBHOOK_URL)
  .refine(isAllowedWebhookUrl, { message: 'must be an https URL with a public host name' });

export const WebhookSubscriptionCreateSchema = z
  .object({
    url: WebhookUrlSchema,
    event_types: z
      .array(EventTypeSchema)
      .min(1)
      .max(EVENT_TYPES.length)
      .refine((t) => new Set(t).size === t.length, { message: 'event_types must be distinct' }),
  })
  .strict();
export type WebhookSubscriptionCreate = z.infer<typeof WebhookSubscriptionCreateSchema>;

/** What a list shows about a subscription. Never the signing secret. */
export const WebhookSubscriptionViewSchema = z
  .object({
    id: IdSchema,
    url: z.string().max(MAX_WEBHOOK_URL),
    event_types: z.array(EventTypeSchema).min(1),
    created_at: IsoUtcSchema,
    disabled_at: IsoUtcSchema.nullable(),
  })
  .strict();
export type WebhookSubscriptionView = z.infer<typeof WebhookSubscriptionViewSchema>;

/** The answer to a create: the view plus the signing secret, shown this once. */
export const WebhookSubscriptionCreatedSchema = WebhookSubscriptionViewSchema.extend({
  signing_secret: z.string().regex(/^whsec_[0-9a-f]{64}$/),
}).strict();
export type WebhookSubscriptionCreated = z.infer<typeof WebhookSubscriptionCreatedSchema>;

export const WEBHOOK_DELIVERY_STATUSES = ['pending', 'delivered', 'failed', 'dead'] as const;
export type WebhookDeliveryStatus = (typeof WEBHOOK_DELIVERY_STATUSES)[number];

/** A delivery as shown: the codes of the spec, never a url, a body, a secret or the receiver's words. */
export const WebhookDeliveryViewSchema = z
  .object({
    id: IdSchema,
    event_id: IdSchema,
    event_type: EventTypeSchema,
    attempt: z.number().int().nonnegative(),
    status: z.enum(WEBHOOK_DELIVERY_STATUSES),
    next_at: IsoUtcSchema.nullable(),
    last_error: z
      .enum([
        'timeout',
        'connection',
        'http_4xx',
        'http_5xx',
        'sender_error',
        'subscription_disabled',
      ])
      .nullable(),
    created_at: IsoUtcSchema,
    updated_at: IsoUtcSchema,
  })
  .strict();
export type WebhookDeliveryView = z.infer<typeof WebhookDeliveryViewSchema>;

/** Who an event is about: the owner ids a subscription is matched against. */
export interface EventAudience {
  buyer_id: string | null;
  publisher_id: string | null;
  order_id: string | null;
  /** True when operators receive it (the event is about the platform, not one buyer or seller). */
  operators: boolean;
}
const NOBODY: EventAudience = {
  buyer_id: null,
  publisher_id: null,
  order_id: null,
  operators: false,
};

/**
 * Reads the audience out of the payload of the given type. A payload that is not the payload of the type
 * has no audience. refund.completed names no buyer: the delivery pass looks the buyer up through the order.
 */
export function eventAudience(type: EventType, payload: unknown): EventAudience {
  const parsed = EVENT_PAYLOAD_SCHEMAS[type].safeParse(payload);
  if (!parsed.success) return { ...NOBODY };
  const p = parsed.data as Record<string, unknown>;
  const str = (k: string): string | null => (typeof p[k] === 'string' ? p[k] : null);
  switch (type) {
    case 'order.paid':
    case 'entitlement.granted':
      return { ...NOBODY, buyer_id: str('buyer_id'), order_id: str('order_id') };
    case 'sale.recorded':
    case 'refund.completed':
      return { ...NOBODY, publisher_id: str('publisher_id'), order_id: str('order_id') };
    case 'mandate.exhausted':
      return { ...NOBODY, buyer_id: str('buyer_id') };
    case 'settlement.completed':
      return { ...NOBODY, operators: true };
  }
}

// ---------- route registry and the OpenAPI document ----------
export interface RouteDoc {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  /** OpenAPI style: `/api/v1/api-keys/{id}`. */
  path: string;
  summary: string;
  /**
   * `session` = a signed-in owner (cookie, CSRF); `apikey` = a bearer key with the listed scopes;
   * `public` = no credentials (API-A: the status route).
   */
  auth: 'session' | 'apikey' | 'public';
  scopes: readonly Scope[];
  /** Where the input is read from: the JSON body, the query string, or nowhere. Path params are separate. */
  input: { in: 'body' | 'query' | 'none'; schema?: ZodType };
  success: { status: 200 | 201; schema: ZodType };
  /** Error statuses this route can answer, besides the ones every route has. */
  errors: readonly (400 | 404 | 409 | 422)[];
}

export const V1_ROUTES: readonly RouteDoc[] = [
  {
    method: 'POST',
    path: '/api/v1/api-keys',
    summary:
      'Issue an API key. The token is in this answer only; a repeat with the same Idempotency-Key returns the key without it.',
    auth: 'session',
    scopes: [],
    input: { in: 'body', schema: ApiKeyIssueRequestSchema },
    success: { status: 201, schema: ApiKeyIssuedSchema },
    errors: [400, 409, 422],
  },
  {
    method: 'GET',
    path: '/api/v1/api-keys',
    summary: 'List your API keys. Never shows a secret or a hash.',
    auth: 'session',
    scopes: [],
    input: { in: 'none' },
    success: { status: 200, schema: pageOf(ApiKeyViewSchema) },
    errors: [],
  },
  {
    method: 'DELETE',
    path: '/api/v1/api-keys/{id}',
    summary: 'Revoke one of your API keys. Another owner key answers 404.',
    auth: 'session',
    scopes: [],
    input: { in: 'none' },
    success: { status: 200, schema: ApiKeyViewSchema },
    errors: [400, 404],
  },
  // ----- API-A: buyer (a key owned by a buyer) -----
  {
    method: 'GET',
    path: '/api/v1/catalogue/search',
    summary:
      'Search the authorised catalogue by words (title and abstract), cheapest first among equals. Filters: publisher, max_price (minor units). Pages with cursor.',
    auth: 'apikey',
    scopes: ['catalogue:read'],
    input: { in: 'query', schema: CatalogueSearchQuerySchema },
    success: { status: 200, schema: CatalogueSearchResponseSchema },
    errors: [400, 422],
  },
  {
    method: 'GET',
    path: '/api/v1/offers/{id}',
    summary: 'One authorised offer: article facts, options with prices, and the rights it carries.',
    auth: 'apikey',
    scopes: ['catalogue:read'],
    input: { in: 'none' },
    success: { status: 200, schema: OfferSummarySchema },
    errors: [404],
  },
  {
    method: 'POST',
    path: '/api/v1/briefs',
    summary: 'Turn a free-text need into a stored brief. 503 ai_off while the AI switch is off.',
    auth: 'apikey',
    scopes: ['catalogue:read'],
    input: { in: 'body', schema: BriefCreateRequestSchema },
    success: { status: 200, schema: BriefSchema },
    errors: [400, 409, 422],
  },
  {
    method: 'POST',
    path: '/api/v1/briefs/{id}/discover',
    summary: 'Find offers for a stored brief of yours: a proposal with fit cards, or no match.',
    auth: 'apikey',
    scopes: ['catalogue:read'],
    input: { in: 'none' },
    success: { status: 200, schema: DiscoverResponseSchema },
    errors: [400, 404, 409, 422],
  },
  {
    method: 'POST',
    path: '/api/v1/quotes',
    summary: 'Quote one offer: the price for an access option, valid for a short time.',
    auth: 'apikey',
    scopes: ['orders:write'],
    input: { in: 'body', schema: QuoteRequestSchema },
    success: { status: 200, schema: QuoteResponseSchema },
    errors: [400, 404, 409, 422],
  },
  {
    method: 'POST',
    path: '/api/v1/approvals',
    summary:
      'Approve a quote or a proposal with your consent. The approval token is in the answer body and is used once by POST /api/v1/orders.',
    auth: 'apikey',
    scopes: ['orders:write'],
    input: { in: 'body', schema: ApprovalRequestSchema },
    success: { status: 201, schema: ApprovalIssuedSchema },
    errors: [400, 404, 409, 422],
  },
  {
    method: 'POST',
    path: '/api/v1/orders',
    summary:
      'Place the order for an approval. One Idempotency-Key places one order, however often it is sent.',
    auth: 'apikey',
    scopes: ['orders:write'],
    input: { in: 'body', schema: OrderPlaceRequestSchema },
    success: { status: 201, schema: OrderPlacedSchema },
    errors: [400, 404, 409, 422],
  },
  {
    method: 'GET',
    path: '/api/v1/orders',
    summary:
      'Your orders, newest first. With no parameters: the order list with cursor. With any filter (TxnQuery: from, to, min_minor, max_minor, currency, status, refund, case, q, ref, channel, sort, dir, limit, cursor): one line per purchased item, paged by keyset.',
    auth: 'apikey',
    scopes: ['orders:read'],
    input: { in: 'query', schema: OrderListQuerySchema },
    success: { status: 200, schema: z.union([OrderListSchema, TxnLinePageSchema]) },
    errors: [400],
  },
  {
    method: 'GET',
    path: '/api/v1/orders/export',
    summary:
      'Your lines under the current filter as CSV text in a JSON answer { filename, csv, truncated }. At most 5000 rows.',
    auth: 'apikey',
    scopes: ['orders:read'],
    input: { in: 'query', schema: TxnQueryMapSchema },
    success: { status: 200, schema: TxnExportSchema },
    errors: [400],
  },
  {
    method: 'GET',
    path: '/api/v1/orders/{ref}',
    summary: 'One of your orders. Another buyer order and a missing one answer the same 404.',
    auth: 'apikey',
    scopes: ['orders:read'],
    input: { in: 'none' },
    success: { status: 200, schema: OrderViewSchema },
    errors: [404],
  },
  {
    method: 'POST',
    path: '/api/v1/orders/{ref}/cancel',
    summary: 'Cancel one of your orders that is still unpaid and has no approved payment.',
    auth: 'apikey',
    scopes: ['orders:write'],
    input: { in: 'none' },
    success: { status: 200, schema: OrderCancelledSchema },
    errors: [404, 409],
  },
  {
    method: 'GET',
    path: '/api/v1/library',
    summary:
      'What you own: one entry per item with its access window and state. Filters: from and to (purchased date), seller, q (item text), access (available, ended, revoked); limit and cursor page.',
    auth: 'apikey',
    scopes: ['library:read'],
    input: { in: 'query', schema: TxnQueryMapSchema },
    success: { status: 200, schema: LibraryListSchema },
    errors: [400],
  },
  {
    method: 'POST',
    path: '/api/v1/library/{id}/link',
    summary: 'A short-lived content link for one item you own.',
    auth: 'apikey',
    scopes: ['library:read'],
    input: { in: 'none' },
    success: { status: 200, schema: LinkIssuedSchema },
    errors: [404],
  },
  // ----- API-A: seller (a key owned by a publisher; the publisher is always the key owner) -----
  {
    method: 'GET',
    path: '/api/v1/seller/offers',
    summary: 'Your offers, with the price cap.',
    auth: 'apikey',
    scopes: ['catalogue:read'],
    input: { in: 'none' },
    success: { status: 200, schema: SellerOfferListSchema },
    errors: [404],
  },
  {
    method: 'POST',
    path: '/api/v1/seller/offers',
    summary: 'Put one of your articles on sale: version 1 of a new offer.',
    auth: 'apikey',
    scopes: ['offers:write'],
    input: { in: 'body', schema: SellerOfferCreateRequestSchema },
    success: { status: 201, schema: SellerOfferResultSchema },
    errors: [400, 404, 409, 422],
  },
  {
    method: 'PATCH',
    path: '/api/v1/seller/offers/{id}',
    summary: 'Revise the prices of your offer. Writes a new version; nothing is changed in place.',
    auth: 'apikey',
    scopes: ['offers:write'],
    input: { in: 'body', schema: SellerOfferReviseRequestSchema },
    success: { status: 200, schema: SellerOfferResultSchema },
    errors: [400, 404, 409, 422],
  },
  {
    method: 'DELETE',
    path: '/api/v1/seller/offers/{id}',
    summary:
      'Take your offer off sale. Writes a withdrawn version; buyers who already approved keep what they saw.',
    auth: 'apikey',
    scopes: ['offers:write'],
    input: { in: 'query', schema: SellerOfferWithdrawQuerySchema },
    success: { status: 200, schema: SellerOfferResultSchema },
    errors: [400, 404, 409, 422],
  },
  {
    method: 'GET',
    path: '/api/v1/seller/sales',
    summary:
      'Your sales, newest first. No buyer identity. With no parameters: every sale. With any filter (TxnQuery without buyer, seller, agent_key, environment, flags), limit or cursor: keyset paging.',
    auth: 'apikey',
    scopes: ['sales:read'],
    input: { in: 'query', schema: TxnQueryMapSchema },
    success: { status: 200, schema: z.union([SellerSalesSchema, TxnLinePageSchema]) },
    errors: [400, 404],
  },
  {
    method: 'GET',
    path: '/api/v1/seller/sales/export',
    summary:
      'Your sales under the current filter as CSV text in a JSON answer. No buyer column. At most 5000 rows.',
    auth: 'apikey',
    scopes: ['sales:read'],
    input: { in: 'query', schema: TxnQueryMapSchema },
    success: { status: 200, schema: TxnExportSchema },
    errors: [400],
  },
  // ----- API-A: operator (reads only; no key ever changes a switch, starts or stops anything) -----
  {
    method: 'GET',
    path: '/api/v1/ops/overview',
    summary: 'Environment, latest orders, operation counts, alerts, invariants and job state.',
    auth: 'apikey',
    scopes: ['ops:read'],
    input: { in: 'none' },
    success: { status: 200, schema: OpsOverviewSchema },
    errors: [404],
  },
  {
    method: 'GET',
    path: '/api/v1/ops/reconciler',
    summary:
      'The job loop: when it last finished a pass, what is due, operation counts and alerts.',
    auth: 'apikey',
    scopes: ['ops:read'],
    input: { in: 'none' },
    success: { status: 200, schema: OpsReconcilerSchema },
    errors: [404],
  },
  {
    method: 'GET',
    path: '/api/v1/ops/orders/{ref}',
    summary:
      'One order as an operator sees it: units, payment orders and operations. No identities.',
    auth: 'apikey',
    scopes: ['ops:read'],
    input: { in: 'none' },
    success: { status: 200, schema: OpsOrderDetailSchema },
    errors: [404],
  },
  {
    method: 'GET',
    path: '/api/v1/ops/transactions',
    summary:
      'Every purchased item with filters and four saved views (view=needs_attention, refunds_today, agent_purchases, sandbox_only). Order refs, amounts, states, flags and opaque ids only: no buyer id, agent key id, buyer or seller name, or provider order id.',
    auth: 'apikey',
    scopes: ['ops:read'],
    input: { in: 'query', schema: TxnQueryMapSchema },
    success: { status: 200, schema: TxnLinePageSchema },
    errors: [400],
  },
  {
    method: 'GET',
    path: '/api/v1/ops/switches',
    summary:
      'The state of every switch and of the payment locks, read only. Stop, start and switch changes are never available to a key.',
    auth: 'apikey',
    scopes: ['ops:read'],
    input: { in: 'none' },
    success: { status: 200, schema: OpsSwitchesSchema },
    errors: [404],
  },
  {
    method: 'GET',
    path: '/api/v1/status',
    summary: 'Is the service up, in which environment. Adds revision and db. Public.',
    auth: 'public',
    scopes: [],
    input: { in: 'none' },
    success: { status: 200, schema: StatusSchema },
    errors: [],
  },
  {
    method: 'POST',
    path: '/api/v1/webhook-subscriptions',
    summary:
      'Subscribe a URL to events your owner kind may receive. The signing secret is in this answer only; a repeat with the same Idempotency-Key returns the subscription without it.',
    auth: 'apikey',
    scopes: ['events:read'],
    input: { in: 'body', schema: WebhookSubscriptionCreateSchema },
    success: { status: 201, schema: WebhookSubscriptionCreatedSchema },
    errors: [400, 409, 422],
  },
  {
    method: 'GET',
    path: '/api/v1/webhook-subscriptions',
    summary:
      'List your newest 100 webhook subscriptions, newest first. Never shows a signing secret.',
    auth: 'apikey',
    scopes: ['events:read'],
    input: { in: 'none' },
    success: { status: 200, schema: pageOf(WebhookSubscriptionViewSchema) },
    errors: [],
  },
  {
    method: 'DELETE',
    path: '/api/v1/webhook-subscriptions/{id}',
    summary:
      'Disable one of your webhook subscriptions. It receives nothing more and its deliveries stay readable. Another owner subscription answers 404.',
    auth: 'apikey',
    scopes: ['events:read'],
    input: { in: 'none' },
    success: { status: 200, schema: WebhookSubscriptionViewSchema },
    errors: [400, 404],
  },
  {
    method: 'GET',
    path: '/api/v1/webhook-subscriptions/{id}/deliveries',
    summary:
      'The newest 100 deliveries of one of your subscriptions: attempt, status, next try and an error code. Never the receiver answer.',
    auth: 'apikey',
    scopes: ['events:read'],
    input: { in: 'none' },
    success: { status: 200, schema: pageOf(WebhookDeliveryViewSchema) },
    errors: [404],
  },
  ...AGENT_ROUTES,
  ...ALERT_ROUTES,
  ...TRACE_ROUTES,
];

const jsonSchema = (schema: ZodType): Record<string, unknown> => {
  const out = z.toJSONSchema(schema, { target: 'draft-2020-12' }) as Record<string, unknown>;
  delete out['$schema'];
  return out;
};

const ERROR_TEXT: Record<number, string> = {
  400: 'A required header is missing or malformed (for example Idempotency-Key).',
  401: 'No valid credentials.',
  403: 'The credentials are valid but may not do this.',
  404: 'Not found.',
  409: 'Conflict with an earlier request.',
  422: 'The request did not match the expected shape.',
  429: 'Too many requests.',
};

const errorResponse = (status: number): Record<string, unknown> => ({
  description: ERROR_TEXT[status] ?? 'Error.',
  content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
});

/**
 * API-A (O6). The existing payment provider webhook, listed as the inbound webhook. It is not a v1 route
 * (nothing here adds, moves or wraps it) and a client never calls it; it is listed so a reader of this file
 * knows which URL the provider posts to. OpenAPI 3.1 keeps inbound calls under `webhooks`, apart from `paths`.
 */
export const INBOUND_WEBHOOK_PATH = '/api/webhooks/paypal' as const;
const INBOUND_WEBHOOKS: Record<string, unknown> = {
  'payment-provider-events': {
    post: {
      summary: 'Inbound payment provider webhook (existing route, unchanged)',
      description: `Served at POST ${INBOUND_WEBHOOK_PATH}. The payment provider calls it, never an API client. The route checks the provider signature over the raw body before it reads anything, answers with an empty JSON body, and is limited per address.`,
      'x-route': INBOUND_WEBHOOK_PATH,
      security: [],
      requestBody: {
        required: true,
        content: { 'application/json': { schema: { type: 'object' } } },
      },
      responses: {
        '200': { description: 'Accepted.' },
        '400': { description: 'The body could not be read.' },
        '401': { description: 'The signature did not verify.' },
        '429': { description: 'Too many requests from this address.' },
      },
    },
  },
};

/** The OpenAPI 3.1 document for the registered routes. Deterministic: same input, same bytes. */
export function buildOpenApiV1(): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const r of V1_ROUTES) {
    const parameters: Record<string, unknown>[] = [];
    for (const name of r.path.matchAll(/\{([^}]+)\}/g))
      parameters.push({
        name: name[1],
        in: 'path',
        required: true,
        schema: { type: 'string', minLength: 1, maxLength: 200 },
      });
    if (r.method !== 'GET')
      parameters.push({
        name: 'Idempotency-Key',
        in: 'header',
        required: true,
        description: '8 to 128 characters of letters, digits, underscore and dash.',
        schema: { type: 'string', pattern: '^[A-Za-z0-9_-]{8,128}$' },
      });
    if (r.auth === 'session' && r.method !== 'GET')
      parameters.push({
        name: 'X-CSRF-Token',
        in: 'header',
        required: true,
        schema: { type: 'string' },
      });
    const statuses = new Set<number>([401, 403, 429, ...r.errors]);
    const responses: Record<string, unknown> = {
      [String(r.success.status)]: {
        description: 'Success.',
        content: { 'application/json': { schema: jsonSchema(r.success.schema) } },
      },
    };
    for (const s of [...statuses].sort((a, b) => a - b)) responses[String(s)] = errorResponse(s);
    const op: Record<string, unknown> = {
      summary: r.summary,
      security:
        r.auth === 'public'
          ? []
          : [r.auth === 'apikey' ? { bearerKey: [...r.scopes] } : { sessionCookie: [] }],
      parameters,
      responses,
    };
    if (r.input.in === 'body' && r.input.schema)
      op['requestBody'] = {
        required: true,
        content: { 'application/json': { schema: jsonSchema(r.input.schema) } },
      };
    if (r.input.in === 'query' && r.input.schema) {
      const schema = jsonSchema(r.input.schema) as { properties?: Record<string, unknown> };
      for (const [name, s] of Object.entries(schema.properties ?? {}))
        parameters.push({ name, in: 'query', required: false, schema: s });
    }
    (paths[r.path] ??= {})[r.method.toLowerCase()] = op;
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'UnitMarket public API',
      version: '1.0.0',
      description:
        'Version 1 of the public API. Runs offline in MVP 1: no payment provider is called by these routes.',
    },
    paths,
    webhooks: INBOUND_WEBHOOKS,
    components: {
      securitySchemes: {
        bearerKey: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'umk_<id>_<secret>',
          description:
            'An API key issued with POST /api/v1/api-keys. Sent as Authorization: Bearer.',
        },
        sessionCookie: {
          type: 'apiKey',
          in: 'cookie',
          name: '__Host-ums_s',
          description: 'The signed-in session of a buyer, publisher or operator.',
        },
      },
      schemas: {
        Error: jsonSchema(ErrorEnvelopeSchema),
        Event: jsonSchema(EventEnvelopeSchema),
      },
    },
  };
}
