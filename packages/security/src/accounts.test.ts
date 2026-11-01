// ID-ACCOUNTS: the password policy, the username shape, the common list and the hash round trip. Pure:
// no database, no clock. NIST 800-63B: length rules, a block list, no composition rules, nothing trimmed.
import { describe, expect, it } from 'vitest';
import {
  ACCOUNT_DUMMY_HASH,
  COMMON_PASSWORDS,
  PASSWORD_MAX,
  PASSWORD_MIN,
  USERNAME_PATTERN,
  checkPasswordPolicy,
} from './accounts';
import { hashPasscode, verifyPasscode } from './passcode';

const ctx = { username: 'alice', display_name: 'Alice Example' };
const ok = (p: string, c = ctx) => checkPasswordPolicy(p, c);
const EMOJI = ['😀', '😃', '😄', '😁', '😆', '😅', '😂', '🙂', '🙃', '😉', '😊', '😇'];

describe('password policy: length', () => {
  it('names its bounds', () => {
    expect([PASSWORD_MIN, PASSWORD_MAX]).toEqual([12, 128]);
  });
  it('11 characters is too short, 12 is enough', () => {
    expect(ok('violet-lamp')).toEqual({ ok: false, reason: 'too_short' });
    expect(ok('violet-lamps')).toEqual({ ok: true });
  });
  it('128 characters is allowed, 129 is too long', () => {
    expect(ok('q7'.repeat(64))).toEqual({ ok: true });
    expect(ok('q7'.repeat(64) + 'x')).toEqual({ ok: false, reason: 'too_long' });
  });
  it('counts characters, not UTF-16 units: twelve emoji are twelve characters', () => {
    expect(ok(EMOJI.join(''))).toEqual({ ok: true });
    expect(ok(EMOJI.slice(0, 11).join(''))).toEqual({ ok: false, reason: 'too_short' });
    // 127 letters and one emoji is 128 characters, although it is 129 UTF-16 units
    expect(ok('xq'.repeat(63) + 'z' + '😀')).toEqual({ ok: true });
    expect(ok('xq'.repeat(63) + 'z' + '😀' + 'y')).toEqual({ ok: false, reason: 'too_long' });
  });
  it('counts after NFKC: a ligature is two letters', () => {
    // 'ﬁ' is one character before NFKC and 'fi' after it
    expect(ok('ﬁnd' + 'ﬁsh' + 'ﬁre' + 'ﬂy')).toEqual({ ok: true });
    expect(ok('ﬁ'.repeat(65))).toEqual({ ok: false, reason: 'too_long' });
    expect(ok('ﬁ'.repeat(64) + '')).toEqual({ ok: true });
  });
  it('never trims: spaces count and are kept', () => {
    expect(ok('           a')).toEqual({ ok: true });
    expect(ok(' violet-lamp ')).toEqual({ ok: true });
    expect(ok('violet-lamp ')).toEqual({ ok: true });
  });
  it('asks for no mix of letters, digits and symbols', () => {
    expect(ok('only lower case words here')).toEqual({ ok: true });
    expect(ok('ONLYUPPERCASEWORDS')).toEqual({ ok: true });
    expect(ok('72956183440917')).toEqual({ ok: true });
  });
});

describe('password policy: block list and context', () => {
  it('the common list holds 200 distinct lower case entries', () => {
    expect(COMMON_PASSWORDS).toHaveLength(200);
    expect(new Set(COMMON_PASSWORDS).size).toBe(200);
    for (const p of COMMON_PASSWORDS) expect(p, p).toBe(p.normalize('NFKC').toLowerCase());
  });
  it('refuses every common password long enough to reach the list, in any case', () => {
    const long = COMMON_PASSWORDS.filter((p) => Array.from(p).length >= PASSWORD_MIN);
    expect(long.length).toBeGreaterThan(40);
    for (const p of long) {
      expect(ok(p), p).toEqual({ ok: false, reason: 'common' });
      expect(ok(p.toUpperCase()), p).toEqual({ ok: false, reason: 'common' });
    }
  });
  it('the short ones are refused as too short, which is the same refusal for the person', () => {
    const short = COMMON_PASSWORDS.filter((p) => Array.from(p).length < PASSWORD_MIN);
    expect(short.length).toBeGreaterThan(100);
    for (const p of short) expect(ok(p).ok, p).toBe(false);
  });
  it('compares after NFKC: a full width copy of a common password is still common', () => {
    const p = COMMON_PASSWORDS.find(
      (x) => Array.from(x).length >= PASSWORD_MIN && /^[a-z0-9]+$/.test(x),
    )!;
    const wide = Array.from(p)
      .map((c) => String.fromCharCode(c.charCodeAt(0) + 0xfee0))
      .join('');
    expect(ok(wide)).toEqual({ ok: false, reason: 'common' });
  });
  it('refuses a password that contains the username, in any case', () => {
    expect(ok('my purple horse alice 99')).toEqual({ ok: false, reason: 'contains_username' });
    expect(ok('MY PURPLE HORSE ALICE 99')).toEqual({ ok: false, reason: 'contains_username' });
    expect(ok('my purple horse bob 99')).toEqual({ ok: true });
  });
  it('refuses a password equal to the display name, and not one that merely resembles it', () => {
    const c = { username: 'ax9', display_name: 'Correct Horse Battery' };
    expect(ok('correct horse battery', c)).toEqual({ ok: false, reason: 'same_as_name' });
    expect(ok('Correct Horse Battery', c)).toEqual({ ok: false, reason: 'same_as_name' });
    expect(ok('correct horse battery staple', c)).toEqual({ ok: true });
  });
  it('refuses one character repeated', () => {
    expect(ok('zzzzzzzzzzzz')).toEqual({ ok: false, reason: 'repetitive' });
    expect(ok('😀'.repeat(12))).toEqual({ ok: false, reason: 'repetitive' });
  });
  it('a lone surrogate is still counted and never throws', () => {
    expect(() => ok('\ud800'.repeat(12) + 'abc')).not.toThrow();
  });
});

describe('password policy: bytes', () => {
  // Hangul written as separate letters (three jamo per syllable, 9 bytes) is 128 characters after NFKC and
  // 1152 bytes raw. The check of a stored hash refuses more than 1024 bytes, so signup must refuse them too:
  // no password may pass signup and then fail every sign in.
  const jamo = (n: number): string =>
    Array.from(
      { length: n },
      (_, i) =>
        String.fromCodePoint(0x1100 + (i % 19)) +
        String.fromCodePoint(0x1161 + (i % 21)) +
        String.fromCodePoint(0x11a8 + (i % 27)),
    ).join('');
  it('refuses more than 1024 raw UTF-8 bytes, even when the NFKC length is within 128', () => {
    expect(jamo(128).normalize('NFKC')).toHaveLength(128);
    expect(Buffer.byteLength(jamo(128), 'utf8')).toBe(1152);
    expect(ok(jamo(128))).toEqual({ ok: false, reason: 'too_long' });
    expect(ok(jamo(114))).toEqual({ ok: false, reason: 'too_long' }); // 1026 bytes
  });
  it('allows exactly 1024 bytes and fewer', () => {
    expect(Buffer.byteLength(jamo(113), 'utf8')).toBe(1017);
    expect(ok(jamo(113))).toEqual({ ok: true });
    expect(ok('\u{1f600}'.repeat(2) + jamo(112) + 'ab')).toEqual({ ok: true }); // 1018 bytes
  });
  it('every password the policy allows can be verified (the stored hash check takes it)', async () => {
    const salt = '0123456789abcdef0123456789abcdef';
    const pw = jamo(113);
    expect(ok(pw)).toEqual({ ok: true });
    const h = await hashPasscode(pw, salt);
    expect(await verifyPasscode(h, pw)).toBe(true);
  });
});

describe('username shape', () => {
  it('accepts 3 to 30 of lower case letters, digits, dot, dash and underscore', () => {
    for (const u of ['abc', 'a.b-c_d', 'x'.repeat(30), '007', 'jo.smith']) {
      expect(USERNAME_PATTERN.test(u), u).toBe(true);
    }
  });
  it('refuses everything else', () => {
    for (const u of [
      'ab',
      'x'.repeat(31),
      'Alice',
      'a b c',
      'a@b.c',
      "o'neil",
      '<b>',
      'üser',
      'alice\n',
      '',
      'a/b',
      '1; DROP TABLE buyers',
    ]) {
      expect(USERNAME_PATTERN.test(u), JSON.stringify(u)).toBe(false);
    }
  });
});

describe('hashing', () => {
  const salt = '0123456789abcdef0123456789abcdef';
  it('round trips and refuses a wrong or empty attempt', async () => {
    const h = await hashPasscode('a long enough phrase', salt);
    expect(await verifyPasscode(h, 'a long enough phrase')).toBe(true);
    expect(await verifyPasscode(h, 'a long enough phrasf')).toBe(false);
    expect(await verifyPasscode(h, '')).toBe(false);
  });
  it('normalises with NFKC on both sides', async () => {
    const h = await hashPasscode('ﬁnd the ﬁsh now', salt);
    expect(await verifyPasscode(h, 'find the fish now')).toBe(true);
  });
  it('the dummy hash is well formed, costs a real verification and matches nothing', async () => {
    expect(ACCOUNT_DUMMY_HASH).toMatch(/^scrypt:16384:8:1:[0-9a-f]{32}:[0-9a-f]{64}$/);
    for (const attempt of ['', 'password', 'a long enough phrase', ACCOUNT_DUMMY_HASH]) {
      expect(await verifyPasscode(ACCOUNT_DUMMY_HASH, attempt)).toBe(false);
    }
  });
});
