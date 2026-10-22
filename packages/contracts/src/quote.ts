import { z } from 'zod';
import { AccessOptionSchema } from './catalogue';
import { CorridorIdSchema } from './corridor';
import { IdSchema, IsoUtcSchema, MoneySchema } from './primitives';

export const NoMatchReasonSchema = z.enum([
  'above_ceiling',
  'withdrawn',
  'not_authorised',
  'corridor_unsupported',
  'already_owned',
  'below_publisher_floor',
  'option_not_offered',
]);
export type NoMatchReason = z.infer<typeof NoMatchReasonSchema>;

export const QuoteSchema = z
  .object({
    kind: z.literal('quote'),
    quote_id: IdSchema,
    offer_id: IdSchema,
    offer_version: z.string().min(1),
    option: AccessOptionSchema,
    price: MoneySchema,
    corridor_id: CorridorIdSchema,
    expires_at: IsoUtcSchema,
    source: z.enum(['direct', 'wordpress', 'discovery']),
  })
  .strict();
export type Quote = z.infer<typeof QuoteSchema>;

export const NoMatchSchema = z
  .object({ kind: z.literal('no_match'), reason: NoMatchReasonSchema })
  .strict();
export type NoMatch = z.infer<typeof NoMatchSchema>;
