// INT-OPS-C / OPS-C.3 (C3, C4): an operator revokes any buyer's cap. The same FOR UPDATE and idempotent revoke as
// revokeMandate, without the buyer filter, for an operator with the second factor only. The reason is a code from a
// closed list and lands in the audit action in clear (`mandate.revoked.<code>`); audit_log.reason stays empty.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Actor } from '@umsbx/contracts';
import {
  OPERATOR_REVOKE_REASONS,
  checkBudget,
  createMandate,
  getMandate,
  revokeMandate,
  revokeMandateAsOperator,
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

const OP: Actor = { kind: 'operator', operator_id: 'opr_vikram', mfa: true };
const OP_PLAIN: Actor = { kind: 'operator', operator_id: 'opr_demo', mfa: false };

const create = async (buyer_id = 'buy_A', agent_key_id = 'key_A1') => {
  const r = await createMandate(h.db, h.deps, {
    buyer_id,
    agent_key_id,
    ...CAPS,
    max_count: 3,
  });
  if (!r.ok) throw new Error(`create refused: ${r.error}`);
  return r.value;
};

describe('revokeMandateAsOperator', () => {
  it('the reason codes are the closed list of the spec, with no free text', () => {
    expect([...OPERATOR_REVOKE_REASONS]).toEqual([
      'abuse',
      'owner_request',
      'compromised',
      'other',
    ]);
  });

  it('revokes any buyer mandate and writes one audit row as the operator, the code in the action', async () => {
    const a = await create('buy_A', 'key_A1');
    const b = await create('buy_B', 'key_B1');
    h.clock.advance(5000);
    const r = await revokeMandateAsOperator(h.db, h.deps, OP, { id: b.id, reason_code: 'abuse' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.id).toBe(b.id);
    expect(r.value.buyer_id).toBe('buy_B');
    expect(r.value.revoked_at).toBe(h.clock.now().toISOString());
    expect((await getMandate(h.db, 'buy_B', b.id))!.revoked_at).toBe(h.clock.now().toISOString());
    expect((await getMandate(h.db, 'buy_A', a.id))!.revoked_at).toBeNull();
    const rows = h.audits.filter((e) => e.action.startsWith('mandate.revoked'));
    expect(rows).toEqual([
      {
        actor: OP,
        action: 'mandate.revoked.abuse',
        target: b.id,
        reason: null,
        detail: { agent_key_id: 'key_B1', buyer_id: 'buy_B' },
      },
    ]);
  });

  it.each(OPERATOR_REVOKE_REASONS.map((c) => [c]))('code %s lands in the action', async (code) => {
    const m = await create();
    const r = await revokeMandateAsOperator(h.db, h.deps, OP, { id: m.id, reason_code: code });
    expect(r.ok).toBe(true);
    expect(h.audits.at(-1)!.action).toBe(`mandate.revoked.${code}`);
    expect(h.audits.at(-1)!.reason).toBeNull();
  });

  it('a revoked cap leaves the agent with mandate_required, reason revoked', async () => {
    const m = await create();
    await revokeMandateAsOperator(h.db, h.deps, OP, { id: m.id, reason_code: 'compromised' });
    expect(
      await checkBudget(h.db, h.deps, { buyer_id: 'buy_A', agent_key_id: 'key_A1' }),
    ).toMatchObject({ status: 'mandate_required', reason: 'revoked' });
  });

  it('a second revoke keeps the first time and writes no second audit row', async () => {
    const m = await create();
    const first = await revokeMandateAsOperator(h.db, h.deps, OP, {
      id: m.id,
      reason_code: 'abuse',
    });
    h.clock.advance(60_000);
    const again = await revokeMandateAsOperator(h.db, h.deps, OP, {
      id: m.id,
      reason_code: 'other',
    });
    expect(again).toEqual(first);
    expect(h.audits.filter((e) => e.action.startsWith('mandate.revoked'))).toHaveLength(1);
  });

  it('a cap the buyer revoked already is answered as it is, with no operator audit row', async () => {
    const m = await create();
    await revokeMandate(h.db, h.deps, { buyer_id: 'buy_A', id: m.id });
    const r = await revokeMandateAsOperator(h.db, h.deps, OP, { id: m.id, reason_code: 'abuse' });
    expect(r.ok).toBe(true);
    expect(h.audits.map((e) => e.action)).toEqual(['mandate.created', 'mandate.revoked']);
  });

  it('an unknown id is not_found and writes nothing', async () => {
    const r = await revokeMandateAsOperator(h.db, h.deps, OP, {
      id: 'man_unknown',
      reason_code: 'abuse',
    });
    expect(r).toEqual({ ok: false, error: 'not_found' });
    expect(h.audits.filter((e) => e.action.startsWith('mandate.revoked'))).toEqual([]);
  });

  it('refuses an operator without the second factor and every non operator, and changes nothing', async () => {
    const m = await create();
    const cases: [Actor, string][] = [
      [OP_PLAIN, 'mfa_required'],
      [{ kind: 'buyer', buyer_id: 'buy_A' }, 'not_operator'],
      [{ kind: 'publisher', publisher_id: 'pub_x' }, 'not_operator'],
      [{ kind: 'system', name: 'jobs' } as unknown as Actor, 'not_operator'],
    ];
    for (const [actor, error] of cases) {
      expect(
        await revokeMandateAsOperator(h.db, h.deps, actor, { id: m.id, reason_code: 'abuse' }),
      ).toEqual({ ok: false, error });
    }
    // Only `true` counts as the second factor.
    const truthy = { kind: 'operator', operator_id: 'opr_x', mfa: 'yes' } as unknown as Actor;
    expect(
      await revokeMandateAsOperator(h.db, h.deps, truthy, { id: m.id, reason_code: 'abuse' }),
    ).toEqual({ ok: false, error: 'mfa_required' });
    expect(
      await count(h.db, 'SELECT count(*) AS c FROM mandates WHERE revoked_at IS NOT NULL'),
    ).toBe(0);
    expect(h.audits.map((e) => e.action)).toEqual(['mandate.created']);
  });

  it('refuses a reason outside the list, before it reads anything', async () => {
    const m = await create();
    for (const bad of ['', 'ABUSE', 'abuse ', 'because I said so', 'mandate.revoked']) {
      expect(
        await revokeMandateAsOperator(h.db, h.deps, OP, {
          id: m.id,
          reason_code: bad as never,
        }),
      ).toEqual({ ok: false, error: 'invalid_reason' });
    }
    expect((await getMandate(h.db, 'buy_A', m.id))!.revoked_at).toBeNull();
  });

  it('leaves revokeMandate as it was: a buyer still cannot revoke another buyer cap', async () => {
    const b = await create('buy_B', 'key_B1');
    expect(await revokeMandate(h.db, h.deps, { buyer_id: 'buy_A', id: b.id })).toEqual({
      ok: false,
      error: 'not_found',
    });
  });
});
