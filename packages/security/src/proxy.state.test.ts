// CO-7 / D-022 / ASM-57: the hosted demo runs behind one proxy (UMS_TRUSTED_PROXIES=1). The client
// address is the rightmost X-Forwarded-For entry; a client-supplied left entry cannot choose or
// share a bucket.
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
const refuse = async () => ({ status: 401 as const, code: 'unauthenticated', message: 'no' });
const schema = z.object({ persona: z.string() }).strict();
const post = (xff: string) =>
  new Request(`${ORIGIN}/api/login`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'x-forwarded-for': xff },
    body: JSON.stringify({ persona: 'amira' }),
  });

describe('D-022 with one trusted proxy', () => {
  it('buckets by the rightmost entry, 203.0.113.9, whatever the left entry says', async () => {
    const rig = await makeRig({ trusted_proxies: 1 });
    const run = withRoute(login, schema, refuse)(rig.deps);
    const via = (xff: string) => run(post(xff), { remote_addr: '10.9.9.9' });
    expect((await via('6.6.6.6, 203.0.113.9')).status).toBe(401);
    expect((await via('7.7.7.7, 203.0.113.9')).status).toBe(401);
    // Same real address, a third different left entry: the bucket is full.
    expect((await via('8.8.8.8, 203.0.113.9')).status).toBe(429);
    // The spoofed left entries never became buckets of their own.
    expect((await via('6.6.6.6, 203.0.113.10')).status).toBe(401);
  });

  it('two clients that spoof the left entry share no bucket with each other real address', async () => {
    const rig = await makeRig({ trusted_proxies: 1 });
    const run = withRoute(login, schema, refuse)(rig.deps);
    const a = (left: string) => run(post(`${left}, 203.0.113.9`), { remote_addr: '10.9.9.9' });
    const b = (left: string) => run(post(`${left}, 203.0.113.10`), { remote_addr: '10.9.9.9' });
    // Client A fills its own bucket while claiming to be B.
    expect((await a('203.0.113.10')).status).toBe(401);
    expect((await a('203.0.113.10')).status).toBe(401);
    expect((await a('203.0.113.10')).status).toBe(429);
    // Client B, claiming to be A, still has its full allowance.
    expect((await b('203.0.113.9')).status).toBe(401);
    expect((await b('203.0.113.9')).status).toBe(401);
    expect((await b('203.0.113.9')).status).toBe(429);
    // And A stays limited: B's traffic did not reset or move it.
    expect((await a('1.2.3.4')).status).toBe(429);
  });

  it('a single-entry header is that entry; padding on the left changes nothing', async () => {
    const rig = await makeRig({ trusted_proxies: 1 });
    const run = withRoute(login, schema, refuse)(rig.deps);
    const via = (xff: string) => run(post(xff), { remote_addr: '10.9.9.9' });
    expect((await via('203.0.113.20')).status).toBe(401);
    expect((await via('1.1.1.1,2.2.2.2,203.0.113.20')).status).toBe(401);
    expect((await via('203.0.113.20')).status).toBe(429);
  });
});
