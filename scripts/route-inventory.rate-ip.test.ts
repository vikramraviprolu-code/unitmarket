// AI-H: the route inventory reads and prints the optional `rate_ip` rule, and refuses one that is not per ip.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from './test-helpers';

const SCRIPT = join(REPO_ROOT, 'scripts', 'route-inventory.mjs');
const src = (ipRule: string) => `import { withRoute, type RouteMeta } from '@umsbx/security';
export const routeMeta: RouteMeta = {
  path: '/api/discover',
  method: 'POST',
  auth: 'buyer',
  csrf: true,
  rate: { name: 'discovery', per: 'actor', limit: 20, window_ms: 3_600_000 },
  rate_ip: ${ipRule},
  max_body_bytes: 4096,
  idempotent: false,
  risk: 'medium',
};
export const POST = withRoute(routeMeta, schema, handler);
`;
function run(source: string) {
  const root = mkdtempSync(join(tmpdir(), 'route-inv-ip-'));
  const p = join(root, 'apps/web/src/app/api/discover/route.ts');
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, source);
  const r = spawnSync(process.execPath, [SCRIPT, '--root', root, '--check'], { encoding: 'utf8' });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

describe('route-inventory rate_ip (AI-H)', () => {
  it('lists the per-ip rule next to the actor rule', () => {
    const r = run(src("{ name: 'discovery-ip', per: 'ip', limit: 40, window_ms: 3_600_000 }"));
    expect(r.status).toBe(0);
    expect(r.out).toContain('rate=discovery 20/3600000ms actor');
    expect(r.out).toContain('rate_ip=discovery-ip 40/3600000ms ip');
  });
  it('refuses a rate_ip that is not per ip', () => {
    const r = run(src("{ name: 'discovery-ip', per: 'actor', limit: 40, window_ms: 3_600_000 }"));
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/rate_ip/);
  });
  it('the real discovery routes carry the per-ip rule', () => {
    const r = spawnSync(process.execPath, [SCRIPT, '--root', REPO_ROOT, '--check'], {
      encoding: 'utf8',
    });
    expect(r.status).toBe(0);
    const lines = r.stdout.split('\n');
    for (const path of ['/api/discover', '/api/briefs'])
      expect(lines.find((l) => l.includes(` ${path} `))).toContain(
        'rate_ip=discovery-ip 40/3600000ms ip',
      );
  });
});
