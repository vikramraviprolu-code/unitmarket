// INT-OPS-B / OPS-B.1: the logic of the shared filter bar. Pure. A URL goes to chips, the chips go back to the
// same canonical URL, and the URL map is what the table sends to the route. Two bars use it: Transactions
// (the TxnQuery fields of SR0) and Activity (the filters of TR1). Comma lists are SR0's, so `status=paid,failed`
// is one URL value and two chips.
//
// The bar never offers a field the server would refuse (B1): the Transactions field list minus the role's entry
// in REFUSED_FIELDS (packages/contracts/src/txn-query.ts, the table `scopeQuery` reads) is what it shows, and
// a refused key in a URL is dropped before anything is sent. There is no second parser: values are checked by
// parseTxnQuery for Transactions and by the same enums TR1's route uses for Activity. The page cursor is never
// part of the bar's state, so a new filter always starts at page one.
import {
  ACTOR_KINDS,
  CHANNELS,
  IsoUtcSchema,
  REFUSED_FIELDS,
  STATUS_GROUPS,
  parseTxnQuery,
} from '@umsbx/contracts';
import type { StatusGroup, TxnQuery } from '@umsbx/contracts';

export type FilterPersona = keyof typeof REFUSED_FIELDS;
export type BarContext =
  { kind: 'txn'; persona: FilterPersona } | { kind: 'activity'; mfa: boolean };
export type RawMap = Readonly<Record<string, string | undefined>>;
export type UrlMap = Record<string, string>;

export const TXN_FIELDS = [
  'from',
  'to',
  'min_minor',
  'max_minor',
  'currency',
  'status',
  'refund',
  'case',
  'buyer',
  'seller',
  'q',
  'ref',
  'channel',
  'agent_key',
  'environment',
  'flags',
] as const;
export const ACTIVITY_FIELDS = [
  'actor_kind',
  'actor_id',
  'channel',
  'event_type',
  'chain_key',
  'from',
  'to',
] as const;

/** SR0's six words, in its order. */
export const STATUS_WORDS: readonly StatusGroup[] = Object.keys(STATUS_GROUPS) as StatusGroup[];
export const STATUS_LABEL: Readonly<Record<StatusGroup, string>> = {
  attention: 'Needs attention',
  refunded: 'Refunded',
  part_refunded: 'Part refunded',
  paid: 'Paid',
  failed: 'Failed',
  in_progress: 'In progress',
};

/** SR1's four saved views of the operator list. The ids are the ones the route takes in `view=`. */
export const SAVED_VIEWS = [
  { id: 'needs_attention', label: 'Needs attention' },
  { id: 'refunds_today', label: 'Refunds today' },
  { id: 'agent_purchases', label: 'Agent purchases' },
  { id: 'sandbox_only', label: 'Sandbox only' },
] as const;
const VIEW_IDS: readonly string[] = SAVED_VIEWS.map((v) => v.id);
const SORTS = ['newest', 'amount', 'status'] as const;
const DIRS = ['asc', 'desc'] as const;

export interface Preset {
  id: string;
  label: string;
  map: UrlMap;
}
export const ACTIVITY_PRESETS: readonly Preset[] = [
  { id: 'switch_history', label: 'Switch history', map: { event_type: 'safety_switches.' } },
];

const LIST_FIELDS: ReadonlySet<string> = new Set(['currency', 'status', 'refund', 'case', 'flags']);
const REFUND_WORDS: Readonly<Record<string, string>> = {
  none: 'No refund',
  requested: 'Refund requested',
  partial: 'Part refunded',
  full: 'Fully refunded',
};
const CASE_WORDS: Readonly<Record<string, string>> = {
  none: 'No case',
  open: 'Case open',
  resolved: 'Case resolved',
};
const FLAG_WORDS: Readonly<Record<string, string>> = {
  alert: 'Has an alert',
  mismatch: 'Amount mismatch',
  unknown_op: 'Unknown PayPal step',
};
const CHANNEL_WORDS: Readonly<Record<string, string>> = { human: 'Person', agent: 'Agent' };

export interface Chip {
  field: string;
  /** One value: a list field has one chip for each value. */
  value: string;
  label: string;
  /** What the chip says, for example "Status: Paid". */
  text: string;
}
export interface BarState {
  chips: Chip[];
  /** The sort, direction and page size, kept in the URL but not shown as chips. */
  extras: { sort?: string; dir?: string; limit?: string };
  /** The canonical URL map: what the page URL holds and what the table sends. */
  map: UrlMap;
}

// ---------- URL helpers ----------

const decode = (s: string): string => {
  const t = s.replace(/\+/g, ' ');
  try {
    return decodeURIComponent(t);
  } catch {
    return t;
  }
};

/** `?a=b&c=d` or `a=b&c=d` to a map. The first of a repeated key wins. Own keys only, no prototype. */
export function parseQueryString(qs: string): RawMap {
  const out: Record<string, string> = Object.create(null) as Record<string, string>;
  const body = qs.startsWith('?') ? qs.slice(1) : qs;
  for (const part of body.split('&')) {
    if (part === '') continue;
    const at = part.indexOf('=');
    const key = decode(at < 0 ? part : part.slice(0, at));
    const value = at < 0 ? '' : decode(part.slice(at + 1));
    if (key !== '' && !Object.hasOwn(out, key)) out[key] = value;
  }
  return out;
}

const encode = (key: string, value: string): string => {
  const enc = encodeURIComponent(value);
  return LIST_FIELDS.has(key) ? enc.replace(/%2C/g, ',') : enc;
};

/** A map to `a=b&c=d`, in the map's own order (the canonical order when it came from the bar). */
export function queryString(map: Readonly<Record<string, string>>): string {
  return Object.entries(map)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encode(k, v)}`)
    .join('&');
}

const own = (raw: RawMap, key: string): string | undefined =>
  Object.hasOwn(raw, key) && typeof raw[key] === 'string' ? raw[key] : undefined;

// ---------- fields ----------

/** The role the server will apply to a signed-in actor: an operator without MFA is the key role. */
export function txnPersona(actor: { kind: string; mfa?: boolean }): FilterPersona {
  switch (actor.kind) {
    case 'operator':
      return actor.mfa === true ? 'operator' : 'operator_key';
    case 'publisher':
      return 'publisher';
    default:
      return 'buyer';
  }
}

export function offeredFields(ctx: BarContext): string[] {
  if (ctx.kind === 'txn') {
    const refused = REFUSED_FIELDS[ctx.persona];
    return TXN_FIELDS.filter((f) => !refused.includes(f));
  }
  return ACTIVITY_FIELDS.filter((f) => f !== 'actor_id' || ctx.mfa);
}

const viewsOffered = (ctx: BarContext): boolean =>
  ctx.kind === 'txn' && (ctx.persona === 'operator' || ctx.persona === 'operator_key');

/** Fields in the canonical URL order of one bar, then the saved view. */
const orderOf = (ctx: BarContext): readonly string[] =>
  ctx.kind === 'txn' ? [...TXN_FIELDS, 'view'] : ACTIVITY_FIELDS;

const FIELD_LABEL: Readonly<Record<string, string>> = {
  from: 'From',
  to: 'To',
  min_minor: 'Amount at least',
  max_minor: 'Amount at most',
  currency: 'Currency',
  status: 'Status',
  refund: 'Refund',
  case: 'Case',
  buyer: 'Buyer',
  seller: 'Seller',
  q: 'Search',
  ref: 'Order ref',
  channel: 'Channel',
  agent_key: 'Agent key',
  environment: 'Environment',
  flags: 'Flag',
  view: 'Saved view',
  actor_kind: 'Actor',
  actor_id: 'Actor id',
  event_type: 'Event starts with',
  chain_key: 'Chain',
};

/** A minor-unit number as money without a currency sign: 500 becomes 5.00. */
const minorText = (minor: string): string => {
  const n = minor.padStart(3, '0');
  return `${n.slice(0, -2)}.${n.slice(-2)}`;
};

/** What a chip says for one value. Stored values are shown as they are when no plain word exists. */
function valueText(ctx: BarContext, field: string, value: string): string {
  if (field === 'status') return STATUS_LABEL[value as StatusGroup] ?? value;
  if (field === 'refund') return REFUND_WORDS[value] ?? value;
  if (field === 'case') return CASE_WORDS[value] ?? value;
  if (field === 'flags') return FLAG_WORDS[value] ?? value;
  if (field === 'channel' && ctx.kind === 'txn') return CHANNEL_WORDS[value] ?? value;
  if (field === 'min_minor' || field === 'max_minor') return minorText(value);
  if (field === 'view') return SAVED_VIEWS.find((v) => v.id === value)?.label ?? value;
  if (field === 'actor_kind') return value;
  return value;
}

function chipOf(ctx: BarContext, field: string, value: string): Chip {
  const label = FIELD_LABEL[field] ?? field;
  const text =
    field === 'from' || field === 'to' || field === 'min_minor' || field === 'max_minor'
      ? `${label} ${valueText(ctx, field, value)}`
      : `${label}: ${valueText(ctx, field, value)}`;
  return { field, value, label, text };
}

// ---------- parse ----------

const TEXT_MAX = 200;
const CONTROL = /\p{Cc}/u;
const cleanText = (v: string | undefined, max = TEXT_MAX): string | undefined => {
  const s = v?.trim();
  return s !== undefined && s.length > 0 && s.length <= max && !CONTROL.test(s) ? s : undefined;
};

function txnValues(raw: RawMap): Map<string, string[]> {
  const q: TxnQuery = parseTxnQuery(raw);
  const out = new Map<string, string[]>();
  for (const f of TXN_FIELDS) {
    const v: unknown = (q as Record<string, unknown>)[f];
    if (v === undefined) continue;
    out.set(f, Array.isArray(v) ? v.map(String) : [String(v)]);
  }
  return out;
}

function activityValues(raw: RawMap): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const kind = own(raw, 'actor_kind')?.trim();
  if (kind !== undefined && (ACTOR_KINDS as readonly string[]).includes(kind))
    out.set('actor_kind', [kind]);
  const id = cleanText(own(raw, 'actor_id'));
  if (id !== undefined) out.set('actor_id', [id]);
  const ch = own(raw, 'channel')?.trim();
  if (ch !== undefined && (CHANNELS as readonly string[]).includes(ch)) out.set('channel', [ch]);
  const ev = cleanText(own(raw, 'event_type'));
  if (ev !== undefined) out.set('event_type', [ev]);
  const chain = cleanText(own(raw, 'chain_key'));
  if (chain !== undefined) out.set('chain_key', [chain]);
  for (const f of ['from', 'to'] as const) {
    const v = own(raw, f)?.trim();
    if (v !== undefined && IsoUtcSchema.safeParse(v).success) out.set(f, [v]);
  }
  return out;
}

/** Fields in canonical order, each with its values, refused and unknown ones left out. */
function chipsOf(ctx: BarContext, raw: RawMap): { chips: Chip[]; extras: BarState['extras'] } {
  const offered = new Set(offeredFields(ctx));
  const values = ctx.kind === 'txn' ? txnValues(raw) : activityValues(raw);
  const chips: Chip[] = [];
  for (const field of orderOf(ctx)) {
    if (field === 'view') {
      const v = own(raw, 'view')?.trim();
      if (viewsOffered(ctx) && v !== undefined && VIEW_IDS.includes(v))
        chips.push(chipOf(ctx, 'view', v));
      continue;
    }
    if (!offered.has(field)) continue;
    for (const v of values.get(field) ?? []) chips.push(chipOf(ctx, field, v));
  }
  const extras: BarState['extras'] = {};
  if (ctx.kind === 'txn') {
    const q = parseTxnQuery(raw);
    if (q.sort !== undefined && (SORTS as readonly string[]).includes(q.sort)) extras.sort = q.sort;
    if (q.dir !== undefined && (DIRS as readonly string[]).includes(q.dir)) extras.dir = q.dir;
    if (q.limit !== undefined) extras.limit = String(q.limit);
  } else {
    const n = own(raw, 'limit')?.trim();
    if (n !== undefined && /^\d{1,3}$/.test(n) && Number(n) >= 1 && Number(n) <= 200)
      extras.limit = String(Number(n));
  }
  return { chips, extras };
}

/** Chips (grouped by field, in canonical order) and extras to the canonical URL map. */
export function mapFromChips(
  ctx: BarContext,
  chips: readonly Chip[],
  extras: BarState['extras'] = {},
): UrlMap {
  const out: UrlMap = {};
  for (const field of orderOf(ctx)) {
    const values = chips.filter((c) => c.field === field).map((c) => c.value);
    if (values.length > 0) out[field] = values.join(',');
  }
  if (extras.sort !== undefined) out['sort'] = extras.sort;
  if (extras.dir !== undefined) out['dir'] = extras.dir;
  if (extras.limit !== undefined) out['limit'] = extras.limit;
  return out;
}

export function barState(ctx: BarContext, raw: RawMap): BarState {
  const { chips, extras } = chipsOf(ctx, raw);
  return { chips, extras, map: mapFromChips(ctx, chips, extras) };
}

// ---------- change ----------

/** An amount typed in money ("5.00", "12.5") to minor units, or null. */
export function amountToMinor(text: string): string | null {
  const m = /^(\d{1,7})(?:\.(\d{1,2}))?$/.exec(text.trim());
  if (m === null) return null;
  return String(Number(m[1]) * 100 + Number(((m[2] ?? '') + '00').slice(0, 2)));
}

const dayToIso = (field: 'from' | 'to', day: string): string =>
  field === 'from' ? `${day}T00:00:00.000Z` : `${day}T23:59:59.999Z`;

/** The value as the URL holds it, or null when the field does not take it. */
function normalise(ctx: BarContext, field: string, value: string): string | null {
  const v = value.trim();
  if (v === '') return null;
  if (ctx.kind === 'activity') {
    if (field === 'from' || field === 'to') {
      const iso = /^\d{4}-\d{2}-\d{2}$/.test(v) ? dayToIso(field, v) : v;
      return IsoUtcSchema.safeParse(iso).success ? iso : null;
    }
    const got = activityValues({ [field]: v }).get(field);
    return got?.[0] ?? null;
  }
  if (field === 'min_minor' || field === 'max_minor') return amountToMinor(v);
  if (field === 'view') return VIEW_IDS.includes(v) ? v : null;
  const probe: Record<string, string> = { [field]: field === 'currency' ? v.toUpperCase() : v };
  const got = txnValues(probe).get(field);
  return got?.[0] ?? null;
}

/** The map with `value` added to a list field or set on a single field. Refused or invalid: unchanged. */
export function withField(ctx: BarContext, raw: RawMap, field: string, value: string): UrlMap {
  const state = barState(ctx, raw);
  const allowed = field === 'view' ? viewsOffered(ctx) : offeredFields(ctx).includes(field);
  const v = allowed ? normalise(ctx, field, value) : null;
  if (v === null) return state.map;
  const kept = LIST_FIELDS.has(field) ? state.chips : state.chips.filter((c) => c.field !== field);
  if (kept.some((c) => c.field === field && c.value === v)) return state.map;
  return mapFromChips(ctx, [...kept, chipOf(ctx, field, v)], state.extras);
}

/** The map without one chip: the value of a list field, or the whole field when `value` is left out. */
export function withoutChip(ctx: BarContext, raw: RawMap, field: string, value?: string): UrlMap {
  const state = barState(ctx, raw);
  const chips = state.chips.filter(
    (c) => !(c.field === field && (value === undefined || c.value === value)),
  );
  return mapFromChips(ctx, chips, state.extras);
}

/** A link to a page with this map as its query. */
export const hrefWith = (basePath: string, map: Readonly<Record<string, string>>): string => {
  const qs = queryString(map);
  return qs === '' ? basePath : `${basePath}?${qs}`;
};

/** The link to the next page: the same filters and TR1's or SR0's cursor, unchanged. Null when there is none. */
export function pageHref(
  basePath: string,
  ctx: BarContext,
  raw: RawMap,
  cursor: string | null,
): string | null {
  if (cursor === null) return null;
  const map = barState(ctx, raw).map;
  return `${basePath}?${queryString(map)}${queryString(map) === '' ? '' : '&'}cursor=${encodeURIComponent(cursor)}`;
}

// ---------- the add-filter form ----------

export interface FieldControl {
  field: string;
  label: string;
  type: 'text' | 'date' | 'amount' | 'select';
  options?: readonly { value: string; label: string }[];
  placeholder?: string;
}

const pick = (words: Readonly<Record<string, string>>) =>
  Object.entries(words).map(([value, label]) => ({ value, label }));

/** How the add-filter form asks for each field the bar offers. */
export function fieldControls(ctx: BarContext): FieldControl[] {
  const make = (field: string): FieldControl => {
    const label = FIELD_LABEL[field] ?? field;
    switch (field) {
      case 'from':
      case 'to':
        return { field, label, type: 'date' };
      case 'min_minor':
      case 'max_minor':
        return { field, label, type: 'amount', placeholder: '5.00' };
      case 'status':
        return {
          field,
          label,
          type: 'select',
          options: STATUS_WORDS.map((w) => ({ value: w, label: STATUS_LABEL[w] })),
        };
      case 'refund':
        return { field, label, type: 'select', options: pick(REFUND_WORDS) };
      case 'case':
        return { field, label, type: 'select', options: pick(CASE_WORDS) };
      case 'flags':
        return { field, label, type: 'select', options: pick(FLAG_WORDS) };
      case 'environment':
        return {
          field,
          label,
          type: 'select',
          options: ['dryrun', 'sandbox'].map((v) => ({ value: v, label: v })),
        };
      case 'channel':
        return ctx.kind === 'txn'
          ? { field, label, type: 'select', options: pick(CHANNEL_WORDS) }
          : {
              field,
              label,
              type: 'select',
              options: CHANNELS.map((v) => ({ value: v, label: v })),
            };
      case 'actor_kind':
        return {
          field,
          label,
          type: 'select',
          options: ACTOR_KINDS.map((v) => ({ value: v, label: v })),
        };
      case 'currency':
        return { field, label, type: 'text', placeholder: 'USD' };
      default:
        return { field, label, type: 'text' };
    }
  };
  return offeredFields(ctx).map(make);
}

/** A page's `searchParams` (strings, arrays or nothing) to the flat map the bar reads: the first value of each. */
export function rawFromSearchParams(
  sp: Readonly<Record<string, string | string[] | undefined>>,
): RawMap {
  // A plain object, so it can cross to a client component; the one key that would touch the prototype is skipped.
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(sp)) {
    const first = Array.isArray(v) ? v[0] : v;
    if (k !== '__proto__' && typeof first === 'string') out[k] = first;
  }
  return out;
}
