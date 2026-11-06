// INT-OPS-C / OPS-C.4: the pure parts of the Money tab totals and the ledger list. A total is one environment, one
// currency and one ledger kind; it never mixes dryrun and sandbox rows (C6). The query of the list is checked here.
import type { EnvironmentLabel } from '@umsbx/contracts';

export const LEDGER_KINDS = [
  'sale',
  'paypal_fee',
  'platform_fee',
  'refund',
  'reversal',
  'commission_reversal',
  // POB 0029: the fee and payout split kinds.
  'fee',
  'payable',
  'fee_reversal',
  'payable_reversal',
  'payout_adjustment',
] as const;
export type LedgerKind = (typeof LEDGER_KINDS)[number];

export const LEDGER_KIND_WORD: Record<LedgerKind, string> = {
  sale: 'Sales',
  paypal_fee: 'PayPal fees',
  platform_fee: 'Platform fees',
  refund: 'Refunds',
  reversal: 'Reversals',
  commission_reversal: 'Commission reversals',
  fee: 'Fees',
  payable: 'Payable to sellers',
  fee_reversal: 'Fee reversals',
  payable_reversal: 'Payable reversals',
  payout_adjustment: 'Payout adjustments',
};

export interface LedgerQuery {
  environment: EnvironmentLabel;
  currency: string;
  kind: LedgerKind;
}

/** The list URL of one total. */
export function ledgerHref(environment: string, currency: string, kind: string): string {
  const q = new URLSearchParams({ environment, currency, kind });
  return `/ops/money/ledger?${q.toString()}`;
}

const one = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/** The list query, or null for anything but a stored environment, a currency code and a ledger kind. */
export function parseLedgerQuery(raw: Record<string, unknown>): LedgerQuery | null {
  const environment = one(raw['environment']);
  const currency = one(raw['currency']);
  const kind = one(raw['kind']);
  if (environment !== 'dryrun' && environment !== 'sandbox') return null;
  if (currency === null || !/^[A-Z]{3}$/.test(currency)) return null;
  if (kind === null || !(LEDGER_KINDS as readonly string[]).includes(kind)) return null;
  return { environment, currency, kind: kind as LedgerKind };
}

/** The words of a kind; a kind the list does not know shows as it is stored. */
export const kindWord = (kind: string): string =>
  (LEDGER_KIND_WORD as Record<string, string>)[kind] ?? kind;

/** The jump links of the ledger list. */
export const OPS_LEDGER_SECTIONS: { id: string; label: string }[] = [
  { id: 'ledger-lines', label: 'Lines' },
];

/** The stored rates of the day as one sentence; the Money page shows it as it is and computes nothing from it. */
export function ratesText(
  rates: { date: string; eur_usd: number | string; eur_gbp: number | string } | null,
): string {
  if (rates === null) return 'No rates stored.';
  return `${rates.date}: 1 EUR is ${rates.eur_usd} USD and ${rates.eur_gbp} GBP.`;
}
