import { z } from 'zod';
import { AccessOptionSchema } from './catalogue';
import { IdSchema, IsoUtcSchema, MoneySchema } from './primitives';

// level null means "not assessable": the UI shows it as unknown, never as a score.
export const FitDimensionSchema = z
  .object({
    key: z.enum(['topic', 'budget', 'access', 'language', 'recency']),
    label: z.string(),
    level: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]).nullable(),
    basis: z.enum([
      'keyword_overlap',
      'price_vs_ceiling',
      'option_offered',
      'language_equal',
      'publish_date',
    ]),
    evidence: z.string(),
  })
  .strict();
export type FitDimension = z.infer<typeof FitDimensionSchema>;

export const FitCardSchema = z
  .object({
    offer_id: IdSchema,
    dimensions: z.array(FitDimensionSchema),
    band: z.enum(['strong', 'good', 'partial']).nullable(),
  })
  .strict();
export type FitCard = z.infer<typeof FitCardSchema>;

export const BriefSchema = z
  .object({
    brief_id: IdSchema,
    buyer_id: IdSchema,
    need: z.string(),
    ceiling: MoneySchema.nullable(),
    option: AccessOptionSchema.nullable(),
    language: z.string().nullable(),
    terms: z.array(z.string()),
    created_at: IsoUtcSchema,
  })
  .strict();
export type Brief = z.infer<typeof BriefSchema>;
