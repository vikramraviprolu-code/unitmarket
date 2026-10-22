import { describe, expect, it } from 'vitest';
import { makeLinkToken, readLinkToken } from './index';
import { sanitiseFilename } from './index';
import { secretOf } from './world';

const secret = secretOf('unit-test-secret-0123456789abcdef');
const NOW = new Date('2026-10-21T10:00:00.000Z');
const exp = Math.floor(NOW.getTime() / 1000) + 600;

describe('link token', () => {
  it('token round trip', () => {
    const t = makeLinkToken(secret, { link_id: 'lnk_ABC123', exp_unix: exp });
    expect(t).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(readLinkToken(secret, t, NOW)).toEqual({ ok: true, value: { link_id: 'lnk_ABC123' } });
  });

  it('changed byte is bad_token', () => {
    const t = makeLinkToken(secret, { link_id: 'lnk_ABC123', exp_unix: exp });
    for (const i of [0, Math.floor(t.length / 2), t.length - 1]) {
      const flipped = t.slice(0, i) + (t[i] === 'A' ? 'B' : 'A') + t.slice(i + 1);
      const r = readLinkToken(secret, flipped, NOW);
      expect(r).toEqual({ ok: false, error: 'bad_token' });
    }
    expect(readLinkToken(secret, '', NOW)).toEqual({ ok: false, error: 'bad_token' });
    expect(readLinkToken(secret, 'not a token!', NOW)).toEqual({ ok: false, error: 'bad_token' });
    const other = secretOf('another-secret-0123456789abcdef-x');
    expect(readLinkToken(other, t, NOW)).toEqual({ ok: false, error: 'bad_token' });
  });

  it('expired', () => {
    const t = makeLinkToken(secret, { link_id: 'lnk_ABC123', exp_unix: exp });
    expect(readLinkToken(secret, t, new Date(NOW.getTime() + 599_000))).toMatchObject({ ok: true });
    expect(readLinkToken(secret, t, new Date(NOW.getTime() + 600_000))).toEqual({
      ok: false,
      error: 'expired',
    });
  });

  it('refuses to sign with an empty secret', () => {
    expect(() => makeLinkToken(secretOf(''), { link_id: 'lnk_x', exp_unix: exp })).toThrow();
  });
});

describe('download filename', () => {
  it('filename sanitised against path and header injection', () => {
    const bad = [
      '../../etc/passwd',
      'a/b\\c',
      'x"; filename="evil.exe',
      'line1\r\nSet-Cookie: a=b',
      'été ünï',
      '..',
      '',
      '   ',
      'a'.repeat(500),
    ];
    for (const title of bad) {
      const f = sanitiseFilename(title, 'text/plain');
      expect(f).toMatch(/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,120}\.txt$/);
      expect(f).not.toMatch(/[\r\n";/\\]|\.\./);
    }
    expect(sanitiseFilename('Good Title', 'application/pdf')).toBe('Good Title.pdf');
    expect(sanitiseFilename('t', 'application/x-weird')).toBe('t.bin');
  });
});
