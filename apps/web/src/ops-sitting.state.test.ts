// OPS-SW (D-120, state): POST /api/ops/sitting through the real route wrapper and the real app. An operator
// signed in with the authenticator code opens a PayPal sandbox sitting (the approval row the owner used to
// insert at a terminal), then Start turns PayPal on under it. Nothing reaches a network: the wire is a
// counting fake and no PayPal call is made here.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REF, SCOPE, NOW, bootStartRig } from './ops-start-support';
import type { StartRig } from './ops-start-support';
import { call } from './support';
import type { Session } from './support';

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

const sitting = async (
  s: Session | null,
  body: unknown = { reason: 'demo sitting' },
  csrf = true,
) => {
  const route = await import('./app/api/ops/sitting/route');
  return call(route.POST, { url: '/api/ops/sitting', method: 'POST', session: s, body, csrf });
};
const errCode = async (r: Response): Promise<string> =>
  ((await r.clone().json()) as { error: { code: string } }).error.code;
const rows = async (r: StartRig) =>
  (await r.app.db.query<{ approval_ref: string }>('SELECT approval_ref FROM outbound_approvals'))
    .rows;

describe('open a PayPal sitting from Controls', () => {
  it('an operator with the code opens one with the D-094 ceiling; Start then turns PayPal on', async () => {
    rig = await bootStartRig({ approval: false });
    const s = await rig.mfaOperator();
    const r = await sitting(s);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({
      approval_ref: `${REF}~20261031T120000Z`,
      scope: SCOPE,
      valid_until: '2026-10-31T16:00:00.000Z',
      max_amount_minor: 500,
      max_calls: 40,
    });
    expect(await rig.count('outbound_approval.create')).toBe(1);
    expect(await rig.isOn()).toBe(false);
    const started = await rig.startAs(s, { reason: 'demo sitting', confirm_scope: SCOPE });
    expect(started.status).toBe(200);
    expect(await rig.isOn()).toBe(true);
    expect(rig.wire.calls).toHaveLength(0);
  });

  it('a second press while the sitting runs is refused 409 sitting_active', async () => {
    rig = await bootStartRig({ approval: false });
    const s = await rig.mfaOperator();
    expect((await sitting(s)).status).toBe(200);
    vi.setSystemTime(NOW + 60_000);
    const again = await sitting(s, { reason: 'again' });
    expect(again.status).toBe(409);
    expect(await errCode(again)).toBe('sitting_active');
    expect(await rows(rig)).toHaveLength(1);
  });

  it('is refused without the code, to a publisher, without a session, without CSRF, without a reason', async () => {
    rig = await bootStartRig({ approval: false });
    const plain = await rig.plainOperator();
    const r1 = await sitting(plain);
    expect(r1.status).toBe(403);
    expect(await errCode(r1)).toBe('mfa_required');
    expect((await sitting(await rig.publisher())).status).toBe(403);
    expect((await sitting(null)).status).toBe(401);
    const s = await rig.mfaOperator();
    expect((await sitting(s, { reason: 'demo' }, false)).status).toBe(403);
    expect((await sitting(s, { reason: '' })).status).toBe(422);
    expect((await sitting(s, { reason: 'x', max_calls: 999 })).status).toBe(422);
    expect(await rows(rig)).toHaveLength(0);
  });
});
