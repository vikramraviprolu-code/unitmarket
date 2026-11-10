// DOMAIN-PROOF-2 (D-116) through a booted offline app: the permanent code over the routes, the operator vouch and
// removal routes (second factor, reason, audit), the import-start words, and the page sources. Scripted web, no socket.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSession } from '@umsbx/security';
import {
  SHOP,
  SHOP_HOST,
  SOURCE_URL,
  WELL_KNOWN_URL,
  bootImportWorld,
  fakeWeb,
  homeWithToken,
  shopPages,
} from './web-import-support';
import type { ImportWebWorld } from './web-import-support';
import { call } from './support';
import type { Session } from './support';
import * as copy from './lib/web-import-copy';
import * as opsCopy from './lib/ops-publishers-copy';

vi.mock('server-only', () => ({}));
type Handler = (
  req: Request,
  ctx?: { params: Promise<Record<string, string>> },
) => Promise<Response>;

const worlds: ImportWebWorld[] = [];
const data = (name: string): string =>
  readFileSync(new URL(`../../../domain/catalogue/test-data/${name}`, import.meta.url), 'utf8');
const boot = async (): Promise<ImportWebWorld> => {
  const w = await bootImportWorld({ web: fakeWeb(shopPages(data)) });
  worlds.push(w);
  return w;
};
afterEach(async () => {
  for (const w of worlds.splice(0)) await w.app.close();
});
const here = new URL('.', import.meta.url).pathname;
const read = (rel: string): string => readFileSync(join(here, rel), 'utf8');
const json = async <T = Record<string, unknown>>(r: Response): Promise<T> => (await r.json()) as T;
const harbour = (w: ImportWebWorld) => w.pub['harbour-ledger'];

const URLS = {
  remove: '/api/publisher/import/domains/remove',
  vouch: '/api/ops/publishers/domains/vouch',
  opsRemove: '/api/ops/publishers/domains/remove',
} as const;
async function handlers() {
  return {
    remove: (await import('./app/api/publisher/import/domains/remove/route')).POST as Handler,
    vouch: (await import('./app/api/ops/publishers/domains/vouch/route')).POST as Handler,
    opsRemove: (await import('./app/api/ops/publishers/domains/remove/route')).POST as Handler,
  };
}
async function plainOperator(w: ImportWebWorld): Promise<Session> {
  const s = await createSession(w.app.security, {
    kind: 'operator',
    operator_id: 'opr_plain',
    mfa: false,
  });
  return { cookie: s.cookie.split(';')[0] ?? '', csrf: s.csrf_token };
}
async function pendingId(w: ImportWebWorld): Promise<string> {
  expect((await w.post('domains', harbour(w), { host: SHOP_HOST })).status).toBe(200);
  return (
    await w.app.db.query<{ id: string }>('SELECT id FROM publisher_domains WHERE host = $1', [
      SHOP_HOST,
    ])
  ).rows[0]!.id;
}

describe('the route files', () => {
  it.each([
    ['api/publisher/import/domains/remove', 'publisher'],
    ['api/ops/publishers/domains/vouch', 'operator'],
    ['api/ops/publishers/domains/remove', 'operator'],
  ])('%s exists, %s only, csrf, strict body', (r, role) => {
    const f = `app/${r}/route.ts`;
    expect(existsSync(join(here, f))).toBe(true);
    const src = read(f);
    expect(src).toContain(`auth: '${role}'`);
    expect(src).toMatch(/csrf: true/);
    expect(src).toMatch(/\.strict\(\)/);
    if (role === 'publisher') expect(src).not.toMatch(/publisher_id|actor\.publisher/);
  });
});

describe('A. the permanent code over the routes and the engine', () => {
  it('two addresses answer the same code, and the engine shows it again at any time', async () => {
    const w = await boot();
    const a = await json<{ token: string }>(
      await w.post('domains', harbour(w), { host: SHOP_HOST }),
    );
    const b = await json<{ token: string }>(
      await w.post('domains', harbour(w), { host: 'second.pub-one.invalid' }),
    );
    expect(b.token).toBe(a.token);
    expect(await w.app.engine.webImport.proofCode(w.actor['harbour-ledger'])).toEqual({
      code: a.token,
    });
    expect(await w.app.engine.webImport.proofCode(w.actor['quayside-gazette'])).not.toEqual({
      code: a.token,
    });
  });

  it('the page source shows the code with the one-time instruction', () => {
    expect(copy.CODE_INSTRUCTION).toBe('Put this code once on each of your sites');
    const src = read('app/publisher/import/page.tsx');
    expect(src).toContain('proofCode');
    expect(src).toContain('CODE_INSTRUCTION');
    expect(src).toContain('DOMAIN_VERIFIED_BY_US');
    expect(copy.DOMAIN_VERIFIED_BY_US).toBe('Verified by UnitMarket');
  });
});

describe('B. the operator vouch routes', () => {
  const body = (id: string, reason = 'Checked on a call') => ({ domain_id: id, reason });

  it('a publisher session is refused, a plain operator gets 403 mfa_required, no reason is 422', async () => {
    const w = await boot();
    const h = await handlers();
    const id = await pendingId(w);
    const pub = await call(h.vouch, {
      url: URLS.vouch,
      method: 'POST',
      body: body(id),
      session: harbour(w),
    });
    expect(pub.status).toBe(403);
    const plain = await call(h.vouch, {
      url: URLS.vouch,
      method: 'POST',
      body: body(id),
      session: await plainOperator(w),
    });
    expect(plain.status).toBe(403);
    expect((await json<{ error: { code: string } }>(plain)).error.code).toBe('mfa_required');
    const short = await call(h.vouch, {
      url: URLS.vouch,
      method: 'POST',
      body: body(id, 'ab'),
      session: w.refund.op,
    });
    expect(short.status).toBe(422);
    const state = await w.app.db.query<{ state: string }>(
      'SELECT state FROM publisher_domains WHERE id = $1',
      [id],
    );
    expect(state.rows[0]!.state).toBe('pending');
  });

  it('an operator with the code vouches; begin then needs no code on the site; the publisher sees operator', async () => {
    const w = await boot();
    const h = await handlers();
    const id = await pendingId(w);
    const res = await call(h.vouch, {
      url: URLS.vouch,
      method: 'POST',
      body: body(id),
      session: w.refund.op,
    });
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ host: SHOP_HOST, state: 'verified' });
    const audit = await w.app.db.query<{ action: string; reason: string }>(
      "SELECT action, reason FROM audit_log WHERE action = 'domain.vouched'",
    );
    expect(audit.rows).toEqual([{ action: 'domain.vouched', reason: 'Checked on a call' }]);
    w.web.calls.length = 0;
    const b = await w.post('begin', harbour(w), { source_url: SOURCE_URL });
    expect(b.status).toBe(200);
    expect(w.web.calls).toEqual([]);
    const listed = await w.app.engine.webImport.domains(w.actor['harbour-ledger']);
    expect(listed!.domains[0]).toMatchObject({ host: SHOP_HOST, verified_by: 'operator' });
    expect(opsCopy.OPS_VOUCH_BUTTON).toBe('Mark as verified by operator');
    expect(read('app/ops/publishers/page.tsx')).toContain('DomainForms');
  });

  it('the ops engine lists the addresses for an operator and refuses everyone else', async () => {
    const w = await boot();
    await pendingId(w);
    const ok = await w.app.engine.opsDomains.list({
      kind: 'operator',
      operator_id: 'opr_vikram',
      mfa: false,
    });
    expect(ok.ok && ok.value.domains).toHaveLength(1);
    expect(await w.app.engine.opsDomains.list(w.actor['harbour-ledger'])).toMatchObject({
      ok: false,
    });
  });
});

describe('C. removal over the routes', () => {
  it('the publisher removes its address; the import cannot begin from it; a stranger gets 404', async () => {
    const w = await boot();
    const h = await handlers();
    const code = (
      await json<{ token: string }>(await w.post('domains', harbour(w), { host: SHOP_HOST }))
    ).token;
    w.web.pages[`${SHOP}/`] = { body: homeWithToken(code) };
    expect((await w.post('check', harbour(w), { host: SHOP_HOST })).status).toBe(200);
    const stranger = await call(h.remove, {
      url: URLS.remove,
      method: 'POST',
      body: { host: SHOP_HOST },
      session: w.pub['quayside-gazette'],
    });
    expect(stranger.status).toBe(404);
    const res = await call(h.remove, {
      url: URLS.remove,
      method: 'POST',
      body: { host: SHOP_HOST },
      session: harbour(w),
    });
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ host: SHOP_HOST, state: 'removed' });
    const b = await w.post('begin', harbour(w), { source_url: SOURCE_URL });
    expect(b.status).toBe(403);
    expect((await w.app.engine.webImport.domains(w.actor['harbour-ledger']))!.domains).toEqual([]);
  });

  it('the operator removes by id with the code and a reason; without the code it is 403', async () => {
    const w = await boot();
    const h = await handlers();
    const id = await pendingId(w);
    const no = await call(h.opsRemove, {
      url: URLS.opsRemove,
      method: 'POST',
      body: { domain_id: id, reason: 'Site is gone' },
      session: await plainOperator(w),
    });
    expect(no.status).toBe(403);
    const yes = await call(h.opsRemove, {
      url: URLS.opsRemove,
      method: 'POST',
      body: { domain_id: id, reason: 'Site is gone' },
      session: w.refund.op,
    });
    expect(yes.status).toBe(200);
    expect(
      (await w.app.db.query("SELECT 1 FROM audit_log WHERE action = 'domain.removed'")).rows,
    ).toHaveLength(1);
  });
});

describe('D. the words at import start', () => {
  it('unreachable and missing are different sentences', () => {
    expect(copy.importErrorText('site_unreachable')).toBe(
      'We could not reach your site at that address. Check that it is online.',
    );
    expect(copy.importErrorText('proof_lost')).toBe(
      'We could not find your code on that address any more, so nothing was imported. Check the tag or the file, then try again.',
    );
    expect(copy.importStatusOf('site_unreachable')).toBe(409);
  });

  it('over the route: a dead site answers site_unreachable, a page without the code answers proof_lost', async () => {
    const w = await boot();
    const code = (
      await json<{ token: string }>(await w.post('domains', harbour(w), { host: SHOP_HOST }))
    ).token;
    w.web.pages[`${SHOP}/`] = { body: homeWithToken(code) };
    await w.post('check', harbour(w), { host: SHOP_HOST });
    w.web.pages[`${SHOP}/`] = { refuse: 'timeout' };
    w.web.pages[WELL_KNOWN_URL] = { refuse: 'timeout' };
    const dead = await w.post('begin', harbour(w), { source_url: SOURCE_URL });
    expect(dead.status).toBe(409);
    expect((await json<{ error: { code: string; message: string } }>(dead)).error).toMatchObject({
      code: 'site_unreachable',
      message: 'We could not reach your site at that address. Check that it is online.',
    });
    w.web.pages[`${SHOP}/`] = { body: '<html><head></head><body>no tag</body></html>' };
    w.web.pages[WELL_KNOWN_URL] = { refuse: 'bad_status' };
    const gone = await w.post('begin', harbour(w), { source_url: SOURCE_URL });
    expect((await json<{ error: { code: string } }>(gone)).error.code).toBe('proof_lost');
  });
});
