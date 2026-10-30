import { describe, expect, it } from 'vitest';
import {
  createSession,
  resolveSession,
  resolveSessionRecord,
  revokeAllSessions,
  revokeSession,
} from './session';
import { cookiePair, makeRig } from './test-support';

const buyer = { kind: 'buyer', buyer_id: 'buy_a' } as const;
const MIN = 60_000;
const HOUR = 60 * MIN;

describe('session lifetime', () => {
  it('session expires at 8 h absolute and 30 min idle', async () => {
    const { deps, clock } = await makeRig();
    const s = await createSession(deps, buyer);
    const c = cookiePair(s.cookie);

    // idle: 29 min gap is fine and renews; 31 min gap ends it.
    clock.advance(29 * MIN);
    expect(await resolveSession(deps, c)).toEqual(buyer);
    clock.advance(29 * MIN);
    expect(await resolveSession(deps, c)).toEqual(buyer);
    clock.advance(31 * MIN);
    expect(await resolveSession(deps, c)).toBeNull();

    // absolute: keep it active every 20 min; it still dies at 8 h.
    const s2 = await createSession(deps, buyer);
    const c2 = cookiePair(s2.cookie);
    for (let t = 20; t < 8 * 60; t += 20) {
      clock.advance(20 * MIN);
      expect(await resolveSession(deps, c2)).toEqual(buyer);
    }
    clock.advance(20 * MIN); // 8 h exactly
    expect(await resolveSession(deps, c2)).toBeNull();
    expect(HOUR * 8).toBe(8 * 60 * MIN);
  });

  it('revokeAll ends every session of the actor and no other', async () => {
    const { deps, audit } = await makeRig();
    const a1 = await createSession(deps, buyer);
    const a2 = await createSession(deps, buyer);
    const b = await createSession(deps, { kind: 'buyer', buyer_id: 'buy_b' });
    expect(await revokeAllSessions(deps, buyer)).toBe(2);
    expect(await resolveSession(deps, cookiePair(a1.cookie))).toBeNull();
    expect(await resolveSession(deps, cookiePair(a2.cookie))).toBeNull();
    expect(await resolveSession(deps, cookiePair(b.cookie))).toEqual({
      kind: 'buyer',
      buyer_id: 'buy_b',
    });
    expect(await revokeAllSessions(deps, buyer)).toBe(0);
    expect(audit.some((e) => e.action === 'session.revoke_all')).toBe(true);
  });

  it('revokeSession ends only the session of the cookie, audits it, and a replay is a no-op (FIX-FLOW D1)', async () => {
    const { deps, audit } = await makeRig();
    const s1 = await createSession(deps, buyer);
    const s2 = await createSession(deps, buyer);
    const c1 = cookiePair(s1.cookie);
    const rec = (await resolveSessionRecord(deps, c1))!;
    expect(await revokeSession(deps, { id: rec.id, actor: rec.actor })).toBe(true);
    expect(await resolveSession(deps, c1)).toBeNull();
    expect(await resolveSession(deps, cookiePair(s2.cookie))).toEqual(buyer);
    expect(audit.some((e) => e.action === 'session.revoke')).toBe(true);
    // A replay, and an id that belongs to another actor, change nothing.
    expect(await revokeSession(deps, { id: rec.id, actor: rec.actor })).toBe(false);
    const rec2 = (await resolveSessionRecord(deps, cookiePair(s2.cookie)))!;
    expect(
      await revokeSession(deps, { id: rec2.id, actor: { kind: 'buyer', buyer_id: 'buy_b' } }),
    ).toBe(false);
    expect(await resolveSession(deps, cookiePair(s2.cookie))).toEqual(buyer);
  });

  it('a tampered signature or a foreign secret is refused', async () => {
    const a = await makeRig();
    const s = await createSession(a.deps, buyer);
    const c = cookiePair(s.cookie);
    const forged = c.replace(/.$/, (ch) => (ch === 'A' ? 'B' : 'A'));
    expect(await resolveSession(a.deps, forged)).toBeNull();
    const other = await makeRig({
      db: a.db,
      session_secret: {
        reveal: () => 'another-secret',
        toString: () => '[redacted]',
        toJSON: () => '[redacted]',
      },
    });
    expect(await resolveSession(other.deps, c)).toBeNull();
  });
});

describe('L2 defence in depth: mfa needs an mfa signature and a named operator row', () => {
  const named = { kind: 'operator', operator_id: 'opr_vikram', mfa: true } as const;
  it('an opr_demo row never gets mfa, even with an mfa signature', async () => {
    const { deps } = await makeRig();
    const s = await createSession(deps, { ...named, operator_id: 'opr_demo' });
    expect(await resolveSession(deps, cookiePair(s.cookie))).toEqual({
      kind: 'operator',
      operator_id: 'opr_demo',
      mfa: false,
    });
  });
  it('an mfa cookie whose row was changed to opr_demo does not give mfa', async () => {
    const { deps, db } = await makeRig();
    const s = await createSession(deps, named);
    await db.query("UPDATE sessions SET actor_id = 'opr_demo' WHERE actor_kind = 'operator'");
    expect(await resolveSession(deps, cookiePair(s.cookie))).toEqual({
      kind: 'operator',
      operator_id: 'opr_demo',
      mfa: false,
    });
  });
  it('a named operator row with a plain signature is a normal non-mfa session', async () => {
    const { deps } = await makeRig();
    const s = await createSession(deps, { ...named, mfa: false });
    expect(await resolveSession(deps, cookiePair(s.cookie))).toEqual({ ...named, mfa: false });
  });
  it('a named operator row with an mfa signature keeps mfa', async () => {
    const { deps } = await makeRig();
    const s = await createSession(deps, named);
    expect(await resolveSession(deps, cookiePair(s.cookie))).toEqual(named);
  });
});
