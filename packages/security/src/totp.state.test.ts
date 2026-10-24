// CO-6: replay, operator sessions and the sign-in decision, over a real PGlite database whose audit
// sink writes the real audit_log (the replay check reads that table).
import { describe, expect, it } from 'vitest';
import { SESSION_ABSOLUTE_MS, SESSION_IDLE_MS, createSession, resolveSession } from './session';
import { UNVERIFIED_OPERATOR_ID, acceptTotp, operatorSignIn } from './totp';
import { cookiePair, secret } from './test-support';
import {
  KEYS,
  MIN,
  SAKTHI_B32,
  SAKTHI_KEY,
  STEP_MS,
  VIKRAM_B32,
  VIKRAM_KEY,
  totpRig,
  usedRows,
} from './totp-test-support';

const vikram = { operator_id: 'opr_vikram', key: secret(VIKRAM_B32) } as const;

describe('replay: a step already used by that operator is refused', () => {
  it('the second use of a code is refused and the first is recorded as an audit row', async () => {
    const r = await totpRig();
    const code = r.code(VIKRAM_KEY);
    expect(await acceptTotp(r.deps, { ...vikram, code })).toBe('accepted');
    expect(await acceptTotp(r.deps, { ...vikram, code })).toBe('replay');
    const rows = await usedRows(r, 'opr_vikram');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actor_kind: 'operator',
      actor_id: 'opr_vikram',
      action: 'operator.totp_used',
    });
    expect(rows[0]?.detail).toMatchObject({ step: r.step() });
  });
  it('a refused attempt (wrong or replay) writes no second row', async () => {
    const r = await totpRig();
    const code = r.code(VIKRAM_KEY);
    await acceptTotp(r.deps, { ...vikram, code });
    await acceptTotp(r.deps, { ...vikram, code });
    await acceptTotp(r.deps, { ...vikram, code: r.code(VIKRAM_KEY, 5) });
    expect(await usedRows(r)).toHaveLength(1);
  });
  it('the code of the next step is a different code and is accepted; the earlier one stays used', async () => {
    const r = await totpRig();
    const first = r.code(VIKRAM_KEY);
    expect(await acceptTotp(r.deps, { ...vikram, code: first })).toBe('accepted');
    r.clock.advance(STEP_MS);
    const second = r.code(VIKRAM_KEY);
    expect(second).not.toBe(first);
    expect(await acceptTotp(r.deps, { ...vikram, code: second })).toBe('accepted');
    // the first code is still inside the window of the new step, and still used
    expect(await acceptTotp(r.deps, { ...vikram, code: first })).toBe('replay');
    expect((await usedRows(r, 'opr_vikram')).map((x) => x.detail['step'])).toEqual([
      r.step() - 1,
      r.step(),
    ]);
  });
  it('the used step survives a restart: it is in the database, not in memory', async () => {
    const a = await totpRig();
    const code = a.code(VIKRAM_KEY);
    expect(await acceptTotp(a.deps, { ...vikram, code })).toBe('accepted');
    const restarted = { ...a.deps };
    expect(await acceptTotp(restarted, { ...vikram, code })).toBe('replay');
  });
  it('a used step belongs to its operator: another operator is not affected', async () => {
    const r = await totpRig();
    expect(await acceptTotp(r.deps, { ...vikram, code: r.code(VIKRAM_KEY) })).toBe('accepted');
    expect(
      await acceptTotp(r.deps, {
        operator_id: 'opr_sakthi',
        key: secret(SAKTHI_B32),
        code: r.code(SAKTHI_KEY),
      }),
    ).toBe('accepted');
  });
  it('a step is also used up when it was accepted one step early or late', async () => {
    const r = await totpRig();
    const early = r.code(VIKRAM_KEY, 1); // clock is one step behind this code
    expect(await acceptTotp(r.deps, { ...vikram, code: early })).toBe('accepted');
    r.clock.advance(STEP_MS); // now that code is the current step
    expect(await acceptTotp(r.deps, { ...vikram, code: early })).toBe('replay');
  });
});

describe('L1 monotonic window: only a step above the highest used step is accepted', () => {
  it('after step S is accepted, an older unused code (S-1) is refused', async () => {
    const r = await totpRig();
    expect(await acceptTotp(r.deps, { ...vikram, code: r.code(VIKRAM_KEY) })).toBe('accepted');
    expect(await acceptTotp(r.deps, { ...vikram, code: r.code(VIKRAM_KEY, -1) })).toBe('replay');
    expect(await usedRows(r, 'opr_vikram')).toHaveLength(1);
  });
  it('after step S+1 is accepted early, the current code (S) and the older code (S-1) are refused', async () => {
    const r = await totpRig();
    expect(await acceptTotp(r.deps, { ...vikram, code: r.code(VIKRAM_KEY, 1) })).toBe('accepted');
    expect(await acceptTotp(r.deps, { ...vikram, code: r.code(VIKRAM_KEY, 0) })).toBe('replay');
    expect(await acceptTotp(r.deps, { ...vikram, code: r.code(VIKRAM_KEY, -1) })).toBe('replay');
    expect(await usedRows(r, 'opr_vikram')).toHaveLength(1);
  });
  it('the same code is refused', async () => {
    const r = await totpRig();
    const code = r.code(VIKRAM_KEY);
    expect(await acceptTotp(r.deps, { ...vikram, code })).toBe('accepted');
    expect(await acceptTotp(r.deps, { ...vikram, code })).toBe('replay');
  });
  it('a later step is accepted', async () => {
    const r = await totpRig();
    expect(await acceptTotp(r.deps, { ...vikram, code: r.code(VIKRAM_KEY) })).toBe('accepted');
    expect(await acceptTotp(r.deps, { ...vikram, code: r.code(VIKRAM_KEY, 1) })).toBe('accepted');
    expect((await usedRows(r, 'opr_vikram')).map((x) => x.detail['step'])).toEqual([
      r.step(),
      r.step() + 1,
    ]);
  });
  it('the highest used step belongs to its operator: another operator may still use S-1', async () => {
    const r = await totpRig();
    expect(await acceptTotp(r.deps, { ...vikram, code: r.code(VIKRAM_KEY) })).toBe('accepted');
    expect(
      await acceptTotp(r.deps, {
        operator_id: 'opr_sakthi',
        key: secret(SAKTHI_B32),
        code: r.code(SAKTHI_KEY, -1),
      }),
    ).toBe('accepted');
  });
});

describe('clock skew: current step and one either side', () => {
  it.each([
    [-2, 'wrong'],
    [-1, 'accepted'],
    [0, 'accepted'],
    [1, 'accepted'],
    [2, 'wrong'],
  ])('a code %i steps away is %s', async (delta, verdict) => {
    const r = await totpRig();
    expect(await acceptTotp(r.deps, { ...vikram, code: r.code(VIKRAM_KEY, delta) })).toBe(verdict);
  });
});

describe('operator sessions end after 30 min idle and 8 h absolute', () => {
  const op = { kind: 'operator', operator_id: 'opr_vikram', mfa: true } as const;
  it('the mfa flag is kept by the session', async () => {
    const r = await totpRig();
    const withMfa = await createSession(r.deps, op);
    const without = await createSession(r.deps, { ...op, mfa: false });
    expect(await resolveSession(r.deps, cookiePair(withMfa.cookie))).toEqual(op);
    expect(await resolveSession(r.deps, cookiePair(without.cookie))).toEqual({ ...op, mfa: false });
  });
  it('idle: 29 min renews, 31 min ends it', async () => {
    const r = await totpRig();
    const s = cookiePair((await createSession(r.deps, op)).cookie);
    r.clock.advance(29 * MIN);
    expect(await resolveSession(r.deps, s)).toEqual(op);
    r.clock.advance(29 * MIN);
    expect(await resolveSession(r.deps, s)).toEqual(op);
    r.clock.advance(31 * MIN);
    expect(await resolveSession(r.deps, s)).toBeNull();
  });
  it('exactly 30 min idle ends it', async () => {
    const r = await totpRig();
    const s = cookiePair((await createSession(r.deps, op)).cookie);
    r.clock.advance(SESSION_IDLE_MS);
    expect(await resolveSession(r.deps, s)).toBeNull();
  });
  it('absolute: active every 20 min, it still ends at 8 h', async () => {
    const r = await totpRig();
    const s = cookiePair((await createSession(r.deps, op)).cookie);
    for (let t = 20; t < 8 * 60; t += 20) {
      r.clock.advance(20 * MIN);
      expect(await resolveSession(r.deps, s)).toEqual(op);
    }
    r.clock.advance(20 * MIN);
    expect(await resolveSession(r.deps, s)).toBeNull();
    expect(SESSION_ABSOLUTE_MS).toBe(8 * 60 * MIN);
  });
});

describe('the sign-in decision', () => {
  const sign = (
    r: Awaited<ReturnType<typeof totpRig>>,
    over: { operator?: string; code?: string },
  ) => operatorSignIn(r.deps, { keys: KEYS, ...over });

  it('no keys configured: the operator signs in with mfa false, even with a code', async () => {
    const r = await totpRig();
    expect(await operatorSignIn(r.deps, { keys: [] })).toEqual({
      ok: true,
      operator_id: UNVERIFIED_OPERATOR_ID,
      mfa: false,
    });
    expect(
      await operatorSignIn(r.deps, {
        keys: [],
        operator: 'vikram',
        code: r.code(VIKRAM_KEY),
      }),
    ).toEqual({ ok: true, operator_id: 'opr_demo', mfa: false });
    expect(await usedRows(r)).toEqual([]);
  });
  it('keys configured, no code: mfa false and the unverified id, never a named operator', async () => {
    const r = await totpRig();
    for (const operator of [undefined, 'vikram', 'nobody']) {
      for (const code of [undefined, '', '   ']) {
        expect(
          await sign(r, {
            ...(operator ? { operator } : {}),
            ...(code === undefined ? {} : { code }),
          }),
        ).toEqual({
          ok: true,
          operator_id: 'opr_demo',
          mfa: false,
        });
      }
    }
  });
  it('keys configured, right code: mfa true as opr_<name>, and the session carries it', async () => {
    const r = await totpRig();
    const res = await sign(r, { operator: 'vikram', code: r.code(VIKRAM_KEY) });
    expect(res).toEqual({ ok: true, operator_id: 'opr_vikram', mfa: true });
    if (!res.ok) throw new Error('unreachable');
    const actor = { kind: 'operator', operator_id: res.operator_id, mfa: res.mfa } as const;
    const s = await createSession(r.deps, actor);
    expect(await resolveSession(r.deps, cookiePair(s.cookie))).toEqual(actor);
  });
  it('the name may be typed in any case with spaces around it, and the code with a space in it', async () => {
    const r = await totpRig();
    const code = r.code(SAKTHI_KEY);
    const typed = `${code.slice(0, 3)} ${code.slice(3)}`;
    expect(await sign(r, { operator: '  Sakthi ', code: typed })).toEqual({
      ok: true,
      operator_id: 'opr_sakthi',
      mfa: true,
    });
  });
  it('a wrong code, a replayed code and an unknown name are all refusals, with the reason kept apart', async () => {
    const r = await totpRig();
    expect(await sign(r, { operator: 'vikram', code: r.code(VIKRAM_KEY, 9) })).toEqual({
      ok: false,
      reason: 'wrong_code',
    });
    const code = r.code(VIKRAM_KEY);
    expect((await sign(r, { operator: 'vikram', code })).ok).toBe(true);
    expect(await sign(r, { operator: 'vikram', code })).toEqual({ ok: false, reason: 'replay' });
    expect(await sign(r, { operator: 'nobody', code })).toEqual({
      ok: false,
      reason: 'unknown_operator',
    });
    expect(await sign(r, { code })).toEqual({ ok: false, reason: 'unknown_operator' });
  });
  it('a configured key shorter than 20 bytes refuses everything (fail closed)', async () => {
    const r = await totpRig();
    const short = [{ name: 'vikram', key: secret('GEZDGNBVGY3TQOJQ') }]; // 10 bytes
    const code = r.code(VIKRAM_KEY);
    expect(await operatorSignIn(r.deps, { keys: short, operator: 'vikram', code })).toEqual({
      ok: false,
      reason: 'wrong_code',
    });
    const broken = [{ name: 'vikram', key: secret('not base32 at all!') }];
    expect(await operatorSignIn(r.deps, { keys: broken, operator: 'vikram', code })).toEqual({
      ok: false,
      reason: 'wrong_code',
    });
  });
});
