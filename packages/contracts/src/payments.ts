// Origin: AIC_Hackathon_UnitMarket@a36ddc03fd0b962000f686291c145b50ee337f90:packages/contracts/src/payment-operation.ts. Adapted; owned by SBX.
// State names for payment operations, orders, units and money events (architecture section 4).
import { z } from 'zod';
import { CaptureStatusSchema } from './paypal';
import { IdSchema } from './primitives';

export const OperationKindSchema = z.enum([
  'create',
  'capture',
  'readback',
  'refund',
  'refund_readback',
]);
export type OperationKind = z.infer<typeof OperationKindSchema>;
export const OperationStateSchema = z.enum(['prepared', 'sent', 'unknown', 'confirmed', 'failed']);
export type OperationState = z.infer<typeof OperationStateSchema>;
export const OperationFailureSchema = z.enum([
  'declined',
  'mismatch',
  'unparseable',
  'window_expired',
  'invalid_request',
  'rejected',
]);
export type OperationFailure = z.infer<typeof OperationFailureSchema>;
export const OrderStatusSchema = z.enum([
  'created',
  'awaiting_buyer',
  'capture_requested',
  'capture_claimed',
  'unresolved',
  'paid',
  'paid_partial',
  'failed',
  'abandoned',
  'frozen',
]);
export type OrderStatus = z.infer<typeof OrderStatusSchema>;
export const UnitStatusSchema = z.enum([
  'expected',
  'captured_verified',
  'pending',
  'declined',
  'mismatch',
  'partially_refunded',
  'refunded',
  'reversal_suspected',
  'reversed',
]);
export type UnitStatus = z.infer<typeof UnitStatusSchema>;
/**
 * The states of a refund request (UI0.5). `refund_requests.state` has no database CHECK (migration 0004
 * line 220), so this list is read from the values domain/payments/src/refunds.ts writes: the OPEN and
 * IN_FLIGHT sets (lines 75 and 78) name 'requested', 'sent', 'unknown', 'pending' and 'unresolved'; the
 * insert writes 'requested' (283 to 284); 'cancelled' (342, 916), 'failed' (527, 916, 1163, 1233), 'sent'
 * (711), 'pending' (753), 'rejected' (771), 'unknown' (786), 'completed' (909) and 'unresolved' (1233) are
 * the updates. Additive: no existing schema reads it.
 */
export const REFUND_REQUEST_STATES = [
  'requested',
  'sent',
  'unknown',
  'pending',
  'unresolved',
  'completed',
  'failed',
  'cancelled',
  'rejected',
] as const;
export type RefundRequestState = (typeof REFUND_REQUEST_STATES)[number];
export const MoneyStateSchema = z.enum([
  'pending',
  'captured',
  'denied',
  'refunded',
  'reversed',
  'unknown',
]);
export type MoneyState = z.infer<typeof MoneyStateSchema>;
export const MoneyEventSchema = z.enum([
  'capture_verified',
  'pending',
  'declined',
  'unknown',
  'refund_verified',
  'reversal_verified',
]);
export type MoneyEvent = z.infer<typeof MoneyEventSchema>;
export const MatchFieldSchema = z.enum([
  'provider_order_id',
  'reference',
  'currency',
  'extra_unit',
  'reference_id',
  'payee',
  'amount',
  'capture_id',
  'capture_id_reused',
  'read_before_claim',
]);
export type MatchField = z.infer<typeof MatchFieldSchema>;

export const UnitMatchSchema = z
  .object({
    reference_id: IdSchema,
    result: z.enum(['matched', 'pending', 'declined', 'no_capture', 'mismatch']),
    field: MatchFieldSchema.nullable(),
    status: CaptureStatusSchema.nullable(),
  })
  .strict();
export type UnitMatch = z.infer<typeof UnitMatchSchema>;

export const MatchResultSchema = z.discriminatedUnion('level', [
  z.object({ level: z.literal('order'), ok: z.literal(false), field: MatchFieldSchema }).strict(),
  z
    .object({ level: z.literal('units'), ok: z.literal(true), units: z.array(UnitMatchSchema) })
    .strict(),
]);
export type MatchResult = z.infer<typeof MatchResultSchema>;
