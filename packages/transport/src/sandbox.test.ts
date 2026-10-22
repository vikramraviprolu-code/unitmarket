import { describe, expect, it } from 'vitest';
import { createSandboxTransport } from './sandbox';
import { req } from './test-support';

describe('sandbox transport (sealed MVP-A stub)', () => {
  it('sandbox transport stub always blocked connect_off', async () => {
    const t = createSandboxTransport();
    expect(t.kind).toBe('sandbox');
    for (const r of [
      req('create_order', '/v2/checkout/orders'),
      req('get_order', '/v2/checkout/orders/ABC123'),
      req('get_order', 'https://evil.example/x'),
      req('oauth_token', '/v1/oauth2/token', { method: 'POST' }),
    ]) {
      await expect(t.send(r)).resolves.toEqual({ kind: 'blocked', by: 'connect_off' });
    }
  });
});
