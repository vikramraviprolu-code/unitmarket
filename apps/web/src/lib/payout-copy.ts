// The words of the payout and fee screens (POB-M1, D-089). Pure: no server module, no clock. Operations: "Payouts to publishers"
// with its state labels and the fee form. Publisher statement and sales page: the money block. Every figure shown with these words
// is read from stored rows by the page. Wording rules: D-051, no italics, no dashes. The golden test pins every string.
import type { PayoutState } from '@umsbx/contracts';
import { formatMinor } from './format';

// ---- Operations ----

export const PAYOUTS_HEADING = 'Payouts to publishers';
export const PAYOUTS_LEDE =
  'UnitMarket pays a publisher after the access window of a sale has ended, with no refund open. One payout is for one publisher and one currency.';
export const PAYOUTS_EMPTY = 'No payouts yet.';
/** Shown for a dry run: the payout port of this build pays nothing. The word comes from the stored environment of the page. */
export const PAYOUTS_DRYRUN_NOTE = 'Dry run: no money moved.';
export const PAYOUTS_SANDBOX_NOTE =
  'Payouts are made due here and not sent: a real sandbox payout needs its own approval.';

export const PAYOUT_STATE_LABEL: Record<PayoutState, string> = {
  due: 'Due',
  sending: 'Sending',
  sent: 'Sent',
  confirmed: 'Paid out',
  failed: 'Failed',
  cancelled: 'Cancelled',
};
export const PAYOUT_STATE_TONE: Record<PayoutState, 'good' | 'warn' | 'bad' | 'info' | 'neutral'> =
  {
    due: 'info',
    sending: 'warn',
    sent: 'good',
    confirmed: 'good',
    failed: 'bad',
    cancelled: 'neutral',
  };
export const PAYOUT_COLUMNS = {
  publisher: 'Publisher',
  amount: 'Amount',
  state: 'State',
  sales: 'Sales',
  created: 'Created',
} as const;

export const FEE_HEADING = 'Fee on top';
export const FEE_LEDE =
  'UnitMarket adds this fee to the publisher price and the customer pays it. A new rate applies to offers published from now on. Enter 0 to 30 percent.';
export const FEE_INPUT_LABEL = 'Fee in percent (0 to 30)';
export const FEE_REASON_LABEL = 'Reason';
export const FEE_SUBMIT = 'Set the fee';
export const FEE_NO_MFA =
  'Changing the fee needs a sign in with your authenticator code. This session has none.';
export const FEE_BAD_INPUT = 'Enter a number from 0 to 30 with at most two decimals.';
export const FEE_SAVED = 'The fee is set.';
export const FEE_HISTORY_HEADING = 'Earlier settings';

/** `bps` is whole basis points (1000 is 10 percent). Shown as percent, never as basis points. */
export function bpsToPercentText(bps: number): string {
  const whole = Math.floor(bps / 100);
  const frac = bps % 100;
  if (frac === 0) return String(whole);
  return `${String(whole)}.${String(frac).padStart(2, '0').replace(/0$/, '')}`;
}
export function feeCurrentText(bps: number): string {
  return `Current fee: ${bpsToPercentText(bps)} percent.`;
}

/**
 * What an operator typed, in percent, as whole basis points: digits with at most two decimals, from 0 to 30. Anything else
 * (a sign, an exponent, a comma, a missing digit, more than two decimals, a lookalike digit) is null.
 */
export function percentToBps(text: string): number | null {
  const t = text.trim();
  const m = /^([0-9]{1,2})(?:\.([0-9]{1,2}))?$/.exec(t);
  if (m === null) return null;
  const bps = Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
  return bps <= 3000 ? bps : null;
}

// ---- Publisher statement and sales page ----

export const MONEY_LABEL = {
  fee: 'UnitMarket fee on top (paid by the customer)',
  owed: 'Owed to you',
  paid: 'Paid out to you',
  adjustments: 'Open adjustments (refunded after payout)',
  next: 'Owed, not yet paid out',
} as const;

export const MONEY_SOURCE = {
  fee: 'Source: ledger fee rows minus fee reversal rows.',
  owed: 'Source: ledger payable rows minus payable reversal rows.',
  paid: 'Source: payouts that were sent or paid out.',
  adjustments:
    'Source: the publisher share of refunds booked after payout, not yet taken off a payout.',
  next: 'Source: what is owed and not yet in a payout that went out, less the open adjustments, never below zero. It includes sales still inside their access window.',
} as const;

export const MONEY_NOTE = {
  owed: 'Whether or not it is paid out yet.',
  adjustments: 'Taken off your next payout.',
} as const;

export interface MoneyFigures {
  fee_minor: number;
  owed_minor: number;
  paid_out_minor: number;
  adjustment_minor: number;
  net_minor: number;
}
export interface MoneyTile {
  key: 'fee' | 'owed' | 'paid' | 'adjustments' | 'next';
  label: string;
  value: string;
  note?: string;
}

/** The tiles of one block: fee, owed, paid out, owed and not yet paid out (M1-L5; the key stays `next`), and the open adjustments only when there are some. */
export function moneyTiles(m: MoneyFigures, currency: string): MoneyTile[] {
  const tiles: MoneyTile[] = [
    { key: 'fee', label: MONEY_LABEL.fee, value: formatMinor(m.fee_minor, currency) },
    {
      key: 'owed',
      label: MONEY_LABEL.owed,
      value: formatMinor(m.owed_minor, currency),
      note: MONEY_NOTE.owed,
    },
    { key: 'paid', label: MONEY_LABEL.paid, value: formatMinor(m.paid_out_minor, currency) },
  ];
  if (m.adjustment_minor > 0) {
    tiles.push({
      key: 'adjustments',
      label: MONEY_LABEL.adjustments,
      value: formatMinor(m.adjustment_minor, currency),
      note: MONEY_NOTE.adjustments,
    });
  }
  tiles.push({ key: 'next', label: MONEY_LABEL.next, value: formatMinor(m.net_minor, currency) });
  return tiles;
}
