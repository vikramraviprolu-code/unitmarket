// CO-3: the raw-body option is narrow on purpose. It skips the JSON parse, so it may only be declared
// by the one public webhook route, with a limiter, and never together with a session, CSRF or
// idempotency. Anything else fails when the module loads.
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { DEFAULT_RATES } from './rate';
import { withRoute } from './route';
import type { RouteMeta } from './route';
import { ORIGIN, makeRig } from './test-support';

const good: RouteMeta = {
  path: '/api/webhooks/paypal',
  method: 'POST',
  auth: 'webhook',
  csrf: false,
  rate: DEFAULT_RATES.webhook_invalid,
  raw: true,
  max_body_bytes: 65_536,
  idempotent: false,
  risk: 'high',
};
const Input = z
  .object({ raw_body: z.string(), headers: z.record(z.string(), z.string()) })
  .strict();
const noop = async () => ({ status: 200 as const, body: {} });

describe('raw option declaration', () => {
  it('the webhook route as declared is accepted', () => {
    expect(() => withRoute(good, Input, noop)).not.toThrow();
  });

  it.each<[string, Partial<RouteMeta>]>([
    ['a buyer route', { auth: 'buyer', csrf: true }],
    ['a public route', { auth: 'public', csrf: true }],
    ['an operator route', { auth: 'operator', csrf: true }],
    ['a GET route', { method: 'GET' }],
    ['another path', { path: '/api/orders' }],
    ['a path that only starts like the webhook', { path: '/api/webhooks/paypal/extra' }],
    ['no limiter', { rate: null }],
    ['an actor limiter', { rate: { name: 'x', per: 'actor', limit: 5, window_ms: 1000 } }],
    ['csrf on', { csrf: true }],
    ['idempotent', { idempotent: true }],
  ])('raw is refused on %s', (_name, over) => {
    expect(() => withRoute({ ...good, ...over } as RouteMeta, Input, noop)).toThrow(/raw/);
  });

  it('raw false behaves as before: a JSON body is parsed and checked', async () => {
    const rig = await makeRig();
    const { raw: _raw, ...plain } = good;
    void _raw;
    const h = withRoute(
      { ...plain, path: '/api/webhooks/other' },
      z.object({ a: z.number() }).strict(),
      noop,
    );
    const res = await h(rig.deps)(
      new Request(`${ORIGIN}/api/webhooks/other`, { method: 'POST', body: 'not json' }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: { code: string } }).toMatchObject({
      error: { code: 'bad_request' },
    });
  });

  it('a raw handler whose schema does not take { raw_body, headers } answers 422 with an empty body', async () => {
    const rig = await makeRig();
    const h = withRoute(good, z.object({ other: z.string() }).strict(), noop);
    const res = await h(rig.deps)(
      new Request(`${ORIGIN}/api/webhooks/paypal`, { method: 'POST', body: '{}' }),
    );
    expect(res.status).toBe(422);
    expect(await res.text()).toBe('{}');
  });

  it('a session cookie or CSRF header on a raw route is ignored, not trusted', async () => {
    const rig = await makeRig();
    let actor = '';
    const h = withRoute(good, Input, async (ctx) => {
      actor = ctx.actor.kind;
      return { status: 200 as const, body: {} };
    });
    const res = await h(rig.deps)(
      new Request(`${ORIGIN}/api/webhooks/paypal`, {
        method: 'POST',
        body: '{}',
        headers: {
          cookie: '__Host-ums_session=ses_0123456789abcdefghjkmnpqrs.sig',
          origin: 'https://evil.example',
        },
      }),
    );
    expect(res.status).toBe(200);
    expect(actor).toBe('system');
    expect((await rig.db.query('SELECT 1 FROM sessions')).rows).toHaveLength(0);
  });

  it('a handler throw answers 500 with an empty body and no error text', async () => {
    const rig = await makeRig();
    const h = withRoute(good, Input, async () => {
      throw new Error('SECRET-DB-PASSWORD at /srv/app/db.ts:12');
    });
    const res = await h(rig.deps)(
      new Request(`${ORIGIN}/api/webhooks/paypal`, { method: 'POST', body: '{}' }),
    );
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).toBe('{}');
    expect(JSON.stringify(rig.log.events)).not.toContain('SECRET-DB-PASSWORD');
  });
});
