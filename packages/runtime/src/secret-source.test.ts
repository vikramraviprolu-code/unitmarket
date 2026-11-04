// API-W0 (F3): the SecretSource port. The crypto source draws from node:crypto; the fixed source is the
// test double (never the seeded Rng).
import { describe, expect, it } from 'vitest';
import { cryptoSecretSource, fixedSecretSource } from './index';

describe('cryptoSecretSource', () => {
  it('returns the number of bytes asked for, and different bytes each call', () => {
    const s = cryptoSecretSource();
    const a = s.bytes(32);
    const b = s.bytes(32);
    expect(a).toBeInstanceOf(Uint8Array);
    expect(a.length).toBe(32);
    expect(b.length).toBe(32);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
    expect(s.bytes(7).length).toBe(7);
  });

  it('refuses a length that is not a whole number from 1 to 1024', () => {
    const s = cryptoSecretSource();
    for (const n of [0, -1, 1.5, Number.NaN, 1025]) expect(() => s.bytes(n), String(n)).toThrow();
  });
});

describe('fixedSecretSource', () => {
  it('is deterministic for a seed and differs between seeds', () => {
    const a = fixedSecretSource('seed-a');
    const a2 = fixedSecretSource('seed-a');
    const b = fixedSecretSource('seed-b');
    const one = Buffer.from(a.bytes(32)).toString('hex');
    expect(Buffer.from(a2.bytes(32)).toString('hex')).toBe(one);
    expect(Buffer.from(b.bytes(32)).toString('hex')).not.toBe(one);
  });

  it('gives a new value on each call, of the exact length asked for', () => {
    const s = fixedSecretSource('x');
    const first = Buffer.from(s.bytes(32));
    const second = Buffer.from(s.bytes(32));
    expect(first.length).toBe(32);
    expect(first.equals(second)).toBe(false);
    expect(s.bytes(5).length).toBe(5);
    expect(s.bytes(100).length).toBe(100);
  });

  it('refuses a bad length like the real source', () => {
    expect(() => fixedSecretSource('x').bytes(0)).toThrow();
  });
});
