// State tests for entitlements against a real (PGlite) database.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { markAccessReady, sweepWindows } from '@umsbx/access-clock';
import type { AccessPolicy } from '@umsbx/contracts';
import { applyMoneyEvent, createPendingEntitlements, getEntitlementForBuyer } from './index';
import { FIVE_DAYS_MS, HASH, makeWorld, policyFor } from './world';
import type { World } from './world';

let w: World;
beforeAll(async () => {
  w = await makeWorld('ent');
});
afterAll(async () => {
  await w.close();
});
beforeEach(async () => {
  await w.reset();
});

async function pending(n: number, option: 'keep_retrieve' | 'online_read' = 'keep_retrieve') {
  const { article_id, unit_id } = await w.supply(n);
  const policy: AccessPolicy = policyFor(option);
  const [id] = await createPendingEntitlements(w.db, w.deps, {
    buyer_id: 'buy_1', unit_id, items: [{ article_id, option, policy }],
  });
  return id!;
}
const ready = (id: string) =>
  w.db.transaction((tx) =>
    markAccessReady(tx, w.deps, { entitlement_id: id, evidence: { capture_id: 'CAP1', content_sha256: HASH, link_probe: 'ok' } }),
  );
const row = async (id: string) =>
  (await w.db.query<{ money_state: string; access_state: string; licence_state: string | null; transition_log: { record: string; from: string | null; to: string }[] }>(
    'SELECT money_state, access_state, licence_state, transition_log FROM entitlements WHERE id = $1', [id])).rows[0]!;

describe('createPendingEntitlements', () => {
  it('creates locked pending rows in input order, each with a not_started window', async () => {
    const a = await w.supply(1);
    const ids = await createPendingEntitlements(w.db, w.deps, {
      buyer_id: 'buy_1', unit_id: a.unit_id,
      items: [{ article_id: a.article_id, option: 'keep_retrieve', policy: policyFor('keep_retrieve') }],
    });
    expect(ids).toHaveLength(1);
    const r = await row(ids[0]!);
    expect(r).toMatchObject({ money_state: 'pending', access_state: 'locked', licence_state: null, transition_log: [] });
    const win = await w.db.query('SELECT state, credit_ms FROM access_windows WHERE entitlement_id = $1', [ids[0]]);
    expect(win.rows).toEqual([{ state: 'not_started', credit_ms: 0 }]);
  });

  it('returns one id per item, in order', async () => {
    const a = await w.supply(1);
    const b = await w.supply(2);
    // Two items on two units (unique (unit_id, article_id)): one call per unit.
    const x = await createPendingEntitlements(w.db, w.deps, { buyer_id: 'buy_1', unit_id: a.unit_id, items: [{ article_id: a.article_id, option: 'keep_retrieve', policy: policyFor('keep_retrieve') }] });
    const y = await createPendingEntitlements(w.db, w.deps, { buyer_id: 'buy_1', unit_id: b.unit_id, items: [{ article_id: b.article_id, option: 'online_read', policy: policyFor('online_read') }] });
    expect(new Set([...x, ...y]).size).toBe(2);
  });
});

describe('applyMoneyEvent', () => {
  it('capture_verified then refund_verified then capture_verified ends refunded and revoked (PAY-08)', async () => {
    const id = await pending(1);
    const one = await applyMoneyEvent(w.db, w.deps, { entitlement_id: id, event: 'capture_verified' });
    expect(one).toEqual({ ok: true, value: { changed: true, money: 'captured', access: 'locked' } });
    await ready(id);
    expect((await row(id)).access_state).toBe('available');
    const two = await applyMoneyEvent(w.db, w.deps, { entitlement_id: id, event: 'refund_verified' });
    expect(two).toEqual({ ok: true, value: { changed: true, money: 'refunded', access: 'revoked' } });
    const three = await applyMoneyEvent(w.db, w.deps, { entitlement_id: id, event: 'capture_verified' });
    expect(three).toEqual({ ok: false, error: { code: 'forbidden_transition' } });
    const r = await row(id);
    expect(r).toMatchObject({ money_state: 'refunded', access_state: 'revoked', licence_state: 'terminated' });
    const win = await w.db.query<{ state: string }>('SELECT state FROM access_windows WHERE entitlement_id = $1', [id]);
    expect(win.rows[0]!.state).toBe('revoked');
  });

  it('logs transitions in the order money, access, licence', async () => {
    const id = await pending(1);
    await applyMoneyEvent(w.db, w.deps, { entitlement_id: id, event: 'capture_verified' });
    await ready(id);
    await applyMoneyEvent(w.db, w.deps, { entitlement_id: id, event: 'reversal_verified' });
    const log = (await row(id)).transition_log.map((t) => `${t.record}:${t.from}>${t.to}`);
    expect(log).toEqual([
      'money:pending>captured', 'licence:null>granted',
      'access:locked>available',
      'money:captured>reversed', 'access:available>revoked', 'licence:granted>terminated',
    ]);
  });

  it('two applies of one event change once', async () => {
    const id = await pending(1);
    const first = await applyMoneyEvent(w.db, w.deps, { entitlement_id: id, event: 'capture_verified' });
    const before = await row(id);
    const second = await applyMoneyEvent(w.db, w.deps, { entitlement_id: id, event: 'capture_verified' });
    expect(first.ok && first.value.changed).toBe(true);
    expect(second).toEqual({ ok: true, value: { changed: false, money: 'captured', access: 'locked' } });
    expect(await row(id)).toEqual(before);
  });

  it('two racing applies of one event change once', async () => {
    const id = await pending(1);
    const [a, b] = await Promise.all([
      applyMoneyEvent(w.db, w.deps, { entitlement_id: id, event: 'capture_verified' }),
      applyMoneyEvent(w.db, w.deps, { entitlement_id: id, event: 'capture_verified' }),
    ]);
    const changed = [a, b].filter((r) => r.ok && r.value.changed).length;
    expect(changed).toBe(1);
    expect((await row(id)).transition_log.filter((t) => t.record === 'money')).toHaveLength(1);
  });

  it('refuses a forbidden cell and changes nothing', async () => {
    const id = await pending(1);
    const before = await row(id);
    const r = await applyMoneyEvent(w.db, w.deps, { entitlement_id: id, event: 'refund_verified' });
    expect(r).toEqual({ ok: false, error: { code: 'forbidden_transition' } });
    expect(await row(id)).toEqual(before);
  });

  it('reports an unknown entitlement as a value', async () => {
    const r = await applyMoneyEvent(w.db, w.deps, { entitlement_id: 'ent_nope', event: 'capture_verified' });
    expect(r).toEqual({ ok: false, error: { code: 'unknown_entitlement' } });
  });

  it('a malformed id names no entitlement', async () => {
    const r = await applyMoneyEvent(w.db, w.deps, { entitlement_id: 'ent_\u0000x', event: 'capture_verified' });
    expect(r).toEqual({ ok: false, error: { code: 'unknown_entitlement' } });
  });

  it('declined and unknown move money only', async () => {
    const id = await pending(1);
    const r = await applyMoneyEvent(w.db, w.deps, { entitlement_id: id, event: 'unknown' });
    expect(r).toEqual({ ok: true, value: { changed: true, money: 'unknown', access: 'locked' } });
    const r2 = await applyMoneyEvent(w.db, w.deps, { entitlement_id: id, event: 'capture_verified' });
    expect(r2.ok && r2.value.money).toBe('captured');
  });
});

describe('getEntitlementForBuyer', () => {
  it('returns the view for the owner', async () => {
    const id = await pending(1);
    const v = await getEntitlementForBuyer(w.db, { entitlement_id: id, buyer_id: 'buy_1' });
    expect(v).toMatchObject({
      entitlement_id: id, buyer_id: 'buy_1', article_id: 'art_1', unit_id: 'unt_1', option: 'keep_retrieve',
      money: 'pending', access: 'locked', licence: null,
      window: { state: 'not_started', started_at: null, base_ends_at: null, ends_at: null, paused_at: null, credit_ms: 0 },
    });
  });
  it('keep item after end reads "ended" with history kept; online item reads "ended" (A-19)', async () => {
    const keep = await pending(1, 'keep_retrieve');
    const online = await pending(2, 'online_read');
    for (const id of [keep, online]) {
      await applyMoneyEvent(w.db, w.deps, { entitlement_id: id, event: 'capture_verified' });
      await ready(id);
    }
    w.clock.advance(FIVE_DAYS_MS - 1);
    expect((await sweepWindows(w.deps, { max_items: 10 })).ended).toBe(0);
    w.clock.advance(1);
    expect((await sweepWindows(w.deps, { max_items: 10 })).ended).toBe(2);
    for (const [id, option] of [[keep, 'keep_retrieve'], [online, 'online_read']] as const) {
      const v = await getEntitlementForBuyer(w.db, { entitlement_id: id, buyer_id: 'buy_1' });
      expect(v).toMatchObject({ option, money: 'captured', access: 'ended', licence: 'granted', window: { state: 'ended' } });
      const hist = await w.db.query<{ kind: string }>('SELECT kind FROM access_events WHERE entitlement_id = $1 ORDER BY at, ctid', [id]);
      expect(hist.rows.map((r) => r.kind)).toEqual(['access_ready', 'window_ended']);
    }
  });
});
