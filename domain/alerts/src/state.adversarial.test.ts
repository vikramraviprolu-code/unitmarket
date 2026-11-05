// INT-AL AL.3: acknowledge, resolve with a reason code, reopen. Each is a journaled event with the operator.
// Domain rules only; the route checks (MFA, CSRF, bearer keys) are in apps/web/src/ops-alerts-state.adversarial.test.ts.
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { acknowledgeAlert, alertState, getAlert, reopenAlert, resolveAlert } from './index';
import { ctxOf, makeWorld } from './world';
import type { World } from './world';

let w: World;
let a: string;
beforeEach(async () => {
  w = await makeWorld('al-state');
  await w.order(1);
  a = await w.alert({ kind: 'payment_unresolved', order: 1, unit: 1, reason: 'r1' });
  w.as(ctxOf());
});
afterEach(async () => w.close());

describe('alert state (AL.3)', () => {
  it('starts open, then acknowledged, then resolved, then open again after a reopen', async () => {
    expect(await alertState(w.db, a)).toBe('open');
    expect((await acknowledgeAlert(w.deps, { alert_id: a })).ok).toBe(true);
    expect(await alertState(w.db, a)).toBe('acknowledged');
    expect((await resolveAlert(w.deps, { alert_id: a, reason_code: 'fixed_upstream' })).ok).toBe(
      true,
    );
    expect(await alertState(w.db, a)).toBe('resolved');
    expect((await reopenAlert(w.deps, { alert_id: a })).ok).toBe(true);
    expect(await alertState(w.db, a)).toBe('open');
    expect((await w.events(a)).map((e) => e.kind)).toEqual([
      'acknowledged',
      'resolved',
      'reopened',
    ]);
  });

  it('a second resolve is a no-op that answers the same', async () => {
    const first = await resolveAlert(w.deps, { alert_id: a, reason_code: 'false_positive' });
    const second = await resolveAlert(w.deps, { alert_id: a, reason_code: 'duplicate' });
    expect(first.ok && second.ok).toBe(true);
    expect(second).toEqual(first);
    const ev = await w.events(a);
    expect(ev).toHaveLength(1);
    expect(ev[0]?.reason_code).toBe('false_positive');
  });

  it('a second acknowledge is a no-op', async () => {
    await acknowledgeAlert(w.deps, { alert_id: a });
    await acknowledgeAlert(w.deps, { alert_id: a });
    expect(await w.events(a)).toHaveLength(1);
  });

  it('a reopen of an open alert is refused as wrong_state; an unknown id is not_found', async () => {
    const r = await reopenAlert(w.deps, { alert_id: a });
    expect(r).toEqual({ ok: false, error: { code: 'wrong_state' } });
    expect(await resolveAlert(w.deps, { alert_id: 'alr_nope', reason_code: 'other' })).toEqual({
      ok: false,
      error: { code: 'not_found' },
    });
    expect(await acknowledgeAlert(w.deps, { alert_id: 'alr_nope' })).toEqual({
      ok: false,
      error: { code: 'not_found' },
    });
  });

  it('the reason code comes from a closed list and the note has at most 200 characters', async () => {
    const bad = await resolveAlert(w.deps, { alert_id: a, reason_code: 'because' as never });
    expect(bad).toEqual({ ok: false, error: { code: 'bad_input' } });
    const long = await resolveAlert(w.deps, {
      alert_id: a,
      reason_code: 'other',
      note: 'x'.repeat(201),
    });
    expect(long).toEqual({ ok: false, error: { code: 'bad_input' } });
    expect(await w.events(a)).toHaveLength(0);
    for (const code of [
      'fixed_upstream',
      'false_positive',
      'duplicate',
      'accepted_risk',
      'other',
    ] as const) {
      const id = await w.alert({ kind: 'frozen_order', order: 1, unit: 1, reason: `rc_${code}` });
      expect((await resolveAlert(w.deps, { alert_id: id, reason_code: code })).ok).toBe(true);
    }
  });

  it('the journal shows the operator, the web channel and the reason code', async () => {
    await resolveAlert(w.deps, { alert_id: a, reason_code: 'accepted_risk' });
    const ev = (await w.events(a))[0]!;
    const rows = await w.trace('alert_events', ev.id);
    expect(rows).toEqual([{ actor_kind: 'operator', actor_id: 'opr_vikram', channel: 'web' }]);
    const body = await w.raw.query<{ body: unknown }>(
      "SELECT body FROM trace_events WHERE source_table = 'alert_events' AND source_id = $1",
      [ev.id],
    );
    expect(JSON.stringify(body.rows[0]!.body)).toContain('accepted_risk');
  });

  it('who and when come from the journal, joined on the alert_events row', async () => {
    await acknowledgeAlert(w.deps, { alert_id: a });
    const h = (await getAlert(w.db, a))!.history[0]!;
    expect(h.kind).toBe('acknowledged');
    expect(h.actor_kind).toBe('operator');
    expect(h.actor_id).toBe('opr_vikram');
    expect(h.channel).toBe('web');
  });

  it('the note is kept only as sha256: an email in it appears nowhere', async () => {
    const note = 'call jane.doe@example.com about it';
    await resolveAlert(w.deps, { alert_id: a, reason_code: 'other', note });
    const ev = (await w.events(a))[0]!;
    expect(ev.note_sha256).toBe(createHash('sha256').update(note).digest('hex'));
    const dump = JSON.stringify(
      (await w.raw.query('SELECT * FROM alert_events')).rows.concat(
        (await w.raw.query('SELECT * FROM trace_events')).rows,
        (await w.raw.query('SELECT * FROM audit_log')).rows,
      ),
    );
    expect(dump).not.toContain('jane.doe');
    expect(dump).not.toContain('example.com');
  });

  it('alert_events is append-only and cannot be truncated', async () => {
    await acknowledgeAlert(w.deps, { alert_id: a });
    await expect(w.raw.query("UPDATE alert_events SET kind = 'resolved'")).rejects.toThrow();
    await expect(w.raw.query('DELETE FROM alert_events')).rejects.toThrow();
    await expect(w.raw.query('TRUNCATE alert_events')).rejects.toThrow();
  });
});
