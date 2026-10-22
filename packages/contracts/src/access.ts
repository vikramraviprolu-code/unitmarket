import { z } from 'zod';
import { IdSchema, IsoUtcSchema } from './primitives';

export const WindowStateNameSchema = z.enum([
  'not_started',
  'running',
  'paused',
  'ended',
  'revoked',
]);
export type WindowStateName = z.infer<typeof WindowStateNameSchema>;

export const WindowStateSchema = z
  .object({
    state: WindowStateNameSchema,
    started_at: IsoUtcSchema.nullable(),
    base_ends_at: IsoUtcSchema.nullable(),
    ends_at: IsoUtcSchema.nullable(),
    paused_at: IsoUtcSchema.nullable(),
    credit_ms: z.number().int().nonnegative(),
  })
  .strict();
export type WindowState = z.infer<typeof WindowStateSchema>;

export const AccessEventKindSchema = z.enum([
  'access_ready',
  'link_issued',
  'download_completed',
  'download_aborted',
  'reader_rendered',
  'reader_beacon',
  'delivery_failed',
  'delivery_restored',
  'credit_granted',
  'window_ended',
  'revoked',
]);
export type AccessEventKind = z.infer<typeof AccessEventKindSchema>;

export const AccessEventSchema = z
  .object({
    entitlement_id: IdSchema,
    kind: AccessEventKindSchema,
    at: IsoUtcSchema,
    source: z.enum(['system', 'buyer', 'operator']),
    evidence: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
  })
  .strict();
export type AccessEvent = z.infer<typeof AccessEventSchema>;
