// Transport boundary: the only way a request leaves the process (architecture section 7).
import { z } from 'zod';
import { IdSchema, MinorUnitsSchema } from './primitives';
import type { EnvironmentLabel, MinorUnits } from './primitives';

export const PayPalOperationSchema = z.enum([
  'oauth_token',
  'create_order',
  'get_order',
  'capture_order',
  'get_capture',
  'refund_capture',
  'get_refund',
  'verify_webhook_postback',
  'fetch_webhook_cert',
]);
export type PayPalOperation = z.infer<typeof PayPalOperationSchema>;

export const OutboundRequestSchema = z
  .object({
    operation: PayPalOperationSchema,
    method: z.enum(['GET', 'POST']),
    path: z.string(),
    headers: z.record(z.string(), z.string()),
    body: z.string().nullable(),
    order_ref: IdSchema.nullable(),
    amount_minor: MinorUnitsSchema.nullable(),
    /** dry-run fixture selector; ignored by the sandbox transport */
    scenario: z.string().nullable(),
  })
  .strict();
export type OutboundRequest = z.infer<typeof OutboundRequestSchema>;

export const BlockReasonSchema = z.enum([
  'connect_off',
  'kill_switch',
  'no_approval',
  'budget',
  'egress',
  'dry_run_miss',
]);
export type BlockReason = z.infer<typeof BlockReasonSchema>;

export const TransportResultSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('response'),
      status: z.number().int(),
      headers: z.record(z.string(), z.string()),
      body: z.string(),
      duration_ms: z.number().nonnegative(),
    })
    .strict(),
  z.object({ kind: z.literal('timeout') }).strict(),
  z.object({ kind: z.literal('network_error'), code: z.string() }).strict(),
  z.object({ kind: z.literal('blocked'), by: BlockReasonSchema }).strict(),
]);
export type TransportResult = z.infer<typeof TransportResultSchema>;

export interface Transport {
  readonly kind: EnvironmentLabel;
  send(r: OutboundRequest): Promise<TransportResult>;
}

export const GateVerdictSchema = z.discriminatedUnion('allowed', [
  z.object({ allowed: z.literal(true), approval_ref: z.string().min(1) }).strict(),
  z
    .object({
      allowed: z.literal(false),
      by: z.enum(['connect_off', 'kill_switch', 'no_approval', 'budget']),
    })
    .strict(),
]);
export type GateVerdict = z.infer<typeof GateVerdictSchema>;

/**
 * What the transport asks the gate about one request. `scope` and `approval_ref` are the
 * construction-time approval the transport stands on (FIX-BPREP M2); a gate that receives them
 * blocks when they do not match its active approval row. Optional so older gates and callers
 * keep compiling.
 */
export interface OutboundCheck {
  operation: PayPalOperation;
  amount_minor: MinorUnits | null;
  scope?: string;
  approval_ref?: string;
}

export interface OutboundGate {
  check(c: OutboundCheck): Promise<GateVerdict>;
}
