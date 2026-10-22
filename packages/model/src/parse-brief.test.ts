import { describe, expect, it } from 'vitest';
import { parseBrief } from './parse-brief';

describe('parseBrief', () => {
  it('parses "need X, under $6, download, English"', () => {
    expect(parseBrief('need X, under $6, download, English')).toEqual({
      need: 'X',
      ceiling_minor: 600,
      currency: 'USD',
      option: 'keep_retrieve',
      language: 'en',
      terms: ['x'],
    });
  });

  it('maps currency words, view words and fractions with integer arithmetic', () => {
    const r = parseBrief('Need solar power basics, max 2.50 euros, read online, German');
    expect(r).toMatchObject({ ceiling_minor: 250, currency: 'EUR', option: 'online_read', language: 'de' });
    expect(r.terms).toEqual(['solar', 'power', 'basics']);
    expect(parseBrief('need tax guide, 4.5 pounds, view').currency).toBe('GBP');
    expect(parseBrief('need tax guide, view').option).toBe('online_read');
    expect(parseBrief('need tax guide, keep').option).toBe('keep_retrieve');
  });

  it('returns nulls when the brief says nothing about ceiling, option, language', () => {
    expect(parseBrief('need heat pumps')).toMatchObject({
      ceiling_minor: null,
      currency: null,
      option: null,
      language: null,
    });
  });

  it('nulls an absurd ceiling instead of overflowing', () => {
    expect(parseBrief('need a guide under $99999999999999999999999').ceiling_minor).toBeNull();
  });

  it('strips control and zero-width characters', () => {
    expect(parseBrief('need a\u0000b​c guide').need).not.toMatch(/[\u0000​]/);
  });
});
