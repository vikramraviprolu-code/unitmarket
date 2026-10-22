import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from './test-helpers';

const SCRIPT = join(REPO_ROOT, 'scripts', 'route-inventory.mjs');

function repoWith(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'route-inv-'));
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
      .replace('csrf: true', 'csrf: false');
    const r = run(repoWith({ '(shop)/api/orders/[id]/route.ts': src }), '--check');
    expect(r.out).toContain('route-inventory: ok');
    expect(r.status).toBe(0);
  });

  it('passes on the repository as it stands', () => {
    const r = run(REPO_ROOT, '--check');
    expect(r.status).toBe(0);
  });
});
