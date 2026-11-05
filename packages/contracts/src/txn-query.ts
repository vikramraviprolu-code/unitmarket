// INT-SR0 (SR0.1, SR0.2): one transaction filter contract for the buyer, seller and operator lists.
//
// TxnQuery has the filters F1 to F13 of the search proposal (section 4.3), a sort and a keyset cursor. It
// parses from a URL string map; an invalid value is dropped, never an error, so a stale link still opens.
// STATUS_GROUPS and statusGroupOf say, in one place, which of six plain words a line is in. REFUSED_FIELDS is
// the table of fields each role may not send (the domain package enforces it; the UI and the evals read it).
// A filter list (status, refund, case, currency, flags) means "any of these"; different filters are ANDed.
import { z } from 'zod';

// ---------- Status groups (F4) ----------

/** The six words, in precedence order: a line gets the first word whose rule it meets. */
export const StatusGroupSchema = z.enum([
  'attention',
  'refunded',
  'part_refunded',
  'paid',
  'failed',
  'in_progress',
]);
export type StatusGroup = z.infer<typeof StatusGroupSchema>;

/**
 * Which `orders.status` and `order_units.status` values put a line in a group. `attention` also holds a
 * `pending` unit that has not changed for more than PENDING_ATTENTION_MS (a rule that needs the time).
 * `in_progress` is the rest: its lists name what it holds today, and an unlisted pair falls in it too.
 */
export const STATUS_GROUPS: Readonly<
  Record<StatusGroup, { readonly order: readonly string[]; readonly unit: readonly string[] }>
> = {
  attention: { order: ['unresolved', 'frozen'], unit: ['mismatch', 'reversal_suspected'] },
  refunded: { order: [], unit: ['refunded', 'reversed'] },
  part_refunded: { order: [], unit: ['partially_refunded'] },
  paid: { order: [], unit: ['captured_verified'] },
  failed: { order: ['failed', 'abandoned'], unit: ['declined'] },
  in_progress: {
    order: ['created', 'awaiting_buyer', 'capture_requested', 'capture_claimed', 'paid_partial'],
    unit: ['expected', 'pending'],
  },
};

/** A unit that stays `pending` for longer than this needs attention (strictly longer). */
export const PENDING_ATTENTION_MS = 3_600_000;

export interface StatusGroupRow {
  order_status: string;
  unit_status: string;
  unit_updated_at: string | Date;
}

/** The one word for a line. `now` comes from the injected Clock (S6). */
export function statusGroupOf(row: StatusGroupRow, now: Date): StatusGroup {
  for (const group of StatusGroupSchema.options) {
    if (group === 'in_progress') break;
    const rule = STATUS_GROUPS[group];
    if (rule.order.includes(row.order_status) || rule.unit.includes(row.unit_status)) return group;
    if (group === 'attention' && row.unit_status === 'pending') {
      const since = new Date(row.unit_updated_at).getTime();
      if (now.getTime() - since > PENDING_ATTENTION_MS) return 'attention';
    }
  }
  return 'in_progress';
}

// ---------- Fields ----------

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
// \p{Cc}: the C0 and C1 control characters.
const CONTROL = /\p{Cc}/u;

function validDay(s: string): boolean {
  const m = DAY.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

const MAX_MINOR = 2_147_483_647;
const TEXT_MAX = 200;
const Q_MAX = 100;
const CURSOR_MAX = 4096;
const LIST_MAX = 10;

const DaySchema = z.string().refine(validDay, 'a UTC day, YYYY-MM-DD');
const MinorSchema = z.number().int().min(0).max(MAX_MINOR);
const TextSchema = z
  .string()
  .min(1)
  .max(TEXT_MAX)
  .refine((s) => !CONTROL.test(s), 'no control characters');
const QSchema = z
  .string()
  .min(1)
  .max(Q_MAX)
  .refine((s) => !CONTROL.test(s), 'no control characters');

const REFUND_VALUES = ['none', 'requested', 'partial', 'full'] as const;
const CASE_VALUES = ['none', 'open', 'resolved'] as const;
const FLAG_VALUES = ['alert', 'mismatch', 'unknown_op'] as const;
const CHANNEL_VALUES = ['human', 'agent'] as const;
const ENVIRONMENT_VALUES = ['dryrun', 'sandbox'] as const;
const SORT_VALUES = ['newest', 'amount', 'status'] as const;
const DIR_VALUES = ['asc', 'desc'] as const;

const list = <T extends z.ZodTypeAny>(item: T) => z.array(item).min(1).max(LIST_MAX);

export const TxnQuerySchema = z
  .object({
    from: DaySchema.optional(),
    to: DaySchema.optional(),
    min_minor: MinorSchema.optional(),
    max_minor: MinorSchema.optional(),
    currency: list(z.string().regex(/^[A-Z]{3}$/)).optional(),
    status: list(StatusGroupSchema).optional(),
    refund: list(z.enum(REFUND_VALUES)).optional(),
    case: list(z.enum(CASE_VALUES)).optional(),
    buyer: TextSchema.optional(),
    seller: TextSchema.optional(),
    q: QSchema.optional(),
    ref: TextSchema.optional(),
    channel: z.enum(CHANNEL_VALUES).optional(),
    agent_key: TextSchema.optional(),
    environment: z.enum(ENVIRONMENT_VALUES).optional(),
    flags: list(z.enum(FLAG_VALUES)).optional(),
    sort: z.enum(SORT_VALUES).optional(),
    dir: z.enum(DIR_VALUES).optional(),
    limit: z.number().int().min(1).max(100).optional(),
    cursor: z.string().min(1).max(CURSOR_MAX).optional(),
  })
  .strict();
export type TxnQuery = z.infer<typeof TxnQuerySchema>;

/** Every key a client may send. The role check reads the raw keys, so this list is its vocabulary. */
export const TXN_QUERY_KEYS: readonly string[] = Object.keys(TxnQuerySchema.shape);

/**
 * Fields a role is refused with 400 `field_not_allowed`, whatever the value. `operator_key` is an api_client
 * of an operator (`mfa: false`): refused nothing, but its `buyer` and `seller` match opaque ids only.
 */
export const REFUSED_FIELDS: Readonly<
  Record<'buyer' | 'agent' | 'publisher' | 'operator_key' | 'operator', readonly string[]>
> = {
  buyer: ['buyer', 'environment', 'flags'],
  agent: ['buyer', 'environment', 'flags'],
  publisher: ['buyer', 'seller', 'agent_key', 'environment', 'flags'],
  operator_key: [],
  operator: [],
};

// ---------- Parse ----------

type Raw = Readonly<Record<string, string | undefined>>;

const own = (raw: Raw, key: string): string | undefined => {
  if (!Object.hasOwn(raw, key)) return undefined;
  const v = raw[key];
  return typeof v === 'string' ? v : undefined;
};

function splitList(s: string): string[] {
  const out: string[] = [];
  for (const part of s.split(',')) {
    const item = part.trim();
    if (item !== '' && !out.includes(item)) out.push(item);
  }
  return out;
}

function enumList<const T extends readonly string[]>(
  raw: Raw,
  key: string,
  allowed: T,
): T[number][] | undefined {
  const s = own(raw, key);
  if (s === undefined) return undefined;
  const items = splitList(s).filter((x): x is T[number] =>
    (allowed as readonly string[]).includes(x),
  );
  return items.length > 0 ? items.slice(0, LIST_MAX) : undefined;
}

function oneOf<const T extends readonly string[]>(
  raw: Raw,
  key: string,
  allowed: T,
): T[number] | undefined {
  const s = own(raw, key)?.trim();
  return s !== undefined && (allowed as readonly string[]).includes(s)
    ? (s as T[number])
    : undefined;
}

function day(raw: Raw, key: string): string | undefined {
  const s = own(raw, key)?.trim();
  return s !== undefined && validDay(s) ? s : undefined;
}

function minor(raw: Raw, key: string): number | undefined {
  const s = own(raw, key)?.trim();
  if (s === undefined || !/^\d{1,10}$/.test(s)) return undefined;
  const n = Number(s);
  return n <= MAX_MINOR ? n : undefined;
}

function text(raw: Raw, key: string, max: number): string | undefined {
  const s = own(raw, key)?.trim();
  if (s === undefined || s.length === 0 || s.length > max || CONTROL.test(s)) return undefined;
  return s;
}

/**
 * Reads the keys of TXN_QUERY_KEYS from a URL string map and keeps every value that is valid. Own properties
 * only. A cursor is never dropped for being malformed: it reaches the cursor decoder, which refuses it with
 * 400 `bad_cursor`, so a broken cursor never turns into page 1. An absurdly long one is replaced by a marker
 * that no decoder accepts.
 */
export function parseTxnQuery(raw: Raw): TxnQuery {
  const out: Record<string, unknown> = {};
  const put = (key: string, value: unknown): void => {
    if (value !== undefined) out[key] = value;
  };

  let from = day(raw, 'from');
  let to = day(raw, 'to');
  if (from !== undefined && to !== undefined && from > to) {
    from = undefined;
    to = undefined;
  }
  put('from', from);
  put('to', to);

  let min = minor(raw, 'min_minor');
  let max = minor(raw, 'max_minor');
  if (min !== undefined && max !== undefined && min > max) {
    min = undefined;
    max = undefined;
  }
  put('min_minor', min);
  put('max_minor', max);

  const currency = own(raw, 'currency');
  if (currency !== undefined) {
    const codes = splitList(currency.toUpperCase()).filter((c) => /^[A-Z]{3}$/.test(c));
    if (codes.length > 0) put('currency', codes.slice(0, LIST_MAX));
  }
  put('status', enumList(raw, 'status', StatusGroupSchema.options));
  put('refund', enumList(raw, 'refund', REFUND_VALUES));
  put('case', enumList(raw, 'case', CASE_VALUES));
  put('buyer', text(raw, 'buyer', TEXT_MAX));
  put('seller', text(raw, 'seller', TEXT_MAX));
  put('q', text(raw, 'q', Q_MAX));
  put('ref', text(raw, 'ref', TEXT_MAX));
  put('channel', oneOf(raw, 'channel', CHANNEL_VALUES));
  put('agent_key', text(raw, 'agent_key', TEXT_MAX));
  put('environment', oneOf(raw, 'environment', ENVIRONMENT_VALUES));
  put('flags', enumList(raw, 'flags', FLAG_VALUES));
  put('sort', oneOf(raw, 'sort', SORT_VALUES));
  put('dir', oneOf(raw, 'dir', DIR_VALUES));

  const limit = own(raw, 'limit')?.trim();
  if (limit !== undefined && /^\d{1,4}$/.test(limit)) {
    const n = Number(limit);
    if (n >= 1 && n <= 100) out['limit'] = n;
  }

  const cursor = own(raw, 'cursor');
  if (cursor !== undefined && cursor.length > 0)
    out['cursor'] = cursor.length <= CURSOR_MAX ? cursor : '!';

  return out as TxnQuery;
}

// ---------- INT-SR1: response rows ----------

/** The raw URL string map the search routes take. Value errors never fail here: parseTxnQuery drops them. */
const queryMap = z.record(z.string().max(100), z.string().max(4200));
/**
 * withRoute asks every schema for `.strict()` (rule L2). The search routes take the raw string map: a bad value
 * or an unknown key is dropped by `parseTxnQuery`, never a 422, and the role check (scopeQuery) reads the raw
 * keys and answers 400 `field_not_allowed`. So strict is the map itself. The named keys are the documented
 * parameters (`view`: operator saved view; `access`: library access state).
 */
export const TxnQueryMapSchema = Object.assign(queryMap, { strict: () => queryMap });

/** A cell of the shared line: every field one role may be shown. Which role sees which is fixed in code. */
export const TxnLineSchema = z
  .object({
    unit_id: z.string().min(1).max(200),
    order_ref: z.string().min(1).max(200),
    order_ref6: z.string().min(1).max(6),
    /** The one of six plain words: attention, refunded, part_refunded, paid, failed, in_progress. */
    status: StatusGroupSchema,
    order_status: z.string().max(60),
    unit_status: z.string().max(60),
    created_at: z.string().max(40),
    updated_at: z.string().max(40),
    captured_at: z.string().max(40).nullable(),
    currency: z.string().max(3),
    amount_minor: z.number().int(),
    refunded_minor: z.number().int(),
    environment: z.enum(ENVIRONMENT_VALUES),
    titles: z.array(z.string().max(300)),
    refund_state: z.string().max(60).nullable(),
    refund_amount_minor: z.number().int().nullable(),
    case_state: z.string().max(60).nullable(),
    case_kind: z.string().max(60).nullable(),
    channel: z.enum(CHANNEL_VALUES),
    // Buyer and operator lines.
    order_total_minor: z.number().int().optional(),
    agent_key_id: z.string().max(200).nullable().optional(),
    // Operator lines (opaque ids).
    publisher_id: z.string().max(200).optional(),
    buyer_id: z.string().max(200).optional(),
    mandate_id: z.string().max(200).nullable().optional(),
    alert_count: z.number().int().optional(),
    has_unknown_op: z.boolean().optional(),
    order_mismatch: z.boolean().optional(),
    // Seller lines: the seller's own name.
    seller_name: z.string().max(300).optional(),
    // Operator lines with MFA only.
    seller_slug: z.string().max(200).optional(),
    buyer_display_name: z.string().max(300).optional(),
    provider_order_id: z.string().max(200).nullable().optional(),
    capture_id: z.string().max(200).nullable().optional(),
    refund_id: z.string().max(200).nullable().optional(),
  })
  .strict();
export type TxnLine = z.infer<typeof TxnLineSchema>;

export const TxnLinePageSchema = z
  .object({
    items: z.array(TxnLineSchema),
    next_cursor: z.string().min(1).max(500).nullable(),
  })
  .strict();

/** PUB-E1 shape: the file is a JSON string, never a text/csv answer. */
export const TxnExportSchema = z
  .object({
    filename: z.string().min(1).max(120),
    csv: z.string(),
    truncated: z.boolean(),
  })
  .strict();
export type TxnExport = z.infer<typeof TxnExportSchema>;
