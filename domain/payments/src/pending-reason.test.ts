// MC2-L6 (D-083): the closed set of labels for a stored pending reason. Pure table test. A reason
// string that is not one of the known ones is never shown; the generic words are.
import { describe, expect, it } from 'vitest';
import {
  PENDING_REASON_LABEL,
  SELLER_ACCEPTANCE_REASON,
  pendingReasonKind,
  pendingReasonLabel,
} from './pending-reason';

describe('pendingReasonKind and pendingReasonLabel', () => {
  const table: Array<[string, string | null | undefined, string, string]> = [
    [
      'the manual action reason',
      'RECEIVING_PREFERENCE_MANDATES_MANUAL_ACTION',
      'awaiting_seller_acceptance',
      'Awaiting seller acceptance',
    ],
    ['another PayPal reason', 'PENDING_REVIEW', 'payment_pending', 'Payment pending at PayPal'],
    ['the e-check reason', 'ECHECK', 'payment_pending', 'Payment pending at PayPal'],
    ['the stored fallback word', 'PENDING', 'payment_pending', 'Payment pending at PayPal'],
    ['null', null, 'payment_pending', 'Payment pending at PayPal'],
    ['undefined', undefined, 'payment_pending', 'Payment pending at PayPal'],
    ['an empty string', '', 'payment_pending', 'Payment pending at PayPal'],
    [
      'a lower case spelling',
      'receiving_preference_mandates_manual_action',
      'payment_pending',
      'Payment pending at PayPal',
    ],
    [
      'the reason with spaces around it',
      ' RECEIVING_PREFERENCE_MANDATES_MANUAL_ACTION ',
      'payment_pending',
      'Payment pending at PayPal',
    ],
    [
      'the reason as a prefix of a longer string',
      'RECEIVING_PREFERENCE_MANDATES_MANUAL_ACTION_X',
      'payment_pending',
      'Payment pending at PayPal',
    ],
  ];
  it.each(table)('%s', (_name, reason, kind, label) => {
    expect(pendingReasonKind(reason)).toBe(kind);
    expect(pendingReasonLabel(reason)).toBe(label);
  });

  it('the label set is closed: two labels, and every answer is one of them', () => {
    expect(Object.keys(PENDING_REASON_LABEL).sort()).toEqual([
      'awaiting_seller_acceptance',
      'payment_pending',
    ]);
    const labels = new Set(Object.values(PENDING_REASON_LABEL));
    for (const r of [
      '<b>x</b>',
      'x'.repeat(10_000),
      '\u0000',
      'constructor',
      '__proto__',
      'toString',
    ]) {
      expect(labels.has(pendingReasonLabel(r))).toBe(true);
      expect(pendingReasonKind(r)).toBe('payment_pending');
    }
  });

  it('names the PayPal reason in one place', () => {
    expect(SELLER_ACCEPTANCE_REASON).toBe('RECEIVING_PREFERENCE_MANDATES_MANUAL_ACTION');
  });
});
