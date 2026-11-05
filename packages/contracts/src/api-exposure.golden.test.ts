// INT-CTL / CTL.4: the registry of API groups. Every apikey route of the inventory maps to exactly one group;
// api-keys (owner) and status (public) map to none; the SQL CHECK lists of migration 0026 equal the consts (R2-2).
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  API_GROUPS,
  EXPOSURE_REASON_CODES,
  GROUP_OF_PATH,
  SEED_EPOCH,
  groupOfPath,
} from './api-exposure';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const inventory = (): { method: string; path: string; auth: string }[] => {
  const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'route-inventory.mjs')], {
    encoding: 'utf8',
  });
  expect(r.status, r.stderr).toBe(0);
  return r.stdout
    .split('\n')
    .map((l) => /^(GET|POST|PATCH|DELETE) (\/\S+) auth=(\w+)/.exec(l))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ method: m[1]!, path: m[2]!, auth: m[3]! }));
};

describe('the group list', () => {
  it('is the eight REST and MCP groups plus the six MCP tools (F7)', () => {
    expect([...API_GROUPS]).toEqual([
      'catalogue',
      'orders',
      'library',
      'mandates',
      'webhooks',
      'seller',
      'ops',
      'mcp',
      'mcp:search_catalogue',
      'mcp:get_offer',
      'mcp:propose_pack',
      'mcp:open_unit',
      'mcp:check_budget',
      'mcp:buy_unit',
    ]);
    expect([...EXPOSURE_REASON_CODES]).toEqual([
      'incident',
      'partner_request',
      'maintenance',
      'other',
    ]);
    expect(SEED_EPOCH).toBe('1970-01-01T00:00:00Z');
  });

  it('the prefix table is the one of the spec (F1)', () => {
    expect(GROUP_OF_PATH).toEqual({
      catalogue: 'catalogue',
      briefs: 'catalogue',
      offers: 'catalogue',
      orders: 'orders',
      quotes: 'orders',
      approvals: 'orders',
      library: 'library',
      mandates: 'mandates',
      'webhook-subscriptions': 'webhooks',
      seller: 'seller',
      ops: 'ops',
      mcp: 'mcp',
    });
  });
});

describe('every apikey route maps to exactly one group', () => {
  it('each apikey route of the inventory has a group, and every group of the table is used', () => {
    const routes = inventory().filter((r) => r.auth === 'apikey');
    expect(routes.length).toBeGreaterThan(30);
    const unmapped = routes.filter((r) => groupOfPath(r.path) === null).map((r) => r.path);
    expect(unmapped).toEqual([]);
    const used = new Set(routes.map((r) => groupOfPath(r.path)));
    for (const g of new Set(Object.values(GROUP_OF_PATH))) expect(used.has(g), g).toBe(true);
  });

  it('api-keys (owner) and status (public) are never gated', () => {
    expect(groupOfPath('/api/v1/api-keys')).toBeNull();
    expect(groupOfPath('/api/v1/api-keys/[id]')).toBeNull();
    expect(groupOfPath('/api/v1/status')).toBeNull();
    const rest = inventory().filter((r) => r.auth !== 'apikey' && r.path.startsWith('/api/v1/'));
    for (const r of rest) expect(groupOfPath(r.path), r.path).toBeNull();
  });

  it('a path outside /api/v1, a lookalike prefix and an empty prefix map to none', () => {
    for (const p of [
      '/api/orders',
      '/api/v10/orders',
      '/api/v1/',
      '/api/v1',
      '/api/v1/orders2',
      '/api/v1/ORDERS',
    ])
      expect(groupOfPath(p), p).toBeNull();
    expect(groupOfPath('/api/v1/orders/[ref]/cancel')).toBe('orders');
    expect(groupOfPath('/api/v1/webhook-subscriptions/[id]/deliveries')).toBe('webhooks');
  });
});

describe('the SQL CHECK lists equal the consts (R2-2)', () => {
  const dir = join(ROOT, 'packages', 'db', 'migrations', 'common');
  const file = readdirSync(dir).find((f) => /^\d{4}_api_exposure\.sql$/.test(f));
  const sql = (): string =>
    readFileSync(join(dir, file ?? 'missing'), 'utf8').replace(/--.*$/gm, '');
  const listIn = (re: RegExp): string[] => {
    const m = re.exec(sql());
    expect(m, String(re)).not.toBeNull();
    return [...m![1]!.matchAll(/'([^']+)'/g)].map((x) => x[1]!);
  };
  it('is migration 0026', () => expect(file).toBe('0026_api_exposure.sql'));
  it('group_name IN (...) lists API_GROUPS', () => {
    expect(listIn(/group_name\s+IN\s*\(([^)]*)\)/i)).toEqual([...API_GROUPS]);
  });
  it('reason_code IN (...) lists the reason codes', () => {
    expect(listIn(/reason_code\s+IN\s*\(([^)]*)\)/i)).toEqual([...EXPOSURE_REASON_CODES]);
  });
});
