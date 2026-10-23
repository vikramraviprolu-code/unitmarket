// BU-2 review B3: fail_safe_without_mfa lifts the MFA rule for an operator POST route, so the route
// inventory prints it, and only /api/ops/stop may carry it.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
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
  it('fails the check on any other route that sets it, whatever its auth', () => {
    for (const [path, auth] of [
      ['/api/ops/other', 'operator'],
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
  it('fails when /api/ops/stop itself is not an operator POST route', () => {
    const r = run(repoWith({ 'api/ops/stop/route.ts': route('/api/ops/stop', 'buyer', FLAG) }));
    expect(r.status).toBe(1);
  });
  it('in this repository exactly one route carries the flag, and it is /api/ops/stop', () => {
    const r = run(REPO_ROOT);
    expect(r.status, r.out).toBe(0);
    const flagged = r.out.split('\n').filter((l) => l.includes('failsafe_no_mfa=true'));
    expect(flagged).toHaveLength(1);
    expect(flagged[0]).toContain('POST /api/ops/stop auth=operator');
  });
});
