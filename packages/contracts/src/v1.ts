// API-W0 (F1): the /api/v1 contracts shared by every public API lane: the error envelope, pagination,
// the API key shapes, the payload of each event, and the route registry the OpenAPI document is built
// from. Lanes A, B and C add their request and response schemas and their routes here (additive).
import { z } from 'zod';
import type { ZodType } from 'zod';
import { IdSchema, IsoUtcSchema, MinorUnitsSchema, MoneySchema } from './primitives';
import { KeyKindSchema, SCOPES, ScopeSchema } from './principal';
import type { Scope } from './principal';

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

// ---------- route registry and the OpenAPI document ----------
export interface RouteDoc {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  /** OpenAPI style: `/api/v1/api-keys/{id}`. */
  path: string;
  summary: string;
  /** `session` = a signed-in owner (cookie, CSRF); `apikey` = a bearer key with the listed scopes. */
  auth: 'session' | 'apikey';
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
      security: [r.auth === 'apikey' ? { bearerKey: [...r.scopes] } : { sessionCookie: [] }],
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
