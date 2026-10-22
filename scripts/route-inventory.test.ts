import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from './test-helpers';

const SCRIPT = join(REPO_ROOT, 'scripts', 'route-inventory.mjs');

function repoWith(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'route-inv-'));
  for (const [rel, src] of Object.entries(files)) {
    // A key starting with apps/ is relative to the repository root, any other is under src/app.
    const p = rel.startsWith('apps/') ? join(root, rel) : join(root, 'apps/web/src/app', rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, src);
  }
  return root;
}
const run = (root: string, ...args: string[]) => {
  const r = spawnSync(process.execPath, [SCRIPT, '--root', root, ...args], { encoding: 'utf8' });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
};

const GOOD = `import { withRoute, type RouteMeta } from '@umsbx/security';
export const routeMeta: RouteMeta = {
  path: '/api/quotes',
  method: 'POST',
  auth: 'buyer',
  csrf: true,
  rate: { name: 'quote', per: 'actor', limit: 30, window_ms: 60000 },
  max_body_bytes: 8192,
  idempotent: false,
  risk: 'low',
};
export const POST = withRoute(routeMeta, schema, handler);
`;

describe('route-inventory', () => {
  it('route_inventory: --check fails when a route file lacks RouteMeta (SOP 5)', () => {
    const root = repoWith({
      'api/quotes/route.ts': GOOD,
      'api/orders/route.ts': 'export async function POST() { return new Response(null); }\n',
    });
    const r = run(root, '--check');
    expect(r.status).toBe(1);
    expect(r.out).toContain('api/orders/route.ts');
    expect(r.out).toMatch(/RouteMeta/);
  });

  it('passes and lists the route when every route file declares valid RouteMeta', () => {
    const r = run(repoWith({ 'api/quotes/route.ts': GOOD }), '--check');
    expect(r.status).toBe(0);
    expect(r.out).toContain('/api/quotes');
    expect(r.out).toContain('route-inventory: ok');
  });

  it('fails when meta.path does not match the file location', () => {
    const r = run(repoWith({ 'api/other/route.ts': GOOD }), '--check');
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/path/);
  });

  it('fails on a POST route without csrf and on an unknown auth rule', () => {
    const noCsrf = GOOD.replace('csrf: true', 'csrf: false');
    expect(run(repoWith({ 'api/quotes/route.ts': noCsrf }), '--check').status).toBe(1);
    const badAuth = GOOD.replace("'buyer'", "'anyone'");
    expect(run(repoWith({ 'api/quotes/route.ts': badAuth }), '--check').status).toBe(1);
  });

  it('route groups and dynamic segments map to the URL path', () => {
    const src = GOOD.replace('/api/quotes', '/api/orders/[id]')
      .replace("'POST'", "'GET'")
      .replace('export const POST', 'export const GET')
      .replace('csrf: true', 'csrf: false');
    const r = run(repoWith({ '(shop)/api/orders/[id]/route.ts': src }), '--check');
    expect(r.out).toContain('route-inventory: ok');
    expect(r.status).toBe(0);
  });

  it('passes on the repository as it stands', () => {
    const r = run(REPO_ROOT, '--check');
    expect(r.status).toBe(0);
  });

  // Review H4: the literal alone proves nothing; the handler export must use it.
  describe('handlers must be built with withRoute(routeMeta, ...)', () => {
    const fails = (files: Record<string, string>, pattern: RegExp) => {
      const r = run(repoWith(files), '--check');
      expect(r.status).toBe(1);
      expect(r.out).toMatch(pattern);
    };

    it('a raw exported POST function next to a routeMeta literal fails', () => {
      fails(
        {
          'api/quotes/route.ts':
            GOOD.replace(/export const POST.*\n/, '') +
            'export async function POST() { return new Response(null); }\n',
        },
        /withRoute/,
      );
    });
    it('a raw exported const handler fails', () => {
      fails(
        {
          'api/quotes/route.ts':
            GOOD.replace(/export const POST.*\n/, '') +
            'export const POST = async () => new Response(null);\n',
        },
        /withRoute/,
      );
    });
    it('a re-exported or aliased handler fails', () => {
      fails(
        {
          'api/quotes/route.ts':
            GOOD.replace(/export const POST.*\n/, '') +
            'const h = withRoute(routeMeta, s, f);\nexport { h as POST };\n',
        },
        /withRoute/,
      );
      fails(
        {
          'api/quotes/route.ts':
            GOOD.replace(/export const POST.*\n/, '') + "export { POST } from './impl';\n",
        },
        /withRoute/,
      );
    });
    it('withRoute named only in a comment or string does not count', () => {
      fails(
        {
          'api/quotes/route.ts':
            GOOD.replace(/export const POST.*\n/, '') +
            "// withRoute(routeMeta, a, b)\nexport const POST = async () => new Response('withRoute(routeMeta');\n",
        },
        /withRoute/,
      );
    });
    it('a handler built with another meta fails', () => {
      fails(
        { 'api/quotes/route.ts': GOOD.replace('withRoute(routeMeta', 'withRoute(otherMeta') },
        /withRoute/,
      );
    });
    it('the exported verb must match routeMeta.method', () => {
      fails(
        { 'api/quotes/route.ts': GOOD.replace('export const POST', 'export const GET') },
        /method/,
      );
      fails(
        { 'api/quotes/route.ts': GOOD + 'export const DELETE = withRoute(routeMeta, s, f);\n' },
        /method/,
      );
    });
    it('a route file that exports no handler fails', () => {
      fails(
        { 'api/quotes/route.ts': GOOD.replace(/export const POST.*\n/, '') },
        /no exported handler/,
      );
    });
    it('route.js, route.mjs, route.jsx files are scanned too', () => {
      for (const ext of ['js', 'mjs', 'jsx', 'mts']) {
        fails(
          {
            [`api/orders/route.${ext}`]:
              'export async function POST() { return new Response(null); }\n',
          },
          /RouteMeta/,
        );
      }
    });
    it('apps/web/app and the pages router are scanned; pages/api is refused', () => {
      fails(
        {
          'apps/web/app/api/orders/route.ts':
            'export async function POST() { return new Response(null); }\n',
        },
        /RouteMeta/,
      );
      fails({ 'apps/web/pages/api/orders.ts': 'export default function h() {}\n' }, /pages\/api/);
      fails(
        { 'apps/web/src/pages/api/orders/index.js': 'module.exports = () => {};\n' },
        /pages\/api/,
      );
    });
    it('apps/web/app without src passes with a good route', () => {
      const r = run(repoWith({ 'apps/web/app/api/quotes/route.ts': GOOD }), '--check');
      expect(r.status).toBe(0);
    });
  });

  it('check:routes is a package script and runs in ci and in the CI workflow', () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts['check:routes']).toContain('route-inventory.mjs --check');
    expect(pkg.scripts['ci']).toContain('check:routes');
    const wf = readFileSync(join(REPO_ROOT, '.github/workflows/ci.yml'), 'utf8');
    expect(wf).toContain('pnpm check:routes');
  });
});

// Opus review 4 M6: the initializer must be exactly withRoute(routeMeta, ...); server actions are
// not inventoried, so a 'use server' file is refused.
describe('route-inventory AST rules (review 4 M6)', () => {
  const withHandler = (line: string) => GOOD.replace(/export const POST = .*\n/, `${line}\n`);
  it.each([
    ['conditional', 'export const POST = cond ? raw : withRoute(routeMeta, schema, handler);'],
    ['logical and', 'export const POST = withRoute(routeMeta, schema, handler) && raw;'],
    ['nullish', 'export const POST = raw ?? withRoute(routeMeta, schema, handler);'],
    ['wrapped call', 'export const POST = wrap(withRoute(routeMeta, schema, handler));'],
    ['other meta', 'export const POST = withRoute(otherMeta, schema, handler);'],
    ['sequence', 'export const POST = (0, raw, withRoute(routeMeta, schema, handler));'],
    ['member call', 'export const POST = lib.withRoute(routeMeta, schema, handler);'],
    ['no call', 'export const POST = withRoute;'],
    [
      'stream wrapper outside the allowed file',
      'export const POST = withStream(withRoute(routeMeta, schema, handler));',
    ],
    ['other deps binding', 'export const POST = withRoute(routeMeta, schema, handler)(evil);'],
    [
      'two arguments bound',
      'export const POST = withRoute(routeMeta, schema, handler)(securityDeps, 1);',
    ],
  ])('refuses %s', (_n, line) => {
    const r = run(repoWith({ 'api/quotes/route.ts': withHandler(line) }), '--check');
    expect(r.status, r.out).toBe(1);
    expect(r.out).toContain('api/quotes/route.ts');
  });
  it('accepts parentheses, satisfies and a type assertion around the exact call', () => {
    for (const line of [
      'export const POST = (withRoute(routeMeta, schema, handler));',
      'export const POST = withRoute(routeMeta, schema, handler) as unknown as Handler;',
      'export const POST: Handler = withRoute(routeMeta, schema, handler);',
      'export const POST = withRoute(routeMeta, schema, handler)(securityDeps);',
    ])
      expect(run(repoWith({ 'api/quotes/route.ts': withHandler(line) }), '--check').status).toBe(0);
  });
  it.each([
    ['file level', "'use server';\nexport async function act() { return 1; }\n"],
    ['function level', "export async function act() {\n  'use server';\n  return 1;\n}\n"],
    ['double quotes', '"use server";\nexport const a = 1;\n'],
  ])('refuses a use-server action (%s) anywhere under apps/web', (_n, src) => {
    const r = run(
      repoWith({ 'api/quotes/route.ts': GOOD, 'apps/web/src/lib/actions.ts': src }),
      '--check',
    );
    expect(r.status, r.out).toBe(1);
    expect(r.out).toContain('apps/web/src/lib/actions.ts');
    expect(r.out).toMatch(/use server/);
  });
});
