// POB-I1 test helper: a booted offline app whose web import fetcher is a scripted web (no socket), a
// publisher session per seeded publisher, and call helpers for the import routes. The fixture pages are
// read from the catalogue package's test-data folder as text. Nothing here reads the environment.
import { createSession } from '@umsbx/security';
import type { Actor } from '@umsbx/contracts';
import type { App } from '../composition.server';
import { bootRefundWorld } from './refund-support';
import type { RefundWorld } from './refund-support';
import { call } from './support';
import type { Session } from './support';

type Handler = (
  req: Request,
  ctx?: { params: Promise<Record<string, string>> },
) => Promise<Response>;

export const SHOP_HOST = 'shop.pub-one.invalid';
export const SHOP = `https://${SHOP_HOST}`;
export const SOURCE_URL = `${SHOP}/catalogue`;
export const WELL_KNOWN_URL = `${SHOP}/.well-known/unitmarket-verify.txt`;

/** Reads a fixture of domain/catalogue/test-data as text. Only a *.test.ts file may use node:fs: the test passes this in. */
export type FixtureReader = (name: string) => string;

export const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 1, 2, 3,
]);
export const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1]);

export interface Page {
  content_type?: string;
  body?: string;
  bytes?: Uint8Array;
  refuse?: string;
}
export interface Call {
  url: string;
  allow: string[];
  kind: 'text' | 'image';
}
export interface FakeWeb {
  pages: Record<string, Page>;
  calls: Call[];
  fetch(
    url: string,
    o: { allow: readonly string[]; kind?: 'text' | 'image' },
  ): Promise<
    | { ok: true; body: string; bytes: Uint8Array; content_type: string; host: string }
    | { ok: false; reason: string }
  >;
}

export function shopPages(data: FixtureReader): Record<string, Page> {
  return {
    [SOURCE_URL]: { content_type: 'text/html; charset=utf-8', body: data('web-shop-jsonld.page') },
    [`${SHOP}/img/chart.png`]: { content_type: 'image/png', bytes: PNG },
    [`${SHOP}/img/knots.jpg`]: { content_type: 'image/jpeg', bytes: JPEG },
    [`${SHOP}/a/quay-walk`]: { body: data('web-item-article.page') },
    [`${SHOP}/feed.xml`]: { content_type: 'application/rss+xml', body: data('web-shop.rss.xml') },
    [`${SHOP}/plain`]: {
      body: '<html><head><title>Plain</title></head><body><p>Hi</p></body></html>',
    },
  };
}

export function fakeWeb(pages: Record<string, Page>): FakeWeb {
  const web: FakeWeb = {
    pages,
    calls: [],
    async fetch(url, o) {
      const kind = o.kind ?? 'text';
      web.calls.push({ url, allow: [...o.allow], kind });
      let host: string;
      try {
        host = new URL(url).hostname;
      } catch {
        return { ok: false, reason: 'bad_url' };
      }
      if (!o.allow.includes(host)) return { ok: false, reason: 'host_not_allowed' };
      const p = web.pages[url];
      if (p === undefined) return { ok: false, reason: 'bad_status' };
      if (p.refuse !== undefined) return { ok: false, reason: p.refuse };
      return {
        ok: true,
        body: kind === 'image' ? '' : (p.body ?? ''),
        bytes: p.bytes ?? new TextEncoder().encode(p.body ?? ''),
        content_type: p.content_type ?? (kind === 'image' ? 'image/png' : 'text/html'),
        host,
      };
    },
  };
  return web;
}

export const homeWithToken = (token: string): string =>
  `<!doctype html><html><head><meta charset="utf-8"><title>Shop</title>` +
  `<meta name="unitmarket-verify" content="${token}"></head><body><h1>Home</h1></body></html>`;

const SLUGS = ['harbour-ledger', 'quayside-gazette'] as const;
type Slug = (typeof SLUGS)[number];

export interface ImportWebWorld {
  refund: RefundWorld;
  app: App;
  web: FakeWeb;
  pub: Record<Slug, Session>;
  pubId: Record<Slug, string>;
  actor: Record<Slug, Actor>;
  routes: {
    domains: Handler;
    check: Handler;
    begin: Handler;
    status: Handler;
    items: Handler;
    publish: Handler;
  };
  post: (
    route: keyof ImportWebWorld['routes'],
    session: Session | null,
    body: unknown,
    o?: { csrf?: boolean },
  ) => Promise<Response>;
  get: (query: string, session: Session | null) => Promise<Response>;
}

export async function bootImportWorld(o: {
  /** The scripted web, or null for the feature off. Required: the fixtures are read by the test. */
  web: FakeWeb | null;
  fee?: (m: number, c: string) => number;
  env?: Record<string, string>;
}): Promise<ImportWebWorld> {
  const web = o.web === null ? null : o.web;
  const refund = await bootRefundWorld(o.env ?? {}, {
    ...(web === null ? {} : { test_import_fetcher: web }),
    ...(o.fee === undefined ? {} : { import_fee: { feeFor: o.fee } }),
  });
  const pub = {} as ImportWebWorld['pub'];
  const pubId = {} as ImportWebWorld['pubId'];
  const actor = {} as ImportWebWorld['actor'];
  for (const slug of SLUGS) {
    const id = (
      await refund.app.db.query<{ id: string }>('SELECT id FROM publishers WHERE slug = $1', [slug])
    ).rows[0]!.id;
    actor[slug] = { kind: 'publisher', publisher_id: id };
    const s = await createSession(refund.app.security, actor[slug]);
    pub[slug] = { cookie: s.cookie.split(';')[0] ?? '', csrf: s.csrf_token };
    pubId[slug] = id;
  }
  const routes = {
    domains: (await import('./app/api/publisher/import/domains/route')).POST as Handler,
    check: (await import('./app/api/publisher/import/domains/check/route')).POST as Handler,
    begin: (await import('./app/api/publisher/import/begin/route')).POST as Handler,
    status: (await import('./app/api/publisher/import/status/route')).GET as Handler,
    items: (await import('./app/api/publisher/import/items/route')).POST as Handler,
    publish: (await import('./app/api/publisher/import/publish/route')).POST as Handler,
  };
  const urls = {
    domains: '/api/publisher/import/domains',
    check: '/api/publisher/import/domains/check',
    begin: '/api/publisher/import/begin',
    status: '/api/publisher/import/status',
    items: '/api/publisher/import/items',
    publish: '/api/publisher/import/publish',
  } as const;
  return {
    refund,
    app: refund.app,
    web: web ?? fakeWeb({}),
    pub,
    pubId,
    actor,
    routes,
    post: (route, session, body, opt = {}) =>
      call(routes[route], {
        url: urls[route],
        method: 'POST',
        body,
        session,
        ...(opt.csrf === undefined ? {} : { csrf: opt.csrf }),
      }),
    get: (query, session) => call(routes.status, { url: `${urls.status}${query}`, session }),
  };
}

/** Domain request, token on the front page, check: the publisher's shop is verified. Returns the token. */
export async function verifyShopOverHttp(
  w: ImportWebWorld,
  who: Slug = 'harbour-ledger',
): Promise<string> {
  const a = await w.post('domains', w.pub[who], { host: SHOP_HOST });
  if (a.status !== 200) throw new Error(`domains answered ${String(a.status)}`);
  const { token } = (await a.json()) as { token: string };
  w.web.pages[`${SHOP}/`] = { body: homeWithToken(token) };
  const c = await w.post('check', w.pub[who], { host: SHOP_HOST });
  if (c.status !== 200) throw new Error(`check answered ${String(c.status)}`);
  w.web.calls.length = 0;
  return token;
}

/** Waits (real time, short polls) until the batch has ended, for tests that let the job loop run it. */
export async function waitForBatch(app: App, id: string, polls = 250): Promise<string> {
  let state = 'missing';
  for (let n = 0; n < polls; n += 1) {
    const r = await app.db.query<{ state: string }>(
      'SELECT state FROM import_batches WHERE id = $1',
      [id],
    );
    state = r.rows[0]?.state ?? 'missing';
    if (state !== 'queued' && state !== 'running') return state;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  return `timeout:${state}`;
}
