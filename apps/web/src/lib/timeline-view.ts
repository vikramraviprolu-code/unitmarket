// INT-UI0 / UI0.6: the view logic of the timeline component. Pure: entries in, rows in words out. The entry
// type mirrors TR1's entry exactly (docs/specs/int-tr1-timeline.md, "Entry"); TR1 owns the contract type and
// adds a type-level test that the contract entry can be given to TimelineEntryView. Until TR1 lands the
// component renders TIMELINE_FIXTURES. Words for a step come from `words_key`; TR1 will pass its own map
// from domain/trace/src/words.ts, so an unmapped key falls back to the key made readable, never a blank.
// Wording rules: D-051, no italics, no dashes. No identity, no provider id and no secret in a fixture.
import { formatDateTime, formatMinor } from './format';

export type TimelineActorKind =
  | 'buyer'
  | 'publisher'
  | 'operator'
  | 'agent'
  | 'api_client'
  | 'system'
  | 'paypal'
  | 'unattributed';
export type TimelineChannel =
  'web' | 'api' | 'mcp' | 'job' | 'webhook' | 'cli' | 'seed' | 'backfill';

/** TR1's entry: { at, seq, event_type, words_key, actor, channel, amount_minor?, state_from?, state_to?, source, verified }. */
export interface TimelineEntryView {
  at: string;
  seq: number;
  event_type: string;
  words_key: string;
  actor: { kind: TimelineActorKind; label: string };
  channel: TimelineChannel;
  amount_minor?: number;
  state_from?: string;
  state_to?: string;
  source: { table: string; id: string };
  verified: boolean;
}

/** The field names of TimelineEntryView, for the test that pins them to TR1's entry. */
export const TIMELINE_ENTRY_FIELDS = [
  'at',
  'seq',
  'event_type',
  'words_key',
  'actor',
  'channel',
  'amount_minor',
  'state_from',
  'state_to',
  'source',
  'verified',
] as const satisfies readonly (keyof TimelineEntryView)[];

export const ACTOR_WORDS: Record<TimelineActorKind, string> = {
  buyer: 'Buyer',
  publisher: 'Seller',
  operator: 'Operator',
  agent: 'Agent',
  api_client: 'API client',
  system: 'UnitMarket',
  paypal: 'PayPal',
  unattributed: 'Unknown',
};

export const CHANNEL_WORDS: Record<TimelineChannel, string> = {
  web: 'Website',
  api: 'API',
  mcp: 'Agent tool',
  job: 'Background job',
  webhook: 'PayPal notice',
  cli: 'Command line',
  seed: 'Demo data',
  backfill: 'History import',
};

/** Words for the fixture steps. TR1 replaces this map with the one from domain/trace/src/words.ts. */
export const FIXTURE_WORDS: Record<string, string> = {
  order_started: 'The order was started.',
  payment_approved: 'The buyer approved the payment at PayPal.',
  payment_taken: 'PayPal took the payment.',
  item_unlocked: 'The item was unlocked for the buyer.',
  refund_requested: 'A refund was requested.',
  refund_completed: 'PayPal completed the refund.',
};

export const TIMELINE_EMPTY = 'Nothing has happened on this order yet.';
export const TIMELINE_ERROR = 'The history could not be loaded. Try again in a moment.';
export const TIMELINE_UNVERIFIED = 'Not yet checked against the record.';
export const TIMELINE_CAP_NOTE = 'Showing the first 500 steps.';

/** Six steps of one order, in an order that is not time order, so a test can see the sort. Synthetic. */
export const TIMELINE_FIXTURES: readonly TimelineEntryView[] = [
  {
    at: '2026-11-04T10:00:00.000Z',
    seq: 1,
    event_type: 'order.created',
    words_key: 'order_started',
    actor: { kind: 'buyer', label: 'You' },
    channel: 'web',
    state_to: 'created',
    source: { table: 'orders', id: 'ord_fixture1' },
    verified: true,
  },
  {
    at: '2026-11-04T10:01:12.000Z',
    seq: 2,
    event_type: 'order.awaiting_buyer',
    words_key: 'payment_approved',
    actor: { kind: 'buyer', label: 'You' },
    channel: 'web',
    state_from: 'created',
    state_to: 'awaiting_buyer',
    source: { table: 'orders', id: 'ord_fixture1' },
    verified: true,
  },
  {
    at: '2026-11-04T10:01:15.000Z',
    seq: 3,
    event_type: 'unit.captured',
    words_key: 'payment_taken',
    actor: { kind: 'paypal', label: 'PayPal' },
    channel: 'webhook',
    amount_minor: 250,
    state_from: 'expected',
    state_to: 'captured_verified',
    source: { table: 'order_units', id: 'unit_fixture1' },
    verified: true,
  },
  {
    at: '2026-11-04T10:01:16.000Z',
    seq: 4,
    event_type: 'entitlement.granted',
    words_key: 'item_unlocked',
    actor: { kind: 'system', label: 'UnitMarket' },
    channel: 'job',
    source: { table: 'entitlements', id: 'ent_fixture1' },
    verified: true,
  },
  {
    at: '2026-11-04T12:30:00.000Z',
    seq: 5,
    event_type: 'refund.requested',
    words_key: 'refund_requested',
    actor: { kind: 'operator', label: 'UnitMarket' },
    channel: 'web',
    amount_minor: 75,
    state_to: 'requested',
    source: { table: 'refund_requests', id: 'rfq_fixture1' },
    verified: true,
  },
  {
    at: '2026-11-04T12:30:09.000Z',
    seq: 6,
    event_type: 'refund.completed',
    words_key: 'refund_completed',
    actor: { kind: 'paypal', label: 'PayPal' },
    channel: 'webhook',
    amount_minor: 75,
    state_from: 'pending',
    state_to: 'completed',
    source: { table: 'refund_requests', id: 'rfq_fixture1' },
    verified: false,
  },
];

export interface TimelineRow {
  at: string;
  /** The time as the screens write it, for example "2026-11-04 10:01 UTC". */
  when: string;
  seq: number;
  actor_kind: TimelineActorKind;
  actor_label: string;
  actor_word: string;
  channel: TimelineChannel;
  channel_word: string;
  text: string;
  /** Money in words, only when the caller names the order's currency; the entry carries none. */
  amount_text: string | null;
  verified: boolean;
  note: string | null;
}

export type TimelineView =
  | { kind: 'rows'; rows: TimelineRow[]; truncated: string | null }
  | { kind: 'empty'; message: string }
  | { kind: 'error'; message: string };

export interface TimelineInput {
  entries?: readonly TimelineEntryView[];
  truncated?: boolean;
  /** Any error text. It is never shown: the view gives one fixed sentence. */
  error?: string;
}

export interface TimelineOptions {
  words?: Readonly<Record<string, string>>;
  currency?: string;
}

/** 'brand_new_step' becomes 'Brand new step'. */
export function readableKey(key: string): string {
  const s = key.replace(/[._]+/g, ' ').trim();
  return s === '' ? s : s.charAt(0).toUpperCase() + s.slice(1);
}

const byTime = (a: TimelineEntryView, b: TimelineEntryView): number =>
  a.at < b.at ? -1 : a.at > b.at ? 1 : a.seq - b.seq;

export function timelineView(input: TimelineInput, opts: TimelineOptions = {}): TimelineView {
  if (input.error !== undefined) return { kind: 'error', message: TIMELINE_ERROR };
  const entries = input.entries ?? [];
  if (entries.length === 0) return { kind: 'empty', message: TIMELINE_EMPTY };
  const words = opts.words ?? FIXTURE_WORDS;
  const rows = [...entries].sort(byTime).map((e): TimelineRow => ({
    at: e.at,
    when: formatDateTime(e.at),
    seq: e.seq,
    actor_kind: e.actor.kind,
    actor_label: e.actor.label,
    actor_word: ACTOR_WORDS[e.actor.kind],
    channel: e.channel,
    channel_word: CHANNEL_WORDS[e.channel],
    text: Object.hasOwn(words, e.words_key) ? words[e.words_key]! : readableKey(e.words_key),
    amount_text:
      e.amount_minor !== undefined && opts.currency !== undefined
        ? formatMinor(e.amount_minor, opts.currency)
        : null,
    verified: e.verified,
    note: e.verified ? null : TIMELINE_UNVERIFIED,
  }));
  return { kind: 'rows', rows, truncated: input.truncated === true ? TIMELINE_CAP_NOTE : null };
}
