import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { MAINTENANCE_ROUTES, withRoute } from './route';
import type { RouteMeta, SecurityDeps } from './route';
import { ORIGIN, makeRig } from './test-support';

// CO-7b (D-037): in maintenance mode the route wrapper answers 503 `maintenance` before it reads the
// method, the cookie, the body, the limiter or the database, for every route except the health check.
// Enforcement lives here and not in middleware (architecture 9.8).
const meta = (path: string, over: Partial<RouteMeta> = {}): RouteMeta => ({
  path,
  method: 'GET',
  auth: 'public',
  csrf: false,
  rate: null,
  max_body_bytes: 1024,
  idempotent: false,
  risk: 'low',
  ...over,
});
const empty = z.object({}).strict();

/** Deps whose every dependency throws when touched: proves nothing is read. */
function untouchable(over: Partial<SecurityDeps> = {}): SecurityDeps {
  const boom = (what: string): never => {
    throw new Error(`touched ${what}`);
  };
  return {
    get db() {
      return boom('db');
    },
    get clock() {
      return boom('clock');
    },
    get session_secret() {
      return boom('session_secret');
    },
    get audit() {
      return boom('audit');
    },
    get passcode_hash() {
      return boom('passcode_hash');
    },
    public_origin: ORIGIN,
    // ids and log are needed for the request id and the error body; they touch no state.
    ids: { next: () => 'x_0' as never, nonce: () => 'abcdef0123456789abcdef0123456789' },
    log: {
      log: () => undefined,
      child() {
        return this;
      },
    },
    ...over,
    maintenance: true,
  } as unknown as SecurityDeps;
}

describe('maintenance gate in withRoute', () => {
  it('names exactly one route that stays up: the health check', () => {
    expect([...MAINTENANCE_ROUTES]).toEqual(['/healthz']);
  });

  it('answers 503 maintenance, runs no handler, reads nothing', async () => {
    let ran = 0;
    const handler = withRoute(meta('/api/library'), empty, async () => {
      ran += 1;
      return { status: 200, body: {} };
    })(untouchable());
    const res = await handler(new Request(`${ORIGIN}/api/library`));
    expect(res.status).toBe(503);
    expect(ran).toBe(0);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('maintenance');
    expect(JSON.stringify(body)).not.toMatch(/db|sql|pglite|flag|var\/data/i);
  });

  it('keeps the security headers and forbids caching', async () => {
    const res = await withRoute(meta('/api/library'), empty, async () => ({
      status: 200,
      body: {},
    }))(untouchable())(new Request(`${ORIGIN}/api/library`));
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-type')).toContain('application/json');
  });

  it.each([
    ['a wrong method', 'DELETE'],
    ['a POST to a GET route', 'POST'],
  ])('%s still gets 503, not 404 or 405', async (_n, method) => {
    const res = await withRoute(meta('/api/library'), empty, async () => ({
      status: 200,
      body: {},
    }))(untouchable())(
      new Request(`${ORIGIN}/api/library`, { method, body: method === 'POST' ? '{}' : null }),
    );
    expect(res.status).toBe(503);
  });

  it('applies to POST, webhook, raw, operator and idempotent routes alike', async () => {
    const cases: RouteMeta[] = [
      meta('/api/session', { method: 'POST', csrf: true }),
      meta('/api/ops/stop', { method: 'POST', csrf: true, auth: 'operator', risk: 'high' }),
      meta('/api/orders', {
        method: 'POST',
        csrf: true,
        auth: 'buyer',
        idempotent: true,
        risk: 'high',
      }),
      meta('/api/webhooks/paypal', {
        method: 'POST',
        auth: 'webhook',
        raw: true,
        rate: { name: 'webhook', per: 'ip', limit: 60, window_ms: 60_000 },
        risk: 'high',
      }),
    ];
    for (const m of cases) {
      const res = await withRoute(m, z.object({}).passthrough(), async () => ({
        status: 200,
        body: {},
      }))(untouchable())(
        new Request(`${ORIGIN}${m.path}`, {
          method: m.method,
          headers: { cookie: 'ums_session=bogus', origin: ORIGIN },
          body: m.method === 'POST' ? '{}' : null,
        }),
      );
      expect(res.status, m.path).toBe(503);
    }
  });

  it('the health check is the one exception: its handler runs', async () => {
    let ran = 0;
    const res = await withRoute(meta('/healthz', { max_body_bytes: 1024 }), empty, async () => {
      ran += 1;
      return { status: 200, body: { ok: true, maintenance: true } };
    })(untouchable())(new Request(`${ORIGIN}/healthz`));
    expect(ran).toBe(1);
    expect(res.status).toBe(200);
  });

  it('matches the path exactly: a look-alike path is not exempt', async () => {
    for (const p of ['/healthz/x', '/healthz2', '/api/healthz', '/Healthz']) {
      const res = await withRoute(meta(p), empty, async () => ({ status: 200, body: {} }))(
        untouchable(),
      )(new Request(`${ORIGIN}${p}`));
      expect(res.status, p).toBe(503);
    }
  });

  it('is not driven by the request: a header or a query cannot lift it', async () => {
    const res = await withRoute(meta('/api/library'), empty, async () => ({
      status: 200,
      body: {},
    }))(untouchable())(
      new Request(`${ORIGIN}/api/library?maintenance=0`, {
        headers: { 'x-maintenance': '0', 'x-forwarded-host': 'healthz' },
      }),
    );
    expect(res.status).toBe(503);
  });

  it('without maintenance (false or undefined) nothing changes', async () => {
    const rig = await makeRig();
    for (const maintenance of [undefined, false]) {
      const deps: SecurityDeps =
        maintenance === undefined ? rig.deps : { ...rig.deps, maintenance };
      const res = await withRoute(meta('/api/library'), empty, async () => ({
        status: 200,
        body: { hi: 1 },
      }))(deps)(new Request(`${ORIGIN}/api/library`));
      expect(res.status).toBe(200);
    }
  });
});
