// INT-CL1 (F11): GET /api/v1/status is the one public health answer: ok, environment, revision and db.
// No new /api/health route; /healthz is unchanged; nothing about switches, flags or approvals is added.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StatusSchema, V1_ROUTES, buildOpenApiV1 } from '@umsbx/contracts';
import { createApp, installApp } from '../composition.server';
import type { App } from '../composition.server';
import { testEnv } from './support';

vi.mock('server-only', () => ({}));

const REVISION = 'unitmarket-sandbox-00031-x7k';
let tmp: string;
let app: App | null = null;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'cl1-status-'));
});
afterEach(async () => {
  await app?.close();
  app = null;
  vi.restoreAllMocks();
  rmSync(tmp, { recursive: true, force: true });
});

async function boot(over: Record<string, string> = {}): Promise<App> {
  app = createApp(await testEnv(over), { switch_cache_ms: 0 });
  installApp(app);
  await app.ready();
  return app;
}
async function status(): Promise<Response> {
  const { GET } = await import('./app/api/v1/status/route');
  return GET(new NextRequest('http://localhost:3000/api/v1/status'));
}

describe('GET /api/v1/status', () => {
  it('200 with exactly ok, environment, revision and db', async () => {
    await boot({ K_REVISION: REVISION });
    const res = await status();
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['db', 'environment', 'ok', 'revision']);
    expect(body).toEqual({ ok: true, environment: 'dryrun', revision: REVISION, db: 'up' });
    expect(StatusSchema.parse(body)).toEqual(body);
  });

  it('revision is null off Cloud Run (no K_REVISION)', async () => {
    await boot();
    const body = (await (await status()).json()) as Record<string, unknown>;
    expect(body['revision']).toBeNull();
    expect(body['db']).toBe('up');
  });

  it('says nothing about switches, the flag, outbound calls, locks or approvals', async () => {
    await boot({ K_REVISION: REVISION });
    const text = JSON.stringify(await (await status()).json());
    expect(text).not.toMatch(/switch|outbound|lock|flag|approval|connect|paypal/i);
  });

  // The maintenance gate in withRoute answers 503 `maintenance` for every route but /healthz (existing
  // tests pin that, and N3 lets this lane edit O5 only), so the route itself is not reachable in
  // maintenance mode. The mapping is checked on the handler: maintenance gives db "closed".
  it('maps maintenance mode to db "closed" and keeps maintenance true', async () => {
    const { status: handler } = await import('./api-v1/ops');
    const fake = {
      engine: {
        health: async () => ({
          ok: true,
          environment: 'dryrun',
          revision: REVISION,
          db: false,
          maintenance: true,
          last_pass_at: null,
          due: 0,
        }),
      },
    } as unknown as App;
    const r = await handler(fake);
    expect(r).toEqual({
      status: 200,
      body: {
        ok: true,
        environment: 'dryrun',
        revision: REVISION,
        db: 'closed',
        maintenance: true,
      },
    });
  });

  it('through the route in maintenance mode: 503 maintenance, as for every route but /healthz', async () => {
    const flag = join(tmp, 'ums-maintenance');
    writeFileSync(flag, '');
    await boot({
      UMS_DB: 'pglite-disk',
      UMS_PGLITE_DIR: join(tmp, 'pglite'),
      UMS_MAINTENANCE_FLAG: flag,
      K_REVISION: REVISION,
    });
    const res = await status();
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('maintenance');
  });

  it('an unhealthy app answers 503 unhealthy and no revision or db figure', async () => {
    const a = await boot({ K_REVISION: REVISION });
    vi.spyOn(a.engine, 'health').mockResolvedValue({
      ok: false,
      environment: 'dryrun',
      db: false,
      maintenance: false,
      last_pass_at: null,
      due: 0,
      revision: REVISION,
    });
    const res = await status();
    expect(res.status).toBe(503);
    const text = JSON.stringify(await res.json());
    expect(text).toContain('unhealthy');
    expect(text).not.toContain(REVISION);
  });

  it('/healthz is unchanged: ok and environment only', async () => {
    await boot({ K_REVISION: REVISION });
    const { GET } = await import('./app/healthz/route');
    const res = await GET(new NextRequest('http://localhost:3000/healthz'));
    expect(await res.json()).toEqual({ ok: true, environment: 'dryrun' });
  });

  it('there is no /api/health route', () => {
    expect(V1_ROUTES.some((r) => r.path === '/api/health')).toBe(false);
  });
});

describe('the OpenAPI document', () => {
  it('lists /api/v1/status with revision and db, and no other body field', () => {
    const doc = buildOpenApiV1() as {
      paths: Record<
        string,
        {
          get: {
            summary: string;
            responses: Record<
              string,
              { content?: { 'application/json': { schema: Record<string, unknown> } } }
            >;
          };
        }
      >;
    };
    const get = doc.paths['/api/v1/status']!.get;
    expect(get.summary).toMatch(/revision and db/);
    const schema = get.responses['200']!.content!['application/json'].schema as {
      properties: Record<string, unknown>;
      required: string[];
      additionalProperties: boolean;
    };
    expect(Object.keys(schema.properties).sort()).toEqual([
      'db',
      'environment',
      'maintenance',
      'ok',
      'revision',
    ]);
    expect([...schema.required].sort()).toEqual(['db', 'environment', 'ok', 'revision']);
    expect(schema.additionalProperties).toBe(false);
  });
});
