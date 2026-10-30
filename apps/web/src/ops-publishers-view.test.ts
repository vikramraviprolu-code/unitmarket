// PUB-UI-OPS: the view-model helpers of the operator publishers and payee request screens. Pure: they turn
// stored values into chip tones and words, and count the figures of the summary tiles. No server module.
import { describe, expect, it } from 'vitest';
import {
  agreementChip,
  applicantStateChip,
  oldestAgeMs,
  payeeChip,
  publisherStatusTone,
  publisherTiles,
  reasonGivenText,
} from './lib/ops-publishers-view';
import * as view from './lib/ops-publishers-view';

const NO_DASH = /[‒-―]|--|\s-\s/;

describe('status and payee chips', () => {
  it('maps a publisher status to a tone', () => {
    expect(publisherStatusTone('active')).toBe('good');
    expect(publisherStatusTone('suspended')).toBe('bad');
    expect(publisherStatusTone('applied')).toBe('info');
  });
  it('says what the payee state is in words, with a tone', () => {
    expect(payeeChip({ last4: null, verified: false, shared: false })).toEqual({
      tone: 'neutral',
      text: 'No payee account',
    });
    expect(payeeChip({ last4: 'AB12', verified: false, shared: false })).toEqual({
      tone: 'warn',
      text: 'Payee not checked',
    });
    expect(payeeChip({ last4: 'AB12', verified: true, shared: true })).toEqual({
      tone: 'good',
      text: 'Payee checked',
    });
  });
});

describe('agreement chip', () => {
  const rec = { terms_version: 'v1' };
  it('is good when the stored version is the current one', () => {
    expect(agreementChip(rec, 'v1')).toEqual({ tone: 'good', text: 'Terms v1 accepted' });
  });
  it('warns when the version changed and was not re-accepted', () => {
    expect(agreementChip({ terms_version: 'v0' }, 'v1')).toEqual({
      tone: 'warn',
      text: 'Terms version changed',
    });
  });
  it('is neutral when nothing was accepted', () => {
    expect(agreementChip(null, 'v1')).toEqual({ tone: 'neutral', text: 'Terms not accepted' });
  });
});

describe('applicant state chip', () => {
  it('waiting is a warn, rejected is bad', () => {
    expect(applicantStateChip('pending').tone).toBe('warn');
    expect(applicantStateChip('rejected').tone).toBe('bad');
    expect(applicantStateChip('pending').text).toBe('Waiting for your answer');
    expect(applicantStateChip('rejected').text).toBe('Rejected');
  });
  it('words the reason given', () => {
    expect(reasonGivenText('too small')).toBe('Reason given: too small');
  });
});

describe('summary figures', () => {
  it('counts publishers by status, waiting applicants and offers on sale from stored rows', () => {
    const t = publisherTiles(
      [
        { status: 'active', offers_live: 3 },
        { status: 'active', offers_live: 0 },
        { status: 'suspended', offers_live: 2 },
        { status: 'applied', offers_live: 0 },
      ],
      [{ state: 'pending' }, { state: 'rejected' }, { state: 'pending' }],
    );
    expect(t).toEqual({ active: 2, suspended: 1, applicantsWaiting: 2, offersOnSale: 5 });
  });
  it('is all zero for nothing', () => {
    expect(publisherTiles([], [])).toEqual({
      active: 0,
      suspended: 0,
      applicantsWaiting: 0,
      offersOnSale: 0,
    });
  });
  it('finds the oldest open payee request, or null for none', () => {
    expect(oldestAgeMs([])).toBeNull();
    expect(oldestAgeMs([{ age_ms: 5 }, { age_ms: 90 }, { age_ms: 7 }])).toBe(90);
  });
});

describe('words', () => {
  it('has no dashes, italics marks or emoji in any string it exports', () => {
    const texts = Object.values(view).filter((v: unknown): v is string => typeof v === 'string');
    expect(texts.length).toBeGreaterThan(8);
    for (const t of texts) {
      expect(t).not.toMatch(NO_DASH);
      expect(t).not.toMatch(/[\u{1F300}-\u{1FAFF}☀-➿]/u);
    }
  });
  it('card descriptions on /ops do not name the other cards, so each link name stays unique', () => {
    expect(view.OPS_CARD_EVALS_TEXT).not.toMatch(/publisher|payee/i);
    expect(view.OPS_CARD_PAYEE_TEXT).not.toMatch(/publishers/i);
  });
});
