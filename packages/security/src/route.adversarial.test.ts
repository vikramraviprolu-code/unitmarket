import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { err, ok } from '@umsbx/contracts';
import { notFoundUnlessOwner } from './route';
import { withRoute, type RouteMeta } from './route';
import { createSession, resolveSession } from './session';
import { ORIGIN, cookiePair, makeRig, type TestRig } from './test-support';

const base: RouteMeta = {
  path: '/api/things',
  method: 'POST',
  auth: 'buyer',
  csrf: true,
  rate: null,
  max_body_bytes: 65_536,
  idempotent: false,
  risk: 'medium',
};
const schema = z.object({ title: z.string() }).strict();
const echo = withRoute(base, schema, async (ctx) => ({
  status: 200 as const,
  body: { title: ctx.input.title },
}));

async function login(rig: TestRig, id = 'buy_a') {
  const s = await createSession(rig.deps, { kind: 'buyer', buyer_id: id });
  return { cookie: cookiePair(s.cookie), csrf: s.csrf_token };
}
const post = (h: Record<string, string>, body: string = '{"title":"x"}') =>
  new Request(`${ORIGIN}/api/things`, { method: 'POST', headers: h, body });
const good = (u: { cookie: string; csrf: string }) => ({
  cookie: u.cookie,
  origin: ORIGIN,
  'x-csrf-token': u.csrf,
});

describe('route wrapper adversarial', () => {
  it('happy path works with all credentials', async () => {
    const rig = makeRig();
    const u = await login(rig);
    const res = await echo(rig.deps)(post(good(u)));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ title: 'x' });
    expect(res.headers.get('content-security-policy')).toMatch(/nonce-[0-9a-f]{32}/);
    expect(res.headers.get('x-request-id')).toMatch(/^[0-9a-f]{32}$/);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('no session gives 401', async () => {
    const rig = makeRig();
    const res = await echo(rig.deps)(post({ origin: ORIGIN }));
    expect(res.status).toBe(401);
  });

  it('a publisher session on a buyer route gives 403', async () => {
    const rig = makeRig();
    const s = await createSession(rig.deps, { kind: 'publisher', publisher_id: 'pub_a' });
    const res = await echo(rig.deps)(
      post({ cookie: cookiePair(s.cookie), origin: ORIGIN, 'x-csrf-token': s.csrf_token }),
    );
    expect(res.status).toBe(403);
  });

  it('buyer B on buyer A object gives 404', async () => {
    const rig = makeRig();
    const rows = new Map([['ord_1', { id: 'ord_1', buyer_id: 'buy_a', total: 5 }]]);
    const route = withRoute(
      { ...base, method: 'GET', csrf: false, path: '/api/orders/[id]' },
      z.object({ id: z.string() }).strict(),
      async (ctx) => {
        const r = notFoundUnlessOwner(rows.get(ctx.input.id) ?? null, ctx.actor);
        return r.ok
          ? { status: 200 as const, body: r.value }
          : { status: 404 as const, code: 'not_found', message: 'Not found.' };
      },
    );
    const a = await login(rig, 'buy_a');
    const b = await login(rig, 'buy_b');
    const get = (id: string, u: { cookie: string }) =>
      route(rig.deps)(
        new Request(`${ORIGIN}/api/orders/x?id=${id}`, { headers: { cookie: u.cookie } }),
      );
    const own = await get('ord_1', a);
    expect(own.status).toBe(200);
    const foreign = await get('ord_1', b);
    const missing = await get('ord_missing', b);
    expect(foreign.status).toBe(404);
    const strip = async (r: Response) => (await r.text()).replace(/E-[0-9a-f]{8}/, 'E-x');
    expect(await strip(foreign)).toBe(await strip(missing)); // no existence oracle (support code differs per request)
  });

  it('notFoundUnlessOwner is a Result and rejects non-buyers', () => {
    const row = { buyer_id: 'buy_a' };
    expect(notFoundUnlessOwner(row, { kind: 'buyer', buyer_id: 'buy_a' })).toEqual(ok(row));
    expect(notFoundUnlessOwner(row, { kind: 'buyer', buyer_id: 'buy_b' })).toEqual(
      err('not_found'),
    );
    expect(notFoundUnlessOwner(row, { kind: 'publisher', publisher_id: 'buy_a' })).toEqual(
      err('not_found'),
    );
    expect(notFoundUnlessOwner(row, { kind: 'system' })).toEqual(err('not_found'));
    expect(notFoundUnlessOwner(null, { kind: 'buyer', buyer_id: 'buy_a' })).toEqual(
      err('not_found'),
    );
  });

  it('POST without Origin or with a foreign Origin gives 403', async () => {
    const rig = makeRig();
    const u = await login(rig);
    const noOrigin = await echo(rig.deps)(post({ cookie: u.cookie, 'x-csrf-token': u.csrf }));
    expect(noOrigin.status).toBe(403);
    for (const o of [
      'https://evil.example',
      `${ORIGIN}.evil.example`,
      'null',
      'http://sandbox.example.test',
    ]) {
      const res = await echo(rig.deps)(post({ ...good(u), origin: o }));
      expect(res.status).toBe(403);
    }
  });

  it('missing or wrong csrf token gives 403', async () => {
    const rig = makeRig();
    const u = await login(rig);
    expect((await echo(rig.deps)(post({ cookie: u.cookie, origin: ORIGIN }))).status).toBe(403);
    expect(
      (
        await echo(rig.deps)(
          post({ cookie: u.cookie, origin: ORIGIN, 'x-csrf-token': 'f'.repeat(32) }),
        )
      ).status,
    ).toBe(403);
    const other = await login(rig, 'buy_b');
    expect(
      (await echo(rig.deps)(post({ cookie: u.cookie, origin: ORIGIN, 'x-csrf-token': other.csrf })))
        .status,
    ).toBe(403);
  });

  it('extra JSON field gives 422 with field names only', async () => {
    const rig = makeRig();
    const u = await login(rig);
    const res = await echo(rig.deps)(
      post(good(u), '{"title":"x","buyer_id":"buy_b","is_admin":true}'),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { fields: string[] } };
    expect(body.error.fields).toEqual(expect.arrayContaining(['buyer_id', 'is_admin']));
    expect(JSON.stringify(body)).not.toContain('"buy_b"');
    const wrongType = await echo(rig.deps)(post(good(u), '{"title":123}'));
    expect(wrongType.status).toBe(422);
    expect((await echo(rig.deps)(post(good(u), '{not json'))).status).toBe(400);
  });

  it('65 KB body gives 413', async () => {
    const rig = makeRig();
    const u = await login(rig);
    const big = JSON.stringify({ title: 'a'.repeat(65 * 1024) });
    const res = await echo(rig.deps)(post(good(u), big));
    expect(res.status).toBe(413);
    // a lying content-length is also caught while reading
    const sneaky = await echo(rig.deps)(post({ ...good(u), 'content-length': '10' }, big));
    expect(sneaky.status).toBe(413);
  });

  it('handler throw returns a generic body without the error text', async () => {
    const rig = makeRig();
    const boom = withRoute(base, schema, async () => {
      throw new Error('SECRET-DB-PASSWORD at /srv/app/db.ts:12');
    });
    const u = await login(rig);
    const res = await boom(rig.deps)(post(good(u)));
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toContain('SECRET');
    expect(text).not.toContain('/srv/app');
    expect(text).not.toContain('stack');
    expect(JSON.parse(text).error.support_code).toMatch(/^E-[0-9a-f]{8}$/);
    expect(JSON.stringify(rig.log.events)).not.toContain('SECRET-DB-PASSWORD');
  });

  it('malformed cookie never throws', async () => {
    const rig = makeRig();
    const weird = [
      '',
      ';;;',
      '=',
      '__Host-ums_s',
      '__Host-ums_s=',
      '__Host-ums_s=%E0%A4%A',
      '__Host-ums_s=' + 'a'.repeat(100_000),
      '__Host-ums_s=ses_x.y',
      '__Host-ums_s=\u0000',
      'a=b; __Host-ums_s=ses_' + '0'.repeat(26) + '.' + 'A'.repeat(43),
    ];
    for (const c of weird) {
      await expect(resolveSession(rig.deps, c)).resolves.toBeNull();
    }
    await expect(resolveSession(rig.deps, null)).resolves.toBeNull();
    const res = await echo(rig.deps)(post({ cookie: weird[6] ?? '', origin: ORIGIN }));
    expect(res.status).toBe(401);
  });

  it('a handler cannot override security headers and a 303 must stay on this site', async () => {
    const rig = makeRig();
    const u = await login(rig);
    const sneaky = withRoute(base, schema, async () => ({
      status: 200 as const,
      body: {},
      headers: { 'Content-Security-Policy': 'default-src *', 'X-Test': 'ok' },
    }));
    const res = await sneaky(rig.deps)(post(good(u)));
    expect(res.headers.get('content-security-policy')).not.toBe('default-src *');
    expect(res.headers.get('x-test')).toBe('ok');
    for (const loc of [
      'https://evil.example/',
      '//evil.example',
      '/\\evil.example',
      'javascript:alert(1)',
    ]) {
      const r = withRoute(base, schema, async () => ({ status: 303 as const, location: loc }));
      expect((await r(rig.deps)(post(good(u)))).status).toBe(500);
    }
    const okRedirect = withRoute(base, schema, async () => ({
      status: 303 as const,
      location: '/library',
    }));
    const rr = await okRedirect(rig.deps)(post(good(u)));
    expect(rr.status).toBe(303);
    expect(rr.headers.get('location')).toBe('/library');
  });

  it('a route cannot be declared without csrf on POST, or idempotent without a session', () => {
    const noop = async () => ({ status: 200 as const, body: {} });
    expect(() => withRoute({ ...base, csrf: false }, schema, noop)).toThrow();
    expect(() => withRoute({ ...base, auth: 'public', idempotent: true }, schema, noop)).toThrow();
    expect(() => withRoute({ ...base, max_body_bytes: 0 }, schema, noop)).toThrow();
    expect(() => withRoute({ ...base, max_body_bytes: 10_000_000 }, schema, noop)).toThrow();
    expect(() => withRoute({ ...base, path: 'no-slash' }, schema, noop)).toThrow();
    expect(() => withRoute({ ...base, auth: 'webhook', csrf: false }, schema, noop)).not.toThrow();
  });

  it('operator without mfa may read but not write (MVP-A)', async () => {
    const rig = makeRig();
    const s = await createSession(rig.deps, { kind: 'operator', operator_id: 'op_1', mfa: false });
    const h = { cookie: cookiePair(s.cookie), origin: ORIGIN, 'x-csrf-token': s.csrf_token };
    const write = withRoute({ ...base, auth: 'operator' }, schema, async () => ({
      status: 200 as const,
      body: {},
    }));
    expect((await write(rig.deps)(post(h))).status).toBe(403);
    const read = withRoute(
      { ...base, auth: 'operator', method: 'GET', csrf: false },
      z.object({}).strict(),
      async (ctx) => ({
        status: 200 as const,
        body: { kind: ctx.actor.kind },
      }),
    );
    const res = await read(rig.deps)(
      new Request(`${ORIGIN}/api/things`, { headers: { cookie: h.cookie } }),
    );
    expect(res.status).toBe(200);
  });

  it('wrong method on the route gives 404', async () => {
    const rig = makeRig();
    const u = await login(rig);
    const res = await echo(rig.deps)(
      new Request(`${ORIGIN}/api/things`, { method: 'GET', headers: { cookie: u.cookie } }),
    );
    expect(res.status).toBe(404);
  });
});
