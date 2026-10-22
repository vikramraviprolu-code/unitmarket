import { z } from 'zod';
import type { ZodType } from 'zod';

export const MAX_BRIEF_CHARS = 2000;
export const MAX_PICKS = 5;
export const MAX_CANDIDATES = 50;

export interface BriefParseOutput {
  need: string;
  ceiling_minor: number | null;
  currency: string | null;
  option: 'keep_retrieve' | 'online_read' | null;
  language: string | null;
  terms: string[];
}

export interface ComposeInput {
  need: string;
  terms: string[];
  ceiling_minor: number | null;
  candidates: { offer_id: string; title: string; abstract: string; topics: string[] }[]; // listing text is data
}

export interface ComposeOutput {
  picks: { offer_id: string; reason: string }[]; // at most 5
  tool_calls: { tool: string; args: Record<string, unknown> }[];
}

export const BriefParseOutputSchema: ZodType<BriefParseOutput> = z.strictObject({
  need: z.string().max(MAX_BRIEF_CHARS),
  ceiling_minor: z.number().int().min(0).max(1_000_000_000).nullable(),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .nullable(),
  option: z.enum(['keep_retrieve', 'online_read']).nullable(),
  language: z
    .string()
    .regex(/^[a-z]{2}$/)
    .nullable(),
  terms: z.array(z.string().min(1).max(40)).max(12),
});

// Not strict on purpose: unknown keys such as price or payee are dropped, not trusted (AI-5).
export const ComposeOutputSchema: ZodType<ComposeOutput> = z.object({
  picks: z
    .array(z.object({ offer_id: z.string().min(1).max(200), reason: z.string().max(300) }))
    .max(MAX_PICKS)
    .refine((p) => new Set(p.map((x) => x.offer_id)).size === p.length, 'duplicate offer_id'),
  tool_calls: z
    .array(z.object({ tool: z.string().max(100), args: z.record(z.string(), z.unknown()) }))
    .max(10),
});

export const ComposeInputSchema: ZodType<ComposeInput> = z.strictObject({
  need: z.string().max(MAX_BRIEF_CHARS),
  terms: z.array(z.string().min(1).max(40)).max(12),
  ceiling_minor: z.number().int().min(0).max(1_000_000_000).nullable(),
  candidates: z
    .array(
      z.strictObject({
        offer_id: z.string().min(1).max(200),
        title: z.string().max(300),
        abstract: z.string().max(5000),
        topics: z.array(z.string().max(60)).max(20),
      }),
    )
    .max(MAX_CANDIDATES),
});
