// CO-6: RFC 6238 over node:crypto. The vectors are the SHA1 rows of RFC 6238 appendix B (8 digits in
// the RFC, the last 6 here) and the HOTP rows of RFC 4226 appendix D.
import { describe, expect, it } from 'vitest';
import {
  OPERATOR_NAME,
  TOTP_ISSUER,
  base32Decode,
  base32Encode,
  isOperatorName,
  matchingSteps,
  otpauthUri,
  stepAt,
  totpCode,
} from './totp';
import { VIKRAM_B32, VIKRAM_KEY, oracleCode } from './totp-test-support';

const RFC_KEY = Buffer.from('12345678901234567890', 'ascii');

describe('RFC 6238 appendix B, SHA1, truncated to 6 digits', () => {
  const rows: Array<[number, string, string]> = [
    [59, '94287082', '287082'],
    [1111111109, '07081804', '081804'],
    [1111111111, '14050471', '050471'],
    [1234567890, '89005924', '005924'],
    [2000000000, '69279037', '279037'],
    [20000000000, '65353130', '353130'],
  ];
  it.each(rows)('T=%i (RFC %s) gives %s', (t, _rfc8, six) => {
    expect(totpCode(RFC_KEY, stepAt(t * 1000))).toBe(six);
  });
  it('the test oracle agrees with the same table', () => {
    for (const [t, , six] of rows) expect(oracleCode(RFC_KEY, stepAt(t * 1000))).toBe(six);
  });
  it('steps are 30 s long', () => {
    expect(stepAt(0)).toBe(0);
    expect(stepAt(29_999)).toBe(0);
    expect(stepAt(30_000)).toBe(1);
    expect(stepAt(59_000)).toBe(1);
  });
});

describe('RFC 4226 appendix D, counters 0 to 9', () => {
  const expected = [
    '755224',
    '287082',
    '359152',
    '969429',
    '338314',
    '254676',
    '287922',
    '162583',
    '399871',
    '520489',
  ];
  it('the step is the HOTP counter', () => {
    expect(expected.map((_, n) => totpCode(RFC_KEY, n))).toEqual(expected);
  });
});

describe('the acceptance window is the current step and one either side', () => {
  const t = 1111111109 * 1000; // step 37037036
  const now = stepAt(t);
  it.each([
    [-2, false],
    [-1, true],
    [0, true],
    [1, true],
    [2, false],
  ])('a code %i steps from now: accepted %s', (delta, accepted) => {
    const code = totpCode(RFC_KEY, now + delta);
    const hit = matchingSteps(RFC_KEY, code, t);
    expect(hit.includes(now + delta)).toBe(accepted);
    if (!accepted) expect(hit).toEqual([]);
  });
  it('the edges of a step: the first and last millisecond see the same window', () => {
    const start = now * 30_000;
    for (const ms of [start, start + 29_999]) {
      expect(matchingSteps(RFC_KEY, totpCode(RFC_KEY, now - 1), ms)).toEqual([now - 1]);
      expect(matchingSteps(RFC_KEY, totpCode(RFC_KEY, now + 1), ms)).toEqual([now + 1]);
      expect(matchingSteps(RFC_KEY, totpCode(RFC_KEY, now + 2), ms)).toEqual([]);
    }
  });
  it('at time zero there is no step before the first and nothing throws', () => {
    expect(matchingSteps(RFC_KEY, totpCode(RFC_KEY, 0), 0)).toEqual([0]);
    expect(matchingSteps(RFC_KEY, totpCode(RFC_KEY, 1), 0)).toEqual([1]);
  });
  it('a code made from another key is refused', () => {
    const other = Buffer.from('ABCDEFGHIJKLMNOPQRST', 'ascii');
    expect(matchingSteps(RFC_KEY, totpCode(other, now), t)).toEqual([]);
  });
});

describe('what counts as a code', () => {
  const t = 59_000;
  const good = '287082';
  it('six ASCII digits, spaces ignored', () => {
    expect(matchingSteps(RFC_KEY, good, t)).toEqual([1]);
    expect(matchingSteps(RFC_KEY, '287 082', t)).toEqual([1]);
    expect(matchingSteps(RFC_KEY, ' 287082 ', t)).toEqual([1]);
  });
  it.each([
    '',
    '28708',
    '2870822',
    '28708a',
    '287-082',
    '287\t082',
    '287082\n',
    '+28708',
    '0x2870',
    '２８７０８２', // full-width digits
    '٢٨٧٠٨٢', // Arabic-Indic digits
    '287082'.repeat(100),
  ])('%j is not a code, and nothing throws', (bad) => {
    expect(matchingSteps(RFC_KEY, bad, t)).toEqual([]);
  });
});

describe('base32 (RFC 4648)', () => {
  const vectors: Array<[string, string]> = [
    ['', ''],
    ['f', 'MY'],
    ['fo', 'MZXQ'],
    ['foo', 'MZXW6'],
    ['foob', 'MZXW6YQ'],
    ['fooba', 'MZXW6YTB'],
    ['foobar', 'MZXW6YTBOI'],
  ];
  it.each(vectors)('encodes %j as %s without padding', (plain, b32) => {
    expect(base32Encode(Buffer.from(plain, 'ascii'))).toBe(b32);
  });
  it('decodes unpadded, padded and lower case text', () => {
    expect(base32Decode('MZXW6YTBOI')?.toString('ascii')).toBe('foobar');
    expect(base32Decode('MZXW6YTBOI======')?.toString('ascii')).toBe('foobar');
    expect(base32Decode('mzxw6ytboi')?.toString('ascii')).toBe('foobar');
    expect(base32Decode('MZXW6===')?.toString('ascii')).toBe('foo');
  });
  it('the fixed test keys round trip', () => {
    expect(base32Encode(VIKRAM_KEY)).toBe(VIKRAM_B32);
    expect(base32Decode(VIKRAM_B32)?.equals(VIKRAM_KEY)).toBe(true);
  });
  it.each([
    '',
    'A', // 5 bits: not a whole byte
    'AAA', // 15 bits
    'AAAAAA', // 30 bits
    'MZXW6YT1', // 1 is not in the alphabet
    'MZXW6YT8',
    'MZXW6YT0',
    'MZXW 6YTB',
    'MZXW6YTB\n',
    'MZ=XW6YT',
    'MZXW6YTB=',
    'MZXQ==',
    'MZXW6YTBOI=====', // padding of the wrong length
    'MZXW6YTB-OI',
    'ÀBCDEFGH',
  ])('refuses %j', (bad) => {
    expect(base32Decode(bad)).toBeNull();
  });
});

describe('operator names', () => {
  it('lower case letters, digits and underscore, starting with a letter, 32 at most', () => {
    for (const ok of ['vikram', 'sakthi', 'a', 'a1', 'a_b', 'x'.repeat(32)])
      expect(isOperatorName(ok), ok).toBe(true);
    for (const bad of [
      '',
      'Vikram',
      '1a',
      '_a',
      'a-b',
      'a b',
      'a:b',
      'a,b',
      '../x',
      'x'.repeat(33),
      'demo',
    ])
      expect(isOperatorName(bad), bad).toBe(false);
    expect(OPERATOR_NAME.test('vikram')).toBe(true);
  });
});

describe('the authenticator URI', () => {
  it('names the issuer, once in the label and once as a parameter, URL encoded', () => {
    expect(TOTP_ISSUER).toBe('UnitMarket Sandbox');
    expect(otpauthUri('vikram', VIKRAM_B32)).toBe(
      `otpauth://totp/UnitMarket%20Sandbox:vikram?secret=${VIKRAM_B32}&issuer=UnitMarket%20Sandbox&algorithm=SHA1&digits=6&period=30`,
    );
  });
});
