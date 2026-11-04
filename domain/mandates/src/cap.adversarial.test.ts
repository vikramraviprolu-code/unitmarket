// API-B (G1, L item): attacks on the cap. Whatever the order or number of calls, the cap is never passed, by
// one minor unit or one purchase; a mandate belongs to one buyer and one agent key; expiry, revocation and
// currency hold. PGlite runs one query at a time, so the real race is proven on Postgres in
// tests/mvp-c-pg/mandates-race.integration.test.ts; this file proves the rules and that the database refuses
// an overspend even when the code is bypassed.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { commit, createMandate, getMandate, release, reserve, revokeMandate } from './index';
import { CAPS, count, makeHarness } from './test-fixtures';
import type { Harness } from './test-fixtures';

let h: Harness;
beforeEach(async () => {
  if (h) await h.db.close();
  h = await makeHarness();
});
afterAll(async () => {
  if (h) await h.db.close();
});

const open = async (caps: Partial<typeof CAPS>, key = 'key_A1', buyer = 'buy_A') => {
  const r = await createMandate(h.db, h.deps, {
    buyer_id: buyer,
    agent_key_id: key,
    ...CAPS,
    ...caps,
  });
  if (!r.ok) throw new Error(r.error);
  return r.value;
};
const take = (
  mandate_id: string,
  amount_minor: number,
  who: { buyer_id?: string; agent_key_id?: string; currency?: string } = {},
) =>
  h.db.transaction((tx) =>
    reserve(tx, h.deps, {
      mandate_id,
      buyer_id: who.buyer_id ?? 'buy_A',
      agent_key_id: who.agent_key_id ?? 'key_A1',
      amount_minor,
      currency: who.currency ?? 'USD',
    }),
  );

describe('20 concurrent purchases', () => {
  it('on a 5-purchase cap book exactly 5', async () => {
    const m = await open({ max_count: 5, max_total_minor: 1_000_000 });
    const all = await Promise.all(Array.from({ length: 20 }, () => take(m.id, 10)));
    expect(all.filter((r) => r.ok)).toHaveLength(5);
    expect(all.filter((r) => !r.ok).every((r) => !r.ok && r.error === 'cap_exhausted')).toBe(true);
    expect((await getMandate(h.db, 'buy_A', m.id))!).toMatchObject({
      used_count: 5,
      spent_minor: 50,
    });
  });

  it('of 30 minor units on a 100 money cap book exactly 3, and never pass the cap by one', async () => {
    const m = await open({ max_total_minor: 100 });
    const all = await Promise.all(Array.from({ length: 20 }, () => take(m.id, 30)));
    expect(all.filter((r) => r.ok)).toHaveLength(3);
    const after = (await getMandate(h.db, 'buy_A', m.id))!;
    expect(after.spent_minor).toBe(90);
    expect(after.spent_minor).toBeLessThanOrEqual(100);
    // the last 10 minor units can still be spent, 11 cannot
    expect((await take(m.id, 11)).ok).toBe(false);
    expect((await take(m.id, 10)).ok).toBe(true);
    expect((await take(m.id, 1)).ok).toBe(false);
  });

  it('a revoke in the middle stops every later purchase and the booked total stays within the cap', async () => {
    const m = await open({ max_count: 8 });
    const calls = Array.from({ length: 20 }, (_, i) =>
      i === 6 ? revokeMandate(h.db, h.deps, { buyer_id: 'buy_A', id: m.id }) : take(m.id, 5),
    );
    await Promise.all(calls);
    const frozen = (await getMandate(h.db, 'buy_A', m.id))!;
    expect(frozen.revoked_at).not.toBeNull();
    expect(frozen.used_count).toBeLessThanOrEqual(8);
    expect(await take(m.id, 5)).toEqual({ ok: false, error: 'revoked' });
    expect((await getMandate(h.db, 'buy_A', m.id))!.used_count).toBe(frozen.used_count);
  });
});

describe('the database refuses an overspend even if the code is bypassed', () => {
  it('a raw UPDATE past either cap, or a mandate without a cap, fails a CHECK', async () => {
    const m = await open({ max_count: 2, max_total_minor: 100 });
    await expect(
      h.db.query('UPDATE mandates SET spent_minor = 101 WHERE id = $1', [m.id]),
    ).rejects.toThrow();
    await expect(
      h.db.query('UPDATE mandates SET used_count = 3 WHERE id = $1', [m.id]),
    ).rejects.toThrow();
    await expect(
      h.db.query('UPDATE mandates SET max_total_minor = NULL, max_count = NULL WHERE id = $1', [
        m.id,
      ]),
    ).rejects.toThrow();
    expect((await getMandate(h.db, 'buy_A', m.id))!).toMatchObject({
      spent_minor: 0,
      used_count: 0,
    });
  });
});

describe('who may spend', () => {
  it('the agent of buyer A cannot use the mandate of buyer B', async () => {
    const mb = await open({ max_count: 5 }, 'key_B1', 'buy_B');
    expect(await take(mb.id, 10, { buyer_id: 'buy_A', agent_key_id: 'key_A1' })).toEqual({
      ok: false,
      error: 'mandate_not_found',
    });
    // not even with the right key id under the wrong buyer
    expect(await take(mb.id, 10, { buyer_id: 'buy_A', agent_key_id: 'key_B1' })).toEqual({
      ok: false,
      error: 'mandate_not_found',
    });
    expect((await getMandate(h.db, 'buy_B', mb.id))!.used_count).toBe(0);
  });

  it('a mandate bound to agent key A cannot be used by agent key B of the same buyer', async () => {
    const m = await open({ max_count: 5 }, 'key_A1');
    expect(await take(m.id, 10, { agent_key_id: 'key_A2' })).toEqual({
      ok: false,
      error: 'mandate_not_found',
    });
    expect((await take(m.id, 10)).ok).toBe(true);
  });

  it('an id that names no mandate gives the same answer as someone else mandate', async () => {
    expect(await take('man_doesnotexist', 10)).toEqual({ ok: false, error: 'mandate_not_found' });
  });
});

describe('time, currency and size', () => {
  it('an expired mandate is refused, exactly at the instant it ends', async () => {
    const m = await open({ max_count: 5, expires_at: '2026-11-04T10:00:30.000Z' });
    h.clock.advance(29_999);
    expect((await take(m.id, 1)).ok).toBe(true);
    h.clock.advance(1);
    expect(await take(m.id, 1)).toEqual({ ok: false, error: 'expired' });
  });

  it('a USD mandate is refused for a EUR or GBP amount and nothing is booked', async () => {
    const m = await open({ max_count: 5 });
    expect(await take(m.id, 10, { currency: 'EUR' })).toEqual({
      ok: false,
      error: 'currency_mismatch',
    });
    expect(await take(m.id, 10, { currency: 'GBP' })).toEqual({
      ok: false,
      error: 'currency_mismatch',
    });
    expect(await take(m.id, 10, { currency: 'usd' })).toEqual({
      ok: false,
      error: 'currency_mismatch',
    });
    expect((await getMandate(h.db, 'buy_A', m.id))!.used_count).toBe(0);
  });

  it('the per-purchase maximum applies to the whole amount', async () => {
    const m = await open({ max_total_minor: 10_000, max_per_purchase_minor: 250 });
    expect(await take(m.id, 251)).toEqual({ ok: false, error: 'over_per_purchase' });
    expect((await take(m.id, 250)).ok).toBe(true);
  });

  it('refuses amounts that are zero, negative, fractional or not numbers, and ones past the integer range', async () => {
    const m = await open({ max_total_minor: 1000 });
    for (const bad of [0, -1, 0.5, Number.NaN, 2 ** 31]) {
      expect(await take(m.id, bad), String(bad)).toMatchObject({ ok: false });
    }
    expect((await getMandate(h.db, 'buy_A', m.id))!).toMatchObject({
      spent_minor: 0,
      used_count: 0,
    });
  });
});

describe('release and commit cannot be turned into free money', () => {
  it('releasing twice gives the room back once; a stranger reservation id changes nothing', async () => {
    const m = await open({ max_count: 3 });
    const a = await take(m.id, 10);
    const b = await take(m.id, 10);
    const ida = a.ok ? a.value.reservation_id : '';
    expect(await h.db.transaction((tx) => release(tx, h.deps, ida))).toBe(true);
    expect(await h.db.transaction((tx) => release(tx, h.deps, ida))).toBe(false);
    expect(await h.db.transaction((tx) => release(tx, h.deps, 'rsv_unknown'))).toBe(false);
    expect(await h.db.transaction((tx) => commit(tx, h.deps, 'rsv_unknown'))).toBe(false);
    expect((await getMandate(h.db, 'buy_A', m.id))!).toMatchObject({
      used_count: 1,
      spent_minor: 10,
    });
    expect(b.ok).toBe(true);
  });

  it('spent_minor always equals the held plus committed reservations', async () => {
    const m = await open({ max_count: 50, max_total_minor: 100_000 });
    const made = await Promise.all(Array.from({ length: 12 }, (_, i) => take(m.id, 7 + i)));
    const ids = made.flatMap((r) => (r.ok ? [r.value.reservation_id] : []));
    for (const [i, id] of ids.entries()) {
      await h.db.transaction((tx) =>
        i % 3 === 0
          ? release(tx, h.deps, id)
          : i % 3 === 1
            ? commit(tx, h.deps, id)
            : Promise.resolve(true),
      );
    }
    const sum = await count(
      h.db,
      "SELECT coalesce(sum(amount_minor), 0) AS c FROM mandate_reservations WHERE mandate_id = $1 AND state IN ('held','committed')",
      [m.id],
    );
    const n = await count(
      h.db,
      "SELECT count(*) AS c FROM mandate_reservations WHERE mandate_id = $1 AND state IN ('held','committed')",
      [m.id],
    );
    expect((await getMandate(h.db, 'buy_A', m.id))!).toMatchObject({
      spent_minor: sum,
      used_count: n,
    });
  });
});
