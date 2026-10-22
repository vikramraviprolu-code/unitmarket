import { z } from 'zod';
import { IdSchema, IsoUtcSchema } from './primitives';

export const CaseKindSchema = z.enum([
  'delivery_failed',
  'payment_unresolved',
  'frozen_order',
  'partial_composite',
  'refund_requested',
  'reversal',
]);
export type CaseKind = z.infer<typeof CaseKindSchema>;
export const CaseStateSchema = z.enum([
  'open',
  'diagnosing',
  'restored',
  'closed_not_charged',
  'refund_pending',
  'refunded',
  'closed_no_fault',
  'closed',
]);
export type CaseState = z.infer<typeof CaseStateSchema>;

export const CaseViewSchema = z
  .object({
    case_id: IdSchema,
    kind: CaseKindSchema,
    state: CaseStateSchema,
    order_id: IdSchema.nullable(),
    entitlement_id: IdSchema.nullable(),
    opened_by: z.enum(['system', 'buyer', 'operator']),
    opened_at: IsoUtcSchema,
    buyer_message: z.string(),
    credit_ms: z.number().int().nonnegative(),
  })
  .strict();
export type CaseView = z.infer<typeof CaseViewSchema>;
