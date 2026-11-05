// INT-TR0 / TR0.1: the transaction journal's contract. The golden list below is the allow-list of what the
// journal copies (spec section "Tracked columns"). The migration seeds trace_tracked with the same rows and
// trace.golden.test.ts keeps the two equal; nothing outside this list is ever copied into trace_events.
// Ids, states, amounts, currencies, booleans and times are copied as values. A `hashed` column is stored
// only as the sha256 hex of its text. A `digest` list (append-only tables only) is frozen: a column added to
// the table later does not change the digest of a row already journaled.

export const ACTOR_KINDS = [
  'buyer',
  'publisher',
  'operator',
  'agent',
  'api_client',
  'system',
  'paypal',
  'unattributed',
] as const;
export type TraceActorKind = (typeof ACTOR_KINDS)[number];

export const CHANNELS = ['web', 'api', 'mcp', 'job', 'webhook', 'cli', 'seed', 'backfill'] as const;
export type TraceChannel = (typeof CHANNELS)[number];

export const UA_FAMILIES = ['browser', 'curl', 'sdk', 'other'] as const;
export type UaFamily = (typeof UA_FAMILIES)[number];

/** One request, job pass, webhook, CLI run or seed block. Ids and enums only: no name, no raw IP, no User-Agent. */
export interface TraceContext {
  id: string;
  /** When the context was opened (ISO 8601 UTC, from deps.clock). */
  at: string;
  channel: TraceChannel;
  actor_kind: TraceActorKind;
  actor_id: string | null;
  on_behalf_of: string | null;
  mandate_id: string | null;
  mfa: boolean;
  req_id: string | null;
  /** 32 hex characters: a keyed hash of the client address, never the address. */
  ip_hash: string | null;
  ua_family: UaFamily | null;
  api_key_id: string | null;
  job: string | null;
  tool: string | null;
}

export interface TrackedTable {
  readonly table: string;
  /** Columns copied as values, old and new. */
  readonly copied: readonly string[];
  /** Columns stored only as sha256 hex of their text. */
  readonly hashed: readonly string[];
  /** Frozen column list of the source digest (append-only tables); empty for the others. */
  readonly digest: readonly string[];
  /** The column that gives occurred_at when it is set (insert) or changes (update). */
  readonly time: string;
  /** Which chain the row belongs to: `<prefix>:<column or lookup>`, or `plat`. */
  readonly chain: string;
}

const t = (
  table: string,
  copied: readonly string[],
  hashed: readonly string[],
  time: string,
  chain: string,
  digest: readonly string[] = [],
): TrackedTable => ({ table, copied, hashed, digest, time, chain });

export const TRACKED_TABLES: readonly TrackedTable[] = [
  t('access_events', ['kind', 'at', 'source', 'seq'], ['evidence'], 'at', 'ord:entitlement_id', [
    'id',
    'entitlement_id',
    'link_id',
    'kind',
    'at',
    'source',
    'evidence',
    'environment',
    'created_at',
    'updated_at',
    'seq',
  ]),
  t(
    'access_windows',
    ['state', 'started_at', 'ends_at', 'paused_at', 'credit_ms'],
    [],
    'updated_at',
    'ord:entitlement_id',
  ),
  // INT-AL (migration 0025): the state history of an alert. Append-only; the note is only ever a sha256.
  t('alert_events', ['alert_id', 'kind', 'reason_code', 'note_sha256'], [], 'at', 'ord:alert_id', [
    'id',
    'alert_id',
    'kind',
    'reason_code',
    'note_sha256',
    'at',
    'created_at',
    'updated_at',
  ]),
  t('alerts', ['kind', 'order_id', 'unit_id'], ['detail'], 'created_at', 'ord:order_id'),
  // INT-CTL (migration 0026): which API groups partners may call. A control row, changed in place; the changer is only
  // ever a sha256, and the reason is a code from a closed list.
  t('api_exposure', ['enabled', 'changed_at', 'reason_code'], ['changed_by'], 'changed_at', 'plat'),
  t('api_keys', ['key_kind', 'scopes', 'revoked_at'], [], 'created_at', 'key:id'),
  t(
    'approvals',
    ['content_hash', 'used_at', 'expires_at', 'environment'],
    ['snapshot'],
    'updated_at',
    'buy:buyer_id',
  ),
  t(
    'audit_log',
    ['actor_kind', 'actor_id', 'action', 'target'],
    ['reason', 'detail'],
    'created_at',
    'plat',
    [
      'id',
      'actor_kind',
      'actor_id',
      'action',
      'target',
      'reason',
      'detail',
      'created_at',
      'updated_at',
    ],
  ),
  t(
    'entitlements',
    ['money_state', 'access_state', 'licence_state', 'article_id', 'unit_id'],
    ['option', 'policy'],
    'updated_at',
    'ord:unit_id',
  ),
  t(
    'ledger_entries',
    ['kind', 'amount_minor', 'currency', 'capture_id', 'refund_id', 'ref_entry_id'],
    [],
    'created_at',
    'ord:unit_id',
    [
      'id',
      'unit_id',
      'capture_id',
      'kind',
      'amount_minor',
      'currency',
      'refund_id',
      'ref_entry_id',
      'environment',
      'created_at',
      'updated_at',
    ],
  ),
  t('links', ['expires_at', 'uses'], [], 'updated_at', 'ord:entitlement_id'),
  t(
    'mandate_reservations',
    ['amount_minor', 'state', 'order_id', 'settled_at'],
    [],
    'settled_at',
    'mdt:mandate_id',
  ),
  t(
    'mandates',
    [
      'max_total_minor',
      'max_count',
      'max_per_purchase_minor',
      'expires_at',
      'revoked_at',
      'spent_minor',
      'used_count',
      'exhausted_at',
    ],
    [],
    'updated_at',
    'mdt:id',
  ),
  t('offers', ['status'], [], 'updated_at', 'pub:publisher_id'),
  t('operations', ['kind', 'state', 'attempt', 'failure_reason'], [], 'updated_at', 'ord:order_id'),
  t(
    'order_units',
    [
      'status',
      'amount_minor',
      'platform_fee_minor',
      'paypal_fee_minor',
      'refunded_minor',
      'capture_id',
      'captured_verified_at',
      'status_reason',
      'mismatch_reason',
    ],
    ['payee_merchant_id'],
    'updated_at',
    'ord:order_id',
  ),
  t(
    'orders',
    ['status', 'total_minor', 'currency', 'corridor_id', 'order_ref', 'environment'],
    ['expected'],
    'updated_at',
    'ord:id',
  ),
  t(
    'outbound_approvals',
    ['scope', 'operations', 'max_amount_minor', 'max_calls_per_day', 'valid_until'],
    ['approved_by'],
    'updated_at',
    'plat',
  ),
  t('payee_decisions', ['decision', 'operator_id'], ['reason'], 'created_at', 'pub:request_id', [
    'id',
    'request_id',
    'decision',
    'operator_id',
    'reason',
    'created_at',
    'updated_at',
  ]),
  t(
    'provider_calls',
    ['operation', 'method', 'http_status', 'outcome', 'debug_id', 'transport_kind'],
    ['request_redacted', 'response_redacted'],
    'created_at',
    'ord:operation_id',
    [
      'id',
      'operation_id',
      'operation',
      'method',
      'path_template',
      'http_status',
      'outcome',
      'debug_id',
      'duration_ms',
      'transport_kind',
      'request_redacted',
      'response_redacted',
      'environment',
      'created_at',
      'updated_at',
    ],
  ),
  t(
    'provider_orders',
    ['status', 'state', 'provider_order_id', 'publisher_id', 'position', 'first_approved_at'],
    [],
    'updated_at',
    'ord:order_id',
  ),
  t(
    'publisher_applicant_decisions',
    ['decision', 'operator_id'],
    ['reason'],
    'created_at',
    'pub:publisher_id',
    ['id', 'publisher_id', 'decision', 'operator_id', 'reason', 'created_at', 'updated_at'],
  ),
  t(
    'publishers',
    ['status', 'payee_verified_at', 'payee_shared'],
    ['paypal_merchant_id'],
    'updated_at',
    'pub:id',
  ),
  t('receipts', ['version', 'sha256'], ['body'], 'created_at', 'ord:order_id', [
    'id',
    'order_id',
    'version',
    'body',
    'sha256',
    'environment',
    'created_at',
    'updated_at',
  ]),
  t('recovery_actions', ['action', 'actor'], ['detail'], 'at', 'ord:case_id', [
    'id',
    'case_id',
    'action',
    'actor',
    'detail',
    'at',
    'created_at',
    'updated_at',
  ]),
  t(
    'recovery_cases',
    ['kind', 'state', 'order_id', 'sla_due_at', 'credit_ms', 'opened_by'],
    ['buyer_message'],
    'updated_at',
    'ord:order_id',
  ),
  t(
    'refund_requests',
    ['amount_minor', 'currency', 'state', 'refund_id', 'capture_id', 'requested_by'],
    ['reason'],
    'updated_at',
    'ord:unit_id',
  ),
  // BR-2: a rule setting is a control row (refund window, access window, mandate length). Append-only, so it
  // has a frozen source digest; the reason is only ever a sha256; the platform chain holds it.
  t(
    'rule_settings',
    ['rule_key', 'scope_kind', 'scope_id', 'value', 'effective_from', 'effective_until', 'set_by'],
    ['reason'],
    'created_at',
    'plat',
    [
      'id',
      'rule_key',
      'scope_kind',
      'scope_id',
      'value',
      'effective_from',
      'effective_until',
      'set_by',
      'reason',
      'approved_by',
      'created_at',
    ],
  ),
  t('safety_switches', ['on', 'changed_at'], ['reason', 'changed_by'], 'changed_at', 'plat'),
  // webhook_events: the order is found from resource.provider_order_id, else resource.capture_id, else
  // resource.refund_id (R2-8); an event that names no known order goes to the platform chain.
  t(
    'webhook_events',
    ['event_id', 'type', 'verified', 'outcome', 'applied_at'],
    ['resource'],
    'received_at',
    'ord:resource',
  ),
];
