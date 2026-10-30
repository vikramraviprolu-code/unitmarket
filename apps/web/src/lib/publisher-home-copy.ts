// The words and the small view rules of the redesigned publisher home (PUB-UI-HOME). Pure: no server module,
// no clock. The page takes every new sentence from here and the golden test pins them. Wording rules: D-051
// (the verb follows the count), no italics, no dashes. The environment word (Sandbox or Dry run) is never typed
// here: it comes from the stored environment.
import type { EnvironmentLabel } from '@umsbx/contracts';
import type { PublisherStatus } from './publisher-copy';
import { sinceLines } from './publisher-e1-copy';
import type { SinceCountsInput } from './publisher-e1-copy';
import { dayText } from './agreement-copy';

export type ChipTone = 'good' | 'warn' | 'bad' | 'info' | 'neutral';

export interface ChipView {
  tone: ChipTone;
  label: string;
}

// Tiles
export const TILE_UNITS = 'Units sold';
export const TILE_UNITS_NOTE = 'Paid units';
export const TILE_REFUNDS = 'Refunds';
export const TILE_NET = 'Net';
export const TILE_NET_NOTE = 'Sales minus refunds and reversals. PayPal fees are not taken off.';
export const TILES_LABEL = 'Your figures';
export const NO_SALES_NOTE = 'No sales yet';
export const OTHER_CURRENCIES_NOTE = 'Other currencies are on your statement.';

export const reversalsNote = (amount: string): string => `Reversals ${amount}`;

// Account panel
export const ACCOUNT_HEADING = 'Your account';
export const FACT_PAYEE = 'Payee account';
export const FACT_SETTLEMENT = 'Settlement';
export const FACT_TERMS = 'Publisher terms';

// Cards
export const CARDS_LABEL = 'Where to next';
export const CARD_OFFERS_BODY = 'Prices, status and changes for each offer.';
export const CARD_SALES_BODY = 'Every paid unit, with refunds and totals.';
export const CARD_STATEMENT_BODY = 'What you earned, per currency, from the ledger.';
export const CARD_PAYOUT_BODY = 'The account your money goes to.';

/** The status chip. The status word comes from the stored status. */
export function statusChip(status: PublisherStatus): ChipView {
  switch (status) {
    case 'active':
      return { tone: 'good', label: 'Active' };
    case 'suspended':
      return { tone: 'bad', label: 'Suspended' };
    case 'applied':
      return { tone: 'info', label: 'Applied' };
  }
}

/** The payee chip: none, waiting for a check, or marked as checked. Words always carry the colour. */
export function payeeChip(p: { last4: string | null; verified_at: string | null }): ChipView {
  if (p.last4 === null) return { tone: 'warn', label: 'None' };
  if (p.verified_at === null) return { tone: 'info', label: 'Waiting for a check' };
  return { tone: 'good', label: 'Marked as checked' };
}

/** The line beside the payee chip: only the last 4 characters, and only from stored data. */
export function payeeDetail(p: { last4: string | null }): string {
  return p.last4 === null ? 'No payee account is set yet.' : `Account on file ending ${p.last4}.`;
}

export function termsChip(a: { terms_version: string } | null): ChipView {
  return a === null
    ? { tone: 'warn', label: 'Not accepted' }
    : { tone: 'good', label: `Accepted ${a.terms_version}` };
}

export function termsDetail(a: { accepted_at: string }): string {
  return `On ${dayText(a.accepted_at)}, demo record.`;
}

export type SinceKind = 'sale' | 'refund' | 'offer' | 'payee';

export interface SinceItem {
  kind: SinceKind;
  chip: ChipView;
  text: string;
}

const KIND_CHIP: Record<SinceKind, ChipView> = {
  sale: { tone: 'good', label: 'New sale' },
  refund: { tone: 'warn', label: 'Refund' },
  offer: { tone: 'info', label: 'Offer change' },
  payee: { tone: 'info', label: 'Payee' },
};

/** One item per kind that is not zero, in the fixed order of sinceLines, each with its kind chip. */
export function sinceItems(c: SinceCountsInput): SinceItem[] {
  const zero: SinceCountsInput = {
    new_sales: 0,
    refunds: 0,
    operator_offer_changes: 0,
    payee_decisions: 0,
  };
  const one = (kind: SinceKind, part: Partial<SinceCountsInput>): SinceItem[] =>
    sinceLines({ ...zero, ...part }).map((text) => ({ kind, chip: KIND_CHIP[kind], text }));
  return [
    ...one('sale', { new_sales: c.new_sales }),
    ...one('refund', { refunds: c.refunds }),
    ...one('offer', { operator_offer_changes: c.operator_offer_changes }),
    ...one('payee', { payee_decisions: c.payee_decisions }),
  ];
}

export interface HomeBlock {
  currency: string;
  environment: EnvironmentLabel;
  units_paid: number;
  refunds_minor: number;
  reversals_minor: number;
  net_minor: number;
}

/**
 * The block the figure tiles show: the one stored under the app's environment, else the first. Dry run rows
 * are never added to sandbox rows, and currencies are never added together. The rest is named in a note.
 */
export function primaryBlock<B extends HomeBlock>(
  blocks: readonly B[],
  environment: EnvironmentLabel,
): { block: B | null; others: number } {
  const block = blocks.find((b) => b.environment === environment) ?? blocks[0] ?? null;
  return { block, others: block === null ? 0 : blocks.length - 1 };
}
