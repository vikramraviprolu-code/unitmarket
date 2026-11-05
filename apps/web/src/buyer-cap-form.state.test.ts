// INT-BUY / BUY.1: the New cap form turns text into a request body. Pure, so every edge is pinned exactly: money text,
// count text, the day, the order of the problems, and the Idempotency-Key that makes one body replay and another not.
import { describe, expect, it } from 'vitest';
import { CAP_PROBLEMS, capRequest, idemFor, moneyToMinor } from './lib/buyer-agents-view';
import { keysModel } from './lib/buyer-keys-view';

const base = {
  agent_key_id: 'key_f1',
  currency: 'USD',
  money_text: '5.00',
  count_text: '10',
  until_day: '2026-11-30',
};
const NOW = new Date('2026-11-05T12:00:00.000Z');

describe('moneyToMinor', () => {
  it('reads whole and fractional money', () => {
    expect(moneyToMinor('5', 'USD')).toBe(500);
    expect(moneyToMinor('5.5', 'USD')).toBe(550);
    expect(moneyToMinor('5.00', 'USD')).toBe(500);
    expect(moneyToMinor(' 0.01 ', 'USD')).toBe(1);
    expect(moneyToMinor('9999999.99', 'USD')).toBe(999999999);
  });
  it('refuses text that is not money, zero, too many decimals and too large', () => {
    for (const t of ['', 'five', '5.005', '0', '0.00', '-1', '5,00', '1e3', '12345678', '.5', '5.'])
      expect(moneyToMinor(t, 'USD'), t).toBeNull();
    expect(moneyToMinor('9999999.99', 'USD')).not.toBeNull();
  });
  it('a currency with no minor digits takes whole numbers only', () => {
    expect(moneyToMinor('500', 'JPY')).toBe(500);
    expect(moneyToMinor('5.5', 'JPY')).toBeNull();
  });
  it('stays under the 32 bit limit', () => {
    expect(moneyToMinor('9999999', 'JPY')).toBe(9999999);
    expect(moneyToMinor('21474836.47', 'USD')).toBeNull();
  });
});

describe('capRequest', () => {
  it('builds the body with both caps, the end of the day in UTC and the consent flag', () => {
    expect(capRequest(base)).toEqual({
      ok: true,
      body: {
        agent_key_id: 'key_f1',
        currency: 'USD',
        max_total_minor: 500,
        max_count: 10,
        expires_at: '2026-11-30T23:59:59.000Z',
        terms_accepted: true,
      },
    });
  });
  it('money only has no max_count, and count only has no max_total_minor', () => {
    const m = capRequest({ ...base, count_text: '' });
    expect(m.ok && 'max_count' in m.body).toBe(false);
    expect(m.ok && m.body.max_total_minor).toBe(500);
    const c = capRequest({ ...base, money_text: '  ' });
    expect(c.ok && 'max_total_minor' in c.body).toBe(false);
    expect(c.ok && c.body.max_count).toBe(10);
  });
  it('says which part is wrong, in a fixed order: key, nothing set, money, count, day', () => {
    expect(capRequest({ ...base, agent_key_id: '' })).toEqual({
      ok: false,
      problem: CAP_PROBLEMS.noKey,
    });
    expect(capRequest({ ...base, money_text: '', count_text: ' ' })).toEqual({
      ok: false,
      problem: CAP_PROBLEMS.nothingSet,
    });
    expect(capRequest({ ...base, money_text: 'five' })).toEqual({
      ok: false,
      problem: CAP_PROBLEMS.badMoney,
    });
    expect(capRequest({ ...base, count_text: 'ten' })).toEqual({
      ok: false,
      problem: CAP_PROBLEMS.badCount,
    });
    expect(capRequest({ ...base, until_day: '' })).toEqual({
      ok: false,
      problem: CAP_PROBLEMS.noDate,
    });
    expect(capRequest({ ...base, until_day: '30/11/2026' })).toEqual({
      ok: false,
      problem: CAP_PROBLEMS.noDate,
    });
    expect(capRequest({ ...base, money_text: 'x', count_text: 'y', until_day: '' })).toEqual({
      ok: false,
      problem: CAP_PROBLEMS.badMoney,
    });
  });
  it('a count must be a whole number from 1 to 2147483647', () => {
    for (const t of ['0', '-1', '1.5', '1e2', '2147483648', '1234567890', '00000000000'])
      expect(capRequest({ ...base, count_text: t }), t).toEqual({
        ok: false,
        problem: CAP_PROBLEMS.badCount,
      });
    const one = capRequest({ ...base, count_text: '1' });
    expect(one.ok && one.body.max_count).toBe(1);
    const top = capRequest({ ...base, count_text: '999999999' });
    expect(top.ok && top.body.max_count).toBe(999999999);
  });
  it('a day with trailing text is refused', () => {
    expect(capRequest({ ...base, until_day: '2026-11-30x' }).ok).toBe(false);
    expect(capRequest({ ...base, until_day: 'x2026-11-30' }).ok).toBe(false);
  });
});

describe('idemFor', () => {
  it('is stable for one body, differs for another body and for another nonce', () => {
    const a = idemFor('nonce1', { a: 1 });
    expect(idemFor('nonce1', { a: 1 })).toBe(a);
    expect(idemFor('nonce1', { a: 2 })).not.toBe(a);
    expect(idemFor('nonce2', { a: 1 })).not.toBe(a);
  });
  it('has the nonce, a dash and eight hex digits, and fits in 128 characters', () => {
    expect(idemFor('n', {})).toMatch(/^n-[0-9a-f]{8}$/);
    expect(idemFor('x'.repeat(300), { a: 1 })).toHaveLength(128);
  });
  it('is a fixed value for a fixed body (FNV 1a)', () => {
    expect(idemFor('n', 'a')).toBe('n-61a1cfea');
  });
});

describe('keysModel dates', () => {
  it('shows the day a key was made and last used', () => {
    const m = keysModel(
      [
        {
          id: 'key_d1',
          key_kind: 'api_client',
          owner_kind: 'buyer',
          scopes: ['catalogue:read'],
          created_at: '2026-11-03T08:00:00.000Z',
          revoked_at: null,
          last_used_at: '2026-11-04T09:30:00.000Z',
        },
      ],
      NOW,
    );
    expect(m.rows[0]).toMatchObject({
      kind_word: 'API client key',
      scopes_text: 'Can read the catalogue.',
      created_text: 'Made 2026-11-03',
      last_used_text: 'Last used 2026-11-04',
    });
  });
});
