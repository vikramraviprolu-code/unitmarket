// Review wave 1 fixes M3, L2, L3 for @umsbx/security. Real PGlite schema (see test-support).
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { IDEMPOTENCY_PENDING_TTL_MS } from './idempotency';
import { withRoute, type RouteMeta } from './route';
import { createSession } from './session';
import { ORIGIN, cookiePair, makeRig } from './test-support';

const orders: RouteMeta = {
  path: '/api/orders',
  method: 'POST',
  auth: 'buyer',
  csrf: true,
  rate: null,
  max_body_bytes: 1024,
  idempotent: true,
  risk: 'high',
};

describe('idempotency reservations (M3)', () => {
  async function setup(handler: () => Promise<never>) {
    const rig = await makeRig();
    let runs = 0;
    const route = withRoute(orders, z.object({}).strict(), async () => {
      runs += 1;
      return handler();
    });
    const s = await createSession(rig.deps, { kind: 'buyer', buyer_id: 'buy_a' });
    const call = () =>
      route(rig.deps)(
        new Request(`${ORIGIN}/api/orders`, {
          method: 'POST',
          headers: {
            cookie: cookiePair(s.cookie),
            origin: ORIGIN,
            'x-csrf-token': s.csrf_token,
            'idempotency-key': 'throw-key-0001',
          },
          body: '{}',
        }),
      );
    return { rig, call, runs: () => runs };
  }

  it('a handler that throws keeps its reservation: an immediate retry gets 409, not a second run', async () => {
    const { call, runs } = await setup(async () => {
      throw new Error('boom after a side effect');
    });
    expect((await call()).status).toBe(500);
    expect((await call()).status).toBe(409);
    expect(runs()).toBe(1);
  });

  it('a pending reservation is reclaimed after the TTL, so a crash does not 409 forever', async () => {
    const { rig, call, runs } = await setup(async () => {
      throw new Error('crash');
    });
    expect((await call()).status).toBe(500);
    rig.clock.advance(IDEMPOTENCY_PENDING_TTL_MS + 1);
    expect((await call()).status).toBe(500); // handler ran again (and threw again)
    expect(runs()).toBe(2);
  });

  it('a refusal result (4xx) still clears the reservation so the client can retry', async () => {
    const rig = await makeRig();
    let fail = true;
    const route = withRoute(orders, z.object({}).strict(), async () =>
      fail
        ? { status: 409 as const, code: 'busy', message: 'busy' }
        : { status: 201 as const, body: { ok: true } },
    );
    const s = await createSession(rig.deps, { kind: 'buyer', buyer_id: 'buy_a' });
    const call = () =>
      route(rig.deps)(
        new Request(`${ORIGIN}/api/orders`, {
          method: 'POST',
          headers: {
            cookie: cookiePair(s.cookie),
            origin: ORIGIN,
            'x-csrf-token': s.csrf_token,
            'idempotency-key': 'refuse-key-001',
          },
          body: '{}',
        }),
      );
    expect((await call()).status).toBe(409);
    fail = false;
    expect((await call()).status).toBe(201);
  });
});

describe('route inputs (L2)', () => {
  const getMeta: RouteMeta = {
    ...orders,
    method: 'GET',
    csrf: false,
    idempotent: false,
    path: '/api/orders/[id]',
  };

  it('Next dynamic params reach the validated input and win over query values', async () => {
    const rig = await makeRig();
    const route = withRoute(getMeta, z.object({ id: z.string() }).strict(), async (ctx) => ({
      status: 200 as const,
      body: { id: ctx.input.id },
    }));
    const s = await createSession(rig.deps, { kind: 'buyer', buyer_id: 'buy_a' });
    const req = new Request(`${ORIGIN}/api/orders/ord_1?id=ord_evil`, {
      headers: { cookie: cookiePair(s.cookie) },
    });
    const res = await route(rig.deps)(req, { params: Promise.resolve({ id: 'ord_1' }) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: 'ord_1' });
  });

  it('a refined object stays strict', async () => {
    const rig = await makeRig();
    const schema = z
      .object({ a: z.number() })
      .strict()
      .refine((v) => v.a > 0);
    const route = withRoute({ ...orders, idempotent: false }, schema, async () => ({
      status: 200 as const,
      body: {},
    }));
    const s = await createSession(rig.deps, { kind: 'buyer', buyer_id: 'buy_a' });
    const post = (body: string) =>
      route(rig.deps)(
        new Request(`${ORIGIN}/api/orders`, {
          method: 'POST',
          headers: { cookie: cookiePair(s.cookie), origin: ORIGIN, 'x-csrf-token': s.csrf_token },
          body,
        }),
      );
    expect((await post('{"a":1}')).status).toBe(200);
    expect((await post('{"a":1,"extra":2}')).status).toBe(422);
  });

  it('a schema that cannot be made strict is refused at build time', () => {
    const noop = async () => ({ status: 200 as const, body: {} });
    const piped = z.object({ a: z.string() }).transform((v) => v);
    expect(() => withRoute({ ...orders, idempotent: false }, piped, noop)).toThrow(/strict/);
    expect(() => withRoute({ ...orders, idempotent: false }, z.string(), noop)).toThrow(/strict/);
  });
});

describe('ip limiting without a client address (L3)', () => {
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

  it('failed attempts on one persona do not lock another persona', async () => {
    const rig = await makeRig();
    const route = withRoute(login, z.object({ persona: z.string() }).strict(), async () => ({
      status: 401 as const,
      code: 'unauthenticated',
      message: 'no',
    }));
    const attempt = (persona: string, headers: Record<string, string> = {}) =>
      route(rig.deps)(
        new Request(`${ORIGIN}/api/login`, {
          method: 'POST',
          headers: { origin: ORIGIN, ...headers },
          body: JSON.stringify({ persona }),
        }),
      );
    expect((await attempt('amira')).status).toBe(401);
    expect((await attempt('amira')).status).toBe(401);
    expect((await attempt('amira')).status).toBe(429); // the attacker's own target is limited
    expect((await attempt('ben')).status).toBe(401); // another persona is untouched
    // Review 4 M7: without a trusted proxy these headers are the client's to rotate, so they no
    // longer open a fresh bucket.
    expect((await attempt('amira', { 'x-forwarded-for': '203.0.113.7' })).status).toBe(429);
    expect((await attempt('amira', { 'user-agent': 'other client' })).status).toBe(429);
  });

  it('rate_target needs a rate', () => {
    const noop = async () => ({ status: 200 as const, body: {} });
    expect(() =>
      withRoute({ ...login, rate: null }, z.object({ persona: z.string() }).strict(), noop),
    ).toThrow();
  });
});
