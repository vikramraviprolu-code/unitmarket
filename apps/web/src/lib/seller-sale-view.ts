// INT-SEL / SEL.1: the sale detail as words. Pure. It reads what the composition module hands over and adds
// nothing: no buyer, no order total, no refund reason. A refund shows its amount, state and date only (F1).
// The money is the statement money: sold, less refunds, less reversals; the PayPal fee sits beside it (F3).
import { formatDateTime, formatMinor, optionLabel } from './format';
import { feeText } from './statement-copy';
import { timelineView } from './timeline-view';
import type { TimelineEntryView, TimelineView } from './timeline-view';
import type { EnvironmentLabel } from '@umsbx/contracts';

export const NOT_FOUND_TEXT = 'We could not find that sale.';
export const SALE_HEADING = 'Sale';
export const BACK_TO_SALES = 'Back to sales';
export const TIMELINE_LABEL = 'Steps of this sale';

export interface SellerSale {
  unit_id: string;
  order_ref6: string;
  status_text: string;
  created_at: string;
  captured_at: string | null;
  currency: string;
  environment: EnvironmentLabel;
  channel: 'human' | 'agent';
  /** Article title and the way it was bought, one per article of the unit. */
  items: { title: string; option: string }[];
  gross_minor: number;
  refunds_minor: number;
  reversals_minor: number;
  paypal_fee_minor: number | null;
  /** The latest refund of the unit: amount, state and date. Never the operator's reason text. */
  refund: { amount_minor: number | null; state: string; at: string } | null;
  timeline: { entries: TimelineEntryView[]; truncated: boolean };
  words: Readonly<Record<string, string>>;
}

export interface SaleView {
  heading: string;
  ref6: string;
  bought_by: 'a person' | 'an agent';
  status_text: string;
  created_text: string;
  units: { title: string; option_text: string }[];
  gross_text: string;
  fee_text: string;
  refund: { amount_text: string; state_text: string; date_text: string } | null;
  reversals_text: string | null;
  net_text: string;
  environment: EnvironmentLabel;
  timeline: TimelineView;
}

const REFUND_STATE: Record<string, string> = {
  requested: 'Requested',
  pending: 'Pending',
  completed: 'Completed',
  failed: 'Failed',
  rejected: 'Not refunded',
};
const stateText = (s: string): string =>
  REFUND_STATE[s] ?? s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, ' ');

export function saleView(s: SellerSale): SaleView {
  const net = s.gross_minor - s.refunds_minor - s.reversals_minor;
  return {
    heading: `${SALE_HEADING} ${s.order_ref6}`,
    ref6: s.order_ref6,
    bought_by: s.channel === 'agent' ? 'an agent' : 'a person',
    status_text: s.status_text,
    created_text: formatDateTime(s.created_at),
    units: s.items.map((i) => ({ title: i.title, option_text: optionLabel(i.option) })),
    gross_text: formatMinor(s.gross_minor, s.currency),
    fee_text: feeText(s.paypal_fee_minor, s.currency, s.environment),
    refund:
      s.refund === null
        ? null
        : {
            amount_text:
              s.refund.amount_minor === null
                ? 'The whole sale'
                : formatMinor(s.refund.amount_minor, s.currency),
            state_text: stateText(s.refund.state),
            date_text: formatDateTime(s.refund.at),
          },
    reversals_text: s.reversals_minor > 0 ? formatMinor(s.reversals_minor, s.currency) : null,
    net_text: formatMinor(net, s.currency),
    environment: s.environment,
    timeline: timelineView(s.timeline, { words: s.words, currency: s.currency }),
  };
}
