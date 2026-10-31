// WEB-OPS-START (state): POST /api/ops/start through the real route wrapper and the real app.
// Time is frozen with a fake Date so the authenticator code and the approval row's dates are exact.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REF, SCOPE, NOW, bootStartRig } from './ops-start-support';
import type { StartRig } from './ops-start-support';

vi.mock('server-only', () => ({}));
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

let rig: StartRig | null = null;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(async () => {
  await rig?.app.close();
  rig = null;
  vi.useRealTimers();
});
const body = (o: Record<string, unknown> = {}) => ({
  reason: 'tester sitting',
  confirm_scope: SCOPE,
  ...o,
});
const errCode = async (r: Response): Promise<string> =>
  ((await r.clone().json()) as { error: { code: string } }).error.code;

describe('start is refused', () => {
  it('with no session (401), a buyer (403), a publisher (403): the switch stays off', async () => {
    rig = await bootStartRig();
    expect((await rig.startAs(null, body())).status).toBe(401);
    const { signIn } = await import('./support');
    const b = await signIn(rig.session.POST, 'buyer-a');
    const p = await signIn(rig.session.POST, 'publisher-harbour');
    expect((await rig.startAs(b, body())).status).toBe(403);
    expect((await rig.startAs(p, body())).status).toBe(403);
    expect(await rig.isOn()).toBe(false);
    expect(await rig.count('safety.resume')).toBe(0);
  });

  it('for an operator who signed in without the authenticator code: 403 mfa_required, plain words, nothing changes', async () => {
    rig = await bootStartRig();
    const res = await rig.startAs(await rig.plainOperator(), body());
    expect(res.status).toBe(403);
    expect(await errCode(res)).toBe('mfa_required');
    const text = JSON.stringify(await res.json());
    expect(text).not.toMatch(/stack|at \w+ \(|node_modules/);
    expect(await rig.isOn()).toBe(false);
    expect(await rig.count('safety.resume')).toBe(0);
  });

  it.each([
    ['no approval row', { approval: false as const }, 'no_active_approval'],
    [
      'an expired approval row',
      { approval: { valid_until: '2026-10-31T11:00:00Z' } },
      'no_active_approval',
    ],
    [
      'an approval row for another scope',
      { approval: { scope: 'mvp_c_refunds' } },
      'scope_mismatch',
    ],
  ])('with %s: 409 %s and a sentence, nothing changes', async (_n, o, code) => {
    rig = await bootStartRig(o);
    const res = await rig.startAs(await rig.mfaOperator(), body());
    expect(res.status).toBe(409);
    expect(await errCode(res)).toBe(code);
    const msg = ((await res.json()) as { error: { message: string } }).error.message;
    expect(msg.length).toBeGreaterThan(20);
    expect(msg).not.toMatch(/stack|Error:|undefined|\bat \w+ \(/);
    expect(await rig.isOn()).toBe(false);
    expect(await rig.count('safety.resume')).toBe(0);
    expect(rig.wire.calls).toHaveLength(0);
  });

  it('when the calls for the day are used up: 409 budget_used_up', async () => {
    rig = await bootStartRig({ approval: { max_calls: 4 } });
    await rig.spend(4);
    const res = await rig.startAs(await rig.mfaOperator(), body());
    expect(res.status).toBe(409);
    expect(await errCode(res)).toBe('budget_used_up');
    expect(await rig.isOn()).toBe(false);
  });

  it.each([['wrong'], [''], [SCOPE.toUpperCase()], ['mvp_b_pollin']])(
    'with the scope typed as %j: 409 scope_not_confirmed, nothing changes',
    async (typed) => {
      rig = await bootStartRig();
      const res = await rig.startAs(await rig.mfaOperator(), body({ confirm_scope: typed }));
      expect(res.status).toBe(409);
      expect(await errCode(res)).toBe('scope_not_confirmed');
      expect(await rig.isOn()).toBe(false);
      expect(await rig.count('safety.resume')).toBe(0);
    },
  );

  it.each([
    ['too short', 'ab'],
    ['blank', '   '],
    ['too long', 'x'.repeat(201)],
  ])('with a reason that is %s: 422, nothing changes', async (_n, reason) => {
    rig = await bootStartRig();
    const res = await rig.startAs(await rig.mfaOperator(), body({ reason }));
    expect(res.status).toBe(422);
    expect(await rig.isOn()).toBe(false);
    expect(await rig.count('safety.resume')).toBe(0);
  });

  it('when the database holds the switch off for another reason: 409 switch_locked, no audit row', async () => {
    rig = await bootStartRig();
    await rig.app.db.exec(`
      CREATE FUNCTION um_test_hold() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'held'; END $$ LANGUAGE plpgsql;
      CREATE TRIGGER um_test_hold BEFORE UPDATE ON safety_switches FOR EACH ROW EXECUTE FUNCTION um_test_hold();
    `);
    const res = await rig.startAs(await rig.mfaOperator(), body());
    expect(res.status).toBe(409);
    expect(await errCode(res)).toBe('switch_locked');
    expect(await rig.count('safety.resume')).toBe(0);
    expect(await rig.count('switch.paypal_outbound.on')).toBe(0);
  });

  it('when the switch is already on: 409 already_on and no second audit row', async () => {
    rig = await bootStartRig({ on: true });
    const res = await rig.startAs(await rig.mfaOperator(), body());
    expect(res.status).toBe(409);
    expect(await errCode(res)).toBe('already_on');
    expect(await rig.count('safety.resume')).toBe(0);
  });
});

describe('start succeeds', () => {
  it('with the code, a reason, an active row and the scope typed: switch on, one audit row, calls left unchanged', async () => {
    rig = await bootStartRig({ connect: false });
    await rig.spend(10);
    const who = { kind: 'operator' as const, operator_id: 'opr_vikram', mfa: true };
    const before = await rig.app.engine.opsSnapshot(who);
    expect(before?.kill_switch.outbound_on).toBe(false);
    expect(before?.kill_switch.budget?.remaining_today).toBe(110);
    const res = await rig.startAs(await rig.mfaOperator(), body({ reason: '  tester sitting  ' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      outbound_on: true,
      connect_flag: 'off',
      calls_left: 110,
      valid_until: '2026-11-03T12:00:00.000Z',
    });
    expect(await rig.isOn()).toBe(true);
    expect(await rig.count('safety.resume')).toBe(1);
    expect(await rig.count('gate.reserve')).toBe(10);
    const row = await rig.app.db.query<{
      actor_id: string;
      target: string;
      reason: string;
      detail: Record<string, unknown>;
    }>(`SELECT actor_id, target, reason, detail FROM audit_log WHERE action = 'safety.resume'`);
    expect(row.rows[0]).toMatchObject({
      actor_id: 'opr_vikram',
      target: REF,
      reason: 'tester sitting',
    });
    expect(row.rows[0]?.detail).toEqual({ approval_ref: REF, scope: SCOPE });
    // pressing Start never calls PayPal, whatever the flag says
    expect(rig.wire.calls).toHaveLength(0);
    const after = await rig.app.engine.opsSnapshot(who);
    expect(after?.kill_switch.outbound_on).toBe(true);
    expect(after?.kill_switch.budget?.remaining_today).toBe(110);
  });

  it('reports connect_flag on when the Cloud Run flag is on, and never sets it', async () => {
    rig = await bootStartRig({ connect: true });
    const res = await rig.startAs(await rig.mfaOperator(), body());
    expect(res.status).toBe(200);
    expect(((await res.json()) as { connect_flag: string }).connect_flag).toBe('on');
  });

  it('stop still turns the switch off after a start', async () => {
    rig = await bootStartRig();
    const op = await rig.mfaOperator();
    expect((await rig.startAs(op, body())).status).toBe(200);
    const { call } = await import('./support');
    const res = await call(rig.stop.POST, {
      url: '/api/ops/stop',
      method: 'POST',
      session: op,
      body: { reason: 'drill' },
    });
    expect(res.status).toBe(200);
    expect(await rig.isOn()).toBe(false);
  });
});
