// Test helper (ID-ACCOUNTS). An offline app with a trusted proxy count of 1 (so a test chooses the client
// address with X-Forwarded-For), plus calls for the four account routes. Passwords here are fictional.
import { createSession } from '@umsbx/security';
import type { Actor } from '@umsbx/contracts';
import { createApp, installApp } from '../composition.server';
import type { App, AppOptions } from '../composition.server';
import { ORIGIN, testEnv } from './support';

export const PW = 'violet lamps hum softly';
export const PW2 = 'seven quiet harbours';

export interface AccountsWorld {
  app: App;
  signup: typeof import('./app/api/accounts/route');
  login: typeof import('./app/api/accounts/login/route');
  password: typeof import('./app/api/accounts/password/route');
  revokeAll: typeof import('./app/api/accounts/sessions/revoke-all/route');
  library: typeof import('./app/api/library/route');
  session: typeof import('./app/api/session/route');
  logs: string[];
}

export async function bootAccounts(
  over: Record<string, string> = { UMS_TRUSTED_PROXIES: '1' },
  opts: AppOptions = {},
): Promise<AccountsWorld> {
  const logs: string[] = [];
  const app = createApp(await testEnv(over), {
    switch_cache_ms: 0,
    log_sink: (l) => logs.push(l),
    ...opts,
  });
  installApp(app);
  await app.ready();
  return {
    app,
    logs,
    signup: await import('./app/api/accounts/route'),
    login: await import('./app/api/accounts/login/route'),
    password: await import('./app/api/accounts/password/route'),
    revokeAll: await import('./app/api/accounts/sessions/revoke-all/route'),
    library: await import('./app/api/library/route'),
    session: await import('./app/api/session/route'),
  };
}

type Handler = (
  req: Request,
  ctx?: { params: Promise<Record<string, string>> },
) => Promise<Response>;

export interface PostOpts {
  ip?: string;
  cookie?: string;
  csrf?: string;
  origin?: string | null;
  headers?: Record<string, string>;
  raw?: string;
}

let addr = 0;
export const freshIp = (): string => {
  addr += 1;
  return `198.51.${String(100 + Math.floor(addr / 250))}.${String(addr % 250)}`;
};

export function post(handler: Handler, path: string, body: unknown, o: PostOpts = {}): Promise<Response> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-forwarded-for': o.ip ?? freshIp(),
    ...(o.headers ?? {}),
  };
  if (o.origin !== null) headers['origin'] = o.origin ?? ORIGIN;
  if (o.cookie !== undefined) headers['cookie'] = o.cookie;
  if (o.csrf !== undefined) headers['x-csrf-token'] = o.csrf;
  return handler(
    new Request(`${ORIGIN}${path}`, {
      method: 'POST',
      headers,
      body: o.raw ?? JSON.stringify(body),
    }),
    { params: Promise.resolve({}) },
  );
}

export interface Got {
  status: number;
  json: Record<string, unknown>;
  text: string;
  cookie: string | null;
  setCookie: string;
  csrf: string | null;
  retryAfter: string | null;
}

export async function got(res: Response): Promise<Got> {
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    /* an empty body */
  }
  const setCookie = res.headers.get('set-cookie') ?? '';
  return {
    status: res.status,
    json,
    text,
    cookie: setCookie.includes('=') && !/Max-Age=0/.test(setCookie) ? (setCookie.split(';')[0] ?? null) : null,
    setCookie,
    csrf: typeof json['csrf_token'] === 'string' ? json['csrf_token'] : null,
    retryAfter: res.headers.get('retry-after'),
  };
}

export const errorOf = (g: Got): { code: string; message: string } => {
  const e = (g.json['error'] ?? {}) as { code?: string; message?: string };
  return { code: e.code ?? '', message: e.message ?? '' };
};

/** The body of a refusal with the per request support code removed, so two refusals can be compared. */
export const bodyShape = (g: Got): string =>
  JSON.stringify(g.json, (k, v: unknown) => (k === 'support_code' ? 'E-x' : v));

let seq = 0;
export const newName = (): string => {
  seq += 1;
  return `reader.${String(seq)}`;
};

export const signupBody = (o: Record<string, unknown> = {}): Record<string, unknown> => ({
  display_name: 'Test Reader',
  username: newName(),
  country: 'GB',
  password: PW,
  accept_terms: true,
  extra_k7q: '',
  ...o,
});

export async function newAccount(w: AccountsWorld, o: Record<string, unknown> = {}) {
  const body = signupBody(o);
  const g = await got(await post(w.signup.POST, '/api/accounts', body));
  if (g.status !== 200 || g.cookie === null || g.csrf === null) throw new Error(`signup failed ${String(g.status)} ${g.text}`);
  return { username: body['username'] as string, password: body['password'] as string, cookie: g.cookie, csrf: g.csrf };
}

export async function operatorCookie(app: App, mfa = true): Promise<{ cookie: string; csrf: string }> {
  const s = await createSession(app.security, { kind: 'operator', operator_id: 'opr_vikram', mfa } as Actor);
  return { cookie: s.cookie.split(';')[0] ?? '', csrf: s.csrf_token };
}
