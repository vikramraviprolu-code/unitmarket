// BU-2 review B3 / INT-CTL: fail_safe_without_mfa lifts the MFA rule for an operator POST route, so the route
// inventory prints it, and only /api/ops/stop and the two `.../off` routes (switches and API exposure) may carry it.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from './test-helpers';

const SCRIPT = join(REPO_ROOT, 'scripts', 'route-inventory.mjs');
const run = (root: string) => {
  const r = spawnSync(process.execPath, [SCRIPT, '--root', root, '--check'], { encoding: 'utf8' });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
};
const route = (path: string, auth: string, extra: string, method = 'POST') => `
export const routeMeta: RouteMeta = {
  path: '${path}',
  method: '${method}',
  auth: '${auth}',
  csrf: ${method === 'POST'},
  rate: null,
  max_body_bytes: 1024,
  idempotent: false,
  risk: 'high',${extra}
};
export const ${method} = withRoute(routeMeta, schema, handler);
`;
const FLAG = '\n  fail_safe_without_mfa: true,';
function repoWith(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'route-failsafe-'));
  for (const [rel, src] of Object.entries(files)) {
    const p = join(root, 'apps/web/src/app', rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, src);
  }
  return root;
}

describe('fail_safe_without_mfa in the route inventory', () => {
  it('is printed for /api/ops/stop and passes the check', () => {
    const r = run(repoWith({ 'api/ops/stop/route.ts': route('/api/ops/stop', 'operator', FLAG) }));
    expect(r.status, r.out).toBe(0);
    const line = r.out.split('\n').find((l) => l.includes('/api/ops/stop')) ?? '';
    expect(line).toContain('failsafe_no_mfa=true');
  });
  it('is not printed for a route without it', () => {
    const r = run(repoWith({ 'api/ops/other/route.ts': route('/api/ops/other', 'operator', '') }));
    expect(r.out).not.toContain('failsafe_no_mfa');
  });
  it('is printed for the two INT-CTL off paths and passes the check', () => {
    const r = run(
      repoWith({
        'api/ops/switches/[name]/off/route.ts': route('/api/ops/switches/[name]/off', 'operator', FLAG),
        'api/ops/api-exposure/[group]/off/route.ts': route(
          '/api/ops/api-exposure/[group]/off',
          'operator',
          FLAG,
        ),
      }),
    );
    expect(r.status, r.out).toBe(0);
    expect(r.out.split('\n').filter((l) => l.includes('failsafe_no_mfa=true'))).toHaveLength(2);
  });
  it('fails the check on either .../on path and on any other route that sets it, whatever its auth', () => {
    for (const [path, auth] of [
      ['/api/ops/other', 'operator'],
      ['/api/ops/switches/[name]/on', 'operator'],
      ['/api/ops/api-exposure/[group]/on', 'operator'],
      ['/api/orders', 'buyer'],
      ['/api/things', 'publisher'],
    ] as const) {
      const r = run(
        repoWith({ [`${path.replace('/api/', 'api/')}/route.ts`]: route(path, auth, FLAG) }),
      );
      expect(r.status, `${path} ${r.out}`).toBe(1);
      expect(r.out).toContain('fail_safe_without_mfa');
    }
  });
  it('fails when an allowed path is not an operator POST route', () => {
    for (const path of [
      '/api/ops/stop',
      '/api/ops/switches/[name]/off',
      '/api/ops/api-exposure/[group]/off',
    ]) {
      const r = run(repoWith({ [`${path.replace('/api/', 'api/')}/route.ts`]: route(path, 'buyer', FLAG) }));
      expect(r.status, path).toBe(1);
    }
  });
  it('in this repository exactly three routes carry the flag, and they are the three allowed paths', () => {
    const r = run(REPO_ROOT);
    expect(r.status, r.out).toBe(0);
    const flagged = r.out.split('\n').filter((l) => l.includes('failsafe_no_mfa=true'));
    expect(flagged).toHaveLength(3);
    expect(flagged.map((l) => l.split(' auth=')[0]).sort()).toEqual([
      'POST /api/ops/api-exposure/[group]/off',
      'POST /api/ops/stop',
      'POST /api/ops/switches/[name]/off',
    ]);
    for (const l of flagged) expect(l).toContain('auth=operator');
  });
  it('the off handlers pass only a literal false and the on handlers never reach the off path', () => {
    for (const f of [
      'apps/web/src/app/api/ops/switches/[name]/off/route.ts',
      'apps/web/src/app/api/ops/api-exposure/[group]/off/route.ts',
    ]) {
      const src = readFileSync(join(REPO_ROOT, f), 'utf8')
        .replace(/\/\/.*$/gm, '')
        .replace(/\/\*[\s\S]*?\*\//g, '');
      expect(src, f).toMatch(/\bfalse\b/);
      expect(src, f).not.toMatch(/\btrue\b/);
      expect(src, f).not.toMatch(/input\.(on|enabled)/);
    }
  });
});
