// POB-I1 (D-089, journey J7 to J9) through a booted offline app: a publisher proves a domain, starts an
// import (the route is named `begin`), watches the progress, reviews and edits the staged list, and publishes.
// The fetcher is a scripted web (AppOptions.test_import_fetcher): no socket is opened. The fee is the
// injected ImportFeePolicy (AppOptions.import_fee), none by default. The pages are .tsx files the unit
// runner does not compile, so their source is read as text.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  JPEG,
  PNG,
  SHOP,
  SHOP_HOST,
  SOURCE_URL,
  WELL_KNOWN_URL,
  bootImportWorld,
  fakeWeb,
  homeWithToken,
  shopPages,
  verifyShopOverHttp,
  waitForBatch,
} from './web-import-support';
import type { ImportWebWorld } from './web-import-support';
import * as copy from './lib/web-import-copy';

vi.mock('server-only', () => ({}));

const worlds: ImportWebWorld[] = [];
const data = (name: string): string =>
  readFileSync(new URL(`../../../domain/catalogue/test-data/${name}`, import.meta.url), 'utf8');
const boot = async (
  o: Partial<Parameters<typeof bootImportWorld>[0]> = {},
): Promise<ImportWebWorld> => {
  const w = await bootImportWorld({ web: fakeWeb(shopPages(data)), ...o });
  worlds.push(w);
  return w;
};
afterEach(async () => {
  for (const w of worlds.splice(0)) await w.app.close();
});
const here = new URL('.', import.meta.url).pathname;
const harbour = (w: ImportWebWorld) => w.pub['harbour-ledger'];
const json = async <T = Record<string, unknown>>(r: Response): Promise<T> => (await r.json()) as T;
interface Item {
  id: string;
  source_key: string;
  title: string;
  price_minor: number | null;
  fee_minor: number | null;
  buyer_price_minor: number | null;
  state: string;
  reason: string | null;
  kind: string;
}
interface Status {
  batch: {
    id: string;
    state: string;
    total: number;
    done: number;
    refused: number;
    note: string | null;
  };
  items: Item[];
  environment: string;
}
async function begun(w: ImportWebWorld): Promise<string> {
  await verifyShopOverHttp(w);
  const r = await w.post('begin', harbour(w), { source_url: SOURCE_URL });
  expect(r.status).toBe(200);
  return (await json<{ batch_id: string }>(r)).batch_id;
}
async function ran(w: ImportWebWorld): Promise<{ id: string; status: Status }> {
  const id = await begun(w);
  expect(await w.app.engine.webImport.runPending()).toEqual({ ran: 1 });
  const s = await w.get(`?batch=${id}`, harbour(w));
  expect(s.status).toBe(200);
  return { id, status: await json<Status>(s) };
}

describe('the route files', () => {
  const routes = ['domains', 'domains/check', 'begin', 'status', 'items', 'publish'];
  it.each(routes)(
    'api/publisher/import/%s/route.ts exists, publisher only, csrf on every POST',
    (r) => {
      const f = join(here, 'app/api/publisher/import', r, 'route.ts');
      expect(existsSync(f)).toBe(true);
      const src = readFileSync(f, 'utf8');
      expect(src).toMatch(/auth: 'publisher'/);
      expect(src).toMatch(/\.strict\(\)/);
      if (src.includes("method: 'POST'")) expect(src).toMatch(/csrf: true/);
      expect(src).not.toMatch(/publisher_id|actor\.publisher/);
    },
  );
  it('the start route is named begin', () => {
    expect(existsSync(join(here, 'app/api/publisher/import/begin/route.ts'))).toBe(true);
    expect(existsSync(join(here, 'app/api/publisher/import/start'))).toBe(false);
  });
});

describe('the whole path over the routes (J7 to J9)', () => {
  it('domain, begin, run, review, edit, hide, publish: the items end up for sale', async () => {
    const w = await boot();
    // J7: prove the domain
    const a = await w.post('domains', harbour(w), { host: SHOP_HOST });
    expect(a.status).toBe(200);
    const asked = await json<{ host: string; state: string; token: string }>(a);
    expect(asked).toMatchObject({
      host: SHOP_HOST,
      state: 'pending',
      token: expect.stringMatching(/^umv-[0-9a-f]{32}$/),
    });
    w.web.pages[`${SHOP}/`] = { body: homeWithToken(asked.token) };
    const c = await w.post('check', harbour(w), { host: SHOP_HOST });
    expect(c.status).toBe(200);
    expect(await json(c)).toEqual({ host: SHOP_HOST, state: 'verified' });
    // begin: queued, nothing fetched but the proof
    const b = await w.post('begin', harbour(w), { source_url: SOURCE_URL });
    expect(b.status).toBe(200);
    const id = (await json<{ batch_id: string }>(b)).batch_id;
    const queued = await json<Status>(await w.get(`?batch=${id}`, harbour(w)));
    expect(queued.batch.state).toBe('queued');
    expect(queued.items).toEqual([]);
    // the background run
    expect(await w.app.engine.webImport.runPending()).toEqual({ ran: 1 });
    // J8: review
    const s = await json<Status>(await w.get(`?batch=${id}`, harbour(w)));
    expect(s.batch).toMatchObject({ state: 'done', total: 6, done: 6, refused: 2 });
    expect(s.environment).toBe('dryrun');
    expect(s.items).toHaveLength(6);
    const tides = s.items.find((i) => i.source_key.endsWith('/a/tides'))!;
    // POB-G: the review shows the fee in force (10 percent, seeded by the fee lane), no longer a zero default
    expect(tides).toMatchObject({
      price_minor: 150,
      fee_minor: 15,
      buyer_price_minor: 165,
      state: 'staged',
    });
    // edit and hide in one call
    const ferry = s.items.find((i) => i.source_key.endsWith('/a/ferry'))!;
    const e = await w.post('items', harbour(w), {
      item_id: ferry.id,
      title: 'Ferry times',
      price_minor: 300,
    });
    expect(e.status).toBe(200);
    expect((await json<{ item: Item }>(e)).item).toMatchObject({
      title: 'Ferry times',
      price_minor: 300,
    });
    const h = await w.post('items', harbour(w), { item_id: tides.id, hidden: true });
    expect(h.status).toBe(200);
    // J9: publish
    const p = await w.post('publish', harbour(w), { batch_id: id, attestation: true });
    expect(p.status).toBe(200);
    expect(await json(p)).toEqual({ published: 2, needs_price: 1, bad_price: 0, failed: 0 });
    const live = await w.app.db.query<{ title: string; status: string }>(
      `SELECT a.title, o.status FROM offers o JOIN articles a ON a.id = o.article_id WHERE a.created_by LIKE 'web_import:%' ORDER BY a.title`,
    );
    expect(live.rows).toEqual([
      { title: 'Ferry times', status: 'authorised' },
      { title: 'Harbour chart print', status: 'authorised' },
    ]);
    const after = await json<Status>(await w.get(`?batch=${id}`, harbour(w)));
    expect(after.items.find((i) => i.id === tides.id)!.state).toBe('hidden');
    expect(after.items.find((i) => i.id === ferry.id)!.state).toBe('published');
  });

  it('the status without a batch lists the own batches', async () => {
    const w = await boot();
    const id = await begun(w);
    const r = await w.get('', harbour(w));
    expect(r.status).toBe(200);
    expect((await json<{ batches: { id: string; state: string }[] }>(r)).batches).toEqual([
      expect.objectContaining({ id, state: 'queued' }),
    ]);
    const other = await w.get('', w.pub['quayside-gazette']);
    expect((await json<{ batches: unknown[] }>(other)).batches).toEqual([]);
  });

  it('the job loop runs a begun import without any other call (background run, progress in the batch)', async () => {
    const w = await boot();
    const jobs = await w.app.startJobs();
    try {
      const id = await begun(w);
      expect(await waitForBatch(w.app, id)).toBe('done');
      const s = await json<Status>(await w.get(`?batch=${id}`, harbour(w)));
      expect(s.batch).toMatchObject({ state: 'done', total: 6, done: 6, refused: 2 });
    } finally {
      await jobs.stop();
    }
  });
});

describe('the fee port is wired through AppOptions.import_fee', () => {
  it('POB-G: the default is the fee in force (10 percent, seeded): the buyer price is the publisher price plus it', async () => {
    const w = await boot();
    const { status } = await ran(w);
    const priced = status.items.filter((x) => x.price_minor !== null);
    expect(priced.length).toBeGreaterThan(0);
    for (const i of priced) {
      expect(i.fee_minor).toBe(Math.round(i.price_minor! * 0.1));
      expect(i.buyer_price_minor).toBe(i.price_minor! + i.fee_minor!);
    }
    expect(status.items.find((i) => i.source_key.endsWith('/a/tides'))).toMatchObject({
      fee_minor: 15,
      buyer_price_minor: 165,
    });
  });
  it('POB-G: a changed setting shows at the next review, with no restart', async () => {
    const w = await boot();
    const { id } = await ran(w);
    const set = await w.app.engine.opsFee.set({
      actor: { kind: 'operator', operator_id: 'opr_vikram', mfa: true },
      fee_bps: 500,
      reason: 'Test of the import review',
    });
    expect(set.ok).toBe(true);
    const s = await json<Status>(await w.get(`?batch=${id}`, harbour(w)));
    expect(s.items.find((i) => i.source_key.endsWith('/a/tides'))).toMatchObject({
      fee_minor: 8,
      buyer_price_minor: 158,
    });
  });
  it('an injected policy adds its fee on top of the publisher price', async () => {
    const asked: [number, string][] = [];
    const w = await boot({
      fee: (m, c) => {
        asked.push([m, c]);
        return Math.round(m * 0.1);
      },
    });
    const { status } = await ran(w);
    const tides = status.items.find((i) => i.source_key.endsWith('/a/tides'))!;
    expect(tides).toMatchObject({ price_minor: 150, fee_minor: 15, buyer_price_minor: 165 });
    expect(asked).toContainEqual([150, 'USD']);
  });
  it('a policy that fails shows no buyer price and does not break the page', async () => {
    const w = await boot({
      fee: () => {
        throw new Error('down');
      },
    });
    const { status } = await ran(w);
    expect(status.items.every((i) => i.buyer_price_minor === null)).toBe(true);
    expect(status.items.find((i) => i.source_key.endsWith('/a/tides'))!.price_minor).toBe(150);
  });
});

describe('answers for the review findings', () => {
  it('proof_lost: begin answers 409 with plain words, writes no batch and fetches no item', async () => {
    const w = await boot();
    await verifyShopOverHttp(w);
    w.web.pages[`${SHOP}/`] = { body: '<html><head></head><body>gone</body></html>' };
    w.web.pages[WELL_KNOWN_URL] = { refuse: 'bad_status' };
    const r = await w.post('begin', harbour(w), { source_url: SOURCE_URL });
    expect(r.status).toBe(409);
    const body = (await json<{ error: { code: string; message: string } }>(r)).error;
    expect(body.code).toBe('proof_lost');
    expect(body.message).toBe(copy.importErrorText('proof_lost'));
    expect((await w.app.db.query('SELECT 1 FROM import_batches')).rows).toEqual([]);
    expect(w.web.calls.some((c) => c.url === SOURCE_URL)).toBe(false);
    const audit = await w.app.db.query<{ action: string }>(
      `SELECT action FROM audit_log WHERE action LIKE 'import.%'`,
    );
    expect(audit.rows.map((x) => x.action)).toEqual(['import.proof_failed']);
  });

  it('a verified domain that now resolves to a private address: 409 proof_lost', async () => {
    const w = await boot();
    await verifyShopOverHttp(w);
    w.web.pages[`${SHOP}/`] = { refuse: 'private_address' };
    w.web.pages[WELL_KNOWN_URL] = { refuse: 'private_address' };
    expect((await w.post('begin', harbour(w), { source_url: SOURCE_URL })).status).toBe(409);
  });

  it('the web_import_enabled switch is the may-fetch check (WEB-IMPORT-SW): off, begin answers 409 paused and nothing is fetched', async () => {
    const w = await boot();
    await verifyShopOverHttp(w);
    await w.app.db.query(
      `UPDATE safety_switches SET "on" = false WHERE name = 'web_import_enabled'`,
    );
    const r = await w.post('begin', harbour(w), { source_url: SOURCE_URL });
    expect(r.status).toBe(409);
    expect((await json<{ error: { code: string } }>(r)).error.code).toBe('paused');
    expect(w.web.calls).toHaveLength(0);
    // a domain that is still pending cannot be checked while paused (a verified one needs no fetch)
    await w.post('domains', harbour(w), { host: 'other.pub-one.invalid' });
    const c = await w.post('check', harbour(w), { host: 'other.pub-one.invalid' });
    expect(c.status).toBe(409);
    expect(w.web.calls).toHaveLength(0);
  });

  it('a switch turned off while a batch is queued ends its run as interrupted (paused), with nothing fetched', async () => {
    const w = await boot();
    const id = await begun(w);
    await w.app.db.query(
      `UPDATE safety_switches SET "on" = false WHERE name = 'web_import_enabled'`,
    );
    w.web.calls.length = 0;
    await w.app.engine.webImport.runPending();
    expect(w.web.calls).toHaveLength(0);
    const row = (
      await w.app.db.query<{ state: string; note: string }>(
        'SELECT state, note FROM import_batches WHERE id = $1',
        [id],
      )
    ).rows[0]!;
    expect(row).toEqual({ state: 'interrupted', note: 'paused' });
  });

  it('with no fetcher the feature is off: every import route answers 503 import_off, nothing is written', async () => {
    const w = await boot({ web: null });
    const a = await w.post('domains', harbour(w), { host: SHOP_HOST });
    expect(a.status).toBe(200); // asking for a token is harmless
    const c = await w.post('check', harbour(w), { host: SHOP_HOST });
    expect(c.status).toBe(503);
    expect((await json<{ error: { code: string } }>(c)).error.code).toBe('import_off');
    await w.app.db.query(
      `UPDATE publisher_domains SET state = 'verified', verified_at = created_at`,
    );
    const b = await w.post('begin', harbour(w), { source_url: SOURCE_URL });
    expect(b.status).toBe(503);
    expect((await w.app.db.query('SELECT 1 FROM import_batches')).rows).toEqual([]);
  });

  it('a queued batch left from before a restart is marked interrupted when the jobs start', async () => {
    const w = await boot();
    await verifyShopOverHttp(w);
    await w.app.db.query(
      `INSERT INTO import_batches (id, publisher_id, source_host, source_url, state, total, done, refused, existing, changed, created_by, created_at, updated_at)
       VALUES ('imb_before_restart', $1, $2, $3, 'running', 4, 1, 0, 0, 0, $1, now(), now())`,
      [w.pubId['harbour-ledger'], SHOP_HOST, SOURCE_URL],
    );
    const jobs = await w.app.startJobs();
    try {
      const row = (
        await w.app.db.query<{ state: string; note: string }>(
          `SELECT state, note FROM import_batches WHERE id = 'imb_before_restart'`,
        )
      ).rows[0]!;
      expect(row).toEqual({ state: 'interrupted', note: 'restart' });
    } finally {
      await jobs.stop();
    }
  });
});

describe('refusals at the door', () => {
  it('every route needs a publisher session: nobody, a buyer and an operator are turned away', async () => {
    const w = await boot();
    const buyer = w.refund.A;
    const op = w.refund.op;
    for (const route of ['domains', 'check', 'begin', 'items', 'publish'] as const) {
      const body = {
        host: SHOP_HOST,
        source_url: SOURCE_URL,
        item_id: 'imi_x',
        title: 'x',
        batch_id: 'imb_x',
        attestation: true,
      };
      const pick = (): unknown =>
        route === 'domains' || route === 'check'
          ? { host: body.host }
          : route === 'begin'
            ? { source_url: body.source_url }
            : route === 'items'
              ? { item_id: body.item_id, title: body.title }
              : { batch_id: body.batch_id, attestation: true };
      expect([401, 403]).toContain((await w.post(route, null, pick())).status);
      expect([401, 403]).toContain((await w.post(route, buyer, pick())).status);
      expect([401, 403]).toContain((await w.post(route, op, pick())).status);
    }
    expect([401, 403]).toContain((await w.get('', null)).status);
    expect([401, 403]).toContain((await w.get('', buyer)).status);
    expect(w.web.calls).toHaveLength(0);
  });

  it('a POST without the CSRF token is refused and does nothing', async () => {
    const w = await boot();
    const r = await w.post('domains', harbour(w), { host: SHOP_HOST }, { csrf: false });
    expect(r.status).toBe(403);
    expect((await w.app.db.query('SELECT 1 FROM publisher_domains')).rows).toEqual([]);
  });

  it('the body has only the named fields: a publisher id, a state, a currency or a content ref is refused', async () => {
    const w = await boot();
    const id = await begun(w);
    await w.app.engine.webImport.runPending();
    const s = await json<Status>(await w.get(`?batch=${id}`, harbour(w)));
    const t = s.items.find((i) => i.source_key.endsWith('/a/tides'))!;
    for (const extra of [
      { publisher_id: w.pubId['quayside-gazette'] },
      { state: 'published' },
      { currency: 'EUR' },
      { content_ref: 'x' },
      { article_id: 'art_x' },
    ]) {
      const r = await w.post('items', harbour(w), { item_id: t.id, title: 'x', ...extra });
      expect(r.status).toBe(422);
    }
    expect(
      (await w.post('begin', harbour(w), { source_url: SOURCE_URL, host: 'other.invalid' })).status,
    ).toBe(422);
    expect(
      (await w.post('publish', harbour(w), { batch_id: id, attestation: true, price: 1 })).status,
    ).toBe(422);
    expect(
      (await w.post('domains', harbour(w), { host: SHOP_HOST, publisher_id: 'x' })).status,
    ).toBe(422);
    const unchanged = await json<Status>(await w.get(`?batch=${id}`, harbour(w)));
    expect(unchanged.items.find((i) => i.id === t.id)!.title).toBe('Tide notes for winter');
  });

  it('a body that is not what the field says is 400: wrong types, huge text, no attestation field', async () => {
    const w = await boot();
    await verifyShopOverHttp(w);
    expect((await w.post('begin', harbour(w), { source_url: 5 })).status).toBe(422);
    // 3000 characters are over the 2560 byte body cap of the route: refused before the shape is read.
    expect((await w.post('begin', harbour(w), { source_url: 'x'.repeat(3000) })).status).toBe(413);
    expect((await w.post('begin', harbour(w), { source_url: 'x'.repeat(2100) })).status).toBe(422);
    expect((await w.post('domains', harbour(w), { host: ['a'] })).status).toBe(422);
    expect((await w.post('publish', harbour(w), { batch_id: 'imb_x' })).status).toBe(422);
    expect(
      (await w.post('publish', harbour(w), { batch_id: 'imb_x', attestation: 'yes' })).status,
    ).toBe(422);
    expect((await w.post('items', harbour(w), { item_id: 'imi_x' })).status).toBe(422);
  });

  it('a domain that is not verified, and an address that is not https, are refused with a fixed answer and no fetch', async () => {
    const w = await boot();
    await verifyShopOverHttp(w);
    const a = await w.post('begin', harbour(w), {
      source_url: 'https://elsewhere.invalid/catalogue',
    });
    expect(a.status).toBe(403);
    expect((await json<{ error: { code: string } }>(a)).error.code).toBe('domain_not_verified');
    const b = await w.post('begin', harbour(w), {
      source_url: 'http://shop.pub-one.invalid/catalogue',
    });
    expect(b.status).toBe(422);
    expect((await json<{ error: { code: string } }>(b)).error.code).toBe('invalid_address');
    const c = await w.post('begin', harbour(w), {
      source_url: 'https://169.254.169.254/computeMetadata/v1/',
    });
    expect(c.status).toBe(422);
    expect(w.web.calls).toHaveLength(0);
  });

  it('one import at a time: a second begin is 409 import_active', async () => {
    const w = await boot();
    await begun(w);
    const r = await w.post('begin', harbour(w), { source_url: SOURCE_URL });
    expect(r.status).toBe(409);
    expect((await json<{ error: { code: string } }>(r)).error.code).toBe('import_active');
  });

  it('another publisher gets 404 for my batch and for my item, the same as for an id that does not exist', async () => {
    const w = await boot();
    const id = await begun(w);
    await w.app.engine.webImport.runPending();
    const s = await json<Status>(await w.get(`?batch=${id}`, harbour(w)));
    const t = s.items[0]!;
    const q = w.pub['quayside-gazette'];
    expect((await w.get(`?batch=${id}`, q)).status).toBe(404);
    expect((await w.get('?batch=imb_nothing', q)).status).toBe(404);
    expect((await w.post('items', q, { item_id: t.id, title: 'x' })).status).toBe(404);
    expect((await w.post('items', q, { item_id: 'imi_nothing', title: 'x' })).status).toBe(404);
    expect((await w.post('publish', q, { batch_id: id, attestation: true })).status).toBe(404);
  });

  it('publish without the tick is 422 attestation_required and writes nothing; once ticked, it is not asked again', async () => {
    const w = await boot();
    const id = await begun(w);
    await w.app.engine.webImport.runPending();
    const before = (await w.app.db.query('SELECT 1 FROM articles')).rows.length;
    const r = await w.post('publish', harbour(w), { batch_id: id, attestation: false });
    expect(r.status).toBe(422);
    expect((await json<{ error: { code: string } }>(r)).error.code).toBe('attestation_required');
    expect((await w.app.db.query('SELECT 1 FROM articles')).rows.length).toBe(before);
    const ok = await w.post('publish', harbour(w), {
      batch_id: id,
      attestation: true,
      item_ids: [],
    });
    expect(ok.status).toBe(200);
    expect(await json(ok)).toEqual({ published: 0, needs_price: 0, bad_price: 0, failed: 0 });
    const again = await w.post('publish', harbour(w), { batch_id: id, attestation: false });
    expect(again.status).toBe(200);
    expect((await json<{ published: number }>(again)).published).toBe(2);
  });
});

describe('what the answers say', () => {
  it('no answer carries a token, a hash, a content reference, an address or a path from the server', async () => {
    const w = await boot();
    const { status } = await ran(w);
    const text = JSON.stringify(status);
    expect(text).not.toMatch(/umv-|token|content_ref|import\/harbour|sha256|127\.0\.0\.1|169\.254/);
    expect(Object.keys(status.items[0]!).sort()).toEqual(
      [
        'article_id',
        'buyer_price_minor',
        'content_bytes',
        'currency',
        'fee_minor',
        'has_image',
        'id',
        'kind',
        'language',
        'offer_id',
        'price_minor',
        'reason',
        'source_key',
        'state',
        'summary',
        'title',
        'topics',
      ].sort(),
    );
  });

  it('error texts are plain sentences: no italics, no dashes, no markup, one for every code', () => {
    const codes = [
      'not_publisher',
      'publisher_not_active',
      'invalid_input',
      'invalid_host',
      'invalid_address',
      'host_taken',
      'too_many_domains',
      'domain_not_verified',
      'proof_missing',
      'proof_refused',
      'proof_lost',
      'import_off',
      'paused',
      'import_active',
      'no_corridor',
      'not_found',
      'not_editable',
      'invalid_title',
      'invalid_price',
      'attestation_required',
      'batch_not_ready',
      'fee_unavailable',
    ];
    for (const code of codes) {
      const t = copy.importErrorText(code);
      expect(t, code).toMatch(/^[A-Z][^<>*_]*[.]$/);
      expect(t, code).not.toMatch(/[—–‒―]| - |--/);
      expect(t.length, code).toBeLessThan(200);
    }
    expect(copy.importErrorText('something_new')).toBe(copy.importErrorText('invalid_input'));
    // POB-G: a fee that cannot be read has its own words and answers 503 (try again later), not the general 422
    expect(copy.importErrorText('fee_unavailable')).not.toBe(copy.importErrorText('invalid_input'));
    expect(copy.importStatusOf('fee_unavailable')).toBe(503);
  });

  it('every exported string of the copy file follows the rules (D-051)', () => {
    const strings: string[] = [];
    const walk = (v: unknown): void => {
      if (typeof v === 'string') strings.push(v);
      else if (v !== null && typeof v === 'object') for (const x of Object.values(v)) walk(x);
    };
    walk(copy);
    expect(strings.length).toBeGreaterThan(20);
    for (const s of strings) {
      expect(s).not.toMatch(/[—–‒―]/);
      expect(s).not.toMatch(/ - /);
      expect(s).not.toMatch(/<\/?(i|em)>/i);
    }
  });

  it('the batch states and the refusal reasons have words, and the words come from one place', () => {
    for (const s of ['queued', 'running', 'done', 'failed', 'interrupted'])
      expect(copy.batchStateText(s)).toMatch(/^[A-Z]/);
    for (const r of [
      'no_text',
      'no_image',
      'image_off_host',
      'image_failed',
      'bad_image',
      'too_large',
    ])
      expect(copy.itemReasonText(r), r).toMatch(/[.]$/);
    for (const n of [
      'deadline',
      'paused',
      'restart',
      'check_failed',
      'no_structured_data',
      'unsupported_type',
      'too_many_items',
      'continues',
      'private_address',
    ])
      expect(copy.batchNoteText(n), n).toMatch(/[.]$/);
  });

  it('D-051: the verb follows the count in the progress line', () => {
    expect(copy.progressText(1, 1, 0)).toBe('1 of 1 item is done.');
    expect(copy.progressText(2, 6, 0)).toBe('2 of 6 items are done.');
    expect(copy.progressText(6, 6, 2)).toBe('6 of 6 items are done. 2 were refused.');
    expect(copy.progressText(1, 4, 1)).toBe('1 of 4 items is done. 1 was refused.');
  });
});

describe('the pages (source read as text)', () => {
  const dir = join(here, 'app/publisher/import');
  const files = (d: string): string[] =>
    existsSync(d)
      ? readdirSync(d).flatMap((n) =>
          statSync(join(d, n)).isDirectory() ? files(join(d, n)) : [join(d, n)],
        )
      : [];
  it('a start page and a review page exist', () => {
    expect(existsSync(join(dir, 'page.tsx'))).toBe(true);
    expect(files(dir).some((f) => /\[batch\][\\/]page\.tsx$/.test(f))).toBe(true);
  });
  it('no raw HTML, no italics, no dashes in the words, labels from the stored environment only', () => {
    for (const f of files(dir).filter((x) => x.endsWith('.tsx'))) {
      const src = readFileSync(f, 'utf8');
      expect(src, f).not.toMatch(/dangerouslySetInnerHTML|innerHTML/);
      expect(src, f).not.toMatch(/<i>|<em>|fontStyle|font-style/);
      expect(src, f).not.toMatch(/>\s*(Sandbox|Dry run|Dry-run)\s*</);
      expect(src, f).not.toMatch(/[—–]/);
    }
  });
  it('the review page does not import the engine, only the composition and the copy file', () => {
    for (const f of files(dir).filter((x) => x.endsWith('page.tsx'))) {
      const src = readFileSync(f, 'utf8');
      expect(src, f).not.toMatch(/@umsbx\/(catalogue|db|transport|payments)/);
    }
  });
});

describe('the fixture shop pages are what the tests think they are', () => {
  it('has the source page, two pictures and a feed', () => {
    const p = shopPages(data);
    expect(Object.keys(p)).toEqual(
      expect.arrayContaining([SOURCE_URL, `${SHOP}/img/chart.png`, `${SHOP}/feed.xml`]),
    );
    expect(PNG[0]).toBe(0x89);
    expect(JPEG[0]).toBe(0xff);
    expect(fakeWeb({}).calls).toEqual([]);
  });
});
