// What the order page shows and when it keeps looking (DP-5b). Pure: from the order view alone, so a
// test can feed it a real pack from the engine. D-051: a hold is never told as a success.
import type { OrderView } from './view-types';
import type { Tone } from '../ui/StatusBanner';

type StatusView = Pick<OrderView, 'status' | 'items' | 'open_case'>;

const SETTLED = new Set(['paid', 'paid_partial', 'failed', 'abandoned', 'frozen']);

/** True when any item line is on hold (a held PayPal order or unit), whatever the order status says. */
export const hasHold = (v: Pick<OrderView, 'items'>): boolean =>
  v.items.some((i) => i.kind === 'hold');

/** The banner tone. A hold wears the warning tone even when the order is `paid` or `paid_partial`. */
export function orderTone(v: Pick<OrderView, 'status' | 'items'>): Tone {
  if (v.status === 'frozen' || hasHold(v)) return 'warn';
  if (v.status === 'paid' || v.status === 'paid_partial') return 'success';
  return v.status === 'failed' ? 'error' : 'info';
}

/**
 * Whether the page keeps asking for the order. It stops once the order is settled, except that a
 * frozen order or any held item is looked at until its case shows: the recovery rules run in the job
 * loop, a moment after the hold.
 */
export function keepPolling(v: StatusView): boolean {
  if (!SETTLED.has(v.status)) return true;
  return (v.status === 'frozen' || hasHold(v)) && v.open_case === null;
}
