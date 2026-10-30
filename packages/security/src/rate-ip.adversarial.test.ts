// AI-H: a per-IP rule next to the per-actor rule. The buyer personas are shared, so one visitor must not
// be able to use up the allowance every judge shares. Real PGlite schema (see test-support).
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { DEFAULT_RATES } from './rate';
import { withRoute, type RouteMeta } from './route';
import { createSession } from './session';
import { ORIGIN, cookiePair, makeRig } from './test-support';

const meta: RouteMeta = {
  path: '/api/discover',
  method: 'POST',
  auth: 'buyer',
  csrf: true,
  rate: { name: 'discovery', per: 'actor', limit: 6, window_ms: 3_600_000 },
  rate_ip: { name: 'discovery-ip', per: 'ip', limit: 2, window_ms: 3_600_000 },
  max_body_bytes: 1024,
  idempotent: false,
  risk: 'medium',
};
const route = withRoute(meta, z.object({}).strict(), async () => ({
  status: 200 as const,
  body: { ok: true },
}));

async function rigWith(trusted_proxies: number) {
  const rig = await makeRig({ trusted_proxies });
  const s = await createSession(rig.deps, { kind: 'buyer', buyer_id: 'buy_shared_persona' });
  const call = (xff?: string) =>
    route(rig.deps)(
      new Request(`${ORIGIN}/api/discover`, {
        method: 'POST',
        headers: {
          cookie: cookiePair(s.cookie),
          origin: ORIGIN,
          'x-csrf-token': s.csrf_token,
          ...(xff === undefined ? {} : { 'x-forwarded-for': xff }),
        },
        body: '{}',
      }),
    );
  return { rig, call };
}

describe('per-IP limit (AI-H)', () => {
  it('has a conservative default rule: per ip, above the persona rule per visitor', () => {
    expect(DEFAULT_RATES.discovery_ip.per).toBe('ip');
    expect(DEFAULT_RATES.discovery_ip.limit).toBe(40);
    expect(DEFAULT_RATES.discovery_ip.window_ms).toBe(3_600_000);
  });

  it('one IP at its limit gets 429 with retry-after; another IP on the same persona still gets 200', async () => {
    const { call } = await rigWith(1);
    expect((await call('203.0.113.1')).status).toBe(200);
    expect((await call('203.0.113.1')).status).toBe(200);
    const denied = await call('203.0.113.1');
    expect(denied.status).toBe(429);
    expect(Number(denied.headers.get('retry-after'))).toBeGreaterThan(0);
    expect((await call('203.0.113.2')).status).toBe(200);
  });

  it('an IP that hammers cannot starve another IP: refused calls never spend the shared persona allowance', async () => {
    const { call } = await rigWith(1);
    for (let i = 0; i < 50; i++) await call('203.0.113.1');
    // The persona allowance is 6; the attacker's IP legitimately spent 2, so 4 remain for others.
    for (let i = 0; i < 4; i++) expect((await call('203.0.113.2')).status).toBe(200);
    // Now the persona rule itself (not the ip rule) ends it for everyone.
    expect((await call('203.0.113.3')).status).toBe(429);
  });

  it('spoofed left X-Forwarded-For entries neither share nor escape a bucket (one trusted proxy)', async () => {
    const { call } = await rigWith(1);
    expect((await call('6.6.6.6, 203.0.113.9')).status).toBe(200);
    expect((await call('7.7.7.7, 203.0.113.9')).status).toBe(200);
    expect((await call('8.8.8.8, 203.0.113.9')).status).toBe(429);
    expect((await call('203.0.113.9, 203.0.113.10')).status).toBe(200);
  });

  it('the bucket refills with time', async () => {
    const { rig, call } = await rigWith(1);
    await call('203.0.113.1');
    await call('203.0.113.1');
    expect((await call('203.0.113.1')).status).toBe(429);
    rig.clock.advance(3_600_000 / 2);
    expect((await call('203.0.113.1')).status).toBe(200);
  });

  it('with no known client address the per-IP rule is not charged (it never becomes one bucket for all)', async () => {
    const { rig, call } = await rigWith(0);
    for (let i = 0; i < 6; i++) expect((await call('203.0.113.1')).status).toBe(200);
    const rows = await rig.db.query(
      `SELECT bucket_key FROM rate_buckets WHERE bucket_key LIKE 'discovery-ip:%'`,
    );
    expect(rows.rows).toHaveLength(0);
    // The persona rule still holds.
    expect((await call()).status).toBe(429);
  });

  it('the address is stored hashed, never raw', async () => {
    const { rig, call } = await rigWith(1);
    await call('198.51.100.77');
    const rows = await rig.db.query<{ bucket_key: string }>(
      `SELECT bucket_key FROM rate_buckets WHERE bucket_key LIKE 'discovery-ip:%'`,
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]!.bucket_key).not.toContain('198.51.100.77');
  });

  it('rate_ip is checked when the route is built: only an ip rule, only with positive numbers', () => {
    const bad = (rate_ip: RouteMeta['rate_ip']) =>
      withRoute({ ...meta, rate_ip }, z.object({}).strict(), async () => ({
        status: 200 as const,
        body: {},
      }));
    expect(() => bad({ name: 'x', per: 'actor', limit: 2, window_ms: 1000 })).toThrow(/rate_ip/);
    expect(() => bad({ name: 'x', per: 'ip', limit: 0, window_ms: 1000 })).toThrow(/rate_ip/);
    expect(() => bad({ name: 'x', per: 'ip', limit: 2, window_ms: 0 })).toThrow(/rate_ip/);
  });
});
