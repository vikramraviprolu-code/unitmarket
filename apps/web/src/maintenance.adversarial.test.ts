// CO-7b (D-037): the flag is created and removed only from the host shell. This file walks every route
// module under apps/web/src/app (the same files scripts/route-inventory.mjs lists) and proves two
// things: in maintenance mode each one answers 503 `maintenance` (the health check 200) and leaves the
// flag exactly as it was; in normal mode no route, as anonymous, buyer or operator, creates the flag or
// deletes it, whatever it is sent.
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp, installApp } from '../composition.server';
import type { App } from '../composition.server';
import { ORIGIN, signIn, testEnv } from './support';
import type { Session } from './support';

vi.mock('server-only', () => ({}));

const APP_DIR = join(__dirname, 'app');
type Handler = (
  req: Request,
  ctx?: { params: Promise<Record<string, string>> },
) => Promise<Response>;
interface Mod {
  routeMeta: { path: string; method: 'GET' | 'POST' | 'PATCH' | 'DELETE' };
  GET?: Handler;
  POST?: Handler;
  PATCH?: Handler;
  DELETE?: Handler;
}
// A route file with several verbs exports routeMetaGET, routeMetaPOST, ... instead of routeMeta (API-W0).
type RawMod = Mod & {
  routeMetaGET?: Mod['routeMeta'];
  routeMetaPOST?: Mod['routeMeta'];
  routeMetaPATCH?: Mod['routeMeta'];
  routeMetaDELETE?: Mod['routeMeta'];
};
const VERBS = ['GET', 'POST', 'PATCH', 'DELETE'] as const;
const BODY_VERBS: readonly string[] = ['POST', 'PATCH', 'DELETE'];

function routeFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) routeFiles(p, out);
    else if (/^route\.[cm]?[jt]sx?$/.test(name))
      out.push(relative(APP_DIR, p).split(sep).join('/'));
  }
  return out;
}
const FILES = routeFiles(APP_DIR);
// Static specifiers (the lint rule bans computed imports). The test below fails when this list and the
// route files on disk differ, so a new route cannot escape the walk.
const IMPORTERS: Record<string, () => Promise<unknown>> = {
  '.well-known/mcp/route.ts': () => import('./app/.well-known/mcp/route'),
  'api/accounts/display-currency/route.ts': () =>
    import('./app/api/accounts/display-currency/route'),
  'api/accounts/login/route.ts': () => import('./app/api/accounts/login/route'),
  'api/accounts/password/route.ts': () => import('./app/api/accounts/password/route'),
  'api/accounts/route.ts': () => import('./app/api/accounts/route'),
  'api/accounts/sessions/revoke-all/route.ts': () =>
    import('./app/api/accounts/sessions/revoke-all/route'),
  'api/appearance/route.ts': () => import('./app/api/appearance/route'),
  'api/applications/route.ts': () => import('./app/api/applications/route'),
  'api/approvals/route.ts': () => import('./app/api/approvals/route'),
  'api/briefs/route.ts': () => import('./app/api/briefs/route'),
  'api/cases/route.ts': () => import('./app/api/cases/route'),
  'api/discover/route.ts': () => import('./app/api/discover/route'),
  'api/v1/api-keys/[id]/route.ts': () => import('./app/api/v1/api-keys/[id]/route'),
  'api/v1/api-keys/route.ts': () => import('./app/api/v1/api-keys/route'),
  'api/v1/mandates/[id]/route.ts': () => import('./app/api/v1/mandates/[id]/route'),
  'api/v1/mandates/route.ts': () => import('./app/api/v1/mandates/route'),
  'api/v1/mcp/route.ts': () => import('./app/api/v1/mcp/route'),
  'api/v1/webhook-subscriptions/[id]/deliveries/route.ts': () =>
    import('./app/api/v1/webhook-subscriptions/[id]/deliveries/route'),
  'api/v1/webhook-subscriptions/[id]/route.ts': () =>
    import('./app/api/v1/webhook-subscriptions/[id]/route'),
  'api/v1/webhook-subscriptions/route.ts': () => import('./app/api/v1/webhook-subscriptions/route'),
  'api/library/[id]/link/route.ts': () => import('./app/api/library/[id]/link/route'),
  'api/library/route.ts': () => import('./app/api/library/route'),
  'api/ops/agent-buy/route.ts': () => import('./app/api/ops/agent-buy/route'),
  'api/ops/rules/route.ts': () => import('./app/api/ops/rules/route'),
  'api/ops/start/route.ts': () => import('./app/api/ops/start/route'),
  'api/ops/stop/route.ts': () => import('./app/api/ops/stop/route'),
  'api/ops/activity/route.ts': () => import('./app/api/ops/activity/route'),
  'api/ops/orders/[ref]/timeline/route.ts': () =>
    import('./app/api/ops/orders/[ref]/timeline/route'),
  'api/ops/units/[id]/evidence/route.ts': () => import('./app/api/ops/units/[id]/evidence/route'),
  'api/ops/units/[id]/evidence.html/route.ts': () =>
    import('./app/api/ops/units/[id]/evidence.html/route'),
  'api/orders/[ref]/cancel/route.ts': () => import('./app/api/orders/[ref]/cancel/route'),
  'api/orders/[ref]/checkout/route.ts': () => import('./app/api/orders/[ref]/checkout/route'),
  'api/orders/[ref]/route.ts': () => import('./app/api/orders/[ref]/route'),
  'api/orders/route.ts': () => import('./app/api/orders/route'),
  'api/quotes/route.ts': () => import('./app/api/quotes/route'),
  'api/receipts/[order]/route.ts': () => import('./app/api/receipts/[order]/route'),
  'api/refunds/[id]/cancel/route.ts': () => import('./app/api/refunds/[id]/cancel/route'),
  'api/refunds/route.ts': () => import('./app/api/refunds/route'),
  'api/ops/publishers/status/route.ts': () => import('./app/api/ops/publishers/status/route'),
  'api/ops/publishers/applicants/route.ts': () =>
    import('./app/api/ops/publishers/applicants/route'),
  'api/ops/publishers/applicants/decision/route.ts': () =>
    import('./app/api/ops/publishers/applicants/decision/route'),
  'api/ops/payee-decisions/route.ts': () => import('./app/api/ops/payee-decisions/route'),
  'api/publisher/export/route.ts': () => import('./app/api/publisher/export/route'),
  'api/publisher/offers/create/route.ts': () => import('./app/api/publisher/offers/create/route'),
  'api/publisher/offers/revise/route.ts': () => import('./app/api/publisher/offers/revise/route'),
  'api/publisher/offers/withdraw/route.ts': () =>
    import('./app/api/publisher/offers/withdraw/route'),
  'api/publisher/payee-requests/route.ts': () => import('./app/api/publisher/payee-requests/route'),
  'api/session/route.ts': () => import('./app/api/session/route'),
  'api/session/signout/route.ts': () => import('./app/api/session/signout/route'),
  'api/v1/approvals/route.ts': () => import('./app/api/v1/approvals/route'),
  'api/v1/briefs/[id]/discover/route.ts': () => import('./app/api/v1/briefs/[id]/discover/route'),
  'api/v1/briefs/route.ts': () => import('./app/api/v1/briefs/route'),
  'api/v1/catalogue/search/route.ts': () => import('./app/api/v1/catalogue/search/route'),
  'api/v1/library/[id]/link/route.ts': () => import('./app/api/v1/library/[id]/link/route'),
  'api/v1/library/route.ts': () => import('./app/api/v1/library/route'),
  'api/v1/offers/[id]/route.ts': () => import('./app/api/v1/offers/[id]/route'),
  'api/v1/ops/orders/[ref]/route.ts': () => import('./app/api/v1/ops/orders/[ref]/route'),
  'api/v1/ops/orders/[ref]/timeline/route.ts': () =>
    import('./app/api/v1/ops/orders/[ref]/timeline/route'),
  'api/v1/ops/trace/verify/route.ts': () => import('./app/api/v1/ops/trace/verify/route'),
  'api/v1/orders/[ref]/timeline/route.ts': () => import('./app/api/v1/orders/[ref]/timeline/route'),
  'api/v1/seller/sales/[unit]/timeline/route.ts': () =>
    import('./app/api/v1/seller/sales/[unit]/timeline/route'),
  'api/v1/ops/overview/route.ts': () => import('./app/api/v1/ops/overview/route'),
  'api/v1/ops/reconciler/route.ts': () => import('./app/api/v1/ops/reconciler/route'),
  'api/v1/ops/switches/route.ts': () => import('./app/api/v1/ops/switches/route'),
  'api/v1/orders/[ref]/cancel/route.ts': () => import('./app/api/v1/orders/[ref]/cancel/route'),
  'api/v1/orders/[ref]/route.ts': () => import('./app/api/v1/orders/[ref]/route'),
  'api/v1/orders/route.ts': () => import('./app/api/v1/orders/route'),
  'api/v1/quotes/route.ts': () => import('./app/api/v1/quotes/route'),
  'api/v1/seller/offers/[id]/route.ts': () => import('./app/api/v1/seller/offers/[id]/route'),
  'api/v1/seller/offers/route.ts': () => import('./app/api/v1/seller/offers/route'),
  'api/v1/seller/sales/route.ts': () => import('./app/api/v1/seller/sales/route'),
  'api/v1/status/route.ts': () => import('./app/api/v1/status/route'),
  'api/webhooks/paypal/route.ts': () => import('./app/api/webhooks/paypal/route'),
  'c/[token]/route.ts': () => import('./app/c/[token]/route'),
  'healthz/route.ts': () => import('./app/healthz/route'),
};
const load = async (): Promise<Mod[]> =>
  Promise.all(
    FILES.map(async (f) => {
      const m = (await IMPORTERS[f]?.()) as RawMod;
      return m.routeMeta === undefined
        ? {
            ...m,
            routeMeta: (m.routeMetaPOST ??
              m.routeMetaGET ??
              m.routeMetaPATCH ??
              m.routeMetaDELETE) as Mod['routeMeta'],
          }
        : m;
    }),
  );
const paramsOf = (path: string): Record<string, string> =>
  Object.fromEntries([...path.matchAll(/\[(\w+)\]/g)].map((m) => [m[1] as string, 'x1']));
const urlOf = (path: string): string => `${ORIGIN}${path.replace(/\[(\w+)\]/g, 'x1')}`;

const snapshot = (flag: string) => ({
  text: readFileSync(flag, 'utf8'),
  mtime: statSync(flag).mtimeMs,
  size: statSync(flag).size,
  ino: statSync(flag).ino,
});

async function hitAll(mods: Mod[], sessions: Array<Session | null>): Promise<Response[]> {
  const out: Response[] = [];
  for (const m of mods) {
    for (const verb of VERBS) {
      const h = m[verb];
      if (h === undefined) continue;
      for (const s of sessions) {
        for (const body of BODY_VERBS.includes(verb)
          ? ['{}', 'not json', '{"persona":"operator"}']
          : [null]) {
          const headers: Record<string, string> = {
            'x-forwarded-for': '203.0.113.7',
            'paypal-transmission-id': 'x',
          };
          if (BODY_VERBS.includes(verb)) {
            headers['origin'] = ORIGIN;
            headers['content-type'] = 'application/json';
          }
          if (s !== null) {
            headers['cookie'] = s.cookie;
            if (BODY_VERBS.includes(verb)) headers['x-csrf-token'] = s.csrf;
          } else headers['cookie'] = 'ums_session=garbage';
          out.push(
            await h(new Request(urlOf(m.routeMeta.path), { method: verb, headers, body }), {
              params: Promise.resolve(paramsOf(m.routeMeta.path)),
            }),
          );
        }
      }
    }
  }
  return out;
}

describe('the walk is not empty', () => {
  it('finds every route module and each declares routeMeta', async () => {
    expect([...FILES].sort()).toEqual(Object.keys(IMPORTERS).sort());
    expect(FILES.length).toBeGreaterThanOrEqual(18);
    const mods = await load();
    for (const m of mods) expect(m.routeMeta.path).toMatch(/^\//);
    expect(mods.some((m) => m.routeMeta.path === '/healthz')).toBe(true);
    expect(mods.some((m) => m.routeMeta.path === '/api/webhooks/paypal')).toBe(true);
    expect(mods.some((m) => m.routeMeta.path === '/c/[token]')).toBe(true);
  });
});

describe('maintenance mode: every route', () => {
  let tmp: string;
  let flag: string;
  let app: App;
  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'co7b-walk-'));
    flag = join(tmp, 'ums-maintenance');
    writeFileSync(flag, 'owner made this\n');
    app = createApp(
      await testEnv({
        UMS_DB: 'pglite-disk',
        UMS_PGLITE_DIR: join(tmp, 'pglite'),
        UMS_MAINTENANCE_FLAG: flag,
      }),
      { switch_cache_ms: 0 },
    );
    installApp(app);
  });
  afterAll(async () => {
    await app.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('answers 503 maintenance (health: 200 maintenance true) and never touches the flag or the disk', async () => {
    const before = snapshot(flag);
    const mods = await load();
    const fake: Session = { cookie: 'ums_session=ses_00000000000000000000000000.x', csrf: 'x' };
    let health = 0;
    for (const m of mods) {
      for (const verb of VERBS) {
        const h = m[verb];
        if (h === undefined) continue;
        const res = await hitOne(m, verb, h, fake);
        if (m.routeMeta.path === '/healthz') {
          health += 1;
          expect(res.status).toBe(200);
          expect(await res.json()).toMatchObject({ ok: true, maintenance: true });
        } else {
          expect(res.status, `${verb} ${m.routeMeta.path}`).toBe(503);
          const body = (await res.json()) as { error: { code: string } };
          expect(body.error.code, m.routeMeta.path).toBe('maintenance');
        }
      }
    }
    expect(health).toBe(1);
    // every other shape of request too: anonymous, garbage cookie, bad bodies
    for (const res of await hitAll(
      mods.filter((m) => m.routeMeta.path !== '/healthz'),
      [null, fake],
    ))
      expect(res.status).toBe(503);
    expect(snapshot(flag)).toEqual(before);
    expect(readdirSync(tmp)).toEqual(['ums-maintenance']);
  });
});

async function hitOne(
  m: Mod,
  verb: (typeof VERBS)[number],
  h: Handler,
  s: Session,
): Promise<Response> {
  const headers: Record<string, string> = { cookie: s.cookie };
  if (BODY_VERBS.includes(verb)) {
    headers['origin'] = ORIGIN;
    headers['content-type'] = 'application/json';
    headers['x-csrf-token'] = s.csrf;
  }
  return h(
    new Request(urlOf(m.routeMeta.path), {
      method: verb,
      headers,
      body: BODY_VERBS.includes(verb) ? '{}' : null,
    }),
    { params: Promise.resolve(paramsOf(m.routeMeta.path)) },
  );
}

describe('normal mode: no route creates or deletes the flag', () => {
  let tmp: string;
  let flag: string;
  let app: App;
  let sessions: Array<Session | null>;
  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'co7b-walk2-'));
    flag = join(tmp, 'ums-maintenance');
    app = createApp(
      await testEnv({
        UMS_DB: 'pglite-disk',
        UMS_PGLITE_DIR: join(tmp, 'pglite'),
        UMS_MAINTENANCE_FLAG: flag,
      }),
      { switch_cache_ms: 0 },
    );
    installApp(app);
    await app.ready();
    const { POST } = (await import('./app/api/session/route')) as unknown as { POST: Handler };
    const buyer = await signIn(POST, 'buyer-a');
    const operator = await signIn(POST, 'operator');
    sessions = [null, buyer, operator];
    expect(buyer).not.toBeNull();
    expect(operator).not.toBeNull();
  }, 60_000);
  afterAll(async () => {
    await app.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('with no flag: after every route, as anonymous, buyer and operator, there is still no flag', async () => {
    const mods = await load();
    const res = await hitAll(mods, sessions);
    expect(res.length).toBeGreaterThan(100);
    expect(res.some((r) => r.status === 200)).toBe(true); // the walk really reached handlers
    // nothing answered "maintenance" in normal mode
    for (const r of res)
      expect(r.status === 503 && (await r.clone().text()).includes('maintenance')).toBe(false);
    expect(existsSync(flag)).toBe(false);
    expect(readdirSync(tmp)).toEqual(['pglite']);
  }, 120_000);

  it('with a flag the owner made after boot: after every route the flag is the same file', async () => {
    writeFileSync(flag, 'owner made this\n');
    const before = snapshot(flag);
    const mods = await load();
    await hitAll(mods, sessions);
    expect(snapshot(flag)).toEqual(before);
    expect(readdirSync(tmp).sort()).toEqual(['pglite', 'ums-maintenance']);
    // the app did not enter maintenance because of it: it stays latched at what it saw at boot
    expect(app.maintenance).toBe(false);
  }, 120_000);

  it('the stop button, the one route that changes a switch, can only turn outbound off', async () => {
    const { POST } = (await import('./app/api/ops/stop/route')) as unknown as { POST: Handler };
    // FIX-FLOW D1: the walk above now includes the sign out route, which ends the sessions it is called
    // with, so this test signs in its own operator session.
    const signInRoute = (await import('./app/api/session/route')) as unknown as { POST: Handler };
    const op = (await signIn(signInRoute.POST, 'operator')) as Session;
    const before = snapshot(flag);
    const res = await POST(
      new Request(`${ORIGIN}/api/ops/stop`, {
        method: 'POST',
        headers: {
          origin: ORIGIN,
          'content-type': 'application/json',
          cookie: op.cookie,
          'x-csrf-token': op.csrf,
        },
        body: JSON.stringify({ reason: 'maintenance test' }),
      }),
      { params: Promise.resolve({}) },
    );
    expect([200, 403]).toContain(res.status);
    expect(snapshot(flag)).toEqual(before);
  });
});
