// Pure sums over ledger rows (P11: the reconciler compares these with the PayPal read-back).
import type { LedgerEntry } from '@umsbx/contracts';

export interface UnitBalance {
  sold_minor: number;
  refunded_minor: number;
  reversed_minor: number;
  net_minor: number;
}

// Sale, refund and reversal rows only; fee and commission rows never change what the buyer paid
// or got back. The caller passes the rows of one unit (or one capture); currency is one per order
// and is enforced when a row is appended, so this function adds integers and nothing else.
export function unitBalance(entries: LedgerEntry[]): UnitBalance {
  let sold = 0;
  let refunded = 0;
  let reversed = 0;
  for (const e of entries) {
    if (e.kind === 'sale') sold += e.amount.minor;
    else if (e.kind === 'refund') refunded += e.amount.minor;
    else if (e.kind === 'reversal') reversed += e.amount.minor;
  }
  return {
    sold_minor: sold,
    refunded_minor: refunded,
    reversed_minor: reversed,
    net_minor: sold - refunded - reversed,
  };
}
