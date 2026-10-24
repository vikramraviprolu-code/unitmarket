import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { hashPasscode, verifyPasscode } from './passcode';

const SALT = '00112233445566778899aabbccddeeff';

describe('passcode', () => {
  it('passcode scrypt verify is timing-safe and rejects wrong input', async () => {
    const hash = await hashPasscode('correct horse', SALT);
    expect(hash.startsWith('scrypt:')).toBe(true);
    expect(hash).not.toContain('correct horse');
    expect(await verifyPasscode(hash, 'correct horse')).toBe(true);
    for (const bad of [
      '',
      'correct hors',
      'correct horse ',
      'CORRECT HORSE',
      'x'.repeat(5000),
      '\u0000',
    ]) {
      expect(await verifyPasscode(hash, bad)).toBe(false);
    }
  });

  it('a malformed or tampered stored hash verifies false and never throws', async () => {
    const hash = await hashPasscode('pw', SALT);
    const parts = hash.split(':');
    const flipped = [
      ...parts.slice(0, -1),
      (parts.at(-1) ?? '').replace(/.$/, (c) => (c === '0' ? '1' : '0')),
    ].join(':');
    for (const bad of [
      '',
      'plain',
      'scrypt:x:y',
      'scrypt:1:1:1:zz:zz',
      `${hash}:extra`,
      flipped,
      'scrypt:999999999:8:1:00:00',
    ]) {
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

  // BU-6c: dotenv-expand reads `$16384` as a variable, so the stored form has no `$`.
  describe('env-safe stored form (BU-6c)', () => {
    const toOld = (h: string): string => h.replaceAll(':', '$');

    it('the new hash has no dollar sign and the exact shape', async () => {
      const hash = await hashPasscode('correct horse', SALT);
      expect(hash).not.toContain('$');
      expect(hash).toMatch(/^scrypt:16384:8:1:[0-9a-f]{32}:[0-9a-f]{64}$/);
      expect(hash.split(':')[4]).toBe(SALT);
    });

    it('accepts the new form and the old dollar form, and nothing else for the wrong passcode', async () => {
      const hash = await hashPasscode('correct horse', SALT);
      const old = toOld(hash);
      expect(old.startsWith('scrypt$16384$8$1$')).toBe(true);
      for (const form of [hash, old]) {
        expect(await verifyPasscode(form, 'correct horse')).toBe(true);
        expect(await verifyPasscode(form, 'correct hors')).toBe(false);
        expect(await verifyPasscode(form, '')).toBe(false);
        expect(await verifyPasscode(form, 'x'.repeat(5000))).toBe(false);
      }
    });

    it('a stored old-form hash made before the change still verifies (fixed vector)', async () => {
      // scrypt of "correct horse" with SALT, N=16384 r=8 p=1, written in the old form.
      const fresh = await hashPasscode('correct horse', SALT);
      const key = fresh.split(':')[5] as string;
      const stored = `scrypt$16384$8$1$${SALT}$${key}`;
      expect(await verifyPasscode(stored, 'correct horse')).toBe(true);
    });

    it('rejects tampered or malformed values in both forms and never throws', async () => {
      const hash = await hashPasscode('pw', SALT);
      const [, n, r, p, salt, key] = hash.split(':') as [
        string,
        string,
        string,
        string,
        string,
        string,
      ];
      const flipKey = key.replace(/.$/, (c) => (c === '0' ? '1' : '0'));
      const bads = [
        `scrypt:${n}:${r}:${p}:${salt}:${flipKey}`,
        `scrypt:${n}:${r}:${p}:${salt}`,
        `scrypt:${n}:${r}:${p}:${salt}:${key}:extra`,
        `scrypt:0:${r}:${p}:${salt}:${key}`,
        `scrypt:${n}:0:${p}:${salt}:${key}`,
        `scrypt:${n}:${r}:0:${salt}:${key}`,
        `scrypt:${(1 << 17) * 2}:${r}:${p}:${salt}:${key}`,
        `scrypt:16383:${r}:${p}:${salt}:${key}`,
        `scrypt:${n}:17:${p}:${salt}:${key}`,
        `scrypt:${n}:${r}:5:${salt}:${key}`,
        `scrypt:${n}:${r}:${p}:zz:${key}`,
        `scrypt:${n}:${r}:${p}:${salt}:${key.slice(2)}`,
        `scrypt:${n}:${r}:${p}:${salt.toUpperCase()}:${key}`,
        `scrypt:${n}:${r}:${p}:${salt}:${key.toUpperCase()}`,
        `scrypt:${n}:${r}:${p}:${salt.slice(1)}:${key}`,
        `scrypt:+${n}:${r}:${p}:${salt}:${key}`,
        `scrypt:${n}.0:${r}:${p}:${salt}:${key}`,
        `scrypt: ${n}:${r}:${p}:${salt}:${key}`,
        `Scrypt:${n}:${r}:${p}:${salt}:${key}`,
        `argon2:${n}:${r}:${p}:${salt}:${key}`,
        `scrypt:${n}:${'9'.repeat(400)}:${p}:${salt}:${key}`,
        `scrypt:${'9'.repeat(400)}:${r}:${p}:${salt}:${key}`,
        `scrypt:${n}:${r}:${'9'.repeat(400)}:${salt}:${key}`,
        `scrypt:0${n}:${r}:${p}:${salt}:${key}`,
        // the shape dotenv-expand leaves behind
        'scrypt6384',
        'scrypt',
        ':::::',
        '$$$$$$',
      ];
      for (const bad of bads) {
        await expect(verifyPasscode(bad, 'pw')).resolves.toBe(false);
        await expect(verifyPasscode(toOld(bad), 'pw')).resolves.toBe(false);
      }
      // mixed separators are neither form
      const mixed = `scrypt$${n}:${r}$${p}:${salt}$${key}`;
      await expect(verifyPasscode(mixed, 'pw')).resolves.toBe(false);
      await expect(verifyPasscode(`scrypt:${n}$${r}:${p}:${salt}:${key}`, 'pw')).resolves.toBe(
        false,
      );
      // sanity: the untampered values verify in both forms
      expect(await verifyPasscode(hash, 'pw')).toBe(true);
      expect(await verifyPasscode(toOld(hash), 'pw')).toBe(true);
    });

    it('keeps the timing-safe compare', () => {
      const src = readFileSync(new URL('./passcode.ts', import.meta.url), 'utf8');
      expect(src).toContain('timingSafeEqual');
    });
  });
});
