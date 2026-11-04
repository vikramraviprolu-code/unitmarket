// API-W0 (F4): the route inventory learns the v1 fields: PATCH and DELETE, auth apikey and owner, scopes,
// and a file that serves more than one verb (routeMetaGET, routeMetaPOST, ...). The inventory is the
// static half of the wrapper rules in packages/security/src/route.ts.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from './test-helpers';

const SCRIPT = join(REPO_ROOT, 'scripts', 'route-inventory.mjs');

function repoWith(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'route-inv-v1-'));
  for (const [rel, src] of Object.entries(files)) {
    const p = join(root, 'apps/web/src/app', rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, src);
  }
  return root;
}
const run = (root: string, ...args: string[]) => {
  const r = spawnSync(process.execPath, [SCRIPT, '--root', root, ...args], { encoding: 'utf8' });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
};

const meta = (name: string, o: Record<string, string>): string => {
  const f = {
    path: "'/api/v1/things'",
    method: "'GET'",
    auth: "'apikey'",
    scopes: "['catalogue:read']",
    csrf: 'false',
    rate: "{ name: 'things', per: 'actor', limit: 60, window_ms: 60000 }",
    max_body_bytes: '1024',
    idempotent: 'false',
    risk: "'low'",
    ...o,
  };
  return `export const ${name}: RouteMeta = {\n${Object.entries(f)
    .map(([k, v]) => `  ${k}: ${v},`)
    .join('\n')}\n};\n`;
};
const head = "import { withRoute, type RouteMeta } from '@umsbx/security';\n";
const single = (o: Record<string, string>, verb = 'GET'): string =>
  `${head}${meta('routeMeta', o)}export const ${verb} = withRoute(routeMeta, schema, handler);\n`;

describe('single verb v1 routes', () => {
  it('accepts a GET bearer route with scopes under /api/v1', () => {
    const r = run(repoWith({ 'api/v1/things/route.ts': single({}) }), '--check');
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain('GET /api/v1/things auth=apikey');
    expect(r.out).toContain('scopes=catalogue:read');
  });

  it('accepts PATCH and DELETE bearer routes that are idempotent', () => {
    const files = {
      'api/v1/things/[id]/route.ts': single(
        { method: "'PATCH'", path: "'/api/v1/things/[id]'", idempotent: 'true' },
        'PATCH',
      ),
      'api/v1/other/[id]/route.ts': single(
        { method: "'DELETE'", path: "'/api/v1/other/[id]'", idempotent: 'true' },
        'DELETE',
      ),
    };
    const r = run(repoWith(files), '--check');
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain('PATCH /api/v1/things/[id]');
    expect(r.out).toContain('DELETE /api/v1/other/[id]');
  });

  it('accepts auth owner (a session of any owner kind) with csrf under /api/v1', () => {
    const src = single(
      {
        method: "'POST'",
        auth: "'owner'",
        scopes: 'null',
        csrf: 'true',
        rate: 'null',
        idempotent: 'true',
      },
      'POST',
    ).replace('  scopes: null,\n', '');
    const r = run(repoWith({ 'api/v1/things/route.ts': src }), '--check');
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain('auth=owner');
  });

  it.each([
    ['an apikey route outside /api/v1', { path: "'/api/things'" }, 'api/things/route.ts', /apikey/],
    [
      'an apikey route under /api/ops',
      { path: "'/api/ops/things'" },
      'api/ops/things/route.ts',
      /apikey/,
    ],
    ['an apikey route without scopes', { scopes: '[]' }, 'api/v1/things/route.ts', /scopes/],
    ['an apikey route with csrf', { csrf: 'true' }, 'api/v1/things/route.ts', /csrf/],
    ['an apikey route without a rate rule', { rate: 'null' }, 'api/v1/things/route.ts', /rate/],
    [
      'an apikey GET that is idempotent',
      { idempotent: 'true' },
      'api/v1/things/route.ts',
      /idempot/,
    ],
  ])('fails on %s', (_name, over, file, msg) => {
    const r = run(repoWith({ [file]: single(over as Record<string, string>) }), '--check');
    expect(r.status, r.out).toBe(1);
    expect(r.out).toMatch(msg);
  });

  it('fails on a non-GET bearer route that is not idempotent', () => {
    const r = run(
      repoWith({
        'api/v1/things/route.ts': single({ method: "'POST'", idempotent: 'false' }, 'POST'),
      }),
      '--check',
    );
    expect(r.status, r.out).toBe(1);
    expect(r.out).toMatch(/idempot/);
  });

  it('fails on scopes on a route that is not an apikey route', () => {
    const r = run(
      repoWith({
        'api/orders/route.ts': single({
          path: "'/api/orders'",
          auth: "'buyer'",
          scopes: "['orders:read']",
        }),
      }),
      '--check',
    );
    expect(r.status, r.out).toBe(1);
    expect(r.out).toMatch(/scopes/);
  });

  it('fails on a non-GET /api/v1 route that is not idempotent, whatever the auth', () => {
    const src = single(
      { method: "'DELETE'", auth: "'owner'", csrf: 'true', rate: 'null', idempotent: 'false' },
      'DELETE',
    ).replace("  scopes: ['catalogue:read'],\n", '');
    const r = run(repoWith({ 'api/v1/things/route.ts': src }), '--check');
    expect(r.status, r.out).toBe(1);
    expect(r.out).toMatch(/idempot/);
  });

  it('a DELETE route needs csrf unless it is a bearer route', () => {
    const src = single(
      { method: "'DELETE'", auth: "'owner'", csrf: 'false', rate: 'null', idempotent: 'true' },
      'DELETE',
    ).replace("  scopes: ['catalogue:read'],\n", '');
    const r = run(repoWith({ 'api/v1/things/route.ts': src }), '--check');
    expect(r.status, r.out).toBe(1);
    expect(r.out).toMatch(/csrf/);
  });

  it('still refuses the old problems: a PUT meta, a handler that is a plain function', () => {
    const put = run(
      repoWith({ 'api/v1/things/route.ts': single({ method: "'PUT'" }, 'PUT') }),
      '--check',
    );
    expect(put.status).toBe(1);
    const plain = run(
      repoWith({
        'api/v1/things/route.ts': `${head}${meta('routeMeta', {})}export async function GET() { return new Response(null); }\n`,
      }),
      '--check',
    );
    expect(plain.status).toBe(1);
    expect(plain.out).toMatch(/withRoute/);
  });
});

describe('a route file with several verbs', () => {
  const both = (extra = '', getName = 'routeMetaGET', postName = 'routeMetaPOST'): string =>
    `${head}${meta('routeMetaGET', { auth: "'owner'", scopes: 'null', csrf: 'false', rate: 'null', path: "'/api/v1/things'" }).replace('  scopes: null,\n', '')}` +
    `${meta('routeMetaPOST', { method: "'POST'", auth: "'owner'", scopes: 'null', csrf: 'true', rate: 'null', idempotent: 'true', path: "'/api/v1/things'" }).replace('  scopes: null,\n', '')}` +
    `export const GET = withRoute(${getName}, schemaA, handlerA);\nexport const POST = withRoute(${postName}, schemaB, handlerB);\n${extra}`;

  it('accepts routeMetaGET and routeMetaPOST with a handler each, and lists both rows', () => {
    const r = run(repoWith({ 'api/v1/things/route.ts': both() }), '--check');
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain('GET /api/v1/things');
    expect(r.out).toContain('POST /api/v1/things');
  });

  it('fails when a handler is built with the meta of another verb', () => {
    const r = run(
      repoWith({ 'api/v1/things/route.ts': both('', 'routeMetaPOST', 'routeMetaPOST') }),
      '--check',
    );
    expect(r.status, r.out).toBe(1);
    expect(r.out).toMatch(/routeMeta/);
  });

  it('fails when a verb is exported without its own meta', () => {
    const r = run(
      repoWith({
        'api/v1/things/route.ts': both('export const DELETE = withRoute(routeMetaPOST, s, h);\n'),
      }),
      '--check',
    );
    expect(r.status, r.out).toBe(1);
    expect(r.out).toMatch(/DELETE/);
  });

  it('fails when a meta has no handler', () => {
    const src = both().replace(/export const POST = [^\n]*\n/, '');
    const r = run(repoWith({ 'api/v1/things/route.ts': src }), '--check');
    expect(r.status, r.out).toBe(1);
    expect(r.out).toMatch(/POST/);
  });

  it('fails when a plain routeMeta and a routeMeta<VERB> are mixed in one file', () => {
    const r = run(
      repoWith({ 'api/v1/things/route.ts': both(meta('routeMeta', { method: "'GET'" })) }),
      '--check',
    );
    expect(r.status, r.out).toBe(1);
    expect(r.out).toMatch(/mix|both|routeMeta/);
  });

  it('fails when a meta path does not match the file location', () => {
    const r = run(repoWith({ 'api/v1/other/route.ts': both() }), '--check');
    expect(r.status, r.out).toBe(1);
    expect(r.out).toMatch(/does not match file location/);
  });

  it('fails when a meta is not an object literal with plain keys (spread or computed key)', () => {
    const src = both().replace(
      "  path: '/api/v1/things',\n  method: 'POST',",
      "  ...base,\n  method: 'POST',",
    );
    const r = run(repoWith({ 'api/v1/things/route.ts': src }), '--check');
    expect(r.status, r.out).toBe(1);
  });
});
