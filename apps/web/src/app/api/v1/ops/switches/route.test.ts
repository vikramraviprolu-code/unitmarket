// API-A (O4): the switches route is one read-only GET for an ops:read key, with a fixed budget.
import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

describe('GET /api/v1/ops/switches', () => {
  it('declares its rule and exports no verb that changes anything', async () => {
    const mod = await import('./route');
    expect(mod.routeMeta).toMatchObject({
      path: '/api/v1/ops/switches',
      method: 'GET',
      auth: 'apikey',
      scopes: ['ops:read'],
      csrf: false,
      rate: { per: 'actor', limit: 60, window_ms: 60_000 },
      max_body_bytes: 1024,
      idempotent: false,
      risk: 'low',
    });
    expect(Object.keys(mod).filter((k) => /^(GET|POST|PUT|PATCH|DELETE)$/.test(k))).toEqual([
      'GET',
    ]);
  });
});
