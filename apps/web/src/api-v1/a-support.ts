// Test support for the API-A suites (not a test, not imported by product code). One booted offline app
// (dry-run transport, nothing reaches the network), the seeded buyers and publishers as actors, a helper
// that issues a bearer key, and request builders for the /api/v1 routes and for the old session routes.
import { createSession, issueKey } from '@umsbx/security';
import type { Actor, Scope } from '@umsbx/contracts';
import { apiKeyDeps } from '../../composition.server';
import type { App } from '../../composition.server';
import { bootPackApp, buyer } from '../composite-support';
import { ORIGIN } from '../support';

export { ORIGIN };

export type Handler = (
  req: Request,
  call?: { params?: Record<string, string> | Promise<Record<string, string>> },
) => Promise<Response>;

export interface Sess {
  cookie: string;
  csrf: string;
}

export interface Req {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  /** Path and query, for example `/api/v1/orders?cursor=abc`. */
  url: string;
  body?: unknown;
  /** The Idempotency-Key header; omitted for a GET. `null` sends none on a change. */
  idem?: string | null;
  params?: Record<string, string>;
  headers?: Record<string, string>;
}

export interface ARig {
  app: App;
  buyerA: Actor;
  buyerB: Actor;
  harbour: Actor;
  quayside: Actor;
  operator: Actor;
  /** Issue an API key for an owner and return its token. */
  key(owner: Actor, scopes: readonly Scope[], kind?: 'api_client' | 'agent'): Promise<string>;
  /** A bearer request to a v1 route handler. */
  v1(handler: Handler, token: string | null, r: Req): Promise<Response>;
  /** A signed-in session for an old route. */
  session(actor: Actor): Promise<Sess>;
  /** A session request to an old route handler (cookie, CSRF, origin). */
  old(handler: Handler, s: Sess | null, r: Req): Promise<Response>;
}

let counter = 0;
export const idemKey = (): string => `a-test-idem-${String(++counter).padStart(6, '0')}-xyz`;

export async function bootA(over: Record<string, string> = {}): Promise<ARig> {
  const app = await bootPackApp(over);
  const pub = async (slug: string): Promise<Actor> => ({
    kind: 'publisher',
    publisher_id: (
      await app.db.query<{ id: string }>('SELECT id FROM publishers WHERE slug = $1', [slug])
    ).rows[0]!.id,
  });
  const rig: ARig = {
    app,
    buyerA: await buyer(app, 'a'),
    buyerB: await buyer(app, 'b'),
    harbour: await pub('harbour-ledger'),
    quayside: await pub('quayside-gazette'),
    operator: { kind: 'operator', operator_id: 'opr_a_test', mfa: true },
    async key(owner, scopes, kind = 'api_client') {
      if (owner.kind === 'system') throw new Error('system cannot own a key');
      const r = await issueKey(apiKeyDeps(app), { owner, key_kind: kind, scopes });
      if (!r.ok) throw new Error(`issue refused: ${r.error}`);
      return r.value.token;
    },
    v1(handler, token, r) {
      const method = r.method ?? 'GET';
      const headers: Record<string, string> = { ...(r.headers ?? {}) };
      if (token !== null) headers['authorization'] = `Bearer ${token}`;
      if (method !== 'GET' && r.idem !== null) headers['idempotency-key'] = r.idem ?? idemKey();
      const init: RequestInit = { method, headers };
      if (r.body !== undefined) {
        init.body = typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
        headers['content-type'] = 'application/json';
      }
      return handler(
        new Request(`${ORIGIN}${r.url}`, init),
        r.params !== undefined ? { params: r.params } : undefined,
      );
    },
    async session(actor) {
      const s = await createSession(app.security, actor);
      return { cookie: s.cookie.split(';')[0] ?? '', csrf: s.csrf_token };
    },
    old(handler, s, r) {
      const method = r.method ?? 'GET';
      const headers: Record<string, string> = { ...(r.headers ?? {}) };
      if (s !== null) headers['cookie'] = s.cookie;
      if (method !== 'GET') {
        headers['origin'] = ORIGIN;
        if (s !== null) headers['x-csrf-token'] = s.csrf;
        if (r.idem !== undefined && r.idem !== null) headers['idempotency-key'] = r.idem;
      }
      const init: RequestInit = { method, headers };
      if (r.body !== undefined) {
        init.body = JSON.stringify(r.body);
        headers['content-type'] = 'application/json';
      }
      return handler(
        new Request(`${ORIGIN}${r.url}`, init),
        r.params !== undefined ? { params: r.params } : undefined,
      );
    },
  };
  return rig;
}

export const json = async <T = Record<string, unknown>>(r: Response): Promise<T> =>
  (await r.json()) as T;

/** A body with every id-like string replaced, so two runs of one operation can be compared by shape. */
export function shape(v: unknown): unknown {
  if (typeof v === 'string')
    return /^(brf|quo|apr|prp|ord|ofr|ent|ses|key|lnk|umsC)_/.test(v) ||
      /^\d{4}-\d{2}-\d{2}T/.test(v) ||
      v.length > 60
      ? '<value>'
      : v;
  if (Array.isArray(v)) return v.map(shape);
  if (v !== null && typeof v === 'object')
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shape(x)]));
  return v;
}
