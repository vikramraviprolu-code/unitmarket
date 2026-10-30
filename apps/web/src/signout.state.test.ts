// FIX-FLOW D1 and D11 (docs/specs/fix-flow-gate12.md): sign out ends the one session of the cookie and
// clears it; the header shows only the items of the signed in role. Offline app, synthetic values.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { App } from '../composition.server';
import { ORIGIN, bootTestApp, call, signIn } from './support';
import { SIGN_OUT_LABEL, navItems } from './lib/nav';

vi.mock('server-only', () => ({}));

let app: App;
let sessionRoute: typeof import('./app/api/session/route');
let signout: typeof import('./app/api/session/signout/route');
let library: typeof import('./app/api/library/route');

beforeAll(async () => {
  app = await bootTestApp();
  sessionRoute = await import('./app/api/session/route');
  signout = await import('./app/api/session/signout/route');
  library = await import('./app/api/library/route');
});
afterAll(async () => {
  await app.close();
});

describe('POST /api/session/signout', () => {
  it('declares itself: public, CSRF Origin check, ip limiter, small body, low risk', () => {
    expect(signout.routeMeta).toMatchObject({
      path: '/api/session/signout',
      method: 'POST',
      auth: 'public',
      csrf: true,
      risk: 'low',
    });
    expect(signout.routeMeta.rate?.per).toBe('ip');
  });

  it('ends this session only, clears the cookie, and the library then answers 401', async () => {
    const one = (await signIn(sessionRoute.POST, 'buyer-a'))!;
    const two = (await signIn(sessionRoute.POST, 'buyer-a'))!;
    expect((await call(library.GET, { url: '/api/library', session: one })).status).toBe(200);
    const res = await call(signout.POST, {
      url: '/api/session/signout',
      method: 'POST',
      body: {},
      session: one,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie') ?? '').toMatch(/Max-Age=0/);
    expect((await call(library.GET, { url: '/api/library', session: one })).status).toBe(401);
    // Personas are shared: another session of the same persona stays signed in.
    expect((await call(library.GET, { url: '/api/library', session: two })).status).toBe(200);
  });

  it('with no session it still answers 200 and clears the cookie; a foreign Origin is refused', async () => {
    const res = await call(signout.POST, { url: '/api/session/signout', method: 'POST', body: {} });
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie') ?? '').toMatch(/Max-Age=0/);
    const bad = await signout.POST(
      new Request(`${ORIGIN}/api/session/signout`, {
        method: 'POST',
        headers: { origin: 'https://elsewhere.example', 'content-type': 'application/json' },
        body: '{}',
      }),
    );
    expect(bad.status).toBe(403);
  });
});

describe('header items per role (D11)', () => {
  const labels = (k: Parameters<typeof navItems>[0]) => navItems(k).items.map((i) => i.label);
  it('signed out: find, help, sign in; no sign out', () => {
    expect(labels(null)).toEqual(['Find articles', 'Help', 'Sign in']);
    expect(navItems(null).sign_out).toBe(false);
  });
  it('buyer: find, library, help, sign out', () => {
    expect(labels('buyer')).toEqual(['Find articles', 'My library', 'Help']);
    expect(navItems('buyer').sign_out).toBe(true);
  });
  it('publisher: publisher, help, sign out; never Find articles', () => {
    expect(labels('publisher')).toEqual(['Publisher', 'Help']);
    expect(navItems('publisher').sign_out).toBe(true);
  });
  it('operator: operations, help, sign out; never Find articles', () => {
    expect(labels('operator')).toEqual(['Operations', 'Help']);
    expect(navItems('operator').sign_out).toBe(true);
  });
  it('the label has no dash', () => {
    expect(SIGN_OUT_LABEL).toBe('Sign out');
  });
});
