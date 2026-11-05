// INT-BUY / BUY.3: the order page in words. The buyer timeline shows approved, paid, ready, downloaded and refunded
// as sentences, with no operator and no context field; the case card says what happens next and by when; a frozen
// order's help link opens its case with the order ref and the item. The logic is in lib/buyer-order-view.ts (the
// unit runner cannot compile .tsx); the e2e spec buyer-order.spec.ts proves the page.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { TRACE_WORDS } from '../composition.server';
import { helpView } from './lib/help-view';
import {
  CASE_STEP_LABELS,
  buyerOrderTimeline,
  caseCardView,
  orderMilestones,
  reportProblemHref,
} from './lib/buyer-order-view';
import type { TimelineEntryView } from './lib/timeline-view';

vi.mock('server-only', () => ({}));

const entry = (
  seq: number,
  event_type: string,
  words_key: string,
  over: Partial<TimelineEntryView> = {},
): TimelineEntryView => ({
  at: `2026-11-05T10:0${String(seq)}:00.000Z`,
  seq,
  event_type,
  words_key,
  actor: { kind: 'buyer', label: 'You' },
  channel: 'web',
  source: { table: 'orders', id: 'ord_view1' },
  verified: true,
  ...over,
});
const ALL: TimelineEntryView[] = [
  entry(1, 'approvals.created', 'approvals.created'),
  entry(2, 'orders.updated', 'orders.updated:paid', {
    actor: { kind: 'paypal', label: 'PayPal' },
    channel: 'webhook',
  }),
  entry(3, 'access_events.created', 'access_events.created:access_ready', {
    actor: { kind: 'system', label: 'UnitMarket' },
    channel: 'job',
  }),
  entry(4, 'access_events.created', 'access_events.created:download_completed'),
  entry(5, 'refund_requests.updated', 'refund_requests.updated:completed', {
    actor: { kind: 'paypal', label: 'PayPal' },
    channel: 'webhook',
  }),
];

describe('BUY.3 the timeline in words', () => {
  it('shows each step as the journal sentence, in time order, with the actor and channel in words', () => {
    const v = buyerOrderTimeline(
      { entries: [...ALL].reverse(), truncated: false },
      'USD',
      TRACE_WORDS,
    );
    expect(v.kind).toBe('rows');
    if (v.kind !== 'rows') return;
    expect(v.rows.map((r) => r.text)).toEqual([
      TRACE_WORDS['approvals.created'],
      TRACE_WORDS['orders.updated:paid'],
      TRACE_WORDS['access_events.created:access_ready'],
      TRACE_WORDS['access_events.created:download_completed'],
      TRACE_WORDS['refund_requests.updated:completed'],
    ]);
    expect(v.rows[0]).toMatchObject({ actor_label: 'You', channel_word: 'Website' });
    expect(v.rows[1]).toMatchObject({ actor_label: 'PayPal', channel_word: 'PayPal notice' });
  });

  it('carries no operator, no context id and no identity field', () => {
    const v = buyerOrderTimeline({ entries: ALL, truncated: false }, 'USD', TRACE_WORDS);
    const text = JSON.stringify(v);
    for (const w of [
      'operator',
      'ctx_',
      'api_key',
      'ip_hash',
      'req_id',
      'on_behalf_of',
      'mandate_id',
      'buyer_id',
    ])
      expect(text, w).not.toContain(w);
    if (v.kind !== 'rows') throw new Error('rows expected');
    for (const r of v.rows) expect(Object.keys(r)).not.toContain('source');
  });

  it('an empty answer, a missing answer and a failed read each have words', () => {
    expect(buyerOrderTimeline({ entries: [], truncated: false }, 'USD', TRACE_WORDS).kind).toBe(
      'empty',
    );
    expect(buyerOrderTimeline(null, 'USD', TRACE_WORDS).kind).toBe('error');
  });

  it('the five milestones are done only when their step happened', () => {
    expect(orderMilestones(ALL).map((m) => [m.id, m.label, m.done])).toEqual([
      ['approved', 'Approved', true],
      ['paid', 'Paid', true],
      ['ready', 'Ready to open', true],
      ['downloaded', 'Downloaded', true],
      ['refunded', 'Refunded', true],
    ]);
    expect(orderMilestones(ALL.slice(0, 2)).map((m) => m.done)).toEqual([
      true,
      true,
      false,
      false,
      false,
    ]);
    expect(orderMilestones([]).every((m) => !m.done)).toBe(true);
  });
});

describe('BUY.3 the case card', () => {
  const now = new Date('2026-11-05T12:00:00.000Z');
  const c = (state: string, sla_due_at = '2026-11-06T10:00:00.000Z') => ({
    case_id: 'cas_view1',
    state,
    buyer_message: 'We are looking at your order.',
    sla_due_at,
    opened_at: '2026-11-05T09:00:00.000Z',
  });
  it('an open case shows its steps with the current one marked, and when we aim to answer', () => {
    const v = caseCardView(c('open'), now);
    expect(v.steps.map((s) => [s.label, s.current, s.done])).toEqual([
      [CASE_STEP_LABELS.opened, true, false],
      [CASE_STEP_LABELS.looking, false, false],
      [CASE_STEP_LABELS.resolved, false, false],
    ]);
    expect(v.due_text).toBe('We aim to answer by 2026-11-06 10:00 UTC.');
    expect(v.message).toBe('We are looking at your order.');
  });
  it('a case being worked on, a late case and a closed case', () => {
    expect(caseCardView(c('diagnosing'), now).steps.map((s) => s.current)).toEqual([
      false,
      true,
      false,
    ]);
    expect(caseCardView(c('open', '2026-11-05T11:00:00.000Z'), now).due_text).toBe(
      'We are past our target and still on it.',
    );
    const done = caseCardView(c('closed'), now);
    expect(done.steps.map((s) => s.done)).toEqual([true, true, true]);
    expect(done.due_text).toBeNull();
  });
});

describe('BUY.3 Report a problem', () => {
  it('a frozen order links to the frozen help page with its ref and its item', () => {
    expect(
      reportProblemHref({ order_ref: 'ref_abc123', status: 'frozen', entitlement_id: 'ent_1' }),
    ).toBe('/help/frozen?order=ref_abc123&item=ent_1');
  });
  it('other orders link to payment help or delivery help, and always carry the ref', () => {
    expect(
      reportProblemHref({ order_ref: 'ref_abc123', status: 'paid', entitlement_id: null }),
    ).toBe('/help/payment?order=ref_abc123');
    expect(
      reportProblemHref({ order_ref: 'ref_abc123', status: 'paid', entitlement_id: 'ent_1' }),
    ).toBe('/help/delivery?order=ref_abc123&item=ent_1');
  });
  it('the help page view names the order and opens a case from an item', () => {
    const v = helpView('frozen', 'ent_1', 'ref_abc123');
    expect(v.canOpenCase).toBe(true);
    expect(v.order_ref).toBe('ref_abc123');
    expect(helpView('frozen', undefined, 'ref_abc123').canOpenCase).toBe(false);
    expect(helpView('frozen', 'ent_1').order_ref).toBeUndefined();
  });
});

describe('BUY.3 the order page reads through the buyer module', () => {
  const here = fileURLToPath(new URL('.', import.meta.url));
  const src = readFileSync(join(here, 'app/orders/[ref]/page.tsx'), 'utf8');
  it('uses readBuyerTimeline, the case card and the report link', () => {
    expect(src).toContain('composition/buyer');
    expect(src).toContain('buyerOrderTimeline(');
    expect(src).toContain('CaseCard');
    expect(src).toContain('reportProblemHref(');
  });
});
