// INT-OPS-C / OPS-C.3 (C3, C4): an operator revokes any owner's API key. It mirrors revokeKey without the owner
// filter, for an operator with the second factor only. The reason is a code from a closed list and lands in the
// audit action in clear (`api_key.revoked.<code>`); audit_log.reason stays empty. revokeKey is unchanged.
import { describe, expect, it, vi } from 'vitest';
import type { Actor } from '@umsbx/contracts';
import {
  OPERATOR_REVOKE_REASONS,
  listKeys,
  revokeKey,
  revokeKeyAsOperator,
  verifyKey,
} from './index';
import { BUYER_A, BUYER_B, OPR_MFA, OPR_PLAIN, PUB_A, makeV1Rig } from './v1-support';
import { expectOffline } from './offline-guard';

vi.mock('node:net', async (orig) => (await import('./offline-guard')).netMock(await orig()));
vi.mock('node:dns', async (orig) => (await import('./offline-guard')).dnsMock(await orig()));
expectOffline();

async function rigWithAudit() {
  const rig = await makeV1Rig();
  const deps = { ...rig.keyDeps, audit: rig.deps.audit };
  const revoked = () => rig.audit.filter((e) => e.action.startsWith('api_key.revoked'));
  return { rig, deps, revoked };
}

describe('revokeKeyAsOperator', () => {
  it('the reason codes are the closed list of the spec', () => {
    expect([...OPERATOR_REVOKE_REASONS]).toEqual([
      'abuse',
      'owner_request',
      'compromised',
      'other',
    ]);
  });

  it('revokes a key of any owner: the next call is refused, and one audit row names the operator and code', async () => {
    const { rig, deps, revoked } = await rigWithAudit();
    const agent = await rig.issue(BUYER_A, 'agent', ['agent:buy', 'catalogue:read']);
    const pub = await rig.issue(PUB_A, 'api_client', ['catalogue:read']);
    rig.clock.advance(1000);
    const r = await revokeKeyAsOperator(deps, OPR_MFA, agent.id, 'compromised');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.id).toBe(agent.id);
    expect(r.value.revoked_at).toBe(rig.clock.now().toISOString());
    expect(r.value).not.toHaveProperty('secret_hash');
    expect(JSON.stringify(r.value)).not.toMatch(/[a-f0-9]{64}/);
    expect(await verifyKey(rig.keyDeps, agent.token)).toEqual({ ok: false, error: 'invalid_key' });
    expect((await verifyKey(rig.keyDeps, pub.token)).ok).toBe(true);
    expect(revoked()).toEqual([
      {
        actor: OPR_MFA,
        action: 'api_key.revoked.compromised',
        target: agent.id,
        reason: null,
        detail: { key_kind: 'agent', owner_kind: 'buyer' },
      },
    ]);
  });

  it.each(OPERATOR_REVOKE_REASONS.map((c) => [c]))('code %s lands in the action', async (code) => {
    const { rig, deps, revoked } = await rigWithAudit();
    const k = await rig.issue(PUB_A, 'api_client', ['catalogue:read']);
    expect((await revokeKeyAsOperator(deps, OPR_MFA, k.id, code)).ok).toBe(true);
    expect(revoked().map((e) => [e.action, e.reason])).toEqual([[`api_key.revoked.${code}`, null]]);
  });

  it('a second revoke keeps the first time and writes no second audit row', async () => {
    const { rig, deps, revoked } = await rigWithAudit();
    const k = await rig.issue(BUYER_B, 'api_client', ['catalogue:read']);
    const first = await revokeKeyAsOperator(deps, OPR_MFA, k.id, 'abuse');
    rig.clock.advance(60_000);
    const again = await revokeKeyAsOperator(deps, OPR_MFA, k.id, 'other');
    expect(again).toEqual(first);
    expect(revoked()).toHaveLength(1);
  });

  it('a key its owner revoked already is answered as it is, with no operator audit row', async () => {
    const { rig, deps, revoked } = await rigWithAudit();
    const k = await rig.issue(PUB_A, 'api_client', ['catalogue:read']);
    await revokeKey(deps, PUB_A, k.id);
    expect((await revokeKeyAsOperator(deps, OPR_MFA, k.id, 'abuse')).ok).toBe(true);
    expect(revoked().map((e) => e.action)).toEqual(['api_key.revoked']);
  });

  it('works without an audit sink, like revokeKey', async () => {
    const rig = await makeV1Rig();
    const k = await rig.issue(PUB_A, 'api_client', ['catalogue:read']);
    expect((await revokeKeyAsOperator(rig.keyDeps, OPR_MFA, k.id, 'abuse')).ok).toBe(true);
    expect(await verifyKey(rig.keyDeps, k.token)).toEqual({ ok: false, error: 'invalid_key' });
  });

  it('an unknown id is not_found and writes nothing', async () => {
    const { deps, revoked } = await rigWithAudit();
    expect(await revokeKeyAsOperator(deps, OPR_MFA, 'key_unknown', 'abuse')).toEqual({
      ok: false,
      error: 'not_found',
    });
    expect(revoked()).toEqual([]);
  });

  it('refuses an operator without the second factor and every non operator, and changes nothing', async () => {
    const { rig, deps, revoked } = await rigWithAudit();
    const k = await rig.issue(PUB_A, 'api_client', ['catalogue:read']);
    const cases: [Actor, string][] = [
      [OPR_PLAIN, 'mfa_required'],
      [{ kind: 'operator', operator_id: 'opr_x', mfa: 'yes' } as unknown as Actor, 'mfa_required'],
      [BUYER_A, 'not_operator'],
      [PUB_A, 'not_operator'],
      [{ kind: 'system', name: 'jobs' } as unknown as Actor, 'not_operator'],
    ];
    for (const [actor, error] of cases)
      expect(await revokeKeyAsOperator(deps, actor, k.id, 'abuse')).toEqual({ ok: false, error });
    expect((await verifyKey(rig.keyDeps, k.token)).ok).toBe(true);
    expect(revoked()).toEqual([]);
  });

  it('refuses a reason outside the list', async () => {
    const { rig, deps } = await rigWithAudit();
    const k = await rig.issue(PUB_A, 'api_client', ['catalogue:read']);
    for (const bad of ['', 'Abuse', 'abuse ', 'free text reason'])
      expect(await revokeKeyAsOperator(deps, OPR_MFA, k.id, bad as never)).toEqual({
        ok: false,
        error: 'invalid_reason',
      });
    expect((await listKeys(rig.keyDeps, PUB_A))[0]!.revoked_at).toBeNull();
  });

  it('leaves revokeKey as it was: an owner still cannot revoke another owner key', async () => {
    const { rig, deps } = await rigWithAudit();
    const k = await rig.issue(BUYER_B, 'api_client', ['catalogue:read']);
    expect(await revokeKey(deps, BUYER_A, k.id)).toEqual({ ok: false, error: 'not_found' });
  });
});
