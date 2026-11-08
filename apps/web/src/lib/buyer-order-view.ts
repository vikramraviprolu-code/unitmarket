// INT-BUY / BUY.3: the logic of the buyer's order page beyond what OrderStatus already shows: the case card and
// the Report a problem link. Pure. SCR-1: the timeline and milestone helpers went with the "What happened" block.
import { formatDateTime } from './format';

export const CASE_STEP_LABELS = {
  opened: 'Request received',
  looking: 'We are looking at it',
  resolved: 'Resolved',
} as const;

export interface CaseCardInput {
  case_id: string;
  state: string;
  buyer_message: string;
  sla_due_at: string;
  opened_at: string;
}
export interface CaseCardView {
  case_id: string;
  steps: { label: string; current: boolean; done: boolean }[];
  due_text: string | null;
  message: string;
}

const CLOSED_STATES = new Set([
  'restored',
  'closed_not_charged',
  'refunded',
  'closed_no_fault',
  'closed',
]);

export function caseCardView(c: CaseCardInput, now: Date): CaseCardView {
  const closed = CLOSED_STATES.has(c.state);
  const working = c.state === 'diagnosing' || c.state === 'refund_pending';
  const at = closed ? 3 : working ? 1 : 0;
  const labels = [CASE_STEP_LABELS.opened, CASE_STEP_LABELS.looking, CASE_STEP_LABELS.resolved];
  const steps = labels.map((label, i) => ({
    label,
    current: !closed && i === at,
    done: closed || i < at,
  }));
  const late = new Date(c.sla_due_at).getTime() < now.getTime();
  return {
    case_id: c.case_id,
    steps,
    due_text: closed
      ? null
      : late
        ? 'We are past our target and still on it.'
        : `We aim to answer by ${formatDateTime(c.sla_due_at)}.`,
    message: c.buyer_message,
  };
}

/** "Report a problem": the frozen help page for a frozen order, delivery help for an item, else payment help. */
export function reportProblemHref(o: {
  order_ref: string;
  status: string;
  entitlement_id: string | null;
}): string {
  const order = `order=${encodeURIComponent(o.order_ref)}`;
  const item = o.entitlement_id === null ? '' : `&item=${encodeURIComponent(o.entitlement_id)}`;
  const slug =
    o.status === 'frozen' ? 'frozen' : o.entitlement_id === null ? 'payment' : 'delivery';
  return `/help/${slug}?${order}${item}`;
}
