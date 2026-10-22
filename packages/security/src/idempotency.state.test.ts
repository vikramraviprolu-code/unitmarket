import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { withRoute, type RouteMeta } from './route';
import { createSession } from './session';
import { ORIGIN, cookiePair, makeRig } from './test-support';

const meta: RouteMeta = {
  path: '/api/orders',
  method: 'POST',
  auth: 'buyer',
  csrf: true,
  rate: null,
  max_body_bytes: 1024,
  idempotent: true,
  risk: 'high',
};

describe('idempotency', () => {
  it('idempotency replays the stored response and refuses a changed body with 422', async () => {
    const rig = makeRig();
    let runs = 0;
    const route = withRoute(meta, z.object({ n: z.number() }).strict(), async (ctx) => {
      runs += 1;
      return { status: 201 as const, body: { created: runs, n: ctx.input.n } };
    });
    const s = await createSession(rig.deps, { kind: 'buyer', buyer_id: 'buy_a' });
    const call = (body: unknown, key: string | null = 'key-0001-abcdef') =>
      route(rig.deps)(
        new Request(`${ORIGIN}/api/orders`, {
          method: 'POST',
          headers: {
            cookie: cookiePair(s.cookie),
            origin: ORIGIN,
            'x-csrf-token': s.csrf_token,
            ...(key === null ? {} : { 'idempotency-key': key }),
          },
          body: JSON.stringify(body),
        }),
      );
    const first = await call({ n: 1 });
    expect(first.status).toBe(201);
    expect(await first.json()).toEqual({ created: 1, n: 1 });
    const again = await call({ n: 1 });
    expect(again.status).toBe(201);
    expect(await again.json()).toEqual({ created: 1, n: 1 });
    expect(again.headers.get('idempotent-replay')).toBe('true');
    expect(runs).toBe(1);

    const changed = await call({ n: 2 });
    expect(changed.status).toBe(422);
    expect(runs).toBe(1);

    expect((await call({ n: 3 }, 'key-0002-abcdef')).status).toBe(201);
    expect(runs).toBe(2);
    expect((await call({ n: 1 }, null)).status).toBe(422); // key required
    expect((await call({ n: 1 }, 'x')).status).toBe(422); // key too short
  });

  it('a key belongs to its actor: another buyer with the same key runs afresh', async () => {
    const rig = makeRig();
    let runs = 0;
    const route = withRoute(meta, z.object({}).strict(), async () => ({
      status: 201 as const,
      body: { runs: ++runs },
    }));
    const mk = async (id: string) => {
      const s = await createSession(rig.deps, { kind: 'buyer', buyer_id: id });
      return new Request(`${ORIGIN}/api/orders`, {
        method: 'POST',
        headers: {
          cookie: cookiePair(s.cookie),
          origin: ORIGIN,
          'x-csrf-token': s.csrf_token,
          'idempotency-key': 'shared-key-123',
        },
        body: '{}',
      });
    };
    expect((await route(rig.deps)(await mk('buy_a'))).status).toBe(201);
    expect((await route(rig.deps)(await mk('buy_b'))).status).toBe(201);
    expect(runs).toBe(2);
  });

  it('a failed attempt is not stored, so the same key can retry', async () => {
    const rig = makeRig();
    let fail = true;
    const route = withRoute(meta, z.object({}).strict(), async () =>
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
            'idempotency-key': 'retry-key-123',
          },
          body: '{}',
        }),
      );
    expect((await call()).status).toBe(409);
    fail = false;
    expect((await call()).status).toBe(201);
  });
});
