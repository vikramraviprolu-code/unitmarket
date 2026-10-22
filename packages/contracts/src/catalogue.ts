import { z } from 'zod';
import {
  CurrencyCodeSchema,
  IdSchema,
  IsoUtcSchema,
  MinorUnitsSchema,
  Sha256HexSchema,
} from './primitives';

export const AccessOptionSchema = z.enum(['keep_retrieve', 'online_read']);
export type AccessOption = z.infer<typeof AccessOptionSchema>;

export const AccessPolicySchema = z
  .object({
    id: IdSchema,
    version: z.string().min(1),
    option: AccessOptionSchema,
    /** 432000000 (5 days) in the MVP policy */
    window_ms: z.number().int().positive(),
    start_rule: z.literal('payment_verified_and_delivery_ready'),
  })
  .strict();
export type AccessPolicy = z.infer<typeof AccessPolicySchema>;

export const RightsSchema = z
  .object({
    scope: z.literal('personal_use'),
    ai_scope: z.enum(['agent_allowed', 'review', 'not_allowed']),
    redistribution: z.literal(false),
  })
  .strict();
export type Rights = z.infer<typeof RightsSchema>;

export const OfferOptionSchema = z
  .object({
    option: AccessOptionSchema,
    price_minor: MinorUnitsSchema,
    policy_id: IdSchema,
    policy_version: z.string().min(1),
  })
  .strict();
export type OfferOption = z.infer<typeof OfferOptionSchema>;

export const AffordabilitySchema = z
  .object({ renegotiation_allowed: z.boolean(), floor_minor: MinorUnitsSchema.nullable() })
  .strict();
export type Affordability = z.infer<typeof AffordabilitySchema>;

export const OfferSchema = z
  .object({
    id: IdSchema,
    version: z.string().min(1),
    publisher_id: IdSchema,
    article_id: IdSchema,
    status: z.enum(['draft', 'authorised', 'withdrawn']),
    currency: CurrencyCodeSchema,
    options: z.array(OfferOptionSchema),
    affordability: AffordabilitySchema,
    terms_version: z.string().min(1),
    rights: RightsSchema,
    valid_from: IsoUtcSchema,
    valid_until: IsoUtcSchema.nullable(),
    superseded_by: IdSchema.nullable(),
  })
  .strict();
export type Offer = z.infer<typeof OfferSchema>;

export const ArticleFactsSchema = z
  .object({
    id: IdSchema,
    publisher_id: IdSchema,
    title: z.string(),
    abstract: z.string(),
    language: z.string(),
    topics: z.array(z.string()),
    published_at: IsoUtcSchema,
    sha256: Sha256HexSchema,
    content_key: z.string(),
  })
  .strict();
export type ArticleFacts = z.infer<typeof ArticleFactsSchema>;

export const PublisherFactsSchema = z
  .object({
    id: IdSchema,
    slug: z.string(),
    display_name: z.string(),
    country: z.string(),
    payee_merchant_id: z.string().nullable(),
    payee_verified_at: IsoUtcSchema.nullable(),
  })
  .strict();
export type PublisherFacts = z.infer<typeof PublisherFactsSchema>;
