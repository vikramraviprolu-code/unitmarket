// INT-AL AL.5: two new signals, `mandate_near_cap` and `webhook_failing`. Each raises once per entity and again
// on recurrence; finished entities (revoked, exhausted, expired, disabled) raise nothing and never flap (R2-1).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HOUR, ctxOf, jobCtx, makeWorld } from './world';
import type { World } from './world';
import { alertState, autoResolve, raiseSignals, resolveAlert, sweepAlerts } from './index';

let w: World;
beforeEach(async () => {
  w = await makeWorld('al-sig');
});
afterEach(async () => w.close());

const signals = async (): Promise<{ raised: number; reopened: number }> => {
  w.as(jobCtx());
  return raiseSignals(w.deps);
};
const alertsOf = async (kind: string): Promise<{ id: string; reason: string; order_id: string | null }[]> =>
  (
    await w.raw.query<{ id: string; reason: string; order_id: string | null }>(
      "SELECT id, detail ->> 'reason' AS reason, order_id FROM alerts WHERE kind = $1 ORDER BY created_at, id",
      [kind],
    )
  ).rows;

describe('mandate_near_cap (AL.5)', () => {
  it('two mandates at 90 percent raise two alerts, with no order on either', async () => {
    await w.mandate({ id: 'man_1', max_total: 1000, spent: 900 });
    await w.mandate({ id: 'man_2', max_total: 500, spent: 450 });
    await w.mandate({ id: 'man_3', max_total: 1000, spent: 899 });
    expect(await signals()).toEqual({ raised: 2, reopened: 0 });
    const rows = await alertsOf('mandate_near_cap');
    expect(rows.map((r) => r.reason)).toEqual(['cap90_man_1', 'cap90_man_2']);
    expect(rows.every((r) => r.order_id === null)).toBe(true);
  });

  it('caps of 3 and 10 purchases fire at 3 and 9', async () => {
    await w.mandate({ id: 'man_a', max_total: null, max_count: 3, used: 2 });
    await w.mandate({ id: 'man_b', max_total: null, max_count: 10, used: 8 });
    expect((await signals()).raised).toBe(0);
    await w.raw.query("UPDATE mandates SET used_count = 3 WHERE id = 'man_a'");
    await w.raw.query("UPDATE mandates SET used_count = 9 WHERE id = 'man_b'");
    expect((await signals()).raised).toBe(2);
    expect((await alertsOf('mandate_near_cap')).map((r) => r.reason).sort()).toEqual(['cap90_man_a', 'cap90_man_b']);
  });

  it('a second pass raises nothing new', async () => {
    await w.mandate({ id: 'man_1', max_total: 1000, spent: 950 });
    await signals();
    expect(await signals()).toEqual({ raised: 0, reopened: 0 });
    expect(await w.count('alerts')).toBe(1);
  });

  it('a resolved alert is reopened by system when the mandate changes again, not before', async () => {
    await w.mandate({ id: 'man_1', max_total: 1000, spent: 920 });
    await signals();
    const [a] = await alertsOf('mandate_near_cap');
    w.clock.advance(HOUR);
    w.as(ctxOf());
    await resolveAlert(w.deps, { alert_id: a!.id, reason_code: 'accepted_risk' });
    w.clock.advance(HOUR);
    expect((await signals()).reopened).toBe(0); // nothing changed since the resolve
    expect(await alertState(w.db, a!.id)).toBe('resolved');
    w.clock.advance(HOUR);
    await w.raw.query("UPDATE mandates SET spent_minor = 960, updated_at = $1 WHERE id = 'man_1'", [
      w.clock.now().toISOString(),
    ]);
    expect(await signals()).toEqual({ raised: 0, reopened: 1 });
    expect(await alertState(w.db, a!.id)).toBe('open');
    expect(await w.count('alerts')).toBe(1);
    const ev = (await w.events(a!.id)).at(-1)!;
    expect(ev.kind).toBe('reopened');
    expect(await w.trace('alert_events', ev.id)).toEqual([{ actor_kind: 'system', actor_id: null, channel: 'job' }]);
  });

  it.each([
    ['revoked', { revoked: true }],
    ['exhausted', { exhausted: true }],
    ['expired', { expires_at: '2026-11-05T09:00:00.000Z' }],
  ])('two passes over a %s mandate write no new event', async (_n, over) => {
    await w.mandate({ id: 'man_1', max_total: 1000, spent: 980, ...over });
    w.as(jobCtx());
    for (let i = 0; i < 2; i++) await sweepAlerts(w.deps);
    expect(await w.count('alerts')).toBe(0);
    expect(await w.count('alert_events')).toBe(0);
  });
});

describe('webhook_failing (AL.5)', () => {
  it('three failed deliveries raise once; a fourth in the same run raises nothing', async () => {
    await w.subscription({ id: 'wsb_1' });
    await w.delivery({ id: 'wdl_1', sub: 'wsb_1', status: 'failed', n: 1 });
    await w.delivery({ id: 'wdl_2', sub: 'wsb_1', status: 'dead', n: 2 });
    expect((await signals()).raised).toBe(0); // two are not enough
    await w.delivery({ id: 'wdl_3', sub: 'wsb_1', status: 'failed', n: 3 });
    expect((await signals()).raised).toBe(1);
    await w.delivery({ id: 'wdl_4', sub: 'wsb_1', status: 'failed', n: 4 });
    expect((await signals()).raised).toBe(0);
    expect((await alertsOf('webhook_failing')).map((r) => r.reason)).toEqual(['webhook_failing_wsb_1_wdl_1']);
  });

  it('a recovery and then three new failures raise a new alert', async () => {
    await w.subscription({ id: 'wsb_1' });
    for (const [i, s] of ['failed', 'failed', 'failed'].entries()) {
      await w.delivery({ id: `wdl_${i + 1}`, sub: 'wsb_1', status: s, n: i + 1 });
    }
    await signals();
    await w.delivery({ id: 'wdl_4', sub: 'wsb_1', status: 'delivered', n: 4 });
    for (const [i, s] of ['failed', 'dead', 'failed'].entries()) {
      await w.delivery({ id: `wdl_${i + 5}`, sub: 'wsb_1', status: s, n: i + 5 });
    }
    expect((await signals()).raised).toBe(1);
    expect((await alertsOf('webhook_failing')).map((r) => r.reason)).toEqual([
      'webhook_failing_wsb_1_wdl_1',
      'webhook_failing_wsb_1_wdl_5',
    ]);
  });

  it('a disabled subscription raises nothing and two passes write no new event', async () => {
    await w.subscription({ id: 'wsb_1', disabled: true });
    for (let i = 1; i <= 3; i++) await w.delivery({ id: `wdl_${i}`, sub: 'wsb_1', status: 'failed', n: i });
    w.as(jobCtx());
    for (let i = 0; i < 2; i++) await sweepAlerts(w.deps);
    expect(await w.count('alerts')).toBe(0);
    expect(await w.count('alert_events')).toBe(0);
  });

  it('delivery recovery resolves the alert in the same job step, once', async () => {
    await w.subscription({ id: 'wsb_1' });
    for (let i = 1; i <= 3; i++) await w.delivery({ id: `wdl_${i}`, sub: 'wsb_1', status: 'failed', n: i });
    w.as(jobCtx());
    await sweepAlerts(w.deps);
    await w.delivery({ id: 'wdl_4', sub: 'wsb_1', status: 'delivered', n: 4 });
    await sweepAlerts(w.deps);
    await sweepAlerts(w.deps);
    const [a] = await alertsOf('webhook_failing');
    expect((await w.events(a!.id)).map((e) => e.kind)).toEqual(['auto_resolved']);
    expect((await autoResolve(w.deps)).resolved).toBe(0);
  });
});
