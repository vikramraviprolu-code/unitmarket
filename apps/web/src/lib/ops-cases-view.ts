// INT-OPS-A / OPS-A.5: the view logic of the case queue and one case. Pure: AL's read shapes in, rows and links in
// words out. The queue is ordered by the time the SLA falls due, and a case past it says so. The detail offers the
// actions AL allows in the case state and builds the request each one posts to /api/ops/cases/[id]/actions with a
// single-use Idempotency-Key. The message to the buyer is plain text the system wrote; it is shown as text and
// never as markup. No buyer name, no PayPal id and no address is read here: AL's case reads carry none.
import { CaseStateSchema } from '@umsbx/contracts';
import type { CaseDetail, CaseQueue } from './view-types';
import { formatDateTime } from './format';
import { OPS_NEEDS_CODE } from './ops-copy';
import { orderHref } from './ops-alerts-view';

export const CASE_STATES = ['unresolved', ...CaseStateSchema.options] as const;
export type CaseFilterState = (typeof CASE_STATES)[number];
export interface CaseFilter {
  state: CaseFilterState;
}

const first = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

export function parseCaseFilter(sp: Record<string, string | string[] | undefined>): CaseFilter {
  const s = first(sp['state']);
  return { state: (CASE_STATES as readonly string[]).includes(s ?? '') ? (s as CaseFilterState) : 'unresolved' };
}

export const caseQuery = (f: CaseFilter): { state: CaseFilterState } => ({ state: f.state });

export const CASE_STATE_WORDS: Record<string, string> = {
  unresolved: 'Still waiting',
  open: 'Open',
  diagnosing: 'Being diagnosed',
  refund_pending: 'Refund pending',
  refunded: 'Refunded',
  restored: 'Access restored',
  closed: 'Closed',
  closed_no_fault: 'Closed, no fault found',
  closed_not_charged: 'Closed, not charged',
};
const stateWord = (s: string): string => CASE_STATE_WORDS[s] ?? s.replace(/_/g, ' ');

export const CASE_KIND_WORDS: Record<string, string> = {
  frozen_order: 'Frozen order',
  refund_requested: 'Refund requested',
  access_problem: 'Access problem',
  payment_problem: 'Payment problem',
};
const kindWord = (k: string): string => CASE_KIND_WORDS[k] ?? k.replace(/_/g, ' ');

export interface CaseRowView {
  case_id: string;
  href: string;
  kind_word: string;
  state_word: string;
  sla_due_at: string;
  sla_text: string;
  late: boolean;
  order_ref: string | null;
  order_href: string | null;
}
export interface CaseQueueView {
  rows: CaseRowView[];
  total: number;
  total_text: string;
  filters: { state: CaseFilterState; label: string; href: string; current: boolean }[];
  next_cursor: string | null;
}

const casesHref = (state: CaseFilterState): string =>
  state === 'unresolved' ? '/ops/buyers/cases' : `/ops/buyers/cases?state=${state}`;

export function caseQueueView(queue: CaseQueue, f: CaseFilter, nowIso: string): CaseQueueView {
  const rows = [...queue.items]
    .sort((a, b) => (a.sla_due_at < b.sla_due_at ? -1 : a.sla_due_at > b.sla_due_at ? 1 : a.case_id < b.case_id ? -1 : 1))
    .map(
      (c): CaseRowView => ({
        case_id: c.case_id,
        href: `/ops/buyers/cases/${c.case_id}`,
        kind_word: kindWord(c.kind),
        state_word: stateWord(c.state),
        sla_due_at: c.sla_due_at,
        sla_text: formatDateTime(c.sla_due_at),
        late: c.sla_due_at < nowIso && (c.state === 'open' || c.state === 'diagnosing' || c.state === 'refund_pending'),
        order_ref: c.order_ref,
        order_href: c.order_ref === null ? null : orderHref(c.order_ref, null),
      }),
    );
  return {
    rows,
    total: queue.total,
    total_text: queue.total === 0 ? 'No cases' : `${String(queue.total)} ${queue.total === 1 ? 'case' : 'cases'}`,
    filters: CASE_STATES.map((state) => ({
      state,
      label: stateWord(state),
      href: casesHref(state),
      current: state === f.state,
    })),
    next_cursor: queue.next_cursor,
  };
}

/** The six actions AL allows on a case, in AL's order. */
export const CASE_ACTION_KINDS = ['diagnose', 'restore', 'credit', 'close_not_charged', 'offer_refund', 'close_no_fault'] as const;
export type CaseActionKind = CaseDetail['allowed_actions'][number];
export const CASE_ACTION_WORDS: Record<CaseActionKind, string> = {
  diagnose: 'Diagnose',
  restore: 'Restore access',
  credit: 'Give extra access time',
  close_not_charged: 'Close, buyer was not charged',
  offer_refund: 'Offer a refund',
  close_no_fault: 'Close, no fault found',
};

export interface CaseActionView {
  kind: CaseActionKind;
  label: string;
  path: string;
  key: string;
  enabled: boolean;
  hint: string | null;
  needs_credit: boolean;
}
export interface CaseDetailView {
  case_id: string;
  kind_word: string;
  state: string;
  state_word: string;
  sla_text: string;
  order_ref: string | null;
  order_href: string | null;
  buyer_message: { label: string; text: string } | null;
  alerts: { alert_id: string; kind: string; href: string }[];
  actions: CaseActionView[];
}

export function caseDetailView(
  d: CaseDetail,
  o: { mfa: boolean; keys: Record<string, string> },
): CaseDetailView {
  return {
    case_id: d.case_id,
    kind_word: kindWord(d.kind),
    state: d.state,
    state_word: stateWord(d.state),
    sla_text: formatDateTime(d.sla_due_at),
    order_ref: d.order_ref,
    order_href: d.order_ref === null ? null : orderHref(d.order_ref, null),
    buyer_message:
      d.buyer_message === undefined || d.buyer_message === ''
        ? null
        : { label: 'Message the system sent to the buyer', text: d.buyer_message },
    alerts: d.alerts.map((a) => ({ alert_id: a.alert_id, kind: a.kind, href: `/ops/alerts/${a.alert_id}` })),
    actions: d.allowed_actions.map(
      (kind): CaseActionView => ({
        kind,
        label: CASE_ACTION_WORDS[kind],
        path: `/api/ops/cases/${d.case_id}/actions`,
        key: o.keys[kind] ?? '',
        enabled: o.mfa,
        hint: o.mfa ? null : OPS_NEEDS_CODE,
        needs_credit: kind === 'credit',
      }),
    ),
  };
}

/** The request one action posts: the credit length only for credit, and the action's own single-use key. */
export function caseActionRequest(
  caseId: string,
  action: Pick<CaseActionView, 'kind' | 'key'>,
  reason: string,
  credit_ms?: number,
): { path: string; body: Record<string, unknown>; headers: Record<string, string> } {
  return {
    path: `/api/ops/cases/${caseId}/actions`,
    body: {
      action: action.kind,
      reason,
      ...(action.kind === 'credit' && credit_ms !== undefined ? { credit_ms } : {}),
    },
    headers: { 'idempotency-key': action.key },
  };
}
