// INT-BUY / BUY.3: the order page in words. The case card says what happens next and by when; a frozen
// order's help link opens its case with the order ref and the item. The logic is in lib/buyer-order-view.ts (the
// unit runner cannot compile .tsx); the e2e spec buyer-order.spec.ts proves the page.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { helpView } from './lib/help-view';
import * as orderView from './lib/buyer-order-view';
import { CASE_STEP_LABELS, caseCardView, reportProblemHref } from './lib/buyer-order-view';

vi.mock('server-only', () => ({}));

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
  it('uses the buyer module, the case card and the report link', () => {
    expect(src).toContain('composition/buyer');
    expect(src).toContain('CaseCard');
    expect(src).toContain('reportProblemHref(');
  });
  it('keeps the heading, the return notice, the live status and the report link', () => {
    expect(src).toContain('<h1>Your order</h1>');
    expect(src).toContain('data-testid="return-notice"');
    expect(src).toContain('data-testid="open-now"');
    expect(src).toContain('<OrderStatus');
    expect(src).toContain('data-testid="report-problem"');
  });
  // SCR-1: the owner asked for the "What happened" block (five milestones and the event timeline) to be removed.
  it('has no order-steps section, no milestones, no timeline and no "What happened" heading', () => {
    expect(src).not.toContain('order-steps');
    expect(src).not.toContain('What happened');
    expect(src).not.toContain('milestones');
    expect(src).not.toContain('Milestones of your order');
    expect(src).not.toContain('Steps of your order');
    expect(src).not.toContain('<Timeline');
    expect(src).not.toContain('buyerOrderTimeline');
    expect(src).not.toContain('orderMilestones');
  });
  it('the view module no longer carries the milestone and timeline helpers made only for that block', () => {
    expect(orderView).not.toHaveProperty('orderMilestones');
    expect(orderView).not.toHaveProperty('buyerOrderTimeline');
  });
});
