// Opus review 4 M7 (client address) and M8 (idempotency hash covers path and params).
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { withRoute, type RouteMeta } from './route';
import { createSession } from './session';
import { ORIGIN, cookiePair, makeRig } from './test-support';

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
const refuse = async () => ({ status: 401 as const, code: 'unauthenticated', message: 'no' });
const schema = z.object({ persona: z.string() }).strict();
const post = (headers: Record<string, string>) =>
  new Request(`${ORIGIN}/api/login`, {
    method: 'POST',
    headers: { origin: ORIGIN, ...headers },
    body: JSON.stringify({ persona: 'amira' }),
  });

describe('client address for the ip limiter (M7)', () => {
  it('without a trusted proxy, rotating X-Forwarded-For or User-Agent gains nothing', async () => {
    const rig = await makeRig();
    const run = withRoute(login, schema, refuse)(rig.deps);
    expect((await run(post({ 'x-forwarded-for': '1.1.1.1', 'user-agent': 'a' }))).status).toBe(401);
    expect((await run(post({ 'x-forwarded-for': '2.2.2.2', 'user-agent': 'b' }))).status).toBe(401);
    expect((await run(post({ 'x-forwarded-for': '3.3.3.3', 'user-agent': 'c' }))).status).toBe(429);
  });
  it('the socket address from the call context keys the bucket', async () => {
    const rig = await makeRig();
    const run = withRoute(login, schema, refuse)(rig.deps);
    const from = (addr: string) =>
      run(post({ 'x-forwarded-for': '9.9.9.9' }), { remote_addr: addr });
    expect((await from('10.0.0.1')).status).toBe(401);
    expect((await from('10.0.0.1')).status).toBe(401);
    expect((await from('10.0.0.1')).status).toBe(429);
    expect((await from('10.0.0.2')).status).toBe(401);
  });
  it('with trusted_proxies = 1 the entry the proxy appended is used; earlier entries are ignored', async () => {
    const rig = await makeRig({ trusted_proxies: 1 });
    const run = withRoute(login, schema, refuse)(rig.deps);
    const via = (xff: string) => run(post({ 'x-forwarded-for': xff }), { remote_addr: '10.9.9.9' });
    expect((await via('6.6.6.6, 203.0.113.7')).status).toBe(401);
    expect((await via('7.7.7.7, 203.0.113.7')).status).toBe(401);
    expect((await via('8.8.8.8, 203.0.113.7')).status).toBe(429);
    expect((await via('8.8.8.8, 203.0.113.8')).status).toBe(401);
  });
  it('trusted_proxies = 1 with no header falls back to the socket address', async () => {
    const rig = await makeRig({ trusted_proxies: 1 });
    const run = withRoute(login, schema, refuse)(rig.deps);
    expect((await run(post({}), { remote_addr: '10.1.1.1' })).status).toBe(401);
    expect((await run(post({}), { remote_addr: '10.1.1.1' })).status).toBe(401);
    expect((await run(post({}), { remote_addr: '10.1.1.1' })).status).toBe(429);
  });
});

describe('idempotency hash covers the path and params (M8)', () => {
  const meta: RouteMeta = {
    path: '/api/orders/[id]',
    method: 'POST',
    auth: 'buyer',
    csrf: true,
    rate: null,
    max_body_bytes: 1024,
    idempotent: true,
    risk: 'high',
  };
  it('the same key on another order id is refused, not replayed', async () => {
    const rig = await makeRig();
    let runs = 0;
    const route = withRoute(meta, z.object({ id: z.string() }).strict(), async (ctx) => ({
      status: 201 as const,
      body: { id: ctx.input.id, runs: ++runs },
    }));
    const s = await createSession(rig.deps, { kind: 'buyer', buyer_id: 'buy_a' });
    const call = (id: string) =>
      route(rig.deps)(
        new Request(`${ORIGIN}/api/orders/${id}`, {
          method: 'POST',
          headers: {
            cookie: cookiePair(s.cookie),
            origin: ORIGIN,
            'x-csrf-token': s.csrf_token,
            'idempotency-key': 'key-0001-abcdef',
          },
          body: '{}',
        }),
        { params: { id } },
      );
    const a = await call('A');
    expect(a.status).toBe(201);
    const b = await call('B');
    expect(b.status).toBe(422);
    expect(((await b.json()) as { code: string }).code).toBe('idempotency_key_reused');
    expect(runs).toBe(1);
    const again = await call('A');
    expect(again.headers.get('idempotent-replay')).toBe('true');
    expect(runs).toBe(1);
  });
});
