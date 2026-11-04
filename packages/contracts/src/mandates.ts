// API-B (G1, G9): the agent spending cap ("mandate") contracts. A buyer gives one agent key a cap: money,
// a number of purchases, or both, in one currency, until an expiry. The request carries the buyer's
// acceptance of the terms; there is no per-order human token for a purchase inside the cap.
import { z } from 'zod';
import { CurrencyCodeSchema, IdSchema, IsoUtcSchema } from './primitives';

/** A positive whole number of minor units or purchases, below 2^31 (the database column is an integer). */
const CapSchema = z
  .number()
  .int()
  .positive()
  .lt(2 ** 31);

export const MandateCreateRequestSchema = z
  .object({
    agent_key_id: IdSchema,
    currency: CurrencyCodeSchema,
    max_total_minor: CapSchema.optional(),
    max_count: CapSchema.optional(),
    max_per_purchase_minor: CapSchema.optional(),
    expires_at: IsoUtcSchema,
    terms_accepted: z.literal(true),
  })
  .strict()
  .refine((m) => m.max_total_minor !== undefined || m.max_count !== undefined, {
    message: 'give a money cap, a purchase count, or both',
    path: ['max_total_minor'],
  });
export type MandateCreateRequest = z.infer<typeof MandateCreateRequestSchema>;

/** What a buyer sees of a mandate. `remaining_*` is null for a cap that is not set. */
export const MandateViewSchema = z
  .object({
    id: IdSchema,
    agent_key_id: IdSchema,
    currency: CurrencyCodeSchema,
    max_total_minor: CapSchema.nullable(),
    max_count: CapSchema.nullable(),
    max_per_purchase_minor: CapSchema.nullable(),
    expires_at: IsoUtcSchema,
    revoked_at: IsoUtcSchema.nullable(),
    spent_minor: z.number().int().nonnegative(),
    used_count: z.number().int().nonnegative(),
    remaining_total_minor: z.number().int().nonnegative().nullable(),
    remaining_count: z.number().int().nonnegative().nullable(),
    created_at: IsoUtcSchema,
  })
  .strict();
export type MandateView = z.infer<typeof MandateViewSchema>;

/** The answer to check_budget: what is left, or the words the agent uses to ask its buyer for a cap. */
export const BudgetStatusSchema = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('active'),
      mandate_id: IdSchema,
      currency: CurrencyCodeSchema,
      remaining_total_minor: z.number().int().nonnegative().nullable(),
      remaining_count: z.number().int().nonnegative().nullable(),
      max_per_purchase_minor: CapSchema.nullable(),
      expires_at: IsoUtcSchema,
    })
    .strict(),
  z
    .object({
      status: z.literal('mandate_required'),
      reason: z.enum(['none', 'revoked', 'expired']),
      ask_buyer: z.string().min(1).max(1000),
    })
    .strict(),
]);
export type BudgetStatus = z.infer<typeof BudgetStatusSchema>;
