// INT-BUY / BUY.3: the logic of the buyer's order page beyond what OrderStatus already shows: the timeline in
// words, five milestones, the case card and the Report a problem link. Pure.
import { formatDateTime } from './format';
import { TIMELINE_ERROR, timelineView } from './timeline-view';
import type { TimelineEntryView, TimelineView } from './timeline-view';

/** The TR1 words (domain/trace/src/words.ts), passed in by the caller so this file imports no server module. */
export type WordsMap = Readonly<Record<string, string>>;

/** The steps of one order in words. A missing answer (the read failed) is one fixed sentence. */
export function buyerOrderTimeline(
  answer: { entries: readonly TimelineEntryView[]; truncated: boolean } | null,
  currency: string,
  words: WordsMap,
): TimelineView {
  if (answer === null) return { kind: 'error', message: TIMELINE_ERROR };
  return timelineView(
    { entries: answer.entries, truncated: answer.truncated },
    { words, currency },
  );
}

export interface Milestone {
  id: 'approved' | 'paid' | 'ready' | 'downloaded' | 'refunded';
  label: string;
  done: boolean;
}

const has = (es: readonly TimelineEntryView[], pred: (k: string) => boolean): boolean =>
  es.some((e) => pred(e.words_key));

export function orderMilestones(entries: readonly TimelineEntryView[]): Milestone[] {
  return [
    {
      id: 'approved',
      label: 'Approved',
      done: has(entries, (k) => k === 'approvals.created' || k === 'orders.created'),
    },
    {
      id: 'paid',
      label: 'Paid',
      done: has(
        entries,
        (k) =>
          k === 'orders.updated:paid' ||
          k === 'orders.updated:paid_partial' ||
          k === 'order_units.updated:captured_verified',
      ),
    },
    {
      id: 'ready',
      label: 'Ready to open',
      done: has(
        entries,
        (k) => k === 'access_events.created:access_ready' || k === 'entitlements.updated:available',
      ),
    },
    {
      id: 'downloaded',
      label: 'Downloaded',
      done: has(entries, (k) => k === 'access_events.created:download_completed'),
    },
    {
      id: 'refunded',
      label: 'Refunded',
      done: has(
        entries,
        (k) => k === 'refund_requests.updated:completed' || k === 'order_units.updated:refunded',
      ),
    },
  ];
}

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
