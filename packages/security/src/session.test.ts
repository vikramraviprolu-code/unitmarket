import { describe, expect, it } from 'vitest';
import { createSession, resolveSession } from './session';
import { cookiePair, makeRig } from './test-support';

const buyer = { kind: 'buyer', buyer_id: 'buy_a' } as const;

describe('session cookie', () => {
  it('cookie has __Host- prefix, HttpOnly, Secure, SameSite=Lax', async () => {
    const { deps } = await makeRig();
    const { cookie, csrf_token } = await createSession(deps, buyer);
    expect(cookie.startsWith('__Host-ums_s=')).toBe(true);
    expect(cookie).toContain('; HttpOnly');
    expect(cookie).toContain('; Secure');
    expect(cookie).toContain('; SameSite=Lax');
    expect(cookie).toContain('; Path=/');
    expect(cookie).not.toMatch(/Domain=/i);
    expect(csrf_token).toMatch(/^[0-9a-f]{32}$/);
    expect(cookie).not.toContain(csrf_token);
  });

  it('round trip resolves the actor; the system actor never gets a session', async () => {
    const { deps } = await makeRig();
    const s = await createSession(deps, buyer);
    expect(await resolveSession(deps, cookiePair(s.cookie))).toEqual(buyer);
    await expect(createSession(deps, { kind: 'system' })).rejects.toThrow();
  });

  it('a session row stores the csrf token only as a hash', async () => {
    const { deps, db } = await makeRig();
    const s = await createSession(deps, buyer);
    const row = (await db.query<{ csrf_token_hash: string }>('SELECT * FROM sessions')).rows[0];
    expect(JSON.stringify(row)).not.toContain(s.csrf_token);
    expect(row?.csrf_token_hash).toMatch(/^[0-9a-f]{64}$/);
  });
});
