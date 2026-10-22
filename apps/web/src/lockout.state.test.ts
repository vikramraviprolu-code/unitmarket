// Gate review M3 through the real route: one anonymous client cannot lock the demo login for
// everyone, and UMS_TRUSTED_PROXIES reaches the security deps.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { App } from '../composition.server';
import { PASSCODE, bootTestApp, call, signIn } from './support';

vi.mock('server-only', () => ({}));

let app: App | null = null;
afterEach(async () => {
  await app?.close();
  app = null;
});

describe('demo login lockout (M3)', () => {
  it('five wrong passcodes with rotating X-Forwarded-For do not stop the right passcode', async () => {
    app = await bootTestApp();
    const route = await import('./app/api/session/route');
    for (let i = 1; i <= 6; i++) {
      const res = await call(route.POST, {
        url: '/api/session',
        method: 'POST',
        body: { persona: 'buyer-a', passcode: `wrong-${i}` },
        headers: { 'x-forwarded-for': `203.0.113.${i}` },
      });
      expect([401, 429]).toContain(res.status);
    }
    const wrongAgain = await call(route.POST, {
      url: '/api/session',
      method: 'POST',
      body: { persona: 'buyer-a', passcode: 'wrong-7' },
    });
    expect(wrongAgain.status).toBe(429);
    expect(await signIn(route.POST, 'buyer-a', PASSCODE)).not.toBeNull();
  });

  it('UMS_TRUSTED_PROXIES is passed to the security deps (default 0)', async () => {
    app = await bootTestApp();
    expect(app.security.trusted_proxies).toBe(0);
    await app.close();
    app = await bootTestApp({ UMS_TRUSTED_PROXIES: '2' });
    expect(app.security.trusted_proxies).toBe(2);
  });
});
