import { z } from 'zod';
import { EnvironmentLabelSchema, IdSchema, IsoUtcSchema, MoneySchema } from './primitives';

export const LedgerKindSchema = z.enum([
  'sale',
  'paypal_fee',
  'platform_fee',
  'refund',
  'reversal',
  'commission_reversal',
]);
export type LedgerKind = z.infer<typeof LedgerKindSchema>;

export const LedgerEntryInputSchema = z
  .object({
    unit_id: IdSchema,
    capture_id: z.string().min(1),
    kind: LedgerKindSchema,
    amount: MoneySchema,
    refund_id: z.string().nullable(),
    ref_entry_id: IdSchema.nullable(),
  })
  .strict();
export type LedgerEntryInput = z.infer<typeof LedgerEntryInputSchema>;

export const LedgerEntrySchema = z
  .object({
    ...LedgerEntryInputSchema.shape,
    id: IdSchema,
    created_at: IsoUtcSchema,
    environment: EnvironmentLabelSchema,
  })
  .strict();
export type LedgerEntry = z.infer<typeof LedgerEntrySchema>;
