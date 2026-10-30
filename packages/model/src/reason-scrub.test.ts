import { describe, expect, it } from 'vitest';
import { sanitiseModelOutput } from './tools';

// AI-H: the model's free-text `reason` is cleaned before any lane can render it.
const ids = new Set(['ofr_a']);
const reasonOf = (reason: string): string => {
  const r = sanitiseModelOutput({ picks: [{ offer_id: 'ofr_a', reason }], tool_calls: [] }, ids);
  if (!r.ok) throw new Error('expected ok');
  return r.value.picks[0]!.reason;
};

describe('reason scrub (AI-H)', () => {
  it('keeps a plain sentence and the scripted reason unchanged', () => {
    expect(reasonOf('Covers solar basics for beginners.')).toBe(
      'Covers solar basics for beginners.',
    );
    expect(reasonOf('Matches 2 of 3 of your terms.')).toBe('Matches 2 of 3 of your terms.');
    expect(reasonOf('fits')).toBe('fits');
  });
  it('removes URLs of every shape', () => {
    for (const bad of [
      'See https://evil.example/pay?x=1 now',
      'See http://evil.example now',
      'See HTTPS://EVIL.EXAMPLE now',
      'See www.evil.example now',
      'See evil.example/path now',
      'See ftp://evil.example/file now',
      'See javascript:alert(1) now',
    ]) {
      const out = reasonOf(bad);
      expect(out, bad).not.toMatch(/evil|https?:|ftp:|javascript:|www\./i);
    }
  });
  it('removes email addresses', () => {
    expect(reasonOf('Write to buyer@example.com today')).not.toMatch(/@|example\.com/);
  });
  it('removes control characters and lone surrogates', () => {
    const out = reasonOf('a\u0000b\u0007c\u001b[31md\u202ee\ufeff\ud800f\u007fg');
    // eslint-disable-next-line no-control-regex
    expect(out).not.toMatch(/[\u0000-\u001f\u007f\u202e\ufeff\ud800]/);
    expect(out).toContain('a');
    expect(out).toContain('g');
  });
  it('removes digits next to a currency sign or code', () => {
    for (const bad of [
      'Only $5 today',
      'Only $ 5.99 today',
      'Only 5$ today',
      'Only €10 today',
      'Only 10,50 € today',
      'Only £3 today',
      'Only ¥1,000 today',
      'Only 5 USD today',
      'Only USD 5 today',
      'Only EUR10 today',
      'Only 10 euros today',
      'Only 7 dollars today',
    ]) {
      expect(reasonOf(bad), bad).not.toMatch(/\d/);
    }
  });
  it('keeps digits that are not next to a currency', () => {
    expect(reasonOf('Chapter 3 of 12 matches')).toBe('Chapter 3 of 12 matches');
  });
  it('collapses whitespace and caps at 160 characters', () => {
    expect(reasonOf('  a   b \n\n c  ')).toBe('a b c');
    const long = reasonOf('word '.repeat(200));
    expect([...long].length).toBeLessThanOrEqual(160);
    const emoji = reasonOf('\u{1F600}'.repeat(300));
    expect([...emoji].length).toBeLessThanOrEqual(160);
    expect(emoji).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
  });
  it('is idempotent', () => {
    const once = reasonOf('Visit https://x.example or $5 or a@b.co now');
    expect(reasonOf(once)).toBe(once);
  });
  it('an all-hostile reason becomes an empty string, not an error', () => {
    expect(reasonOf('https://evil.example')).toBe('');
  });
});
