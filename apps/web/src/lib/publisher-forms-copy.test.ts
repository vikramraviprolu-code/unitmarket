// PUB-UI-FORMS: the view-model rules of the three publisher forms. Pure: status to chip, answer code to
// field, payee to chip. The words are pinned here too, so a change to them is deliberate.
import { describe, expect, it } from 'vitest';
import { parsePriceMinor } from './offer-copy';
import {
  BUYER_SEES_NOTE_READONLY,
  BUYER_SEES_OFF,
  OFFER_READONLY_LEDE,
  collectOptions,
  SECTION_LICENCE,
  SECTION_PRICES,
  SECTION_REVIEW,
  SECTION_WHAT,
  offerErrorField,
  offerStatusTone,
  optionHelp,
  payeeChip,
  payeeEndingText,
  payeeErrorField,
  priceHelp,
} from './publisher-forms-copy';

const NO_DASH = /[‒-―−]/;

describe('offer status chip', () => {
  it('on sale is good, draft is warn, withdrawn is neutral', () => {
    expect(offerStatusTone('authorised')).toBe('good');
    expect(offerStatusTone('draft')).toBe('warn');
    expect(offerStatusTone('withdrawn')).toBe('neutral');
  });
});

describe('answer code to field', () => {
  it('offer codes land next to the field they are about', () => {
    expect(offerErrorField('invalid_price')).toBe('price');
    expect(offerErrorField('invalid_options')).toBe('options');
    expect(offerErrorField('attestation_required')).toBe('attest');
    expect(offerErrorField('invalid_reason')).toBe('reason');
  });
  it('every other offer code stays a message for the whole form', () => {
    for (const c of ['conflict', 'withdrawn', 'not_live', 'forbidden', 'already_offered', 'x'])
      expect(offerErrorField(c)).toBe('form');
  });
  it('payee codes: id problems to the merchant field, the note to the note field, the rest to the form', () => {
    expect(payeeErrorField('invalid_merchant_id')).toBe('merchant');
    expect(payeeErrorField('same_as_current')).toBe('merchant');
    expect(payeeErrorField('invalid_input')).toBe('note');
    expect(payeeErrorField('rate_limited')).toBe('form');
    expect(payeeErrorField('forbidden')).toBe('form');
    expect(payeeErrorField('anything_else')).toBe('form');
  });
});

describe('payee chip', () => {
  it('no payee is a warning that says None', () => {
    expect(payeeChip({ last4: null, verifiedAt: null, operatorChecked: false })).toEqual({
      tone: 'warn',
      text: 'None',
    });
  });
  it('a payee that is not verified yet is pending, in the info tone', () => {
    expect(payeeChip({ last4: 'AB12', verifiedAt: null, operatorChecked: false })).toEqual({
      tone: 'info',
      text: 'Pending',
    });
  });
  it('a payee marked at demo load is Marked as checked, an operator check says so, both good', () => {
    expect(
      payeeChip({ last4: 'AB12', verifiedAt: '2026-10-01T00:00:00Z', operatorChecked: false }),
    ).toEqual({
      tone: 'good',
      text: 'Marked as checked',
    });
    expect(
      payeeChip({ last4: 'AB12', verifiedAt: '2026-10-01T00:00:00Z', operatorChecked: true }),
    ).toEqual({
      tone: 'good',
      text: 'Checked by an operator',
    });
  });
  it('the ending text shows the last 4 only, or says nothing is set', () => {
    expect(payeeEndingText('AB12')).toBe('ending AB12');
    expect(payeeEndingText(null)).toBe('No payee account is set');
  });
});

describe('words', () => {
  it('the section headings are the ones the design names', () => {
    expect([SECTION_WHAT, SECTION_PRICES, SECTION_LICENCE, SECTION_REVIEW]).toEqual([
      'What you are selling',
      'Prices and options',
      'Licence and AI use',
      'Review and save',
    ]);
  });
  it('price help gives the range and an example, option help says what the buyer gets', () => {
    expect(priceHelp('From $0.01 to $5.00.')).toBe('From $0.01 to $5.00. Type it like 2.50.');
    expect(optionHelp('keep_retrieve')).toMatch(/download/i);
    expect(optionHelp('online_read')).toMatch(/online/i);
    expect(optionHelp('other')).toBe('');
  });
  it('no dash character in any new sentence', () => {
    for (const s of [
      BUYER_SEES_OFF,
      OFFER_READONLY_LEDE,
      BUYER_SEES_NOTE_READONLY,
      priceHelp('a'),
      optionHelp('keep_retrieve'),
      optionHelp('online_read'),
    ])
      expect(s).not.toMatch(NO_DASH);
  });
});

describe('collectOptions', () => {
  const rows = (a: [boolean, string], b: [boolean, string]) => [
    { option: 'keep_retrieve', offered: a[0], price: a[1] },
    { option: 'online_read', offered: b[0], price: b[1] },
  ];
  it('sends each offered option in minor units', () => {
    expect(collectOptions(rows([true, '2.50'], [true, '1']), 500, parsePriceMinor)).toEqual({
      options: [
        { option: 'keep_retrieve', price_minor: 250 },
        { option: 'online_read', price_minor: 100 },
      ],
      bad: [],
      code: null,
    });
  });
  it('an option that is not offered is left out and its price is not read', () => {
    const r = collectOptions(rows([false, 'abc'], [true, '1.00']), 500, parsePriceMinor);
    expect(r.code).toBeNull();
    expect(r.options).toEqual([{ option: 'online_read', price_minor: 100 }]);
  });
  it('names the options with a price out of range or not a price', () => {
    const r = collectOptions(rows([true, '9.00'], [true, '0']), 500, parsePriceMinor);
    expect(r.code).toBe('invalid_price');
    expect(r.bad).toEqual(['keep_retrieve', 'online_read']);
    expect(collectOptions(rows([true, '1,5'], [false, '']), 500, parsePriceMinor).bad).toEqual([
      'keep_retrieve',
    ]);
  });
  it('with nothing offered the answer is invalid_options', () => {
    expect(collectOptions(rows([false, ''], [false, '']), 500, parsePriceMinor).code).toBe(
      'invalid_options',
    );
  });
});
