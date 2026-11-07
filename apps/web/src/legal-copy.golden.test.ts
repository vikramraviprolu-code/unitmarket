// LEGAL-A golden (docs/specs/legal-a-pages.md): all four draft pages, word for word, plus the
// sign-in notice and the footer labels. The reviewed file is golden/legal-copy.golden.txt. A change
// to it is a change to what people are told they agree to, so the owners read it (H).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CONTACT_ADDRESS } from './lib/account-copy';
import {
  LEGAL_BANNER,
  LEGAL_DOCS,
  LEGAL_NAV,
  LEGAL_SANDBOX_LINE,
  SIGNIN_PRIVACY_SENTENCE,
} from './lib/legal-copy';

const allText = (): string[] =>
  LEGAL_DOCS.flatMap((d) => [
    d.title,
    d.updated,
    ...d.sections.flatMap((s) => [s.heading, ...s.paragraphs]),
  ]).concat([
    LEGAL_BANNER,
    LEGAL_SANDBOX_LINE,
    SIGNIN_PRIVACY_SENTENCE,
    ...Object.values(LEGAL_NAV),
  ]);

describe('legal copy (golden)', () => {
  it('matches golden/legal-copy.golden.txt', () => {
    const lines: string[] = [`banner: ${LEGAL_BANNER}`, `sandbox line: ${LEGAL_SANDBOX_LINE}`];
    for (const d of LEGAL_DOCS) {
      lines.push(`${d.href} | title: ${d.title}`, `${d.href} | updated: ${d.updated}`);
      for (const s of d.sections) {
        lines.push(`${d.href} | heading: ${s.heading}`);
        for (const p of s.paragraphs) lines.push(`${d.href} | text: ${p}`);
      }
    }
    for (const [k, v] of Object.entries(LEGAL_NAV)) lines.push(`footer link, ${k}: ${v}`);
    lines.push(`sign-in notice: ${SIGNIN_PRIVACY_SENTENCE}`);
    const expected = readFileSync(
      new URL('./golden/legal-copy.golden.txt', import.meta.url),
      'utf8',
    )
      .split('\n')
      .filter((l) => l !== '' && !l.startsWith('#'));
    expect(lines).toEqual(expected);
  });
});

describe('legal copy rules', () => {
  it('every page starts with the banner and then the sandbox line', () => {
    for (const d of LEGAL_DOCS) {
      expect(d.banner, d.href).toBe(LEGAL_BANNER);
      expect(d.sandbox, d.href).toBe(LEGAL_SANDBOX_LINE);
    }
    expect(LEGAL_BANNER).toBe('Draft for owner approval. This is not legal advice.');
  });

  it('has no italics markup', () => {
    for (const t of allText()) {
      expect(t).not.toMatch(/<\/?(i|em|cite|var)\b/i);
      expect(t).not.toMatch(/(^|\s)\*[^*\s][^*]*\*(\s|[.,;:]|$)/);
      expect(t).not.toMatch(/(^|\s)_[^_\s][^_]*_(\s|[.,;:]|$)/);
    }
  });

  it('has no dash characters: no en dash, em dash, minus sign, double hyphen or spaced hyphen', () => {
    for (const t of allText()) {
      expect(t).not.toMatch(/[‒–—―−]/);
      expect(t).not.toMatch(/--/);
      expect(t).not.toMatch(/(^|\s)-(\s|$)/);
    }
  });

  it('never says paid out, and never uses the held-order phrase "not charged"', () => {
    for (const t of allText()) {
      expect(t).not.toMatch(/paid out/i);
      expect(t).not.toMatch(/not charged/i);
    }
  });

  it('claims no compliance with any law and names no real company, person or address', () => {
    for (const t of allText()) {
      expect(t).not.toMatch(
        /GDPR|CCPA|HIPAA|PCI|SOC ?2|ISO ?27001|complian|comply|lawful|legally binding/i,
      );
      expect(t).not.toMatch(/\b(Ltd|Inc|LLC|GmbH|Corp|PLC)\b\.?/);
      // The owner (Sakthi) supplied one team contact address on 30 Oct 2026 (assumption 39). It is the only address allowed.
      expect(t.replace('unitmarket@raviprolu.com', '')).not.toMatch(/@|https?:|www\./i);
    }
  });

  it('says plainly: not legal advice, test build, test money, draft for owner approval', () => {
    const joined = allText().join('\n');
    expect(joined).toMatch(/not legal advice/i);
    expect(joined).toMatch(/test build/i);
    expect(joined).toMatch(/dry run/i);
    expect(joined).toMatch(/test money/i);
    expect(joined).toMatch(/draft/i);
  });

  it('keeps the dates as fixed strings, not computed', () => {
    for (const d of LEGAL_DOCS) expect(d.updated).toMatch(/^Drafted \d{1,2} [A-Z][a-z]+ \d{4}$/);
  });

  it('terms: unit, personal use, five days, 15 minutes, one PayPal payment per publisher', () => {
    const t = flat('terms');
    expect(t).toMatch(/personal use/i);
    expect(t).toMatch(/redistribut/i);
    expect(t).toMatch(/five days/i);
    expect(t).toMatch(/verified payment/i);
    expect(t).toMatch(/15 minutes/);
    expect(t).toMatch(/one PayPal payment for each publisher/i);
  });

  it('terms: GATEFIX2 an unpaid order stays open until cancelled or it expires, never "nothing is charged for that attempt"', () => {
    const t = flat('terms');
    expect(t).not.toMatch(/nothing is charged for that attempt/i);
    expect(t).not.toMatch(/You can start again/);
    expect(t).toMatch(/unpaid order stays open until you cancel it or it expires/i);
    expect(t).toMatch(/nothing is charged until you approve/i);
  });

  it('privacy: what is processed, retention numbers, export or deletion, no tracking, contact placeholder', () => {
    const t = flat('privacy');
    expect(t).toMatch(/session cookie/i);
    expect(t).toMatch(/hashed network address/i);
    expect(t).toMatch(/card data/i);
    expect(t).toMatch(/redacted/i);
    expect(t).toMatch(/30 days/);
    expect(t).toMatch(/90 days/);
    expect(t).toMatch(/operator/i);
    expect(t).toMatch(/no advertising/i);
    expect(t).toMatch(/third-party fonts/i);
    expect(t).toContain('You can reach the team at unitmarket@raviprolu.com.');
  });

  it('privacy: applications to publish say what is stored, that the note is permanent and that no account is made', () => {
    const doc = LEGAL_DOCS.find((d) => d.slug === 'privacy')!;
    const sec = doc.sections.find((s) => s.heading === 'Applications to publish');
    expect(sec).toBeDefined();
    const t = sec!.paragraphs.join(' ');
    expect(t).toMatch(/name/i);
    expect(t).toMatch(/country/i);
    expect(t).toMatch(/note/i);
    expect(t).toMatch(/hashed network address/i);
    expect(t).toMatch(/permanent/i);
    expect(t).toMatch(/cannot be (changed or )?deleted/i);
    expect(t).toMatch(/no account is created/i);
  });

  it('privacy: buyer accounts say what is stored, that the password is only hashed, that deletion removes the account and who resets a lost password', () => {
    const doc = LEGAL_DOCS.find((d) => d.slug === 'privacy')!;
    const sec = doc.sections.find((s) => s.heading === 'Buyer accounts');
    expect(sec).toBeDefined();
    expect(sec!.paragraphs).toHaveLength(1);
    const t = sec!.paragraphs.join(' ');
    expect(t).toMatch(/username/i);
    expect(t).toMatch(/display name/i);
    expect(t).toMatch(/country/i);
    expect(t).toMatch(/a hash of your password/i);
    expect(t).toMatch(/never store the password itself/i);
    expect(t).toMatch(/do not ask for or keep an email address/i);
    expect(t).toMatch(/account and your sign in are removed/i);
    expect(t).toMatch(/operator sets a new one/i);
    expect(t).toContain('unitmarket@raviprolu.com');
    // the account copy and the legal page give the same contact address
    expect(t).toContain(CONTACT_ADDRESS);
  });

  it('refunds: decided per unit by an operator; full refund ends access; partial does not', () => {
    const t = flat('refunds');
    expect(t).toMatch(/operator/i);
    expect(t).toMatch(/each unit/i);
    expect(t).toMatch(/full refund of one publisher's part of your order ends access/i);
    expect(t).toMatch(/no refund request form yet/i);
    expect(t).not.toMatch(/open a help case from your order/i);
    expect(t).toMatch(/partial refund does not/i);
    expect(t).toMatch(/test money/i);
  });

  it('publisher terms: fictional, payee marked checked at load, platform fee line', () => {
    const t = flat('publisher-terms');
    expect(t).toMatch(/fictional/i);
    expect(t).toMatch(/marked as checked/i);
    expect(t).toMatch(/demo data is loaded or by an operator check/i);
    expect(t).toMatch(/statement page/i);
    expect(t).toContain(
      'A platform fee of 10 percent of the publisher price is added to the price shown. The publisher does not pay it.',
    );
    expect(t).not.toMatch(/20 percent|not implemented/i);
    // The terms state a platform fee, so they must not also say there are no fees (QA finding of 2026-11-07).
    expect(t).not.toMatch(/there are no fees/i);
    expect(t).toContain('The only fee is the platform fee described under Commission.');
    expect(t).toMatch(/no payout/i);
    expect(t).toMatch(/statement/i);
  });

  it('publisher terms (LEGAL-B): each topic the owner asked for is stated, with its demo limits', () => {
    const t = flat('publisher-terms');
    expect(t).toMatch(/not exclusive/i);
    expect(t).toMatch(/owns the article or may license it/i);
    expect(t).toMatch(/every revision/i);
    expect(t).toMatch(/licence to sell access to single articles/i);
    expect(t).toMatch(/personal use access/i);
    expect(t).toMatch(/window shown on the offer/i);
    expect(t).toMatch(/withdraw/i);
    expect(t).toMatch(/refunds buyers in full/i);
    expect(t).toMatch(/correction is published as a new article/i);
    expect(t).toMatch(/PayPal keeps the fee/i);
    expect(t).toMatch(/does not use the PayPal disputes service/i);
    expect(t).toMatch(/stored delivery record/i);
    expect(t).toMatch(/suspension/i);
    expect(t).toMatch(/final statement/i);
    expect(t).toMatch(/keep the access they paid for/i);
    expect(t).toMatch(/already approved can still complete/i);
    expect(t).toMatch(/No tax is calculated and no tax invoice is issued in this demo/);
    expect(t).toContain('You can reach the team at unitmarket@raviprolu.com.');
    expect(t).toMatch(/No governing law/i);
  });
});

function flat(slug: string): string {
  const d = LEGAL_DOCS.find((x) => x.slug === slug);
  if (d === undefined) throw new Error(`no doc ${slug}`);
  return d.sections.flatMap((s) => [s.heading, ...s.paragraphs]).join('\n');
}
