// Origin: AIC_Hackathon_UnitMarket@a36ddc03fd0b962000f686291c145b50ee337f90:packages/contracts/src/ports.ts. Adapted; owned by SBX.
// Ports every core function receives explicitly. Interfaces are plain TypeScript; data shapes that
// cross a boundary also have a strict zod schema.
import { z } from 'zod';
import { ActorSchema } from './actor';
import type { Actor } from './actor';
import type { Id } from './primitives';
import { IdSchema, Sha256HexSchema } from './primitives';

// ---------- Database ----------
// Inside transaction(fn) use only tx. Never call a provider or any other I/O port inside fn.
export interface SqlExecutor {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  exec(sql: string): Promise<void>;
}
export interface Database extends SqlExecutor {
  readonly dialect: 'pglite' | 'pg';
  transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T>;
}

// ---------- Time and ids ----------
export interface Clock {
  now(): Date;
}
export const IdPrefixSchema = z.enum([
  'ord',
  'unt',
  'pvo',
  'opr',
  'ent',
  'apr',
  'quo',
  'lnk',
  'aev',
  'led',
  'rct',
  'cas',
  'cac',
  'rfr',
  'brf',
  'prp',
  'pub',
  'art',
  'ofr',
  'buy',
  'ses',
  'alr',
  'pcl',
  'whk',
  'aud',
  'oap',
]);
export type IdPrefix = z.infer<typeof IdPrefixSchema>;
export interface Ids {
  /** `${prefix}_${26 base32 chars of 128 random bits}` */
  next(prefix: IdPrefix): Id;
  /** 32 hex chars, 128 bits */
  nonce(): string;
}

// ---------- Secret ----------
export interface Secret {
  reveal(): string;
  toString(): '[redacted]';
  toJSON(): '[redacted]';
}
export const SecretSchema = z.custom<Secret>(
  (v) =>
    typeof v === 'object' && v !== null && typeof (v as { reveal?: unknown }).reveal === 'function',
  { message: 'must be a Secret (object with reveal())' },
);

// ---------- Logging and audit ----------
export const LogLevelSchema = z.enum(['debug', 'info', 'warn', 'error']);
export type LogLevel = z.infer<typeof LogLevelSchema>;
export const LogFieldsSchema = z.record(
  z.string(),
  z.union([z.string(), z.number(), z.boolean(), z.null()]),
);
export const LogEventSchema = z
  .object({ msg: z.string(), level: LogLevelSchema, fields: LogFieldsSchema })
  .strict();
export type LogEvent = z.infer<typeof LogEventSchema>;
export interface Logger {
  log(e: LogEvent): void;
  child(fields: LogEvent['fields']): Logger;
}

export const AuditEntrySchema = z
  .object({
    actor: ActorSchema,
    action: z.string().min(1),
    target: IdSchema.nullable(),
    reason: z.string().nullable(),
    detail: LogFieldsSchema,
  })
  .strict();
export type AuditEntry = Omit<z.infer<typeof AuditEntrySchema>, 'actor'> & { actor: Actor };
export interface AuditSink {
  record(tx: SqlExecutor, e: AuditEntry): Promise<void>;
}

// ---------- Content ----------
export const ContentHeadSchema = z
  .object({
    bytes: z.number().int().nonnegative(),
    sha256: Sha256HexSchema,
    mime: z.string().min(1),
  })
  .strict();
export type ContentHead = z.infer<typeof ContentHeadSchema>;
export interface ContentStore {
  head(key: string): Promise<ContentHead | null>;
  open(key: string): Promise<AsyncIterable<Uint8Array> | null>;
  health(): Promise<boolean>;
}

// ---------- Model ----------
export const ModelPurposeSchema = z.enum(['brief_parse', 'pack_compose']);
export type ModelPurpose = z.infer<typeof ModelPurposeSchema>;
export const ModelRequestSchema = z
  .object({ purpose: ModelPurposeSchema, system: z.string(), input: z.unknown() })
  .strict();
export type ModelRequest = z.infer<typeof ModelRequestSchema>;
export const ModelResponseSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('ok'),
      output: z.unknown(),
      input_tokens: z.number().int().nonnegative(),
      output_tokens: z.number().int().nonnegative(),
      /** AI-H: the id of the model that really produced this answer (a fallback answer names the fallback). */
      served_model: z.string().min(1).max(100).optional(),
    })
    .strict(),
  z.object({ kind: z.literal('error'), reason: z.string() }).strict(),
]);
export type ModelResponse = z.infer<typeof ModelResponseSchema>;
export interface ModelPort {
  readonly model_id: string;
  complete(r: ModelRequest): Promise<ModelResponse>;
}
/**
 * AI-A: the one request/answer exchange with the model API, as the Claude adapter sees it. The body is
 * the JSON text of a messages request; the answer is the HTTP status and the body text. The host, path
 * and key belong to the wire, never to the caller. A refusal, timeout or network failure rejects.
 */
export interface ModelWire {
  send(body: string): Promise<{ status: number; body: string }>;
}
/**
 * AI-A: the ledger behind the model spend caps, in micro USD (1 USD = 1,000,000). `spentMicroUsd` sums
 * what was charged at or after `since_iso` (null: all time); `charge` records one amount with a short
 * note that holds no input text.
 */
export interface ModelSpendStore {
  spentMicroUsd(since_iso: string | null): Promise<number>;
  charge(micro_usd: number, note: string): Promise<void>;
}

// ---------- Switches ----------
export const SwitchNameSchema = z.enum([
  'paypal_outbound',
  'checkout_enabled',
  'refunds_enabled',
  'unlock_enabled',
  'ai_enabled',
  'webhook_enabled',
]);
export type SwitchName = z.infer<typeof SwitchNameSchema>;
export interface SwitchReader {
  isOn(name: SwitchName): Promise<boolean>;
}
