import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { takeToken } from './rate';
import { withRoute, type RouteMeta } from './route';
import { createSession } from './session';
import { ORIGIN, cookiePair, makeRig } from './test-support';

const rule = { name: 'quote', per: 'actor', limit: 3, window_ms: 60_000 } as const;
const meta: RouteMeta = {
  path: '/api/quote',
  method: 'POST',
  auth: 'buyer',
  csrf: true,
  rate: rule,
  max_body_bytes: 1024,
  idempotent: false,
  risk: 'low',
};
const route = withRoute(meta, z.object({}).strict(), async () => ({
  status: 200 as const,
  body: { ok: true },
}));

describe('rate limit', () => {
  it('rate limit returns 429 at limit + 1', async () => {
    const { deps } = await makeRig();
    const s = await createSession(deps, { kind: 'buyer', buyer_id: 'buy_a' });
    const call = () =>
      route(deps)(
        new Request(`${ORIGIN}/api/quote`, {
          method: 'POST',
          headers: { cookie: cookiePair(s.cookie), origin: ORIGIN, 'x-csrf-token': s.csrf_token },
          body: '{}',
        }),
      );
    expect((await call()).status).toBe(200);
    expect((await call()).status).toBe(200);
    expect((await call()).status).toBe(200);
    const denied = await call();
    expect(denied.status).toBe(429);
    expect(Number(denied.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  it('buckets are per actor and refill with time', async () => {
    const { deps, clock } = await makeRig();
    for (let i = 0; i < 3; i++) expect((await takeToken(deps, rule, 'buy_a')).allowed).toBe(true);
    expect((await takeToken(deps, rule, 'buy_a')).allowed).toBe(false);
    expect((await takeToken(deps, rule, 'buy_b')).allowed).toBe(true);
    clock.advance(20_000); // one token every window/limit = 20 s
    expect((await takeToken(deps, rule, 'buy_a')).allowed).toBe(true);
    expect((await takeToken(deps, rule, 'buy_a')).allowed).toBe(false);
    clock.advance(10 * 60_000);
    for (let i = 0; i < 3; i++) expect((await takeToken(deps, rule, 'buy_a')).allowed).toBe(true);
    expect((await takeToken(deps, rule, 'buy_a')).allowed).toBe(false);
  });

  it('concurrent attempts cannot all read the same token count (M1)', async () => {
    const { deps } = await makeRig();
    const results = await Promise.all(
      Array.from({ length: 12 }, () => takeToken(deps, rule, 'buy_race')),
    );
    expect(results.filter((r) => r.allowed)).toHaveLength(3);
  });

  it('peek never consumes a token and never creates a row', async () => {
    const { deps, db } = await makeRig();
    for (let i = 0; i < 5; i++)
      expect((await takeToken(deps, rule, 'buy_peek', 'peek')).allowed).toBe(true);
    expect((await db.query('SELECT 1 FROM rate_buckets')).rows).toHaveLength(0);
    for (let i = 0; i < 3; i++) await takeToken(deps, rule, 'buy_peek');
    expect((await takeToken(deps, rule, 'buy_peek', 'peek')).allowed).toBe(false);
  });

  it('webhook limiter counts only rejected signatures', async () => {
    const { deps, clock } = await makeRig();
    let handled = 0;
    const wrule = { name: 'webhook-invalid', per: 'ip', limit: 2, window_ms: 60_000 } as const;
    let valid = true;
    const hook = withRoute(
      {
        path: '/api/webhooks/paypal',
        method: 'POST',
        auth: 'webhook',
        csrf: false,
        rate: wrule,
        max_body_bytes: 1024,
        idempotent: false,
        risk: 'high',
      },
      z.object({}).strict(),
      async () => {
        handled += 1;
        return valid
          ? { status: 200 as const, body: { ok: true } }
          : { status: 400 as const, code: 'bad_signature', message: 'bad' };
      },
    );
    const call = () =>
      hook(deps)(new Request(`${ORIGIN}/api/webhooks/paypal`, { method: 'POST', body: '{}' }));
    for (let i = 0; i < 10; i++) expect((await call()).status).toBe(200); // valid traffic never limited
    expect(handled).toBe(10);
    valid = false;
    expect((await call()).status).toBe(400);
    expect((await call()).status).toBe(400);
    // M2 (review): the limiter now runs BEFORE the handler, so an exhausted bucket refuses the
    // request without running the (expensive) signature check. This replaces the earlier
    // expectation that a valid webhook is accepted from an exhausted IP: it contradicts the
    // review finding, which asks for a pre-handler refusal.
    expect((await call()).status).toBe(429);
    expect(handled).toBe(12);
    expect((await call()).status).toBe(429);
    expect(handled).toBe(12);
    clock.advance(60_000);
    valid = true;
    expect((await call()).status).toBe(200); // refilled: a valid webhook passes again
  });
});
