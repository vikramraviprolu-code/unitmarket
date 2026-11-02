// PUB-UI-OPSHOME golden: every new word of the operator home screen. The reviewed file is
// golden/ops-home-copy.golden.txt. D-051: no italics, no dashes. For paypal_outbound, Off is the safe state.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as copy from './lib/ops-home-copy';

const golden = readFileSync(new URL('./golden/ops-home-copy.golden.txt', import.meta.url), 'utf8');

const SWITCHES = [
  'paypal_outbound',
  'checkout_enabled',
  'refunds_enabled',
  'unlock_enabled',
  'ai_enabled',
  'webhook_enabled',
];

function lines(): string[] {
  const out: string[] = [];
  out.push(`switches heading: ${copy.OPS_HOME_HEADING_SWITCHES}`);
  out.push(`switches lede: ${copy.OPS_HOME_SWITCHES_LEDE}`);
  for (const n of SWITCHES) {
    const v = copy.switchView(n, true);
    out.push(`switch ${n}: ${v.label} | ${v.hint}`);
    out.push(
      `switch ${n} on: ${copy.switchChip(n, true).tone} ${copy.switchChip(n, true).text} | off: ${copy.switchChip(n, false).tone} ${copy.switchChip(n, false).text}`,
    );
  }
  out.push(
    `switch paypal_outbound on, flag off: ${copy.switchChip('paypal_outbound', true, true).tone} ${copy.switchChip('paypal_outbound', true, true).text}`,
  );
  out.push(`kill state label: ${copy.OPS_HOME_KILL_STATE_LABEL}`);
  out.push(`orders list heading: ${copy.OPS_HOME_ORDERS_LIST_HEADING}`);
  out.push(`orders notes: ${copy.ordersNote(1, 'paid')} | ${copy.ordersNote(3, 'awaiting_buyer')}`);
  out.push(`states note: ${copy.OPS_HOME_STATES_NOTE}`);
  for (const s of [
    'paid',
    'paid_partial',
    'awaiting_buyer',
    'created',
    'capture_requested',
    'capture_claimed',
    'unresolved',
    'frozen',
    'failed',
    'abandoned',
  ]) {
    const c = copy.orderStatusChip(s);
    out.push(`order ${s}: ${c.tone} ${c.text}`);
  }
  for (const s of ['confirmed', 'prepared', 'sent', 'unknown', 'failed'])
    out.push(`operation ${s}: ${copy.operationStateTone(s)} ${copy.statusWord(s)}`);
  out.push(`invariant chips: ${copy.invariantChip(true).text} | ${copy.invariantChip(false).text}`);
  out.push(
    `invariants summary: ${copy.invariantsSummary([{ ok: true }]).text} | ${copy.invariantsSummary([{ ok: false }, { ok: true }]).text}`,
  );
  return out;
}

describe('the operator home copy', () => {
  it('matches the reviewed golden file', () => {
    expect(lines().join('\n') + '\n').toBe(golden);
  });
  it('has no dash and no emoji', () => {
    for (const l of lines()) {
      expect(l).not.toMatch(/[‒-―]|--|\s-\s/);
      expect(l).not.toMatch(/\p{Extended_Pictographic}/u);
    }
  });
});
