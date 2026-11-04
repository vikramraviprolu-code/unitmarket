// API-B (G1): the mandate store on PGlite. Create, read, revoke; reserve, release, commit; and the
// mandate.exhausted event (E7), written once, in the same transaction as the commit that used the last room.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  checkBudget,
  commit,
  createMandate,
  getMandate,
  release,
  reserve,
  revokeMandate,
} from './index';
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

const create = async (
  over: Partial<typeof CAPS & { buyer_id: string; agent_key_id: string }> = {},
) => {
  const r = await createMandate(h.db, h.deps, {
    buyer_id: 'buy_A',
    agent_key_id: 'key_A1',
    ...CAPS,
    max_count: 3,
    ...over,
  });
  if (!r.ok) throw new Error(`create refused: ${r.error}`);
  return r.value;
};
const book = (mandate_id: string, amount_minor: number, over: Record<string, unknown> = {}) =>
  h.db.transaction((tx) =>
    reserve(tx, h.deps, {
      mandate_id,
      buyer_id: 'buy_A',
      agent_key_id: 'key_A1',
      amount_minor,
      currency: 'USD',
      ...over,
    }),
  );

describe('createMandate, getMandate, revokeMandate', () => {
  it('stores the caps and the expiry and starts with nothing spent', async () => {
    const m = await create({ max_total_minor: 500, max_per_purchase_minor: 100 });
    expect(m).toMatchObject({
      buyer_id: 'buy_A',
      agent_key_id: 'key_A1',
      currency: 'USD',
      max_total_minor: 500,
      max_count: 3,
      max_per_purchase_minor: 100,
      expires_at: '2026-12-04T10:00:00.000Z',
      revoked_at: null,
      spent_minor: 0,
      used_count: 0,
      remaining_total_minor: 500,
      remaining_count: 3,
    });
    expect(m.id).toMatch(/^man_/);
    expect(await getMandate(h.db, 'buy_A', m.id)).toEqual(m);
  });

  it('writes an audit row for the creation and for the revocation', async () => {
    const m = await create();
    await revokeMandate(h.db, h.deps, { buyer_id: 'buy_A', id: m.id });
    expect(h.audits.map((a) => a.action)).toEqual(['mandate.created', 'mandate.revoked']);
  });

  it('refuses a mandate without any cap, with a bad cap, or with an expiry that is not in the future', async () => {
    const base = { buyer_id: 'buy_A', agent_key_id: 'key_A1', ...CAPS };
    expect(await createMandate(h.db, h.deps, base)).toEqual({ ok: false, error: 'invalid_caps' });
    for (const bad of [0, -5, 1.5]) {
      expect(await createMandate(h.db, h.deps, { ...base, max_count: bad }), String(bad)).toEqual({
        ok: false,
        error: 'invalid_caps',
      });
    }
    expect(
      await createMandate(h.db, h.deps, {
        ...base,
        max_count: 1,
        expires_at: '2026-11-04T10:00:00.000Z',
      }),
    ).toEqual({ ok: false, error: 'invalid_expiry' });
    expect(
      await createMandate(h.db, h.deps, {
        ...base,
        max_count: 1,
        expires_at: '2027-12-04T10:00:00.000Z',
      }),
    ).toEqual({ ok: false, error: 'invalid_expiry' });
  });

  it('refuses a key that is not an agent key of this buyer, with one answer for all of them', async () => {
    const base = { ...CAPS, max_count: 1 };
    const other = await createMandate(h.db, h.deps, {
      ...base,
      buyer_id: 'buy_A',
      agent_key_id: 'key_B1',
    });
    const missing = await createMandate(h.db, h.deps, {
      ...base,
      buyer_id: 'buy_A',
      agent_key_id: 'key_nope',
    });
    expect(other).toEqual({ ok: false, error: 'unknown_agent_key' });
    expect(missing).toEqual(other);
  });

  it('allows one open mandate per agent key; a revoked or an expired one makes room', async () => {
    const first = await create();
    expect(
      await createMandate(h.db, h.deps, {
        buyer_id: 'buy_A',
        agent_key_id: 'key_A1',
        ...CAPS,
        max_count: 9,
      }),
    ).toEqual({ ok: false, error: 'mandate_active' });
    await create({ agent_key_id: 'key_A2' }); // another key of the same buyer is independent
    await revokeMandate(h.db, h.deps, { buyer_id: 'buy_A', id: first.id });
    const second = await create({ max_count: 9 });
    expect(second.id).not.toBe(first.id);
    h.clock.advance(31 * 86_400_000);
    const third = await create({ expires_at: '2027-01-04T10:00:00.000Z', max_count: 2 });
    expect(third.id).not.toBe(second.id);
  });

  it('reads only the buyer own mandate, and revoking twice keeps the first time', async () => {
    const m = await create();
    expect(await getMandate(h.db, 'buy_B', m.id)).toBeNull();
    expect(await revokeMandate(h.db, h.deps, { buyer_id: 'buy_B', id: m.id })).toEqual({
      ok: false,
      error: 'not_found',
    });
    const a = await revokeMandate(h.db, h.deps, { buyer_id: 'buy_A', id: m.id });
    h.clock.advance(60_000);
    const b = await revokeMandate(h.db, h.deps, { buyer_id: 'buy_A', id: m.id });
    expect(a.ok && b.ok && a.value.revoked_at).toBe('2026-11-04T10:00:00.000Z');
    expect(b.ok && b.value.revoked_at).toBe('2026-11-04T10:00:00.000Z');
    expect(h.audits.filter((x) => x.action === 'mandate.revoked')).toHaveLength(1);
  });
});

describe('reserve, release, commit', () => {
  it('reserve books the amount and one purchase at once', async () => {
    const m = await create({ max_total_minor: 500 });
    const r = await book(m.id, 120);
    expect(r.ok).toBe(true);
    expect((await getMandate(h.db, 'buy_A', m.id))!).toMatchObject({
      spent_minor: 120,
      used_count: 1,
      remaining_total_minor: 380,
      remaining_count: 2,
    });
    expect(
      await count(h.db, "SELECT count(*) AS c FROM mandate_reservations WHERE state = 'held'"),
    ).toBe(1);
  });

  it('refuses over the cap and leaves the totals as they were', async () => {
    const m = await create({ max_total_minor: 100, max_count: 5 });
    expect((await book(m.id, 60)).ok).toBe(true);
    expect(await book(m.id, 41)).toEqual({ ok: false, error: 'cap_exhausted' });
    expect((await getMandate(h.db, 'buy_A', m.id))!).toMatchObject({
      spent_minor: 60,
      used_count: 1,
    });
  });

  it('release gives the room back once; releasing again, or after commit, does nothing', async () => {
    const m = await create({ max_total_minor: 500 });
    const r = await book(m.id, 200);
    const id = r.ok ? r.value.reservation_id : '';
    expect(await h.db.transaction((tx) => release(tx, h.deps, id))).toBe(true);
    expect(await h.db.transaction((tx) => release(tx, h.deps, id))).toBe(false);
    expect((await getMandate(h.db, 'buy_A', m.id))!).toMatchObject({
      spent_minor: 0,
      used_count: 0,
    });
    const r2 = await book(m.id, 200);
    const id2 = r2.ok ? r2.value.reservation_id : '';
    expect(await h.db.transaction((tx) => commit(tx, h.deps, id2))).toBe(true);
    expect(await h.db.transaction((tx) => release(tx, h.deps, id2))).toBe(false);
    expect((await getMandate(h.db, 'buy_A', m.id))!).toMatchObject({
      spent_minor: 200,
      used_count: 1,
    });
  });

  it('commit keeps the spend and a second commit does nothing', async () => {
    const m = await create({ max_total_minor: 500 });
    const r = await book(m.id, 100);
    const id = r.ok ? r.value.reservation_id : '';
    expect(await h.db.transaction((tx) => commit(tx, h.deps, id))).toBe(true);
    expect(await h.db.transaction((tx) => commit(tx, h.deps, id))).toBe(false);
    expect((await getMandate(h.db, 'buy_A', m.id))!).toMatchObject({
      spent_minor: 100,
      used_count: 1,
    });
  });

  it('a released reservation can be booked again and a revoked or expired mandate takes none', async () => {
    const m = await create({ max_count: 1 });
    const r = await book(m.id, 10);
    expect(await book(m.id, 10)).toEqual({ ok: false, error: 'cap_exhausted' });
    await h.db.transaction((tx) => release(tx, h.deps, r.ok ? r.value.reservation_id : ''));
    expect((await book(m.id, 10)).ok).toBe(true);
    await revokeMandate(h.db, h.deps, { buyer_id: 'buy_A', id: m.id });
    expect(await book(m.id, 10)).toEqual({ ok: false, error: 'revoked' });
    const n = await create({ agent_key_id: 'key_A2' });
    h.clock.advance(31 * 86_400_000);
    expect(await book(n.id, 10, { agent_key_id: 'key_A2' })).toEqual({
      ok: false,
      error: 'expired',
    });
  });
});

describe('mandate.exhausted (E7)', () => {
  const events = async () =>
    (
      await h.db.query<{ type: string; payload: Record<string, unknown> }>(
        "SELECT type, payload FROM event_outbox WHERE type = 'mandate.exhausted' ORDER BY id",
      )
    ).rows;

  it('is written once, with reason count, by the commit that uses the last purchase', async () => {
    const m = await create({ max_count: 2, max_total_minor: 10_000 });
    const a = await book(m.id, 10);
    const b = await book(m.id, 10);
    await h.db.transaction((tx) => commit(tx, h.deps, a.ok ? a.value.reservation_id : ''));
    expect(await events()).toHaveLength(0);
    await h.db.transaction((tx) => commit(tx, h.deps, b.ok ? b.value.reservation_id : ''));
    const rows = await events();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload).toMatchObject({
      mandate_id: m.id,
      buyer_id: 'buy_A',
      agent_key_id: 'key_A1',
      reason: 'count',
    });
    // a repeated commit writes nothing more
    await h.db.transaction((tx) => commit(tx, h.deps, b.ok ? b.value.reservation_id : ''));
    expect(await events()).toHaveLength(1);
  });

  it('has reason money when the spend reaches the money cap first', async () => {
    const m = await create({ max_count: 10, max_total_minor: 100 });
    const a = await book(m.id, 100);
    await h.db.transaction((tx) => commit(tx, h.deps, a.ok ? a.value.reservation_id : ''));
    expect((await events())[0]!.payload).toMatchObject({ reason: 'money' });
  });

  it('is not written while a reservation is only held, nor when committed spend leaves room', async () => {
    const m = await create({ max_count: 2, max_total_minor: 100 });
    const a = await book(m.id, 100); // held: the cap is booked but not yet spent
    expect(await events()).toHaveLength(0);
    await h.db.transaction((tx) => release(tx, h.deps, a.ok ? a.value.reservation_id : ''));
    const b = await book(m.id, 30);
    await h.db.transaction((tx) => commit(tx, h.deps, b.ok ? b.value.reservation_id : ''));
    expect(await events()).toHaveLength(0);
  });

  it('commits and the event together: a rolled back transaction leaves neither', async () => {
    const m = await create({ max_count: 1 });
    const a = await book(m.id, 10);
    const id = a.ok ? a.value.reservation_id : '';
    await expect(
      h.db.transaction(async (tx) => {
        await commit(tx, h.deps, id);
        throw new Error('after commit, before the transaction ends');
      }),
    ).rejects.toThrow();
    expect(await events()).toHaveLength(0);
    expect(
      await count(h.db, "SELECT count(*) AS c FROM mandate_reservations WHERE state = 'held'"),
    ).toBe(1);
  });
});

describe('checkBudget (G9)', () => {
  it('says what is left and until when', async () => {
    const m = await create({ max_total_minor: 500, max_count: 4, max_per_purchase_minor: 200 });
    await book(m.id, 150);
    expect(await checkBudget(h.db, h.deps, { buyer_id: 'buy_A', agent_key_id: 'key_A1' })).toEqual({
      status: 'active',
      mandate_id: m.id,
      currency: 'USD',
      remaining_total_minor: 350,
      remaining_count: 3,
      max_per_purchase_minor: 200,
      expires_at: '2026-12-04T10:00:00.000Z',
    });
  });

  it('with no mandate, or a revoked or expired one, says mandate_required and asks the buyer', async () => {
    const none = await checkBudget(h.db, h.deps, { buyer_id: 'buy_A', agent_key_id: 'key_A1' });
    expect(none).toMatchObject({ status: 'mandate_required', reason: 'none' });
    if (none.status === 'mandate_required') {
      expect(none.ask_buyer).toMatch(/money/i);
      expect(none.ask_buyer).toMatch(/purchases/i);
      expect(none.ask_buyer).toMatch(/both/i);
    }
    const m = await create();
    await revokeMandate(h.db, h.deps, { buyer_id: 'buy_A', id: m.id });
    expect(
      await checkBudget(h.db, h.deps, { buyer_id: 'buy_A', agent_key_id: 'key_A1' }),
    ).toMatchObject({
      status: 'mandate_required',
      reason: 'revoked',
    });
    await create({ agent_key_id: 'key_A2' });
    h.clock.advance(31 * 86_400_000);
    expect(
      await checkBudget(h.db, h.deps, { buyer_id: 'buy_A', agent_key_id: 'key_A2' }),
    ).toMatchObject({
      status: 'mandate_required',
      reason: 'expired',
    });
  });

  it('never shows another buyer or another key a mandate that is not theirs', async () => {
    await create();
    expect(
      await checkBudget(h.db, h.deps, { buyer_id: 'buy_B', agent_key_id: 'key_A1' }),
    ).toMatchObject({
      status: 'mandate_required',
    });
    expect(
      await checkBudget(h.db, h.deps, { buyer_id: 'buy_A', agent_key_id: 'key_A2' }),
    ).toMatchObject({
      status: 'mandate_required',
    });
  });
});
