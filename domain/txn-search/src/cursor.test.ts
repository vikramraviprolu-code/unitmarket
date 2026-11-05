// INT-SR0 (SR0.1): the keyset cursor. It carries the sort, the sort value, the unit id and an opaque hash the
// caller fills in. It never carries a buyer, a seller or any other scope value. A malformed or tampered cursor,
// one from another sort and one with a different hash each throw 400 bad_cursor; none falls back to page 1.
import { describe, expect, it } from 'vitest';
import { TxnSearchError, decodeCursor, encodeCursor } from './cursor';

const NEWEST = {
  s: 'newest',
  k: '2026-11-05T12:00:00.123456Z',
  id: 'unt_1',
  h: 'hash-1',
} as const;

const json = (token: string): Record<string, unknown> =>
  JSON.parse(Buffer.from(token, 'base64url').toString('utf8')) as Record<string, unknown>;
const tokenOf = (o: unknown): string =>
  Buffer.from(JSON.stringify(o), 'utf8').toString('base64url');

function refused(fn: () => unknown): TxnSearchError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(TxnSearchError);
    return e as TxnSearchError;
  }
  throw new Error('expected bad_cursor, got a result');
}

describe('cursor round trip (SR0.1)', () => {
  it('newest: a timestamp sort value', () => {
    const token = encodeCursor(NEWEST);
    expect(decodeCursor(token, { sort: 'newest', h: 'hash-1' })).toEqual({ v: 't1', ...NEWEST });
  });
  it('amount: a number sort value', () => {
    const c = { s: 'amount', k: 1200, id: 'unt_2', h: 'hash-1' } as const;
    expect(decodeCursor(encodeCursor(c), { sort: 'amount', h: 'hash-1' })).toEqual({
      v: 't1',
      ...c,
    });
  });
  it('status: a number (the group rank) sort value', () => {
    const c = { s: 'status', k: 3, id: 'unt_3', h: 'hash-1' } as const;
    expect(decodeCursor(encodeCursor(c), { sort: 'status', h: 'hash-1' })).toEqual({
      v: 't1',
      ...c,
    });
  });
  it('is base64url text with only v, s, k, id and h inside', () => {
    const token = encodeCursor(NEWEST);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Object.keys(json(token)).sort()).toEqual(['h', 'id', 'k', 's', 'v']);
    expect(json(token)['v']).toBe('t1');
  });
  it('never carries a scope value, even if the caller tries to pass one', () => {
    const sneaky = {
      ...NEWEST,
      buyer_id: 'buy_1',
      publisher_id: 'pub_1',
    } as unknown as typeof NEWEST;
    const token = encodeCursor(sneaky);
    expect(Object.keys(json(token)).sort()).toEqual(['h', 'id', 'k', 's', 'v']);
    expect(Buffer.from(token, 'base64url').toString('utf8')).not.toMatch(/buy_1|pub_1/);
  });
});

describe('cursor refusals (SR0.1): each one is 400 bad_cursor', () => {
  const good = encodeCursor(NEWEST);
  const expectBad = (token: string, over: Partial<{ sort: string; h: string }> = {}) => {
    const e = refused(() => decodeCursor(token, { sort: 'newest', h: 'hash-1', ...over }));
    expect(e.code).toBe('bad_cursor');
    expect(e.status).toBe(400);
  };

  it('text that is not base64url', () => expectBad('not a cursor!'));
  it('base64url that is not JSON', () => expectBad(Buffer.from('hello').toString('base64url')));
  it('JSON that is not an object', () => expectBad(tokenOf([1, 2, 3])));
  it('an empty string', () => expectBad(''));
  it('a very long string', () => expectBad('A'.repeat(5000)));
  it('a missing field', () => expectBad(tokenOf({ v: 't1', s: 'newest', k: 'x', id: 'unt_1' })));
  it('an extra field (a scope value added by a client)', () =>
    expectBad(tokenOf({ ...json(good), buyer_id: 'buy_other' })));
  it('another version tag', () => expectBad(tokenOf({ ...json(good), v: 't2' })));
  it('a tampered body (bytes changed)', () => {
    const i = Math.floor(good.length / 2);
    expectBad(good.slice(0, i) + (good[i] === 'A' ? 'B' : 'A') + good.slice(i + 1));
  });
  it('a sort value of the wrong type for the sort', () =>
    expectBad(tokenOf({ ...json(good), s: 'amount', k: 'not-a-number' }), { sort: 'amount' }));
  it('a cursor made for another sort', () => expectBad(good, { sort: 'amount' }));
  it('a hash that differs from the current query hash', () => expectBad(good, { h: 'hash-2' }));
  it('an unknown sort name', () => expectBad(tokenOf({ ...json(good), s: 'oldest' })));
  it('a unit id that is not a plain id', () =>
    expectBad(tokenOf({ ...json(good), id: 'unt_1 \u0000' })));
});
