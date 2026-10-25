// CO-7b (D-037): hosted maintenance mode, as seen from the composition root. While the flag file
// exists at boot the app opens no database, starts no job loop and builds no outbound or Wire; the
// health check says so and everything else answers 503. Without the flag nothing changes.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, installApp } from '../composition.server';
import type { App } from '../composition.server';
import { testEnv } from './support';

// Spies on what maintenance mode must never reach: the database and the job loop. They wrap the real
// functions, so the "without the flag" tests still run the real boot. This folder may not import
// @umsbx/db or @umsbx/jobs, and the seal pins (lint SEAL2/SEAL3, tests/mvp-b/sealed-callers.test.ts)
// allow no new file to name the outbound builder or touch the transport package, so "no transport and
// no Wire" is checked through `app.outbound` (null unless the builder ran) and the log lines the
// transport would write.
const spies = vi.hoisted(() => ({
  openDatabase: vi.fn(),
  startLoop: vi.fn(),
}));
type Fn = (...a: unknown[]) => unknown;
vi.mock('server-only', () => ({}));
vi.mock('@umsbx/db', async (orig) => {
  const m = (await orig()) as Record<string, Fn>;
  spies.openDatabase.mockImplementation(m['openDatabase'] as Fn);
  return { ...m, openDatabase: spies.openDatabase };
});
vi.mock('@umsbx/jobs', async (orig) => {
  const m = (await orig()) as Record<string, Fn>;
  spies.startLoop.mockImplementation(m['startLoop'] as Fn);
  return { ...m, startLoop: spies.startLoop };
});
const openDatabase = spies.openDatabase;
const startLoop = spies.startLoop;

const SB = {
  UMS_MODE: 'sandbox',
  UMS_OUTBOUND_APPROVAL_REF: 'DL-2026-10-25-test',
  PAYPAL_CLIENT_ID: 'synthetic-client-id-for-tests',
  PAYPAL_CLIENT_SECRET: 'synthetic-client-secret-for-tests-xyz',
};

let tmp: string;
let pglite: string;
let flag: string;
let app: App | null = null;
const lines: string[] = [];

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'co7b-web-'));
  pglite = join(tmp, 'pglite');
  flag = join(tmp, 'ums-maintenance');
  lines.length = 0;
  openDatabase.mockClear();
  startLoop.mockClear();
});
afterEach(async () => {
  await app?.close();
  app = null;
  rmSync(tmp, { recursive: true, force: true });
});

async function boot(over: Record<string, string> = {}, withFlag = true): Promise<App> {
  if (withFlag) writeFileSync(flag, '');
  const env = await testEnv({
    UMS_DB: 'pglite-disk',
    UMS_PGLITE_DIR: pglite,
    UMS_MAINTENANCE_FLAG: flag,
    ...over,
  });
  app = createApp(env, { switch_cache_ms: 0, log_sink: (l) => lines.push(l) });
  installApp(app);
  return app;
}

const untouched = (): void => {
  expect(openDatabase).not.toHaveBeenCalled();
  expect(startLoop).not.toHaveBeenCalled();
  // No transport, selfcheck or dry-run send was ever reached (they log when they are).
  expect(lines.filter((l) => /transport\.|dryrun\./.test(l))).toEqual([]);
  expect(existsSync(pglite)).toBe(false);
  expect(existsSync(join(pglite, '.ums-open.lock'))).toBe(false);
};

describe('with the flag at boot', () => {
  it('ready, startJobs and health open nothing, start nothing and build nothing', async () => {
    const a = await boot();
    await a.ready();
    const jobs = await a.startJobs();
    const h = await a.engine.health();
    await jobs.stop();
    expect(a.maintenance).toBe(true);
    expect(h).toMatchObject({ ok: true, db: false, maintenance: true });
    expect(a.outbound).toBeNull();
    untouched();
  });

  it('sandbox mode builds no outbound either', async () => {
    const a = await boot(SB);
    await a.ready();
    await (await a.startJobs()).stop();
    expect(a.config.mode).toBe('sandbox');
    expect(a.outbound).toBeNull();
    untouched();
  });

  it('every engine and database call fails closed without opening anything', async () => {
    const a = await boot(SB);
    await expect(a.db.query('SELECT 1')).rejects.toThrow(/maintenance/i);
    await expect(a.db.exec('SELECT 1')).rejects.toThrow(/maintenance/i);
    await expect(a.db.transaction(async () => 1)).rejects.toThrow(/maintenance/i);
    await expect(a.engine.listOffers()).rejects.toThrow(/maintenance/i);
    await expect(a.engine.signIn({ persona: 'buyer-a', passcode: 'x' })).resolves.toBeNull();
    untouched();
  });

  it('logs one line saying so, and names no value', async () => {
    await boot(SB);
    const mine = lines.filter((l) => l.includes('maintenance.on'));
    expect(mine).toHaveLength(1);
    expect(mine[0]).toContain('flag_present');
    expect(mine[0]).not.toContain(SB.PAYPAL_CLIENT_SECRET);
    expect(mine[0]).not.toContain(tmp);
  });

  it('is latched at boot: removing the flag does not leave maintenance until a restart', async () => {
    const a = await boot();
    rmSync(flag);
    expect(a.maintenance).toBe(true);
    expect((await a.engine.health()).maintenance).toBe(true);
    untouched();
  });

  it('a missing parent folder (disk not mounted) is maintenance, not "no flag"', async () => {
    const a = await boot(
      {
        UMS_PGLITE_DIR: join(tmp, 'gone', 'pglite'),
        UMS_MAINTENANCE_FLAG: join(tmp, 'gone', 'ums-maintenance'),
      },
      false,
    );
    expect(a.maintenance).toBe(true);
    await a.ready();
    expect(existsSync(join(tmp, 'gone'))).toBe(false);
    expect(openDatabase).not.toHaveBeenCalled();
  });

  it('health route: 200, ok, maintenance true, no database figure', async () => {
    await boot();
    const { GET } = await import('./app/healthz/route');
    const res = await GET(new Request('http://localhost:3000/healthz'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, environment: 'dryrun', maintenance: true });
    untouched();
  });

  it('middleware: pages answer 503 maintenance and carry no page content', async () => {
    await boot();
    const { middleware } = await import('./middleware');
    for (const path of ['/', '/library', '/ops', '/signin', '/o/harbour-ledger/tide-tables']) {
      const res = middleware(new NextRequest(`http://localhost:3000${path}`));
      expect(res.status, path).toBe(503);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('maintenance');
      expect(res.headers.get('cache-control')).toBe('no-store');
    }
    untouched();
  });

  it('the middleware matcher still leaves the API, content and health routes to withRoute', async () => {
    const { config } = await import('./middleware');
    const src = JSON.stringify(config.matcher);
    for (const p of ['api/', 'c/', 'healthz']) expect(src).toContain(p);
  });

  it('instrumentation does not start jobs in maintenance mode (second layer)', () => {
    const text = readFileSync(join(__dirname, 'instrumentation.ts'), 'utf8');
    const guard = text.indexOf('.maintenance');
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(text.indexOf('.startJobs()'));
  });
});

describe('without the flag, boot is unchanged', () => {
  it('opens the database once, takes the lock, starts the loop; health has no maintenance field', async () => {
    const a = await boot({}, false);
    expect(a.maintenance).toBe(false);
    await a.ready();
    expect(openDatabase).toHaveBeenCalledTimes(1);
    expect(openDatabase.mock.calls[0]?.[0]).toEqual({
      kind: 'pglite-disk',
      dir: pglite,
    });
    expect(existsSync(join(pglite, '.ums-open.lock'))).toBe(true);
    const jobs = await a.startJobs();
    expect(startLoop).toHaveBeenCalledTimes(1);
    const h = await a.engine.health();
    expect(h.ok).toBe(true);
    expect(h.db).toBe(true);
    expect(h.maintenance).toBeFalsy();
    await jobs.stop();
    await a.close();
    expect(existsSync(join(pglite, '.ums-open.lock'))).toBe(false);
  });

  it('health route body is exactly what it was', async () => {
    await boot({}, false);
    const { GET } = await import('./app/healthz/route');
    const res = await GET(new Request('http://localhost:3000/healthz'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, environment: 'dryrun' });
  });

  it('middleware passes pages through with the page headers', async () => {
    await boot({}, false);
    const { middleware } = await import('./middleware');
    const res = middleware(new NextRequest('http://localhost:3000/library'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
  });

  it('a flag that appears after boot changes nothing until a restart (latched both ways)', async () => {
    const a = await boot({}, false);
    await a.ready();
    writeFileSync(flag, '');
    expect(a.maintenance).toBe(false);
    expect((await a.engine.health()).db).toBe(true);
    await a.close();
  });

  it('with UMS_MAINTENANCE_FLAG unset a file of that name is ignored (no hidden path)', async () => {
    writeFileSync(flag, '');
    mkdirSync(tmp, { recursive: true });
    const env = await testEnv({ UMS_DB: 'pglite-disk', UMS_PGLITE_DIR: pglite });
    app = createApp(env, { switch_cache_ms: 0 });
    installApp(app);
    expect(app.maintenance).toBe(false);
    await app.ready();
    expect(openDatabase).toHaveBeenCalledTimes(1);
  });

  it('memory database, no flag configured: unchanged', async () => {
    const env = await testEnv();
    app = createApp(env, { switch_cache_ms: 0 });
    installApp(app);
    await app.ready();
    expect(app.maintenance).toBe(false);
    expect((await app.engine.health()).ok).toBe(true);
  });
});
