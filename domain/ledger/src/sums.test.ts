import { describe, expect, it } from 'vitest';
import type { LedgerEntry } from '@umsbx/contracts';
import { unitBalance } from './index';

const e = (
  kind: LedgerEntry['kind'],
  minor: number,
  refund_id: string | null = null,
): LedgerEntry => ({
  id: `led_${kind}${minor}${refund_id ?? ''}`,
  unit_id: 'unt_1',
  capture_id: 'CAP1',
  kind,
  amount: { currency: 'USD', minor },
  refund_id,
  ref_entry_id: null,
  created_at: '2026-10-22T10:00:00.000Z',
  environment: 'dryrun',
});

describe('unitBalance', () => {
  it('unitBalance sums', () => {
    expect(unitBalance([])).toEqual({
      sold_minor: 0,
      refunded_minor: 0,
      reversed_minor: 0,
      net_minor: 0,
    });
    expect(unitBalance([e('sale', 500)])).toEqual({
      sold_minor: 500,
      refunded_minor: 0,
      reversed_minor: 0,
      net_minor: 500,
    });
    expect(
      unitBalance([
        e('sale', 500),
        e('refund', 100, 'R1'),
        e('refund', 150, 'R2'),
        e('reversal', 50),
        e('paypal_fee', 30),
      ]),
    ).toEqual({ sold_minor: 500, refunded_minor: 250, reversed_minor: 50, net_minor: 200 });
  });

  it('ignores fee and commission rows and does not depend on order', () => {
    const rows = [
      e('sale', 400),
      e('paypal_fee', 42),
      e('commission_reversal', 10, 'R1'),
      e('refund', 100, 'R1'),
    ];
    expect(unitBalance([...rows].reverse())).toEqual(unitBalance(rows));
    expect(unitBalance(rows).net_minor).toBe(300);
  });
});
