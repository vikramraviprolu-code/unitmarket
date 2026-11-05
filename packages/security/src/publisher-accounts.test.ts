// POB-P1: the pure parts of the publisher account: the invite code shape, its hash, the claim form check and
// the exported lock helper. No database, no clock. The code is hashed exactly as the catalogue domain hashes
// it (same vector in publisher-invites.state.test.ts there), and the password rules are the buyer rules.
import { describe, expect, it } from 'vitest';
import {
  ACCOUNT_LOCK_BASE_MS,
  ACCOUNT_LOCK_CAP_MS,
  ACCOUNT_LOCK_THRESHOLD,
  lockFor,
} from './accounts';
import {
  INVITE_ALPHABET,
  PUBLISHER_CLAIM_RATE,
  checkClaim,
  hashInviteCode,
  normalizeInviteCode,
} from './publisher-accounts';

const PW = 'violet lamps hum softly';
const VECTOR = 'f798776cb4d1e5975b47ed94fcc91314bc8d5c6935ff56b33c03b08c52356818';

describe('the invite code', () => {
  it('uses the 32 symbol alphabet and folds case, spaces and hyphens before hashing', () => {
    expect(INVITE_ALPHABET).toBe('0123456789ABCDEFGHJKMNPQRSTVWXYZ');
    expect(normalizeInviteCode(' abcd-efgh jkmn ')).toBe('ABCDEFGHJKMN');
    expect(hashInviteCode('ABCDEFGHJKMN')).toBe(VECTOR);
    expect(hashInviteCode('abcd-efgh-jkmn')).toBe(VECTOR);
  });
});

describe('checkClaim', () => {
  const base = { code: 'ABCD-EFGH-JKMN', username: 'new.owner', password: PW };
  it('accepts a well formed claim and returns the folded code', () => {
    expect(checkClaim(base)).toEqual({ ok: true, code: 'ABCDEFGHJKMN' });
  });
  it('refuses a code of the wrong length or with a symbol outside the alphabet', () => {
    for (const code of [
      '',
      'ABC',
      'ABCDEFGHJKMNP',
      'ABCDEFGHIKMN',
      'ABCDEFGHJKMO',
      'ABCDEFGHJKM!',
      'ABCDEFGHJKMU',
    ])
      expect(checkClaim({ ...base, code }), code).toEqual({ ok: false, code: 'invalid_input' });
  });
  it('refuses a bad username with invalid_input', () => {
    for (const username of ['ab', 'UPPER', 'has space', 'x'.repeat(31), "o'brien", ''])
      expect(checkClaim({ ...base, username }), username).toEqual({
        ok: false,
        code: 'invalid_input',
      });
  });
  it('applies the buyer password policy, including the username check', () => {
    expect(checkClaim({ ...base, password: 'short' })).toEqual({
      ok: false,
      code: 'weak_password',
      reason: 'too_short',
    });
    expect(checkClaim({ ...base, password: 'password1234' })).toEqual({
      ok: false,
      code: 'weak_password',
      reason: 'common',
    });
    expect(checkClaim({ ...base, password: 'meet new.owner at nine' })).toEqual({
      ok: false,
      code: 'weak_password',
      reason: 'contains_username',
    });
    expect(checkClaim({ ...base, password: 'x'.repeat(12) })).toEqual({
      ok: false,
      code: 'weak_password',
      reason: 'repetitive',
    });
  });
});

describe('the claim limit and the lock helper', () => {
  it('limits claim tries to 10 per 15 minutes per address', () => {
    expect(PUBLISHER_CLAIM_RATE).toMatchObject({ per: 'ip', limit: 10, window_ms: 900_000 });
  });
  it('lockFor is exported and is the buyer lock: none below the threshold, 15 minutes, doubling, one hour cap', () => {
    expect(lockFor(ACCOUNT_LOCK_THRESHOLD - 1)).toBe(0);
    expect(lockFor(ACCOUNT_LOCK_THRESHOLD)).toBe(ACCOUNT_LOCK_BASE_MS);
    expect(lockFor(ACCOUNT_LOCK_THRESHOLD + 1)).toBe(2 * ACCOUNT_LOCK_BASE_MS);
    expect(lockFor(ACCOUNT_LOCK_THRESHOLD + 10)).toBe(ACCOUNT_LOCK_CAP_MS);
  });
});
