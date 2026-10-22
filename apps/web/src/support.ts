// Test helper (lane 15). Builds an isolated offline app from an explicit environment object, so no
// test reads process.env. Passcode and secrets are fictional test values.
import { hashPasscode } from '@umsbx/security';
import { createApp, installApp } from '../composition.server';
import type { App } from '../composition.server';

export const PASSCODE = 'sandbox passcode for tests';
const SALT = '00112233445566778899aabbccddeeff';

// Low-entropy placeholders, built at runtime: a plain sentence that is not repeated characters (config rejects those), distinct per secret.
const dummy = (c: string): string => `${c}-synthetic-test-value-not-a-credential-${c}`;

export async function testEnv(over: Record<string, string> = {}): Promise<Record<string, string>> {
  return {
    UMS_MODE: 'offline',
    UMS_SESSION_SECRET: dummy('s'),
    UMS_APPROVAL_SECRET: dummy('a'),
    UMS_LINK_SECRET: dummy('l'),
    UMS_DEMO_PASSCODE_HASH: await hashPasscode(PASSCODE, SALT),
    UMS_PUBLIC_ORIGIN: 'http://localhost:3000',
    NODE_ENV: 'test',
    ...over,
  };
}

export async function bootTestApp(over: Record<string, string> = {}): Promise<App> {
  const app = createApp(await testEnv(over), { switch_cache_ms: 0 });
  installApp(app);
  await app.ready();
  return app;
}

export const ORIGIN = 'http://localhost:3000';

export interface Session {
  cookie: string;
  csrf: string;
}

export function call(
  handler: (req: Request, ctx?: { params: Promise<Record<string, string>> }) => Promise<Response>,
  o: {
    url: string;
    method?: 'GET' | 'POST';
    body?: unknown;
    session?: Session | null;
    params?: Record<string, string>;
    headers?: Record<string, string>;
    csrf?: boolean;
  },
): Promise<Response> {
  const headers: Record<string, string> = { ...(o.headers ?? {}) };
  if ((o.method ?? 'GET') === 'POST') {
    headers['origin'] = ORIGIN;
    headers['content-type'] = 'application/json';
  }
  if (o.session) {
    headers['cookie'] = o.session.cookie;
    if (o.csrf !== false && (o.method ?? 'GET') === 'POST')
      headers['x-csrf-token'] = o.session.csrf;
  }
  const init: RequestInit = { method: o.method ?? 'GET', headers };
  if (o.body !== undefined) init.body = JSON.stringify(o.body);
  return handler(new Request(`${ORIGIN}${o.url}`, init), {
    params: Promise.resolve(o.params ?? {}),
  });
}

export async function signIn(
  post: (req: Request, ctx?: { params: Promise<Record<string, string>> }) => Promise<Response>,
  persona: string,
  passcode = PASSCODE,
): Promise<Session | null> {
  const res = await call(post, {
    url: '/api/session',
    method: 'POST',
    body: { persona, passcode },
  });
  if (res.status !== 200) return null;
  const set = res.headers.get('set-cookie') ?? '';
  const body = (await res.json()) as { csrf_token: string };
  return { cookie: set.split(';')[0] ?? '', csrf: body.csrf_token };
}
