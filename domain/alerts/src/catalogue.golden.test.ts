// INT-AL AL.2: one catalogue maps every alert kind and every gate reason. A kind or a reason prefix that is
// not mapped fails here, so a new alert cannot reach the operator list without a title, a severity and a fix link.
import { describe, expect, it } from 'vitest';
import { BLOCKED_BY } from '@umsbx/contracts';
import { ALERT_KINDS, describeAlert, describeGate } from './index';

const OLD_KINDS = [
  'frozen_order',
  'create_rejected',
  'content_unavailable',
  'unexpected_capture',
  'fee_above_amount',
  'payment_unresolved',
  'reversal',
  'reversal_hint',
  'partial_composite',
  'refund_unbooked',
  'refund_failed',
  'refund_unresolved',
];
const NEW_KINDS = ['mandate_near_cap', 'webhook_failing'];
const SEVERITIES = ['critical', 'high', 'medium', 'info'];
const MONEY = ['unit_amount', 'order_total', 'refund_amount'];

describe('alert catalogue (AL.2)', () => {
  it('maps the 12 old kinds and the 2 new kinds, and nothing else', () => {
    expect([...ALERT_KINDS].sort()).toEqual([...OLD_KINDS, ...NEW_KINDS].sort());
  });

  it.each([...OLD_KINDS, ...NEW_KINDS])(
    '%s has severity, title, cause, fix link, runbook and money rule',
    (kind) => {
      const reason =
        kind === 'mandate_near_cap'
          ? 'cap90_man_1'
          : kind === 'webhook_failing'
            ? 'webhook_failing_wsb_1_wdl_1'
            : kind === 'refund_unresolved'
              ? 'refund_outcome_unknown_rfr_1'
              : 'x';
      const e = describeAlert(kind, reason, {});
      expect(e).not.toBeNull();
      expect(SEVERITIES).toContain(e!.severity);
      expect(e!.title.length).toBeGreaterThan(3);
      expect(e!.cause.length).toBeGreaterThan(10);
      expect(e!.fix.route.startsWith('/')).toBe(true);
      expect(e!.fix.anchor).toMatch(/^[a-z0-9-]+$/);
      expect(e!.runbook.length).toBeGreaterThan(10);
      expect(e!.money_at_risk === null || MONEY.includes(e!.money_at_risk)).toBe(true);
    },
  );

  it('the two new kinds carry no money at risk', () => {
    expect(describeAlert('mandate_near_cap', 'cap90_man_1', {})!.money_at_risk).toBeNull();
    expect(
      describeAlert('webhook_failing', 'webhook_failing_wsb_1_wdl_1', {})!.money_at_risk,
    ).toBeNull();
  });

  it('money rules follow the audit table', () => {
    expect(describeAlert('payment_unresolved', 'x', {})!.money_at_risk).toBe('order_total');
    expect(describeAlert('refund_failed', 'refund_failed_rfr_1', {})!.money_at_risk).toBe(
      'refund_amount',
    );
    expect(
      describeAlert('refund_unresolved', 'refund_outcome_unknown_rfr_1', {})!.money_at_risk,
    ).toBe('refund_amount');
    expect(describeAlert('unexpected_capture', 'x', {})!.money_at_risk).toBe('unit_amount');
  });

  it('refund_unresolved maps its three reason prefixes to different causes', () => {
    const a = describeAlert('refund_unresolved', 'refund_outcome_unknown_rfr_1', {})!;
    const b = describeAlert('refund_unresolved', 'cannot_book_re_1', {})!;
    const c = describeAlert('refund_unresolved', 'ledger_rule_re_1', {})!;
    expect(new Set([a.cause, b.cause, c.cause]).size).toBe(3);
  });

  it('a fake kind or a fake reason prefix is not mapped', () => {
    expect(describeAlert('made_up_kind', 'x', {})).toBeNull();
    expect(describeAlert('refund_unresolved', 'made_up_reason_rfr_1', {})).toBeNull();
    expect(describeAlert('mandate_near_cap', 'something_else', {})).toBeNull();
    expect(describeAlert('webhook_failing', 'something_else', {})).toBeNull();
  });

  it('every BLOCKED_BY value is mapped and a fake one is not', () => {
    expect([...BLOCKED_BY].sort()).toEqual([
      'budget',
      'connect_off',
      'egress',
      'kill_switch',
      'no_approval',
    ]);
    for (const r of BLOCKED_BY) {
      const e = describeGate(r);
      expect(e).not.toBeNull();
      expect(SEVERITIES).toContain(e!.severity);
      expect(e!.fix.route.startsWith('/')).toBe(true);
      expect(e!.money_at_risk).toBeNull();
    }
    expect(describeGate('made_up')).toBeNull();
  });
});
