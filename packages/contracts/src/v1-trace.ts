// INT-TR1 / TR1.3: the contracts of the timeline routes, the operator verify route, the activity log and the
// evidence pack. The entry shape is the one UI0's TimelineEntryView mirrors (apps/web/src/lib/timeline-view.ts);
// a type-level test keeps them assignable. Ids and enums only. No identity appears in the buyer, seller or
// operator key answers; the extra fields of the operator entry are filled only by operatorView (domain/trace).
import { z } from 'zod';
import type { RouteDoc } from './v1';
import { ACTOR_KINDS, CHANNELS } from './trace';
import { IsoUtcSchema } from './primitives';

const Name = z.string().min(1).max(200);

/** The `{unit}` path parameter of the seller timeline. */
export const SellerUnitParamSchema = z.object({ unit: Name }).strict();

export const TimelineEntrySchema = z
  .object({
    at: IsoUtcSchema,
    seq: z.number().int().min(1),
    event_type: Name,
    words_key: Name,
    actor: z.object({ kind: z.enum(ACTOR_KINDS), label: Name }).strict(),
    channel: z.enum(CHANNELS),
    amount_minor: z.number().int().optional(),
    state_from: Name.optional(),
    state_to: Name.optional(),
    source: z.object({ table: Name, id: Name }).strict(),
    verified: z.boolean(),
  })
  .strict();
// An optional field is absent, never undefined, so the type fits UI0's TimelineEntryView under exactOptionalPropertyTypes.
type Exact<T> = { [K in keyof T as undefined extends T[K] ? never : K]: T[K] } & {
  [K in keyof T as undefined extends T[K] ? K : never]?: Exclude<T[K], undefined>;
};
export type TimelineEntry = Exact<z.infer<typeof TimelineEntrySchema>>;

/** A timeline is capped at 500 entries (`truncated`) and is not paged. */
export const TimelineAnswerSchema = z
  .object({ entries: z.array(TimelineEntrySchema).max(500), truncated: z.boolean() })
  .strict();
export type TimelineAnswer = z.infer<typeof TimelineAnswerSchema>;

/** The operator entry: the same fields, plus what an operator may see. The MFA-only fields come last. */
export const OpsTimelineEntrySchema = TimelineEntrySchema.extend({
  chain_key: Name.optional(),
  job: Name.nullable().optional(),
  tool: Name.nullable().optional(),
  details: z.record(z.string(), z.unknown()).optional(),
  actor_id: Name.optional(),
  req_id: Name.nullable().optional(),
  ip_hash: z.string().max(8).nullable().optional(),
  ua_family: z.string().max(20).nullable().optional(),
  api_key_id: Name.nullable().optional(),
  mfa: z.boolean().optional(),
}).strict();
export type OpsTimelineEntry = z.infer<typeof OpsTimelineEntrySchema>;

export const OpsTimelineAnswerSchema = z
  .object({ entries: z.array(OpsTimelineEntrySchema).max(500), truncated: z.boolean() })
  .strict();
export type OpsTimelineAnswer = z.infer<typeof OpsTimelineAnswerSchema>;

/** Counts only: no row, no chain key beyond the first broken one, no value. */
export const TraceVerifySchema = z
  .object({
    ok: z.boolean(),
    chains: z.number().int().min(0),
    rows: z.number().int().min(0),
    seals: z.number().int().min(0),
    drift: z.number().int().min(0),
    first_broken: z.string().max(300).optional(),
  })
  .strict();
export type TraceVerify = z.infer<typeof TraceVerifySchema>;

export const TRACE_ROUTES: readonly RouteDoc[] = [
  {
    method: 'GET',
    path: '/api/v1/orders/{ref}/timeline',
    summary:
      'The steps of one of your orders in time order, in plain words, with who did each and how. Another buyer order answers 404.',
    auth: 'apikey',
    scopes: ['orders:read'],
    input: { in: 'none' },
    success: { status: 200, schema: TimelineAnswerSchema },
    errors: [404],
  },
  {
    method: 'GET',
    path: '/api/v1/seller/sales/{unit}/timeline',
    summary:
      'The steps of one of your sold units. It shows only your unit and its amount, never the buyer or another seller. Another seller unit answers 404.',
    auth: 'apikey',
    scopes: ['sales:read'],
    input: { in: 'none' },
    success: { status: 200, schema: TimelineAnswerSchema },
    errors: [404],
  },
  {
    method: 'GET',
    path: '/api/v1/ops/orders/{ref}/timeline',
    summary:
      'Every step of one order as an operator key sees it: actor kind, channel, job and tool. No buyer or seller identity and no provider id.',
    auth: 'apikey',
    scopes: ['ops:read'],
    input: { in: 'none' },
    success: { status: 200, schema: OpsTimelineAnswerSchema },
    errors: [404],
  },
  {
    method: 'GET',
    path: '/api/v1/ops/trace/verify',
    summary:
      'Checks the whole journal (chains, heads, seals, digests, drift) and answers counts only.',
    auth: 'apikey',
    scopes: ['ops:read'],
    input: { in: 'none' },
    success: { status: 200, schema: TraceVerifySchema },
    errors: [],
  },
];
