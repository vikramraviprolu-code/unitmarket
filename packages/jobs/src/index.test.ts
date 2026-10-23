import { describe, expect, it } from 'vitest';
import { PACKAGE_NAME } from './index';
import type { CallBudget, CallBudgetSnapshot } from './index';

describe('@umsbx/jobs scaffold', () => {
  it('exports its package name', () => {
    expect(PACKAGE_NAME).toBe('@umsbx/jobs');
  });

  it('exports the call budget types composition needs (BU-5)', async () => {
    const snapshot: CallBudgetSnapshot = { remaining_today: 1, max_calls_per_day: 2 };
    const budget: CallBudget = () => Promise.resolve(snapshot);
    expect(await budget()).toEqual(snapshot);
  });
});
