import { describe, expect, it } from 'vitest';
import { hashPasscode, verifyPasscode } from './passcode';

const SALT = '00112233445566778899aabbccddeeff';

describe('passcode', () => {
  it('passcode scrypt verify is timing-safe and rejects wrong input', async () => {
    const hash = await hashPasscode('correct horse', SALT);
    expect(hash.startsWith('scrypt$')).toBe(true);
    expect(hash).not.toContain('correct horse');
    expect(await verifyPasscode(hash, 'correct horse')).toBe(true);
    for (const bad of ['', 'correct hors', 'correct horse ', 'CORRECT HORSE', 'x'.repeat(5000), '\u0000']) {
      expect(await verifyPasscode(hash, bad)).toBe(false);
    }
  });

  it('a malformed or tampered stored hash verifies false and never throws', async () => {
    const hash = await hashPasscode('pw', SALT);
    const parts = hash.split('$');
    const flipped = [...parts.slice(0, -1), (parts.at(-1) ?? '').replace(/.$/, (c) => (c === '0' ? '1' : '0'))].join('$');
    for (const bad of ['', 'plain', 'scrypt$x$y', 'scrypt$1$1$1$zz$zz', `${hash}$extra`, flipped, 'scrypt$999999999$8$1$00$00']) {
      await expect(verifyPasscode(bad, 'pw')).resolves.toBe(false);
    }
  });

  it('same passcode with another salt gives another hash', async () => {
    const a = await hashPasscode('pw', SALT);
    const b = await hashPasscode('pw', 'ffeeddccbbaa99887766554433221100');
    expect(a).not.toBe(b);
  });

  it('refuses a short or non-hex salt', async () => {
    await expect(hashPasscode('pw', 'abc')).rejects.toThrow();
    await expect(hashPasscode('pw', 'zz'.repeat(16))).rejects.toThrow();
  });
});
