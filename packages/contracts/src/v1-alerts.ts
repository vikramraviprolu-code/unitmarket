// INT-AL (AL.1, AL.6, AL.7): the operator reads of alerts, the needs-you list and the case queue. Reads only,
// apikey with ops:read. The answers carry order refs, unit ids, amounts, states and ids; never a buyer or a
// publisher identity, never a PayPal id, never the text of a message to a buyer (the SR1 rule).
import { z } from 'zod';
import type { RouteDoc } from './v1';
import { CurrencyCodeSchema, IdSchema, IsoUtcSchema, MinorUnitsSchema } from './primitives';

export const ALERT_SEVERITIES = ['critical', 'high', 'medium', 'info'] as const;
export const AlertSeveritySchema = z.enum(ALERT_SEVERITIES);
export const ALERT_STATES = ['open', 'acknowledged', 'resolved'] as const;
export const AlertStateSchema = z.enum(ALERT_STATES);
export const ALERT_EVENT_KINDS = ['acknowledged', 'resolved', 'auto_resolved', 'reopened'] as const;
export const RESOLVE_REASON_CODES = [
  'fixed_upstream',
  'false_positive',
  'duplicate',
  'accepted_risk',
  'other',
] as const;
export const ResolveReasonCodeSchema = z.enum(RESOLVE_REASON_CODES);
export const MONEY_AT_RISK_KINDS = ['unit_amount', 'order_total', 'refund_amount'] as const;
/** The words of a short note an operator may add to a resolve. It is stored only as a sha256. */
export const RESOLVE_NOTE_MAX = 200;

const Limit = z.coerce.number().int().min(1).max(100);
const Cursor = z.string().min(1).max(500);

export const AlertListQuerySchema = z
  .object({
    state: z.enum(['open', 'acknowledged', 'resolved', 'all']).optional(),
    severity: AlertSeveritySchema.optional(),
    kind: z.string().min(1).max(60).optional(),
    limit: Limit.optional(),
    cursor: Cursor.optional(),
  })
  .strict();

export const MoneyAtRiskSchema = z
  .object({
    kind: z.enum(MONEY_AT_RISK_KINDS),
    minor: MinorUnitsSchema,
    currency: CurrencyCodeSchema,
  })
  .strict();

export const AlertRowSchema = z
  .object({
    id: IdSchema,
    kind: z.string(),
    severity: AlertSeveritySchema,
    title: z.string(),
    cause: z.string(),
    state: AlertStateSchema,
    order_ref: z.string().nullable(),
    unit_id: IdSchema.nullable(),
    money_at_risk: MoneyAtRiskSchema.nullable(),
    case_id: IdSchema.nullable(),
    fix: z.object({ route: z.string(), anchor: z.string() }).strict(),
    next_action: z.string(),
    created_at: IsoUtcSchema,
  })
  .strict();

export const AlertListSchema = z
  .object({
    items: z.array(AlertRowSchema),
    total: MinorUnitsSchema,
    next_cursor: z.string().nullable(),
  })
  .strict();

export const AlertHistoryEntrySchema = z
  .object({
    kind: z.enum(ALERT_EVENT_KINDS),
    reason_code: z.string().nullable(),
    at: IsoUtcSchema,
    actor_kind: z.string().nullable(),
    channel: z.string().nullable(),
  })
  .strict();

export const AlertDetailSchema = AlertRowSchema.extend({
  history: z.array(AlertHistoryEntrySchema),
}).strict();

export const NeedsYouRowSchema = z
  .object({
    kind: z.enum(['open_alerts', 'applicants_waiting', 'payee_checks_waiting', 'caps_near_limit']),
    sentence: z.string().min(1),
    href: z.string().startsWith('/'),
    count: MinorUnitsSchema,
  })
  .strict();
export const NeedsYouSchema = z.object({ items: z.array(NeedsYouRowSchema) }).strict();

export const CASE_ACTIONS = [
  'diagnose',
  'restore',
  'credit',
  'close_not_charged',
  'offer_refund',
  'close_no_fault',
] as const;
export const CaseActionSchema = z.enum(CASE_ACTIONS);

export const CaseListQuerySchema = z
  .object({
    state: z
      .enum([
        'unresolved',
        'open',
        'diagnosing',
        'refund_pending',
        'restored',
        'closed_not_charged',
        'refunded',
        'closed_no_fault',
        'closed',
      ])
      .optional(),
    limit: Limit.optional(),
    cursor: Cursor.optional(),
  })
  .strict();

export const CaseQueueRowSchema = z
  .object({
    case_id: IdSchema,
    kind: z.string(),
    state: z.string(),
    sla_due_at: IsoUtcSchema,
    order_ref: z.string().nullable(),
  })
  .strict();
export const CaseListSchema = z
  .object({
    items: z.array(CaseQueueRowSchema),
    total: MinorUnitsSchema,
    next_cursor: z.string().nullable(),
  })
  .strict();

export const CaseDetailSchema = CaseQueueRowSchema.extend({
  credit_ms: MinorUnitsSchema,
  opened_by: z.string(),
  alerts: z.array(z.object({ alert_id: IdSchema, kind: z.string() }).strict()),
  allowed_actions: z.array(CaseActionSchema),
  /** True when the system has sent the buyer a message. The text is in the OPS-A composition read only. */
  buyer_message_present: z.boolean(),
}).strict();

/** The body of the operator session routes (not under /api/v1). */
export const AlertResolveBodySchema = z
  .object({
    reason_code: ResolveReasonCodeSchema,
    note: z.string().max(RESOLVE_NOTE_MAX).optional(),
  })
  .strict();
export const CaseActionBodySchema = z
  .object({
    action: CaseActionSchema,
    reason: z.string().trim().min(2).max(200),
    credit_ms: z
      .number()
      .int()
      .positive()
      .max(86_400_000 * 30)
      .optional(),
  })
  .strict();

const opsRead = { auth: 'apikey', scopes: ['ops:read'] } as const;

export const ALERT_ROUTES: readonly RouteDoc[] = [
  {
    method: 'GET',
    path: '/api/v1/ops/alerts',
    summary:
      'Alerts with severity, cause, order, unit, money at risk, linked case, fix link and state. Filters state, severity, kind; pages with cursor; total is for the filter.',
    ...opsRead,
    input: { in: 'query', schema: AlertListQuerySchema },
    success: { status: 200, schema: AlertListSchema },
    errors: [400, 422],
  },
  {
    method: 'GET',
    path: '/api/v1/ops/alerts/{id}',
    summary: 'One alert with its history (acknowledged, resolved, auto resolved, reopened).',
    ...opsRead,
    input: { in: 'none' },
    success: { status: 200, schema: AlertDetailSchema },
    errors: [404],
  },
  {
    method: 'GET',
    path: '/api/v1/ops/needs-you',
    summary:
      'Everything that waits on an operator: open alerts, applicants, payee checks, caps near the limit.',
    ...opsRead,
    input: { in: 'none' },
    success: { status: 200, schema: NeedsYouSchema },
    errors: [],
  },
  {
    method: 'GET',
    path: '/api/v1/ops/cases',
    summary: 'The case queue, soonest SLA first. Filter by state; pages with cursor.',
    ...opsRead,
    input: { in: 'query', schema: CaseListQuerySchema },
    success: { status: 200, schema: CaseListSchema },
    errors: [400, 422],
  },
  {
    method: 'GET',
    path: '/api/v1/ops/cases/{id}',
    summary:
      'One case: state, kind, SLA, credit, linked alerts and the actions allowed now. Says only that a message to the buyer exists, never its text.',
    ...opsRead,
    input: { in: 'none' },
    success: { status: 200, schema: CaseDetailSchema },
    errors: [404],
  },
];
