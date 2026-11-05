import { z } from 'zod';
import type { ZodType } from 'zod';
import { TXN_QUERY_KEYS } from '@umsbx/contracts';

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

// ---------- INT-GA: the two assist purposes (GA-L1, GA-L2) ----------

/** The scrubbed remainder of a plain-words search (GA.2); the Claude adapter refuses anything longer. */
export const MAX_REST_CHARS = 500;
export const MAX_TXN_ANSWER_KEYS = 12;
export const MAX_TXN_ANSWER_VALUE = 100;
export const MAX_EXPLAIN_TEXT = 400;

const Short = (max: number) => z.string().min(1).max(max);

/** One step of the identity-free projection of GA.4: these seven fields, nothing else. */
export const ExplainEntrySchema = z.strictObject({
  seq: z.number().int().min(1),
  event_type: Short(200),
  words_key: Short(200),
  actor_kind: Short(40),
  channel: Short(40),
  state_from: Short(200).nullable(),
  state_to: Short(200).nullable(),
});
export type ExplainEntryInput = z.infer<typeof ExplainEntrySchema>;

/** GA-L2: the whole explain input. Unknown keys fail the parse, at every level. */
export const ExplainInputSchema = z.strictObject({
  entries: z.array(ExplainEntrySchema).max(500),
  alert_kinds: z.array(Short(60)).max(50),
  fix_ids: z.array(Short(60)).max(50),
});
export type ExplainInput = z.infer<typeof ExplainInputSchema>;

/** GA-L2: the explain answer. `action_id` is checked against the input's fix ids by the caller of the schema. */
export const ExplainOutputSchema = z.strictObject({
  what_happened: Short(MAX_EXPLAIN_TEXT),
  safe_now: Short(MAX_EXPLAIN_TEXT),
  action_id: Short(60),
});
export type ExplainOutput = z.infer<typeof ExplainOutputSchema>;

/**
 * GA-L1: the txn_query answer of the Claude adapter. A map of at most 12 keys, each a TxnQuery field name, each value
 * a string of at most 100 characters. The page cursor and size are not a model's to set.
 */
const TXN_ANSWER_KEYS = TXN_QUERY_KEYS.filter((k) => k !== 'cursor' && k !== 'limit');
export const TxnQueryAnswerSchema = z
  .record(z.string(), z.string().max(MAX_TXN_ANSWER_VALUE))
  .refine((m) => Object.keys(m).length <= MAX_TXN_ANSWER_KEYS, 'too many keys')
  .refine((m) => Object.keys(m).every((k) => TXN_ANSWER_KEYS.includes(k)), 'unknown field');
