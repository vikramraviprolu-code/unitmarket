import { describe, expect, it } from 'vitest';
import { cryptoIds, fakeClock, seededIds, systemClock } from './index';

const ALPHABET = /^[0-9abcdefghjkmnpqrstvwxyz]{26}$/;

describe('fakeClock', () => {
  it('fake clock moves only when told', () => {
    const c = fakeClock('2026-10-21T10:00:00.000Z');
    const a = c.now().toISOString();
    const b = c.now().toISOString();
    expect(a).toBe('2026-10-21T10:00:00.000Z');
    expect(b).toBe(a);
    c.advance(1500);
    expect(c.now().toISOString()).toBe('2026-10-21T10:00:01.500Z');
    c.set('2027-01-01T00:00:00.000Z');
    expect(c.now().toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });
  it('returns a fresh Date each call so callers cannot mutate the clock', () => {
    const c = fakeClock('2026-10-21T10:00:00.000Z');
    c.now().setUTCFullYear(1999);
    expect(c.now().toISOString()).toBe('2026-10-21T10:00:00.000Z');
  });
  it('rejects a start or set value that is not ISO UTC with Z', () => {
    expect(() => fakeClock('2026-10-21T10:00:00+02:00')).toThrow();
    expect(() => fakeClock('not a date')).toThrow();
    const c = fakeClock('2026-10-21T10:00:00.000Z');
    expect(() => c.set('2026-10-21')).toThrow();
    expect(() => c.advance(Number.NaN)).toThrow();
  });
});

describe('systemClock', () => {
  it('returns a Date near real time', () => {
    const t = systemClock().now().getTime();
    expect(Math.abs(t - new Date(t).getTime())).toBe(0);
    expect(t).toBeGreaterThan(1_700_000_000_000);
  });
});

describe('cryptoIds', () => {
  it('crypto ids are 128-bit, prefixed, unique over 10k', () => {
    const ids = cryptoIds();
    const seen = new Set<string>();
    for (let i = 0; i < 10_000; i++) {
      const id = ids.next('ord');
      const [prefix, body] = id.split('_');
      expect(prefix).toBe('ord');
      expect(body).toMatch(ALPHABET);
      // 128 bits are left-padded with two zero bits to fill 26 base32 characters.
      expect('01234567').toContain(body![0]!);
      seen.add(id);
    }
    expect(seen.size).toBe(10_000);
  });
  it('uses the whole alphabet (not a constant or truncated source)', () => {
    const ids = cryptoIds();
    const chars = new Set<string>();
    for (let i = 0; i < 400; i++) for (const ch of ids.next('buy').slice(4)) chars.add(ch);
    expect(chars.size).toBeGreaterThan(28);
  });
  it('nonce is 32 lowercase hex chars (128 bits) and unique', () => {
    const ids = cryptoIds();
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i++) {
      const n = ids.nonce();
      expect(n).toMatch(/^[0-9a-f]{32}$/);
      seen.add(n);
    }
    expect(seen.size).toBe(2000);
  });
});

describe('seededIds', () => {
  it('is deterministic per seed and differs across seeds', () => {
    const a = seededIds('seed-1');
    const b = seededIds('seed-1');
    const c = seededIds('seed-2');
    const seqA = [a.next('ord'), a.next('unt'), a.nonce()];
    const seqB = [b.next('ord'), b.next('unt'), b.nonce()];
    expect(seqA).toEqual(seqB);
    expect(c.next('ord')).not.toBe(seqA[0]);
  });
  it('produces the same format as cryptoIds and is unique over 5k', () => {
    const ids = seededIds('x');
    const seen = new Set<string>();
    for (let i = 0; i < 5000; i++) {
      const id = ids.next('apr');
      expect(id).toMatch(/^apr_[0-9abcdefghjkmnpqrstvwxyz]{26}$/);
      seen.add(id);
    }
    expect(seen.size).toBe(5000);
    expect(ids.nonce()).toMatch(/^[0-9a-f]{32}$/);
  });
});
