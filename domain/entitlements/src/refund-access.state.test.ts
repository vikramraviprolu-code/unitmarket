// CO-5 (ASM-59) state tests: partial and full refunds through applyMoneyEvent against a real
// (PGlite) database. Access follows money: a partial refund moves nothing, a full refund revokes.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { grantCredit, markAccessReady, recordDeliveryEvent } from '@umsbx/access-clock';
import { applyMoneyEvent } from './index';
import { FIVE_DAYS_MS, HASH, makeWorld, START } from './world';
import type { World } from './world';

const H = 3_600_000;
const D = 24 * H;
const T0 = Date.parse(START);
let w: World;
beforeAll(async () => {
  w = await makeWorld('rfe');
});
afterAll(async () => {
  await w.close();
});
beforeEach(async () => {
  await w.reset();
  w.clock.set(START);
});

const evidence = { capture_id: 'CAP1', content_sha256: HASH, link_probe: 'ok' as const };
const ready = (id: string) =>
  w.db.transaction((tx) => markAccessReady(tx, w.deps, { entitlement_id: id, evidence }));
const apply = (
  id: string,
  event:
    | 'capture_verified'
    | 'pending'
    | 'refund_verified'
    | 'reversal_verified'
    | 'partial_refund_verified',
) => w.db.transaction((tx) => applyMoneyEvent(tx, w.deps, { entitlement_id: id, event }));
const by = { kind: 'operator' as const, operator_id: 'opr_1', mfa: true };
const grant = (id: string, credit_ms: number) =>
  w.db.transaction((tx) =>
    grantCredit(tx, w.deps, { entitlement_id: id, credit_ms, case_id: 'cas_1', by }),
  );
const fail = (id: string, kind: 'delivery_failed' | 'delivery_restored') =>
  recordDeliveryEvent(w.deps, {
    entitlement_id: id,
    kind,
    link_id: null,
    source: 'system',
    evidence: {},
  });
const head = async (id: string) =>
  (
    await w.db.query<{
      money_state: string;
      access_state: string;
      licence_state: string | null;
      transition_log: unknown[];
      updated_at: Date;
    }>(
      'SELECT money_state, access_state, licence_state, transition_log, updated_at FROM entitlements WHERE id = $1',
      [id],
    )
  ).rows[0]!;
const win = async (id: string) =>
  (
    await w.db.query<{
      state: string;
      started_at: Date | null;
      base_ends_at: Date | null;
      ends_at: Date;
      paused_at: Date | null;
      credit_ms: number;
      updated_at: Date;
    }>(
      'SELECT state, started_at, base_ends_at, ends_at, paused_at, credit_ms, updated_at FROM access_windows WHERE entitlement_id = $1',
      [id],
    )
  ).rows[0]!;
const kinds = async (id: string) =>
  (
    await w.db.query<{ kind: string }>(
      'SELECT kind FROM access_events WHERE entitlement_id = $1 ORDER BY at, seq',
      [id],
    )
  ).rows.map((r) => r.kind);

describe('partial_refund_verified through applyMoneyEvent', () => {
  it('R1: a running window, its ends_at, the access state and the licence stay exactly as they were', async () => {
    const id = await w.rawEntitlement(1);
    await ready(id);
    w.clock.advance(D);
    await grant(id, 2 * H);
    w.clock.advance(D);
    const before = { head: await head(id), win: await win(id), kinds: await kinds(id) };
    w.clock.advance(H);
    const r = await apply(id, 'partial_refund_verified');
    expect(r).toEqual({
      ok: true,
      value: { changed: false, money: 'captured', access: 'available' },
    });
    expect(await head(id)).toEqual(before.head);
    expect(await win(id)).toEqual(before.win);
    expect(await kinds(id)).toEqual(before.kinds);
    expect((await win(id)).ends_at.getTime()).toBe(T0 + FIVE_DAYS_MS + 2 * H);
  });

  it('R1: a paused window stays paused with the same ends_at', async () => {
    const id = await w.rawEntitlement(1);
    await ready(id);
    w.clock.advance(D);
    await fail(id, 'delivery_failed');
    const before = await win(id);
    expect((await apply(id, 'partial_refund_verified')).ok).toBe(true);
    expect(await win(id)).toEqual(before);
    expect((await win(id)).state).toBe('paused');
    // The pause still earns its restoration credit after the partial refund.
    w.clock.advance(3 * H);
    expect(await fail(id, 'delivery_restored')).toMatchObject({
      state: 'running',
      credit_ms: 3 * H,
    });
  });

  it('R1: repeated partial refunds (several refunds, replays) change nothing', async () => {
    const id = await w.rawEntitlement(1);
    await ready(id);
    const before = { head: await head(id), win: await win(id), kinds: await kinds(id) };
    for (let n = 0; n < 5; n += 1) await apply(id, 'partial_refund_verified');
    expect({ head: await head(id), win: await win(id), kinds: await kinds(id) }).toEqual(before);
  });

  it('R5: a not-started window may start after a partial refund (money stays captured)', async () => {
    const id = await w.rawEntitlement(1);
    expect((await apply(id, 'partial_refund_verified')).ok).toBe(true);
    expect((await head(id)).money_state).toBe('captured');
    const started = await ready(id);
    expect(started).toMatchObject({ state: 'running', started_at: START });
    expect((await head(id)).access_state).toBe('available');
  });

  it('R2: a full refund after a partial refund revokes; a later partial refund changes nothing', async () => {
    const id = await w.rawEntitlement(1);
    await ready(id);
    await apply(id, 'partial_refund_verified');
    w.clock.advance(D);
    expect(await apply(id, 'refund_verified')).toEqual({
      ok: true,
      value: { changed: true, money: 'refunded', access: 'revoked' },
    });
    expect(await win(id)).toMatchObject({ state: 'revoked' });
    const after = { head: await head(id), win: await win(id), kinds: await kinds(id) };
    expect(await apply(id, 'partial_refund_verified')).toEqual({
      ok: true,
      value: { changed: false, money: 'refunded', access: 'revoked' },
    });
    expect({ head: await head(id), win: await win(id), kinds: await kinds(id) }).toEqual(after);
  });

  it('R2: a partial refund on pending money is an allowed no-op and unlocks nothing', async () => {
    const id = await w.rawEntitlement(1, { money_state: 'pending', licence_state: null });
    expect(await apply(id, 'partial_refund_verified')).toEqual({
      ok: true,
      value: { changed: false, money: 'pending', access: 'locked' },
    });
    expect((await head(id)).licence_state).toBeNull();
  });
});

describe('R2: a full refund or reversal revokes from any window state', () => {
  it.each(['refund_verified', 'reversal_verified'] as const)(
    '%s revokes not started, running, paused and ended windows',
    async (event) => {
      for (const stage of ['not_started', 'running', 'paused', 'ended'] as const) {
        await w.reset();
        w.clock.set(START);
        const id = await w.rawEntitlement(1);
        if (stage !== 'not_started') await ready(id);
        if (stage === 'paused') {
          w.clock.advance(D);
          await fail(id, 'delivery_failed');
        }
        if (stage === 'ended') w.clock.advance(FIVE_DAYS_MS + H);
        const r = await apply(id, event);
        expect(r.ok && r.value.access, stage).toBe('revoked');
        expect((await win(id)).state, stage).toBe('revoked');
        expect((await head(id)).licence_state, stage).toBe('terminated');
        expect(
          (await kinds(id)).filter((k) => k === 'revoked'),
          stage,
        ).toHaveLength(1);
      }
    },
  );

  it('R3 end to end: a credit after the full refund answers window_ended and writes nothing', async () => {
    const id = await w.rawEntitlement(1);
    await ready(id);
    await apply(id, 'refund_verified');
    const before = { win: await win(id), kinds: await kinds(id) };
    expect(await grant(id, H)).toEqual({ ok: false, error: { code: 'window_ended' } });
    expect({ win: await win(id), kinds: await kinds(id) }).toEqual(before);
  });

  it('R5: after a full refund markAccessReady refuses with money_not_captured', async () => {
    const id = await w.rawEntitlement(1);
    await apply(id, 'refund_verified');
    await expect(ready(id)).rejects.toThrow(/money_not_captured/);
    expect(await kinds(id)).toEqual(['revoked']);
    expect((await head(id)).access_state).toBe('revoked');
  });

  it('R6: a paused window that is fully refunded keeps its ends_at and earns no restoration credit', async () => {
    const id = await w.rawEntitlement(1);
    await ready(id);
    w.clock.advance(D);
    await fail(id, 'delivery_failed');
    w.clock.advance(D);
    await apply(id, 'refund_verified');
    w.clock.advance(D);
    await fail(id, 'delivery_restored');
    const row = await win(id);
    expect(row.state).toBe('revoked');
    expect(row.credit_ms).toBe(0);
    expect(row.ends_at.getTime()).toBe(T0 + FIVE_DAYS_MS);
  });
});

describe('R4: a pending refund changes nothing', () => {
  it('the money event "pending" on a captured entitlement is refused and writes nothing', async () => {
    const id = await w.rawEntitlement(1);
    await ready(id);
    w.clock.advance(D);
    const before = { head: await head(id), win: await win(id), kinds: await kinds(id) };
    expect(await apply(id, 'pending')).toEqual({
      ok: false,
      error: { code: 'forbidden_transition' },
    });
    expect({ head: await head(id), win: await win(id), kinds: await kinds(id) }).toEqual(before);
  });

  it('only refund_verified, reversal_verified revoke; every other event leaves a running window running', async () => {
    for (const event of ['capture_verified', 'pending', 'partial_refund_verified'] as const) {
      await w.reset();
      w.clock.set(START);
      const id = await w.rawEntitlement(1);
      await ready(id);
      await apply(id, event);
      expect((await win(id)).state, event).toBe('running');
      expect((await head(id)).access_state, event).toBe('available');
    }
  });
});
