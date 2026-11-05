// INT-SEL / SEL.5: the Money page labels. Fee and net are labelled "modelled" only on a statement block whose
// stored environment is dry run (F8); a sandbox block, and an empty statement, carry no such label. The word
// is never typed beside a figure: it comes from here, from the block's stored environment. Pure.
import type { EnvironmentLabel } from '@umsbx/contracts';
import { formatMinor } from './format';
import { EXPORT_STATEMENT_HREF } from './publisher-e1-copy';
import { FEE_NOT_REPORTED } from './statement-copy';

export const MODELLED = 'modelled';
export const MODELLED_NOTE =
  'Fee and net on a dry run are modelled. No money moved and PayPal reported no fee.';
export const PUB_STATEMENT_HREF = EXPORT_STATEMENT_HREF;

export function blockLabels(b: { environment: EnvironmentLabel }): { modelled: boolean } {
  return { modelled: b.environment === 'dryrun' };
}

export interface MoneyBlockRead {
  currency: string;
  environment: EnvironmentLabel;
  sales_minor: number;
  refunds_minor: number;
  reversals_minor: number;
  net_minor: number;
  paypal_fee_minor: number | null;
  modelled: boolean;
}

export interface MoneyBlockView {
  key: string;
  net_text: string;
  fee_text: string;
  /** The word "modelled" on a dry run block, else null. */
  label: string | null;
  note: string | null;
}

/** The labels of every block of a statement. A statement with no block has none. */
export function moneyView(read: { blocks: readonly MoneyBlockRead[] }): {
  blocks: MoneyBlockView[];
} {
  return {
    blocks: read.blocks.map((b): MoneyBlockView => {
      const modelled = b.modelled && blockLabels(b).modelled;
      return {
        key: `${b.currency}-${b.environment}`,
        net_text: formatMinor(b.net_minor, b.currency),
        fee_text:
          b.paypal_fee_minor === null || b.environment === 'dryrun'
            ? FEE_NOT_REPORTED
            : formatMinor(b.paypal_fee_minor, b.currency),
        label: modelled ? MODELLED : null,
        note: modelled ? MODELLED_NOTE : null,
      };
    }),
  };
}
