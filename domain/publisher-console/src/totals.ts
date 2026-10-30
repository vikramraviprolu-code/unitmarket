// The totals row of the publisher sales page (PUB-F1, S4). It is the statement (S5) block, renamed
// for the sales page: the same ledger rows, the same sums, so the two pages show the same numbers by
// construction. Pure; the PayPal fee is carried beside the net and is never subtracted from it.
import type { EnvironmentLabel } from '@umsbx/contracts';
import type { StatementBlock } from './statement';

export interface SalesTotal {
  currency: string;
  environment: EnvironmentLabel;
  /** Units with a ledger sale row. A `mismatch` unit has none, so it is not counted here. */
  units_paid: number;
  gross_minor: number;
  refunds_minor: number;
  reversals_minor: number;
  /** Gross minus refunds minus reversals: the statement net. */
  net_minor: number;
  /** Observed fee rows; null when none are stored. Shown beside the net only. */
  paypal_fee_minor: number | null;
}

export function salesTotals(blocks: readonly StatementBlock[]): SalesTotal[] {
  return blocks.map((b) => ({
    currency: b.currency,
    environment: b.environment,
    units_paid: b.units_sold,
    gross_minor: b.sales_minor,
    refunds_minor: b.refunds_minor,
    reversals_minor: b.reversals_minor,
    net_minor: b.net_minor,
    paypal_fee_minor: b.paypal_fee_minor,
  }));
}
