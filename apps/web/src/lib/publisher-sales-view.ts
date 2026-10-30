// The view-model of the publisher sales page (S4) and statement page (S5) after PUB-UI-SALES: which chip
// tone a status or ledger entry gets, and the tile figures worked out from one totals row. Pure: no server
// module, no clock. Every figure is read from the stored row; nothing is added or subtracted here, and the
// PayPal fee is never part of the net. Wording rules: D-051, no italics, no dashes.
import type { EnvironmentLabel } from '@umsbx/contracts';
import { formatMinor } from './format';
import { TOTALS_COLUMNS, feeText } from './statement-copy';

export type ChipTone = 'good' | 'warn' | 'bad' | 'info' | 'neutral';

export const HOW_MADE_SUMMARY = 'How these figures are made';
export const STATEMENT_FILE_SUMMARY = 'About the download';

/** The tone of a unit status chip. The words always come with it (status_text), colour never stands alone. */
export function unitStatusTone(status: string): ChipTone {
  switch (status) {
    case 'captured_verified':
      return 'good';
    case 'refunded':
    case 'partially_refunded':
    case 'reversal_suspected':
    case 'mismatch':
      return 'warn';
    case 'reversed':
    case 'declined':
      return 'bad';
    case 'pending':
      return 'info';
    default:
      return 'neutral';
  }
}

export function ledgerKindTone(kind: string): ChipTone {
  switch (kind) {
    case 'sale':
      return 'good';
    case 'refund':
      return 'warn';
    case 'reversal':
      return 'bad';
    default:
      return 'neutral';
  }
}

export function envTone(environment: EnvironmentLabel): ChipTone {
  return environment === 'sandbox' ? 'info' : 'warn';
}

export interface TotalsRow {
  currency: string;
  environment: EnvironmentLabel;
  units_paid: number;
  gross_minor: number;
  refunds_minor: number;
  reversals_minor: number;
  net_minor: number;
  paypal_fee_minor: number | null;
}

export interface Tile {
  key: 'units' | 'gross' | 'refunds' | 'net';
  label: string;
  value: string;
  note?: string;
}

/** Paid units, Gross, Refunds and Net from one totals row. The fee is a note beside the net, never subtracted. */
export function totalsTiles(t: TotalsRow): Tile[] {
  const fee = feeText(t.paypal_fee_minor, t.currency, t.environment);
  return [
    { key: 'units', label: TOTALS_COLUMNS.units, value: String(t.units_paid) },
    { key: 'gross', label: TOTALS_COLUMNS.gross, value: formatMinor(t.gross_minor, t.currency) },
    {
      key: 'refunds',
      label: TOTALS_COLUMNS.refunds,
      value: formatMinor(t.refunds_minor, t.currency),
      note: `${TOTALS_COLUMNS.reversals}: ${formatMinor(t.reversals_minor, t.currency)}`,
    },
    {
      key: 'net',
      label: TOTALS_COLUMNS.net,
      value: formatMinor(t.net_minor, t.currency),
      note: `${TOTALS_COLUMNS.fee}: ${fee}. Not subtracted.`,
    },
  ];
}
