// BU-2 review nit folded into BU-7: routeMeta must be a plain object literal with plain keys, so the
// fail_safe_without_mfa flag (and any other field) cannot hide behind a computed key or a spread.
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
const repoWith = (rel: string, src: string): string => {
  const root = mkdtempSync(join(tmpdir(), 'route-literal-'));
  const p = join(root, 'apps/web/src/app', rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, src);
  return root;
};
const FIELDS = `
  path: '/api/ops/stop',
  method: 'POST',
  auth: 'operator',
  csrf: true,
  rate: null,
  max_body_bytes: 1024,
  idempotent: false,
  risk: 'high',`;
const VERB = `export const POST = withRoute(routeMeta, schema, handler);\n`;
const file = (head: string, body: string) => `${head}
export const routeMeta: RouteMeta = {${body}
};
${VERB}`;

describe('routeMeta is a plain object literal', () => {
  it('accepts the plain form with the flag as a plain key', () => {
    const r = run(
      repoWith('api/ops/stop/route.ts', file('', `${FIELDS}\n  fail_safe_without_mfa: true,`)),
    );
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain('failsafe_no_mfa=true');
  });
  it('rejects a computed key that spells the flag', () => {
    const r = run(
      repoWith(
        'api/ops/other/route.ts',
        file(
          '',
          `${FIELDS.replace('/api/ops/stop', '/api/ops/other')}\n  ['fail_safe_' + 'without_mfa']: true,`,
        ),
      ),
    );
    expect(r.status, r.out).toBe(1);
    expect(r.out).toMatch(/computed/);
    expect(r.out).toContain('routeMeta');
  });
  it('rejects a computed key through a variable', () => {
    const r = run(
      repoWith(
        'api/ops/other/route.ts',
        file(
          "const k = 'fail_safe_without_mfa';",
          `${FIELDS.replace('/api/ops/stop', '/api/ops/other')}\n  [k]: true,`,
        ),
      ),
    );
    expect(r.status, r.out).toBe(1);
    expect(r.out).toMatch(/computed/);
  });
  it('rejects a spread', () => {
    const r = run(
      repoWith(
        'api/ops/other/route.ts',
        file(
          'const flags = { fail_safe_without_mfa: true };',
          `${FIELDS.replace('/api/ops/stop', '/api/ops/other')}\n  ...flags,`,
        ),
      ),
    );
    expect(r.status, r.out).toBe(1);
    expect(r.out).toMatch(/spread/);
  });
  it('rejects a spread even when the route is /api/ops/stop', () => {
    const r = run(
      repoWith(
        'api/ops/stop/route.ts',
        file('const more = {};', `${FIELDS}\n  fail_safe_without_mfa: true,\n  ...more,`),
      ),
    );
    expect(r.status, r.out).toBe(1);
    expect(r.out).toMatch(/spread/);
  });
  it('rejects a routeMeta that is not an object literal', () => {
    const src = `
export const routeMeta: RouteMeta = makeMeta();
${VERB}`;
    const r = run(repoWith('api/ops/other/route.ts', src));
    expect(r.status, r.out).toBe(1);
  });
  it('in this repository every routeMeta is a plain literal', () => {
    const r = run(REPO_ROOT);
    expect(r.status, r.out).toBe(0);
  });
});
