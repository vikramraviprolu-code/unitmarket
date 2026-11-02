// The view model and the new short words of the operator home screen (PUB-UI-OPSHOME). Pure: no server
// module, no clock. It turns stored values (switch states, order statuses, operation states, invariant
// results) into a chip tone and its words, and counts the tiles from stored rows. The sentences the page
// already showed stay in the page and in gate-lines.ts; only the new words of the redesign live here.
// Wording rules: D-051, no italics, no dashes. The environment word is never typed here.

export type ChipTone = 'good' | 'warn' | 'bad' | 'info' | 'neutral';
export interface ChipView {
  tone: ChipTone;
  text: string;
}

export const OPS_HOME_HEADING_SWITCHES = 'Switches';
export const OPS_HOME_SWITCHES_LEDE =
  'The stop button below turns off outbound PayPal calls. The other switches are changed with the operator command line.';
export const OPS_HOME_KILL_STATE_LABEL = 'Outbound PayPal calls';
export const OPS_HOME_ORDERS_NOTE_ONE = 'order';
export const OPS_HOME_ORDERS_NOTE_MANY = 'orders';
export const OPS_HOME_ORDERS_LIST_HEADING = 'Latest orders';
export const OPS_HOME_STATES_NOTE = 'operations in this state';
export const OPS_HOME_INVARIANTS_HOLD = 'All hold';
export const OPS_HOME_INVARIANT_OK = 'Holds';
export const OPS_HOME_INVARIANT_FAILED = 'Failing';

/** The six safety switches, in the order the page lists them, with a readable label and one line. */
const SWITCH_WORDS: Record<string, { label: string; hint: string }> = {
  paypal_outbound: {
    label: 'Outbound PayPal calls',
    hint: 'The emergency stop. Off blocks every PayPal call.',
  },
  checkout_enabled: {
    label: 'Checkout',
    hint: 'Off stops new orders and captures.',
  },
  refunds_enabled: {
    label: 'Refunds',
    hint: 'Off stops refunds being made.',
  },
  unlock_enabled: {
    label: 'Unlock',
    hint: 'Off stops buyers opening what they bought.',
  },
  ai_enabled: {
    label: 'AI help',
    hint: 'Off turns the model features off.',
  },
  webhook_enabled: {
    label: 'PayPal notices',
    hint: 'Off answers incoming PayPal notices with a request to retry.',
  },
};

export interface SwitchView {
  name: string;
  label: string;
  hint: string;
  chip: ChipView;
}

/**
 * For paypal_outbound the safe state is Off, so Off is calm and On asks for attention. When the switch is On
 * but the Cloud Run connection flag is Off, no call goes out, and the words say so (WEB-POLISH-2).
 */
export function switchChip(name: string, on: boolean, flagOff = false): ChipView {
  if (name === 'paypal_outbound') {
    return on
      ? flagOff
        ? { tone: 'warn', text: 'On, flag off: no PayPal calls go out' }
        : { tone: 'warn', text: 'On: PayPal calls allowed' }
      : { tone: 'good', text: 'Off: no PayPal calls' };
  }
  return on ? { tone: 'good', text: 'On' } : { tone: 'warn', text: 'Off' };
}

export function switchView(name: string, on: boolean, flagOff = false): SwitchView {
  const words = SWITCH_WORDS[name] ?? { label: name, hint: '' };
  return { name, label: words.label, hint: words.hint, chip: switchChip(name, on, flagOff) };
}

/** 'awaiting_buyer' becomes 'Awaiting buyer'. */
export function statusWord(raw: string): string {
  const s = raw.replace(/_/g, ' ').trim();
  return s === '' ? s : s.charAt(0).toUpperCase() + s.slice(1);
}

const ORDER_ORDER = [
  'paid',
  'paid_partial',
  'awaiting_buyer',
  'created',
  'capture_requested',
  'capture_claimed',
  'unresolved',
  'frozen',
  'failed',
  'abandoned',
];
const OPERATION_ORDER = ['confirmed', 'prepared', 'sent', 'unknown', 'failed'];

export function orderStatusTone(status: string): ChipTone {
  switch (status) {
    case 'paid':
    case 'paid_partial':
      return 'good';
    case 'created':
    case 'awaiting_buyer':
    case 'capture_requested':
    case 'capture_claimed':
      return 'info';
    case 'unresolved':
      return 'warn';
    case 'frozen':
    case 'failed':
      return 'bad';
    default:
      return 'neutral';
  }
}

export function operationStateTone(state: string): ChipTone {
  switch (state) {
    case 'confirmed':
      return 'good';
    case 'prepared':
    case 'sent':
      return 'info';
    case 'unknown':
      return 'warn';
    case 'failed':
      return 'bad';
    default:
      return 'neutral';
  }
}

export const orderStatusChip = (status: string): ChipView => ({
  tone: orderStatusTone(status),
  text: statusWord(status),
});

export interface CountTile {
  key: string;
  label: string;
  count: number;
  tone: ChipTone;
}

function sortByOrder<T>(items: T[], key: (t: T) => string, order: string[]): T[] {
  const rank = (k: string): number => {
    const i = order.indexOf(k);
    return i === -1 ? order.length : i;
  };
  // Array.prototype.sort is stable: unknown keys keep the order they were stored in.
  return [...items].sort((a, b) => rank(key(a)) - rank(key(b)));
}

/** One tile per order status that occurs in the rows, in a fixed order. Counts come from the rows only. */
export function orderTiles(orders: { status: string }[]): CountTile[] {
  const counts = new Map<string, number>();
  for (const o of orders) counts.set(o.status, (counts.get(o.status) ?? 0) + 1);
  const tiles = [...counts].map(([key, count]) => ({
    key,
    label: statusWord(key),
    count,
    tone: orderStatusTone(key),
  }));
  return sortByOrder(tiles, (t) => t.key, ORDER_ORDER);
}

/** One tile per operation state, in a fixed order. Counts are the stored ones. */
export function operationTiles(operations: { state: string; count: number }[]): CountTile[] {
  const tiles = operations.map((o) => ({
    key: o.state,
    label: statusWord(o.state),
    count: o.count,
    tone: operationStateTone(o.state),
  }));
  return sortByOrder(tiles, (t) => t.key, OPERATION_ORDER);
}

export function invariantChip(ok: boolean): ChipView {
  return ok
    ? { tone: 'good', text: OPS_HOME_INVARIANT_OK }
    : { tone: 'bad', text: OPS_HOME_INVARIANT_FAILED };
}

/** The line the page has always shown above the invariants list, with its tone. */
export function invariantsSummary(invariants: { ok: boolean }[]): { text: string; chip: ChipView } {
  const failing = invariants.filter((v) => !v.ok).length;
  return failing === 0
    ? { text: 'All hold.', chip: { tone: 'good', text: OPS_HOME_INVARIANTS_HOLD } }
    : { text: `${failing} failing.`, chip: { tone: 'bad', text: `${failing} failing` } };
}

/** The caption under an order status tile, for example '1 order paid' or '3 orders awaiting buyer'. */
export function ordersNote(count: number, status: string): string {
  const noun = count === 1 ? OPS_HOME_ORDERS_NOTE_ONE : OPS_HOME_ORDERS_NOTE_MANY;
  return `${String(count)} ${noun} ${statusWord(status).toLowerCase()}`;
}

/** The detail the engine gives an invariant ends in ': holds' when it holds. The Holds chip already says so. */
export function invariantDetailText(detail: string, ok: boolean): string {
  return ok ? detail.replace(/: holds$/, '') : detail;
}
