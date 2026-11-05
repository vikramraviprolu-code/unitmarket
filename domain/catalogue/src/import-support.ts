// Test helper only (never exported from index.ts): a scripted web for the web import tests (POB-I1), the
// fixture shop pages and a world with the seeded publishers. Nothing here opens a socket: the "fetcher"
// answers from a map of address to page and keeps a log of every call, so a test can say exactly which
// addresses were asked for and with which allow list.
import type { Database } from '@umsbx/contracts';
import { offersWorld } from './write-support';
import type { OffersWorld } from './write-support';
import { ZERO_FEE_POLICY } from './import-fee';
import type { ImportFeePolicy } from './import-fee';
import { checkDomain, requestDomain } from './domain-proof';
import type { ImportDeps, ImportFetcherPort, ImportFetchOutcome } from './import-types';

export const SHOP_HOST = 'shop.pub-one.invalid';
export const SHOP = `https://${SHOP_HOST}`;
export const SOURCE_URL = `${SHOP}/catalogue`;
export const WELL_KNOWN_URL = `${SHOP}/.well-known/unitmarket-verify.txt`;

/** Reads a fixture of ../test-data as text. Only a *.test.ts file may use node:fs, so the tests pass this in. */
export type FixtureReader = (name: string) => string;

/** Smallest byte strings that carry the signature of each allowed picture type. */
export const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 1, 2, 3,
]);
export const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1]);
export const WEBP = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 4, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20,
]);

export interface ScriptedPage {
  /** Default: text/html for a text call, image/png for an image call. */
  content_type?: string;
  body?: string;
  bytes?: Uint8Array;
  /** Answer with this refusal word instead of a page. */
  refuse?: string;
}
export interface ScriptedCall {
  url: string;
  allow: string[];
  kind: 'text' | 'image';
}
export interface ScriptedWeb extends ImportFetcherPort {
  pages: Record<string, ScriptedPage>;
  calls: ScriptedCall[];
  /**
   * Runs before each answer (the call has been logged); a test may move the clock or read the database. `n` counts
   * the calls made since the hook was set: the first call after it is 1.
   */
  hook: ((n: number, url: string) => Promise<void> | void) | null;
}

export function scriptedWeb(pages: Record<string, ScriptedPage> = {}): ScriptedWeb {
  let hook: ScriptedWeb['hook'] = null;
  let hookBase = 0;
  const web: ScriptedWeb = {
    pages,
    calls: [],
    get hook() {
      return hook;
    },
    set hook(fn) {
      hook = fn;
      hookBase = web.calls.length;
    },
    async fetch(url, o): Promise<ImportFetchOutcome> {
      const kind = o.kind ?? 'text';
      web.calls.push({ url, allow: [...o.allow], kind });
      if (hook !== null) await hook(web.calls.length - hookBase, url);
      let host: string;
      try {
        host = new URL(url).hostname;
      } catch {
        return { ok: false, reason: 'bad_url' };
      }
      if (!o.allow.includes(host)) return { ok: false, reason: 'host_not_allowed' };
      const page = web.pages[url];
      if (page === undefined) return { ok: false, reason: 'bad_status' };
      if (page.refuse !== undefined) return { ok: false, reason: page.refuse };
      const bytes = page.bytes ?? new TextEncoder().encode(page.body ?? '');
      return {
        ok: true,
        body: kind === 'image' ? '' : (page.body ?? ''),
        bytes,
        content_type: page.content_type ?? (kind === 'image' ? 'image/png' : 'text/html'),
        host,
      };
    },
  };
  return web;
}

/** The front page of a site whose owner placed the proof tag. */
export const homeWithToken = (token: string, host = SHOP_HOST): string =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${host}</title>` +
  `<meta name="unitmarket-verify" content="${token}"></head><body><h1>Home</h1></body></html>`;

/** The pages of the fixture shop (no proof yet: a test adds it after asking for a token). */
export function shopPages(fixture: FixtureReader): Record<string, ScriptedPage> {
  return {
    [SOURCE_URL]: {
      content_type: 'text/html; charset=utf-8',
      body: fixture('web-shop-jsonld.page'),
    },
    [`${SHOP}/img/chart.png`]: { content_type: 'image/png', bytes: PNG },
    [`${SHOP}/img/knots.jpg`]: { content_type: 'image/jpeg', bytes: JPEG },
    [`${SHOP}/a/quay-walk`]: { body: fixture('web-item-article.page') },
    [`${SHOP}/p/chart-page`]: { body: fixture('web-item-og-product.page') },
    [`${SHOP}/feed.xml`]: {
      content_type: 'application/rss+xml',
      body: fixture('web-shop.rss.xml'),
    },
    [`${SHOP}/sitemap.xml`]: {
      content_type: 'application/xml',
      body: fixture('web-shop-sitemap.xml'),
    },
    [`${SHOP}/hostile`]: { body: fixture('web-hostile.page') },
    [`${SHOP}/plain`]: {
      body: '<html><head><title>Plain</title></head><body><p>Hi</p></body></html>',
    },
  };
}

export interface ImportWorld extends OffersWorld {
  web: ScriptedWeb;
  /** The may-fetch check: switch it off, or make it throw, to see the run stop. */
  may: { on: boolean; throws: boolean; asked: number };
  /** The fee policy the deps carry; a test may replace it. */
  fee: { policy: ImportFeePolicy };
  /** Dependencies of the web import; `over` replaces any field. */
  idep(over?: Partial<ImportDeps>): ImportDeps;
}

export async function importWorld(pages: Record<string, ScriptedPage>): Promise<ImportWorld> {
  const base = await offersWorld();
  const web = scriptedWeb(pages);
  const may = { on: true, throws: false, asked: 0 };
  const fee = { policy: ZERO_FEE_POLICY as ImportFeePolicy };
  const w: ImportWorld = {
    ...base,
    web,
    may,
    fee,
    idep: (over = {}) => ({
      ...base.deps(),
      fetcher: web,
      mayFetch: async () => {
        may.asked += 1;
        if (may.throws) throw new Error('switch unreadable');
        return may.on;
      },
      get fee() {
        return fee.policy;
      },
      ...over,
    }),
  };
  return w;
}

export const countOf = async (db: Database, sql: string, params: unknown[] = []): Promise<number> =>
  Number((await db.query<{ c: string | number }>(sql, params)).rows[0]?.c ?? 0);

export interface ItemRow {
  id: string;
  source_key: string;
  kind: string;
  title: string;
  summary: string;
  language: string;
  topics: string[];
  price_minor: number | null;
  source_price_minor: number | null;
  currency: string | null;
  image_ref: string | null;
  content_ref: string | null;
  content_sha256: string | null;
  content_mime: string | null;
  content_bytes: number | null;
  state: string;
  reason: string | null;
  article_id: string | null;
  offer_id: string | null;
}
export async function itemRows(db: Database, batch_id?: string): Promise<ItemRow[]> {
  const { rows } = await db.query<Record<string, unknown>>(
    `SELECT id, source_key, kind, title, summary, language, topics, price_minor, source_price_minor, currency,
            image_ref, content_ref, content_sha256, content_mime, content_bytes, state, reason, article_id, offer_id
       FROM import_items ${batch_id === undefined ? '' : 'WHERE batch_id = $1'} ORDER BY created_at, source_key, id`,
    batch_id === undefined ? [] : [batch_id],
  );
  return rows.map((r) => ({
    ...(r as unknown as ItemRow),
    price_minor: r.price_minor == null ? null : Number(r.price_minor),
    source_price_minor: r.source_price_minor == null ? null : Number(r.source_price_minor),
    content_bytes: r.content_bytes == null ? null : Number(r.content_bytes),
  }));
}
export const byKey = (rows: ItemRow[], tail: string): ItemRow => {
  const r = rows.find((x) => x.source_key.endsWith(tail));
  if (r === undefined) throw new Error(`no item ending in ${tail}`);
  return r;
};

export async function batchRow(
  db: Database,
  id: string,
): Promise<{
  state: string;
  note: string | null;
  total: number;
  done: number;
  refused: number;
  existing: number;
  changed: number;
  attested_at: unknown;
}> {
  const r = (
    await db.query<Record<string, unknown>>(
      'SELECT state, note, total, done, refused, existing, changed, attested_at FROM import_batches WHERE id = $1',
      [id],
    )
  ).rows[0]!;
  return {
    state: r.state as string,
    note: (r.note as string | null) ?? null,
    total: Number(r.total),
    done: Number(r.done),
    refused: Number(r.refused),
    existing: Number(r.existing),
    changed: Number(r.changed),
    attested_at: r.attested_at,
  };
}

export const auditRows = async (
  db: Database,
  like: string,
): Promise<
  {
    action: string;
    target: string | null;
    reason: string | null;
    detail: Record<string, unknown>;
    actor_kind: string;
  }[]
> =>
  (
    await db.query<{
      action: string;
      target: string | null;
      reason: string | null;
      detail: unknown;
      actor_kind: string;
    }>(
      'SELECT action, target, reason, detail, actor_kind FROM audit_log WHERE action LIKE $1 ORDER BY created_at, id',
      [like],
    )
  ).rows.map((r) => ({
    ...r,
    detail: (typeof r.detail === 'string' ? JSON.parse(r.detail) : r.detail) as Record<
      string,
      unknown
    >,
  }));

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * A publisher asks for the domain, the site shows the token on the front page, the check passes. Returns
 * the token. The scripted web is changed in place (the front page now carries the tag) and its call log is
 * cleared, so a test sees only the calls it makes itself.
 */
export async function verifyShop(
  w: ImportWorld,
  actor: OffersWorld['harbour'] = w.harbour,
  host = SHOP_HOST,
): Promise<string> {
  const asked = await requestDomain(w.idep(), actor, { host });
  if (!asked.ok || asked.value.token === null) throw new Error('requestDomain refused in a helper');
  const token = asked.value.token;
  w.web.pages[`https://${host}/`] = { body: homeWithToken(token, host) };
  const checked = await checkDomain(w.idep(), actor, { host });
  if (!checked.ok) throw new Error(`checkDomain refused in a helper: ${checked.error.code}`);
  w.web.calls.length = 0;
  return token;
}
