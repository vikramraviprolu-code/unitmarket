// Gate review M3: with no client address (no trusted proxy, no socket address) every client shares
// one 'no-address' bucket. Anonymous wrong passcodes must not lock the right passcode out.
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { withRoute, type RouteMeta } from './route';
import { ORIGIN, makeRig } from './test-support';

const login: RouteMeta = {
  path: '/api/login',
  method: 'POST',
  auth: 'public',
  csrf: true,
  rate: { name: 'passcode', per: 'ip', limit: 2, window_ms: 60_000 },
  rate_target: 'persona',
  max_body_bytes: 1024,
  idempotent: false,
  risk: 'high',
};
const schema = z.object({ persona: z.string(), pass: z.string() }).strict();
const handler = async (c: { input: { pass: string } }) =>
  c.input.pass === 'right'
    ? { status: 200 as const, body: { ok: true } }
    : { status: 401 as const, code: 'sign_in_failed', message: 'no' };
const post = (persona: string, pass: string, headers: Record<string, string> = {}) =>
  new Request(`${ORIGIN}/api/login`, {
    method: 'POST',
    headers: { origin: ORIGIN, ...headers },
    body: JSON.stringify({ persona, pass }),
  });

describe('shared no-address bucket (M3)', () => {
  it('wrong passcodes with rotating X-Forwarded-For exhaust the bucket but the right passcode still signs in', async () => {
    const rig = await makeRig();
    const run = withRoute(login, schema, handler)(rig.deps);
    expect((await run(post('amira', 'bad', { 'x-forwarded-for': '1.1.1.1' }))).status).toBe(401);
    expect((await run(post('amira', 'bad', { 'x-forwarded-for': '2.2.2.2' }))).status).toBe(401);
    // Exhausted: a further wrong passcode is throttled ...
    expect((await run(post('amira', 'bad', { 'x-forwarded-for': '3.3.3.3' }))).status).toBe(429);
    // ... but the right one is not locked out by anonymous failures.
    expect((await run(post('amira', 'right', { 'x-forwarded-for': '4.4.4.4' }))).status).toBe(200);
  });

  it('a successful sign-in resets only that persona bucket', async () => {
    const rig = await makeRig();
    const run = withRoute(login, schema, handler)(rig.deps);
    for (const p of ['amira', 'ben']) {
      await run(post(p, 'bad'));
      await run(post(p, 'bad'));
      expect((await run(post(p, 'bad'))).status).toBe(429);
    }
    expect((await run(post('amira', 'right'))).status).toBe(200);
    expect((await run(post('amira', 'bad'))).status).toBe(401);
    expect((await run(post('ben', 'bad'))).status).toBe(429);
  });

  it('with a real client address the lockout stays strict: the right passcode is refused while exhausted', async () => {
    const rig = await makeRig();
    const run = withRoute(login, schema, handler)(rig.deps);
    const from = (pass: string, addr: string) => run(post('amira', pass), { remote_addr: addr });
    expect((await from('bad', '10.0.0.1')).status).toBe(401);
    expect((await from('bad', '10.0.0.1')).status).toBe(401);
    expect((await from('right', '10.0.0.1')).status).toBe(429);
    expect((await from('right', '10.0.0.2')).status).toBe(200);
  });

  it('an unattributed client cannot brute-force past the throttle for free: wrong guesses stay 429', async () => {
    const rig = await makeRig();
    const run = withRoute(login, schema, handler)(rig.deps);
    for (let i = 0; i < 6; i++) await run(post('amira', `bad${i}`));
    expect((await run(post('amira', 'bad-again'))).status).toBe(429);
  });
});
