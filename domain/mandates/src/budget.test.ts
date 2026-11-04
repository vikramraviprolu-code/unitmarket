// API-B (G1, G9): the pure budget rules. A mandate caps spending by money, by number of purchases, or both,
// has an optional per-purchase maximum, one currency and an expiry. No database here.
import { describe, expect, it } from 'vitest';
import { ASK_BUYER_TEXT, evaluate, remainingOf } from './budget';
import type { MandateRow } from './budget';

const NOW = new Date('2026-11-04T10:00:00.000Z');
const row = (over: Partial<MandateRow> = {}): MandateRow => ({
  id: 'man_1',
  buyer_id: 'buy_A',
  agent_key_id: 'key_A1',
  currency: 'USD',
  max_total_minor: null,
  max_count: null,
  max_per_purchase_minor: null,
  expires_at: '2026-11-05T10:00:00.000Z',
  revoked_at: null,
  spent_minor: 0,
  used_count: 0,
  ...over,
});
const want = (amount_minor: number, currency = 'USD') => ({ amount_minor, currency });

describe('caps by money only', () => {
  const m = row({ max_total_minor: 500 });
  it('allows a purchase up to the cap, to the minor unit', () => {
    expect(evaluate(row({ ...m, spent_minor: 400 }), want(100), NOW)).toEqual({ ok: true });
  });
  it('refuses one minor unit past the cap', () => {
    expect(evaluate(row({ ...m, spent_minor: 400 }), want(101), NOW)).toEqual({
      ok: false,
      reason: 'cap_exhausted',
    });
  });
  it('has no count limit', () => {
    expect(evaluate(row({ ...m, used_count: 10_000 }), want(1), NOW)).toEqual({ ok: true });
  });
});

describe('caps by count only', () => {
  const m = row({ max_count: 3 });
  it('allows the last permitted purchase and refuses the next', () => {
    expect(evaluate(row({ ...m, used_count: 2 }), want(999_999), NOW)).toEqual({ ok: true });
    expect(evaluate(row({ ...m, used_count: 3 }), want(1), NOW)).toEqual({
      ok: false,
      reason: 'cap_exhausted',
    });
  });
});

describe('caps by money and count', () => {
  const m = row({ max_total_minor: 1000, max_count: 2 });
  it('either cap alone stops the purchase', () => {
    expect(evaluate(row({ ...m, spent_minor: 990 }), want(20), NOW).ok).toBe(false);
    expect(evaluate(row({ ...m, used_count: 2 }), want(1), NOW).ok).toBe(false);
    expect(evaluate(row({ ...m, spent_minor: 500, used_count: 1 }), want(500), NOW).ok).toBe(true);
  });
});

describe('per-purchase maximum', () => {
  const m = row({ max_total_minor: 10_000, max_per_purchase_minor: 300 });
  it('applies to the whole amount of one purchase', () => {
    expect(evaluate(m, want(300), NOW)).toEqual({ ok: true });
    expect(evaluate(m, want(301), NOW)).toEqual({ ok: false, reason: 'over_per_purchase' });
  });
});

describe('expiry, revocation and currency', () => {
  it('refuses at the expiry instant and after, allows one millisecond before', () => {
    const m = row({ max_count: 5, expires_at: '2026-11-04T10:00:00.000Z' });
    expect(evaluate(m, want(1), NOW)).toEqual({ ok: false, reason: 'expired' });
    expect(evaluate(m, want(1), new Date(NOW.getTime() - 1))).toEqual({ ok: true });
    expect(evaluate(m, want(1), new Date(NOW.getTime() + 1))).toEqual({
      ok: false,
      reason: 'expired',
    });
  });
  it('refuses a revoked mandate, whatever room is left', () => {
    const m = row({ max_count: 5, revoked_at: '2026-11-04T09:00:00.000Z' });
    expect(evaluate(m, want(1), NOW)).toEqual({ ok: false, reason: 'revoked' });
  });
  it('refuses another currency and never converts', () => {
    const m = row({ max_total_minor: 1_000_000 });
    expect(evaluate(m, want(1, 'EUR'), NOW)).toEqual({ ok: false, reason: 'currency_mismatch' });
    expect(evaluate(m, want(1, 'GBP'), NOW)).toEqual({ ok: false, reason: 'currency_mismatch' });
  });
  it('checks revoked before expired before currency before per-purchase before the caps', () => {
    const all = row({
      max_total_minor: 1,
      max_per_purchase_minor: 1,
      revoked_at: '2026-11-04T09:00:00.000Z',
      expires_at: '2026-11-04T08:00:00.000Z',
    });
    expect(evaluate(all, want(50, 'EUR'), NOW)).toEqual({ ok: false, reason: 'revoked' });
    expect(evaluate({ ...all, revoked_at: null }, want(50, 'EUR'), NOW)).toEqual({
      ok: false,
      reason: 'expired',
    });
    const live = { ...all, revoked_at: null, expires_at: '2026-11-05T10:00:00.000Z' };
    expect(evaluate(live, want(50, 'EUR'), NOW)).toEqual({
      ok: false,
      reason: 'currency_mismatch',
    });
    expect(evaluate(live, want(50), NOW)).toEqual({ ok: false, reason: 'over_per_purchase' });
    expect(evaluate({ ...live, max_per_purchase_minor: null }, want(50), NOW)).toEqual({
      ok: false,
      reason: 'cap_exhausted',
    });
  });
  it('refuses an amount that is not a positive whole number of minor units', () => {
    const m = row({ max_total_minor: 100 });
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(evaluate(m, want(bad), NOW), String(bad)).toEqual({
        ok: false,
        reason: 'invalid_amount',
      });
    }
  });
});

describe('what is left', () => {
  it('reports remaining money and purchases, and null for a cap that is not set', () => {
    expect(remainingOf(row({ max_total_minor: 500, spent_minor: 120 }))).toEqual({
      remaining_total_minor: 380,
      remaining_count: null,
    });
    expect(remainingOf(row({ max_count: 4, used_count: 1 }))).toEqual({
      remaining_total_minor: null,
      remaining_count: 3,
    });
    expect(
      remainingOf(row({ max_total_minor: 100, max_count: 2, spent_minor: 100, used_count: 2 })),
    ).toEqual({
      remaining_total_minor: 0,
      remaining_count: 0,
    });
  });
});

describe('the words an agent is told when it has no cap', () => {
  it('names a money limit, a number of purchases (or both) and an expiry', () => {
    expect(ASK_BUYER_TEXT).toMatch(/money/i);
    expect(ASK_BUYER_TEXT).toMatch(/number of purchases|purchases/i);
    expect(ASK_BUYER_TEXT).toMatch(/both/i);
    expect(ASK_BUYER_TEXT).toMatch(/expir/i);
    expect(ASK_BUYER_TEXT).toMatch(/ask/i);
  });
});
