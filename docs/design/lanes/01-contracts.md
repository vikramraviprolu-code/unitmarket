# Lane 01: contracts (shared types, single owner of every cross-package interface)

Task: write `@umsbx/contracts`: zod schemas and TypeScript types for every interface that crosses a package boundary, delivered in three freezes F1, F2, F3.
Package: `packages/contracts` Owner: Sonnet worker W-01 Reviewer: Opus 5.5 (interface owner of record: the coordinator; changes after a freeze go through a contracts change request, CCR, reviewed by Opus)
Wave: 1 (starts after lane 00 merges). Size: 5 h (F1 by hour 1.5, F2 by hour 3, F3 by hour 5; each freeze is its own commit and merge).

## Goal
Every package in SBX imports shared shapes only from here, so lanes can be built in parallel against exact text. The types below are the contract: names, fields, unions and literal values are fixed. Every object type has a zod schema named `<Type>Schema` with `.strict()`, and the TypeScript type is `z.infer` of it; function and port interfaces are plain TypeScript. No runtime logic beyond schemas and small pure guards.

## Inputs
- `docs/design/architecture.md` sections 3, 4, 5, 7, 8, 9 (BASELINE v1.0).
- Copy and adapt (simulation repo `/home/user/AIC_Hackathon_UnitMarket` at `a36ddc03fd0b962000f686291c145b50ee337f90`, read only, never import): `packages/contracts/src/primitives.ts` (the `id` primitive with its control and zero-width character rules, `isoDatetime`, `sha256`, `currency`), `packages/contracts/src/ports.ts` (Result, ok, err, SqlExecutor, Database, Clock, ModelPort, BriefParse and PackCompose schemas), `snapshot.ts`, `approval.ts`, `expected-transaction.ts`, `payment-operation.ts`, `entitlement.ts` (money, access, licence enums and transition shape). Add the provenance header to each adapted file.
- Dependency: `zod` (approved, D-4).

## Outputs
`packages/contracts/src/{primitives,result,ports,actor,transport,paypal,corridor,catalogue,quote,approval,payments,entitlements,access,ledger,receipts,recovery,fit,config,deps,index}.ts`, one `*.test.ts` per file, `src/index.ts` re-exporting all. Subpath exports: none (single entry).

## Interfaces (exact)

F1: primitives, result, ports, actor
```ts
export type Id = string;            // copied `id` primitive: 1..200 chars, no edge whitespace, no control or zero-width chars
export type MinorUnits = number;    // integer >= 0
export type CurrencyCode = string;  // ^[A-Z]{3}$
export type IsoUtc = string;        // ISO 8601 with Z only
export type Sha256Hex = string;     // ^[a-f0-9]{64}$
export type EnvironmentLabel = 'dryrun' | 'sandbox';
export interface Money { currency: CurrencyCode; minor: MinorUnits }
export type Ok<T> = { ok: true; value: T }; export type Err<E> = { ok: false; error: E };
export type Result<T, E> = Ok<T> | Err<E>; export const ok: <T>(v: T) => Ok<T>; export const err: <E>(e: E) => Err<E>;

export interface SqlExecutor { query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>; exec(sql: string): Promise<void> }
export interface Database extends SqlExecutor { readonly dialect: 'pglite' | 'pg'; transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T> }
export interface Clock { now(): Date }
export type IdPrefix = 'ord' | 'unt' | 'pvo' | 'opr' | 'ent' | 'apr' | 'quo' | 'lnk' | 'aev' | 'led' | 'rct' | 'cas' | 'cac' | 'rfr' | 'brf' | 'prp' | 'pub' | 'art' | 'ofr' | 'buy' | 'ses' | 'alr' | 'pcl' | 'whk' | 'aud' | 'oap';
export interface Ids { next(prefix: IdPrefix): Id /* `${prefix}_${26 base32 chars of 128 random bits}` */; nonce(): string /* 32 hex chars, 128 bits */ }
export interface Secret { reveal(): string; toString(): '[redacted]'; toJSON(): '[redacted]' }
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export interface LogEvent { msg: string; level: LogLevel; fields: Record<string, string | number | boolean | null> }
export interface Logger { log(e: LogEvent): void; child(fields: LogEvent['fields']): Logger }
export interface AuditEntry { actor: Actor; action: string; target: Id | null; reason: string | null; detail: Record<string, string | number | boolean | null> }
export interface AuditSink { record(tx: SqlExecutor, e: AuditEntry): Promise<void> }
export interface ContentHead { bytes: number; sha256: Sha256Hex; mime: string }
export interface ContentStore { head(key: string): Promise<ContentHead | null>; open(key: string): Promise<AsyncIterable<Uint8Array> | null>; health(): Promise<boolean> }
export type ModelPurpose = 'brief_parse' | 'pack_compose';
export interface ModelRequest { purpose: ModelPurpose; system: string; input: unknown }
export type ModelResponse = { kind: 'ok'; output: unknown; input_tokens: number; output_tokens: number } | { kind: 'error'; reason: string };
export interface ModelPort { readonly model_id: string; complete(r: ModelRequest): Promise<ModelResponse> }
export type SwitchName = 'paypal_outbound' | 'checkout_enabled' | 'refunds_enabled' | 'unlock_enabled' | 'ai_enabled' | 'webhook_enabled';
export interface SwitchReader { isOn(name: SwitchName): Promise<boolean> }
export type Actor = { kind: 'buyer'; buyer_id: Id } | { kind: 'publisher'; publisher_id: Id } | { kind: 'operator'; operator_id: Id; mfa: boolean } | { kind: 'system' };
```

F2: transport and PayPal port
```ts
export type PayPalOperation = 'oauth_token' | 'create_order' | 'get_order' | 'capture_order' | 'get_capture' | 'refund_capture' | 'get_refund' | 'verify_webhook_postback' | 'fetch_webhook_cert';
export interface OutboundRequest { operation: PayPalOperation; method: 'GET' | 'POST'; path: string; headers: Record<string, string>; body: string | null; order_ref: Id | null; amount_minor: MinorUnits | null; scenario: string | null /* dry-run fixture selector; ignored by the sandbox transport */ }
export type BlockReason = 'connect_off' | 'kill_switch' | 'no_approval' | 'budget' | 'egress' | 'dry_run_miss';
export type TransportResult = { kind: 'response'; status: number; headers: Record<string, string>; body: string; duration_ms: number } | { kind: 'timeout' } | { kind: 'network_error'; code: string } | { kind: 'blocked'; by: BlockReason };
export interface Transport { readonly kind: EnvironmentLabel; send(r: OutboundRequest): Promise<TransportResult> }
export type GateVerdict = { allowed: true; approval_ref: string } | { allowed: false; by: 'connect_off' | 'kill_switch' | 'no_approval' | 'budget' };
export interface OutboundGate { check(c: { operation: PayPalOperation; amount_minor: MinorUnits | null }): Promise<GateVerdict> }

export type ProviderOrderId = string; // ^[A-Z0-9]{1,36}$
export type ProviderOrderStatus = 'CREATED' | 'SAVED' | 'APPROVED' | 'VOIDED' | 'COMPLETED' | 'PAYER_ACTION_REQUIRED';
export type CaptureStatus = 'COMPLETED' | 'DECLINED' | 'PARTIALLY_REFUNDED' | 'PENDING' | 'REFUNDED' | 'FAILED';
export type RefundStatus = 'CANCELLED' | 'FAILED' | 'PENDING' | 'COMPLETED';
export type PayPalFail =
  | { kind: 'rejected'; http: 400 | 403 | 422; name: string; issue: string | null; debug_id: string | null }
  | { kind: 'not_found'; debug_id: string | null }
  | { kind: 'in_progress'; debug_id: string | null }
  | { kind: 'payer_action'; redirect_url: string | null; debug_id: string | null }
  | { kind: 'unavailable'; retry_after_ms: number | null }
  | { kind: 'timeout' }
  | { kind: 'blocked'; by: BlockReason };
export interface CreateOrderUnit { reference_id: Id; payee_merchant_id: string | null; amount: Money }
export interface CreateOrderReq { request_id: string /* <= 108 chars */; order_ref: Id; units: CreateOrderUnit[] /* 1..10, one currency */; return_url: string; cancel_url: string; scenario: string | null }
export type CreateOrderRes = { kind: 'created'; provider_order_id: ProviderOrderId; status: ProviderOrderStatus; approve_url: string; debug_id: string | null } | PayPalFail;
export interface CapturedPart { capture_id: string; status: CaptureStatus; status_reason: string | null; paypal_fee_minor: MinorUnits | null; refunded_minor: MinorUnits }
export interface OrderReadUnit { reference_id: Id; payee_merchant_id: string | null; amount: Money; capture: CapturedPart | null }
export type OrderRead = { kind: 'order'; provider_order_id: ProviderOrderId; status: ProviderOrderStatus; custom_id: string | null; read_at: IsoUtc; debug_id: string | null; units: OrderReadUnit[] } | PayPalFail;
export interface ClaimUnit { reference_id: Id; capture_id: string | null; status: CaptureStatus | null }
export type CaptureRes = { kind: 'claim'; http: 200 | 201 | 202 | 207; provider_order_id: ProviderOrderId; units: ClaimUnit[]; debug_id: string | null } | PayPalFail;
export type CaptureRead = { kind: 'capture'; capture: CapturedPart; amount: Money; read_at: IsoUtc; debug_id: string | null } | PayPalFail;
export interface RefundReq { capture_id: string; request_id: string; amount: Money | null /* null = full remaining */; note: string }
export type RefundRes = { kind: 'refund'; refund_id: string; status: RefundStatus; amount: Money; capture_id: string | null; debug_id: string | null } | PayPalFail;
export type ProviderEventType = 'PAYMENT.CAPTURE.COMPLETED' | 'PAYMENT.CAPTURE.PENDING' | 'PAYMENT.CAPTURE.DECLINED' | 'PAYMENT.CAPTURE.DENIED' | 'PAYMENT.CAPTURE.REFUNDED' | 'PAYMENT.CAPTURE.REVERSED' | 'CHECKOUT.ORDER.APPROVED' | 'CHECKOUT.PAYMENT-APPROVAL.REVERSED' | 'OTHER';
export interface ProviderEvent { event_id: string; transmission_id: string; type: ProviderEventType; provider_order_id: ProviderOrderId | null; capture_id: string | null; refund_id: string | null; occurred_at: IsoUtc }
export type WebhookVerdict = { kind: 'verified'; event: ProviderEvent } | { kind: 'bad_signature'; why: string } | { kind: 'malformed' } | { kind: 'unverifiable' };
export interface PayPalPort {
  readonly environment: EnvironmentLabel;
  createOrder(r: CreateOrderReq): Promise<CreateOrderRes>;
  getOrder(id: ProviderOrderId, scenario?: string | null): Promise<OrderRead>;
  captureOrder(r: { provider_order_id: ProviderOrderId; request_id: string; scenario?: string | null }): Promise<CaptureRes>;
  getCapture(capture_id: string, scenario?: string | null): Promise<CaptureRead>;
  refundCapture(r: RefundReq): Promise<RefundRes>;            // MVP-C; MVP-A implements against fixtures only
  getRefund(refund_id: string): Promise<RefundRes>;           // MVP-C
  verifyWebhook(w: { headers: Record<string, string>; raw_body: string }): Promise<WebhookVerdict>; // MVP-C
}
```

F3: domain
```ts
export type CorridorId = string; // e.g. 'us-usd'
export interface Corridor { id: CorridorId; currency: CurrencyCode; minor_units: 0 | 2 | 3; buyer_countries: string[]; payee_countries: string[]; domestic_supported: boolean; min_charge_minor: MinorUnits | null; enabled: boolean }
export type AccessOption = 'keep_retrieve' | 'online_read';
export interface AccessPolicy { id: Id; version: string; option: AccessOption; window_ms: number /* 432000000 */; start_rule: 'payment_verified_and_delivery_ready' }
export interface Rights { scope: 'personal_use'; ai_scope: 'agent_allowed' | 'review' | 'not_allowed'; redistribution: false }
export interface OfferOption { option: AccessOption; price_minor: MinorUnits; policy_id: Id; policy_version: string }
export interface Affordability { renegotiation_allowed: boolean; floor_minor: MinorUnits | null }
export interface Offer { id: Id; version: string; publisher_id: Id; article_id: Id; status: 'draft' | 'authorised' | 'withdrawn'; currency: CurrencyCode; options: OfferOption[]; affordability: Affordability; terms_version: string; rights: Rights; valid_from: IsoUtc; valid_until: IsoUtc | null; superseded_by: Id | null }
export interface ArticleFacts { id: Id; publisher_id: Id; title: string; abstract: string; language: string; topics: string[]; published_at: IsoUtc; sha256: Sha256Hex; content_key: string }
export interface PublisherFacts { id: Id; slug: string; display_name: string; country: string; payee_merchant_id: string | null; payee_verified_at: IsoUtc | null }
export type NoMatchReason = 'above_ceiling' | 'withdrawn' | 'not_authorised' | 'corridor_unsupported' | 'already_owned' | 'below_publisher_floor' | 'option_not_offered';
export interface Quote { kind: 'quote'; quote_id: Id; offer_id: Id; offer_version: string; option: AccessOption; price: Money; corridor_id: CorridorId; expires_at: IsoUtc; source: 'direct' | 'wordpress' | 'discovery' }
export interface NoMatch { kind: 'no_match'; reason: NoMatchReason }
export interface SnapshotItem { article_id: Id; article_sha256: Sha256Hex; offer_id: Id; offer_version: string; terms_version: string; publisher_id: Id; payee_merchant_id: string; option: AccessOption; policy: AccessPolicy; rights: Rights; amount_minor: MinorUnits }
export interface SnapshotPublisher { publisher_id: Id; payee_merchant_id: string; amount_minor: MinorUnits; platform_fee_minor: 0 }
export interface ApprovalSnapshot { snapshot_version: '1'; items: SnapshotItem[]; publishers: SnapshotPublisher[]; total_minor: MinorUnits; currency: CurrencyCode; corridor_id: CorridorId; reader: { buyer_id: Id }; rule_version: string; pricing_rule_version: string }
// schema refinements (copy from snapshot.ts): unique article ids; each item's publisher block exists with equal payee; publisher amounts equal item sums; total equals publisher sum; one currency.
export interface Approval { approval_id: Id; buyer_id: Id; snapshot: ApprovalSnapshot; content_hash: Sha256Hex; nonce: string; created_at: IsoUtc; expires_at: IsoUtc /* created + 15 min */; used_at: IsoUtc | null; environment: EnvironmentLabel }
export const APPROVAL_TTL_MS = 900000;
export interface ExpectedUnit { reference_id: Id; publisher_id: Id; payee_merchant_id: string; amount_minor: MinorUnits }
export interface ExpectedTransaction { order_ref: Id; buyer_id: Id; content_hash: Sha256Hex; currency: CurrencyCode; total_minor: MinorUnits; units: ExpectedUnit[]; created_at: IsoUtc; environment: EnvironmentLabel }
export type OperationKind = 'create' | 'capture' | 'readback' | 'refund' | 'refund_readback';
export type OperationState = 'prepared' | 'sent' | 'unknown' | 'confirmed' | 'failed';
export type OperationFailure = 'declined' | 'mismatch' | 'unparseable' | 'window_expired' | 'invalid_request' | 'rejected';
export type OrderStatus = 'created' | 'awaiting_buyer' | 'capture_requested' | 'capture_claimed' | 'unresolved' | 'paid' | 'paid_partial' | 'failed' | 'abandoned' | 'frozen';
export type UnitStatus = 'expected' | 'captured_verified' | 'pending' | 'declined' | 'mismatch' | 'partially_refunded' | 'refunded' | 'reversal_suspected' | 'reversed';
export type MoneyState = 'pending' | 'captured' | 'denied' | 'refunded' | 'reversed' | 'unknown';
export type MoneyEvent = 'capture_verified' | 'pending' | 'declined' | 'unknown' | 'refund_verified' | 'reversal_verified';
export type AccessState = 'locked' | 'available' | 'ended' | 'revoked';
export type LicenceState = 'granted' | 'terminated';
export type MatchField = 'provider_order_id' | 'reference' | 'currency' | 'extra_unit' | 'reference_id' | 'payee' | 'amount' | 'capture_id' | 'capture_id_reused' | 'read_before_claim';
export type UnitMatch = { reference_id: Id; result: 'matched' | 'pending' | 'declined' | 'no_capture' | 'mismatch'; field: MatchField | null; status: CaptureStatus | null };
export type MatchResult = { level: 'order'; ok: false; field: MatchField } | { level: 'units'; ok: true; units: UnitMatch[] };
export type WindowStateName = 'not_started' | 'running' | 'paused' | 'ended' | 'revoked';
export interface WindowState { state: WindowStateName; started_at: IsoUtc | null; base_ends_at: IsoUtc | null; ends_at: IsoUtc | null; paused_at: IsoUtc | null; credit_ms: number }
export type AccessEventKind = 'access_ready' | 'link_issued' | 'download_completed' | 'download_aborted' | 'reader_rendered' | 'reader_beacon' | 'delivery_failed' | 'delivery_restored' | 'credit_granted' | 'window_ended' | 'revoked';
export interface AccessEvent { entitlement_id: Id; kind: AccessEventKind; at: IsoUtc; source: 'system' | 'buyer' | 'operator'; evidence: Record<string, string | number | boolean | null> }
export type LedgerKind = 'sale' | 'paypal_fee' | 'platform_fee' | 'refund' | 'reversal' | 'commission_reversal';
export interface LedgerEntryInput { unit_id: Id; capture_id: string; kind: LedgerKind; amount: Money; refund_id: string | null; ref_entry_id: Id | null }
export interface LedgerEntry extends LedgerEntryInput { id: Id; created_at: IsoUtc; environment: EnvironmentLabel }
export interface ReceiptLine { article_id: Id; article_sha256: Sha256Hex; option: AccessOption; amount_minor: MinorUnits; capture_id: string | null; window: WindowState; delivery: { kind: AccessEventKind; at: IsoUtc }[] }
export interface Receipt { receipt_id: Id; order_id: Id; version: number; snapshot: ApprovalSnapshot; content_hash: Sha256Hex; lines: ReceiptLine[]; refunds: { refund_id: string; amount: Money; at: IsoUtc }[]; debug_ids: string[]; sha256: Sha256Hex; created_at: IsoUtc; environment: EnvironmentLabel }
export type CaseKind = 'delivery_failed' | 'payment_unresolved' | 'frozen_order' | 'partial_composite' | 'refund_requested' | 'reversal';
export type CaseState = 'open' | 'diagnosing' | 'restored' | 'closed_not_charged' | 'refund_pending' | 'refunded' | 'closed_no_fault' | 'closed';
export interface CaseView { case_id: Id; kind: CaseKind; state: CaseState; order_id: Id | null; entitlement_id: Id | null; opened_by: 'system' | 'buyer' | 'operator'; opened_at: IsoUtc; buyer_message: string; credit_ms: number }
export interface FitDimension { key: 'topic' | 'budget' | 'access' | 'language' | 'recency'; label: string; level: 0 | 1 | 2 | 3 | null; basis: 'keyword_overlap' | 'price_vs_ceiling' | 'option_offered' | 'language_equal' | 'publish_date'; evidence: string }
export interface FitCard { offer_id: Id; dimensions: FitDimension[]; band: 'strong' | 'good' | 'partial' | null }
export interface Brief { brief_id: Id; buyer_id: Id; need: string; ceiling: Money | null; option: AccessOption | null; language: string | null; terms: string[]; created_at: IsoUtc }

export interface DomainConfig {
  reconcile_window_ms: number;        // 86400000
  reconcile_backoff_ms: readonly number[]; // [30000, 120000, 600000, 3600000]
  idem_safe_window_ms: number;        // 18000000 (5 h; PayPal keeps keys 6 h)
  abandoned_checkout_ms: number;      // 86400000
  operation_lease_ms: number;         // 60000
  max_capture_retries: number;        // 1
  link_ttl_ms: number;                // 600000
  public_origin: string;              // https origin, or http://localhost in offline mode
  approval_secret: Secret; link_secret: Secret;
  rule_version: string; pricing_rule_version: string;
}
export interface CoreDeps { db: Database; clock: Clock; ids: Ids; log: Logger; audit: AuditSink; switches: SwitchReader; config: DomainConfig; environment: EnvironmentLabel }
export interface PaymentsDeps extends CoreDeps { paypal: PayPalPort; content: ContentStore }
export interface AgentDeps extends CoreDeps { model: ModelPort } // never carries paypal or content
```

## Acceptance tests (`corepack pnpm vitest run --project unit packages/contracts`)
- `id rejects control, zero-width, edge whitespace, 201 chars` (copied cases pass).
- `IsoUtc accepts Z only; rejects +00:00`.
- `Money rejects floats, negatives, lowercase currency`.
- `ProviderOrderId rejects lowercase and 37 chars` (path-injection guard, architecture 7.1).
- `ApprovalSnapshot refinements`: duplicate article, payee differs from publisher block, publisher sum, total sum, two currencies: each refused (A-08, A-09).
- `Approval expires_at equals created_at + 15 min`.
- `CaptureStatus has no REVERSED; ProviderOrderStatus has SAVED and PAYER_ACTION_REQUIRED` (VERIFIED enums).
- `EnvironmentLabel has exactly dryrun and sandbox` (no `live`, P15, A-22).
- `every schema is strict` (an extra key is refused: mass-assignment guard).
- `index exports every name listed in this spec` (snapshot of export names).
- `pnpm typecheck` and `pnpm lint` exit 0.

## Security and NFR gates
P5 (shapes for snapshot match), P15 (no live label), P16 (environment label), SOP 7 (strict input), MAINT-2.

## Do not
Add runtime behaviour, I/O or a dependency beyond `zod`; import any other `@umsbx` package; rename anything above without a CCR; connect to PayPal; put any secret or example credential in tests.

Branch `feat/contracts-shared-types` Commit `feat(contracts): shared types F1 to F3 (SBX-A-01)`.
