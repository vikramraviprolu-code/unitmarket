// ORDER-A: which actions the order page offers. Only an order that waits for its buyer offers any; every
// other status offers none. The order view is already null for anyone but the owner (A-20), so the page
// never reaches this function for another buyer.
import { describe, expect, it } from 'vitest';
import { OrderStatusSchema } from '@umsbx/contracts';
import { CANCEL_ANSWER, CANCEL_BUTTON, RESUME_BUTTON, orderActions } from './order-actions';

describe('orderActions', () => {
  it('offers resume and cancel for awaiting_buyer and nothing for any other status', () => {
    const statuses = OrderStatusSchema.options;
    expect(statuses).toHaveLength(10);
    for (const status of statuses) {
      const a = orderActions({ status });
      if (status === 'awaiting_buyer') expect(a, status).toEqual({ resume: true, cancel: true });
      else expect(a, status).toEqual({ resume: false, cancel: false });
    }
  });

  it('an unknown status offers nothing', () => {
    expect(orderActions({ status: 'something_new' })).toEqual({ resume: false, cancel: false });
  });

  it('uses plain words: no dashes, no italics, a name for each action', () => {
    const all = [CANCEL_BUTTON, RESUME_BUTTON, ...Object.values(CANCEL_ANSWER)].join(' ');
    expect(CANCEL_BUTTON).toBe('Cancel order');
    expect(RESUME_BUTTON).toBe('Continue to payment');
    expect(all).not.toMatch(/[‒-―]| - |<em>|<i>/);
    for (const code of ['wrong_state', 'payment_started', 'unavailable'] as const) {
      expect(CANCEL_ANSWER[code].length).toBeGreaterThan(10);
    }
  });
});
