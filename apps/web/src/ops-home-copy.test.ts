// PUB-UI-OPSHOME: the view-model helpers of the operator home screen. Pure: stored values in, a chip tone and
// words out, tiles counted from rows. No server module.
import { describe, expect, it } from 'vitest';
import * as view from './lib/ops-home-copy';
import {
  invariantChip,
  invariantDetailText,
  invariantsSummary,
  ordersNote,
  operationTiles,
  orderStatusChip,
  orderTiles,
  statusWord,
  switchChip,
  switchView,
} from './lib/ops-home-copy';

const NO_DASH = /[‒-―]|--|\s-\s/;

describe('switch chips', () => {
  it('treats Off as the safe state for paypal_outbound only', () => {
    expect(switchChip('paypal_outbound', false)).toEqual({
      tone: 'good',
      text: 'Off: no PayPal calls',
    });
    expect(switchChip('paypal_outbound', true)).toEqual({
      tone: 'warn',
      text: 'On: PayPal calls allowed',
    });
  });
  // WEB-POLISH-2: three states of the kill switch badge. On with the flag on keeps the old words; Off keeps
  // the old words whatever the flag says; On with the flag off must not say "allowed".
  it('says plainly that no PayPal call goes out when the switch is On and the connection flag is Off', () => {
    const chip = switchChip('paypal_outbound', true, true);
    expect(chip).toEqual({ tone: 'warn', text: 'On, flag off: no PayPal calls go out' });
    expect(chip.text).not.toMatch(/allowed/);
  });
  it('keeps today words when the switch is On and the flag is On (or the flag is not in question)', () => {
    expect(switchChip('paypal_outbound', true, false)).toEqual({
      tone: 'warn',
      text: 'On: PayPal calls allowed',
    });
  });
  it('keeps today words when the switch is Off, flag on or off', () => {
    for (const flagOff of [false, true])
      expect(switchChip('paypal_outbound', false, flagOff)).toEqual({
        tone: 'good',
        text: 'Off: no PayPal calls',
      });
  });
  it('the flag changes only paypal_outbound, and switchView passes it on', () => {
    expect(switchChip('checkout_enabled', true, true)).toEqual({ tone: 'good', text: 'On' });
    expect(switchView('paypal_outbound', true, true).chip.text).toBe(
      'On, flag off: no PayPal calls go out',
    );
    expect(switchView('paypal_outbound', true).chip.text).toBe('On: PayPal calls allowed');
  });
  it('treats On as good and Off as a warning for every other switch', () => {
    for (const name of ['checkout_enabled', 'refunds_enabled', 'unlock_enabled', 'ai_enabled']) {
      expect(switchChip(name, true)).toEqual({ tone: 'good', text: 'On' });
      expect(switchChip(name, false)).toEqual({ tone: 'warn', text: 'Off' });
    }
  });
  it('gives each known switch a readable label and keeps an unknown name as it is', () => {
    expect(switchView('webhook_enabled', true).label).toBe('PayPal notices');
    expect(switchView('some_new_switch', false)).toMatchObject({
      name: 'some_new_switch',
      label: 'some_new_switch',
      hint: '',
    });
  });
});

describe('status words and tiles', () => {
  it('capitalises a status and drops the underscores', () => {
    expect(statusWord('awaiting_buyer')).toBe('Awaiting buyer');
    expect(statusWord('paid')).toBe('Paid');
    expect(statusWord('')).toBe('');
  });
  it('maps an order status to a tone with its words', () => {
    expect(orderStatusChip('paid')).toEqual({ tone: 'good', text: 'Paid' });
    expect(orderStatusChip('frozen')).toEqual({ tone: 'bad', text: 'Frozen' });
    expect(orderStatusChip('awaiting_buyer')).toEqual({ tone: 'info', text: 'Awaiting buyer' });
    expect(orderStatusChip('abandoned').tone).toBe('neutral');
    expect(orderStatusChip('unresolved').tone).toBe('warn');
  });
  it('counts one tile per order status in a fixed order, from the rows only', () => {
    const rows = [
      { status: 'frozen' },
      { status: 'paid' },
      { status: 'awaiting_buyer' },
      { status: 'paid' },
      { status: 'brand_new' },
    ];
    expect(orderTiles(rows).map((t) => [t.label, t.count])).toEqual([
      ['Paid', 2],
      ['Awaiting buyer', 1],
      ['Frozen', 1],
      ['Brand new', 1],
    ]);
    expect(orderTiles([])).toEqual([]);
  });
  it('orders the operation tiles and keeps the stored counts', () => {
    const t = operationTiles([
      { state: 'failed', count: 1 },
      { state: 'confirmed', count: 3 },
      { state: 'unknown', count: 0 },
    ]);
    expect(t.map((x) => `${x.label}:${x.count}:${x.tone}`)).toEqual([
      'Confirmed:3:good',
      'Unknown:0:warn',
      'Failed:1:bad',
    ]);
  });
});

describe('invariants', () => {
  it('says Holds or Failing in words', () => {
    expect(invariantChip(true)).toEqual({ tone: 'good', text: 'Holds' });
    expect(invariantChip(false)).toEqual({ tone: 'bad', text: 'Failing' });
  });
  it('keeps the sentence the page always showed', () => {
    expect(invariantsSummary([{ ok: true }, { ok: true }]).text).toBe('All hold.');
    expect(invariantsSummary([]).text).toBe('All hold.');
    const s = invariantsSummary([{ ok: true }, { ok: false }, { ok: false }]);
    expect(s.text).toBe('2 failing.');
    expect(s.chip).toEqual({ tone: 'bad', text: '2 failing' });
  });
});

describe('tile captions and invariant details', () => {
  it('says how many orders are in a status, singular or plural', () => {
    expect(ordersNote(1, 'paid')).toBe('1 order paid');
    expect(ordersNote(3, 'awaiting_buyer')).toBe('3 orders awaiting buyer');
  });
  it('drops the trailing holds word of a passing invariant and keeps a failing detail whole', () => {
    expect(
      invariantDetailText('every window end equals the end the event log gives: holds', true),
    ).toBe('every window end equals the end the event log gives');
    expect(invariantDetailText('check: 2 violations: a; b', false)).toBe(
      'check: 2 violations: a; b',
    );
    expect(invariantDetailText('check: 2 violations: holds', false)).toBe(
      'check: 2 violations: holds',
    );
  });
});

describe('house style', () => {
  it('has no dash, italic or emoji in any new word', () => {
    const words: string[] = [];
    for (const v of Object.values(view)) if (typeof v === 'string') words.push(v);
    for (const n of [
      'paypal_outbound',
      'checkout_enabled',
      'refunds_enabled',
      'unlock_enabled',
      'ai_enabled',
      'webhook_enabled',
    ]) {
      const s = switchView(n, true);
      words.push(s.label, s.hint, s.chip.text, switchChip(n, false).text);
    }
    expect(words.length).toBeGreaterThan(10);
    for (const w of words) {
      expect(w).not.toMatch(NO_DASH);
      expect(w).not.toMatch(/\p{Extended_Pictographic}/u);
    }
  });
});
