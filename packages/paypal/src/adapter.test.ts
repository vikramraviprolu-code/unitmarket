import { describe, expect, it } from 'vitest';
import { APPROVE_HOST, createReq, harness, resp, scriptedTransport, secret } from './test-support';

const hdr = (h: Record<string, string>, name: string) =>
  Object.entries(h).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];

const createdBody = (links: unknown[]) => ({ id: 'SBXORD00001', status: 'CREATED', links });
const link = (href: string, rel: string) => ({ href, rel, method: 'GET' });

describe('request rules', () => {
  it('request id over 108 chars refused before send', async () => {
    const t = scriptedTransport(() => resp(201, createdBody([])));
    const { adapter } = harness(t);
    const res = await adapter.createOrder(createReq({ request_id: 'k'.repeat(109) }));
    expect(res).toMatchObject({ kind: 'rejected', http: 400, name: 'REQUEST_ID_INVALID' });
    const cap = await adapter.captureOrder({
      provider_order_id: 'SBXORD00001',
      request_id: 'k'.repeat(109),
    });
    expect(cap).toMatchObject({ kind: 'rejected', http: 400, name: 'REQUEST_ID_INVALID' });
    const ref = await adapter.refundCapture({
      capture_id: 'SBXCAP00001',
      request_id: 'k'.repeat(109),
      amount: null,
      note: 'n',
    });
    expect(ref).toMatchObject({ kind: 'rejected', http: 400, name: 'REQUEST_ID_INVALID' });
    expect(t.sent).toHaveLength(0);
  });

  it('a request id of exactly 108 chars is sent; an empty or non-printable one is refused', async () => {
    const t = scriptedTransport(() =>
      resp(201, createdBody([link(`https://${APPROVE_HOST}/c?token=A`, 'approve')])),
    );
    const { adapter } = harness(t);
    expect((await adapter.createOrder(createReq({ request_id: 'k'.repeat(108) }))).kind).toBe(
      'created',
    );
    expect(t.sent).toHaveLength(1);
    for (const bad of ['', 'has space', 'new\nline', 'café']) {
      const r = await adapter.captureOrder({ provider_order_id: 'SBXORD00001', request_id: bad });
      expect(r, JSON.stringify(bad)).toMatchObject({
        kind: 'rejected',
        name: 'REQUEST_ID_INVALID',
      });
    }
    expect(t.sent).toHaveLength(1);
  });

  it('every POST sends the request id, Prefer, Content-Type and a bearer token', async () => {
    const t = scriptedTransport((r) =>
      r.operation === 'oauth_token'
        ? resp(200, { access_token: 'tok-1', expires_in: 3600, token_type: 'Bearer' })
        : r.operation === 'create_order'
          ? resp(201, createdBody([link(`https://${APPROVE_HOST}/c?token=A`, 'approve')]))
          : resp(201, { id: 'SBXORD00001', status: 'COMPLETED', purchase_units: [] }),
    );
    const { adapter } = harness(t, {
      credentials: { client_id: secret('id'), client_secret: secret('sec') },
    });
    await adapter.createOrder(createReq());
    await adapter.captureOrder({ provider_order_id: 'SBXORD00001', request_id: 'umsK-abc' });
    const posts = t.sent.filter((r) => r.operation !== 'oauth_token');
    expect(posts.map((r) => r.operation)).toEqual(['create_order', 'capture_order']);
    for (const r of posts) {
      expect(hdr(r.headers, 'PayPal-Request-Id')).toBe(
        r.operation === 'create_order' ? createReq().request_id : 'umsK-abc',
      );
      expect(hdr(r.headers, 'Prefer')).toBe('return=representation');
      expect(hdr(r.headers, 'Content-Type')).toBe('application/json');
      expect(hdr(r.headers, 'Authorization')).toBe('Bearer tok-1');
    }
    expect(posts[1]?.path).toBe('/v2/checkout/orders/SBXORD00001/capture');
    expect(posts[1]?.body).toBe('{}');
    expect(JSON.parse(posts[0]?.body ?? 'null')).toMatchObject({ intent: 'CAPTURE' });
    // oauth was fetched once for both calls
    expect(t.sent.filter((r) => r.operation === 'oauth_token')).toHaveLength(1);
  });

  it('a path id that is not upper-case alphanumeric is refused before send', async () => {
    const t = scriptedTransport(() => resp(200, {}));
    const { adapter } = harness(t);
    for (const bad of ['abc', '../x', 'A/B', 'A?B', 'A'.repeat(37), '']) {
      const r = await adapter.getOrder(bad);
      expect(r, bad).toMatchObject({ kind: 'rejected', http: 400, name: 'INVALID_ID' });
    }
    expect(await adapter.getCapture('a/b')).toMatchObject({ kind: 'rejected', name: 'INVALID_ID' });
    expect(t.sent).toHaveLength(0);
  });

  it('without credentials a sandbox transport is not called', async () => {
    const t = scriptedTransport(() => resp(200, {}), 'sandbox');
    const { adapter } = harness(t, { credentials: null });
    expect(await adapter.getOrder('SBXORD00001')).toEqual({
      kind: 'unavailable',
      retry_after_ms: null,
    });
    expect(t.sent).toHaveLength(0);
    expect(adapter.environment).toBe('sandbox');
  });

  it('environment follows the transport kind', () => {
    expect(harness(scriptedTransport(() => resp(200, {}), 'dryrun')).adapter.environment).toBe(
      'dryrun',
    );
  });
});

describe('approve link', () => {
  const run = async (links: unknown[]) => {
    const { adapter } = harness(scriptedTransport(() => resp(201, createdBody(links))));
    return adapter.createOrder(createReq());
  };

  it('payer-action is preferred over approve', async () => {
    const r = await run([
      link(`https://${APPROVE_HOST}/approve?token=A`, 'approve'),
      link(`https://${APPROVE_HOST}/payer?token=A`, 'payer-action'),
    ]);
    expect(r).toMatchObject({
      kind: 'created',
      approve_url: `https://${APPROVE_HOST}/payer?token=A`,
    });
  });

  it('approve link with other host refused', async () => {
    const bad = [
      'https://evil.example.invalid/checkoutnow?token=A',
      `https://${APPROVE_HOST}.evil.example.invalid/x`,
      `https://evil.example.invalid/${APPROVE_HOST}`,
      `https://user@evil.example.invalid/`,
      `https://${APPROVE_HOST}@evil.example.invalid/`,
      `http://${APPROVE_HOST}/x`,
      `https://${APPROVE_HOST}:8443/x`,
      `//${APPROVE_HOST}/x`,
      `/checkoutnow?token=A`,
      `javascript:alert(1)`,
      'not a url',
    ];
    for (const href of bad) {
      const r = await run([link(href, 'payer-action')]);
      expect(r, href).toMatchObject({ kind: 'rejected', name: 'APPROVE_LINK_INVALID' });
    }
  });

  it('a payer-action link on a bad host is not rescued by a good approve link', async () => {
    const r = await run([
      link('https://evil.example.invalid/x', 'payer-action'),
      link(`https://${APPROVE_HOST}/approve?token=A`, 'approve'),
    ]);
    expect(r).toMatchObject({ kind: 'rejected', name: 'APPROVE_LINK_INVALID' });
  });

  it('no approving link at all is refused', async () => {
    expect(await run([link('/v2/checkout/orders/SBXORD00001', 'self')])).toMatchObject({
      kind: 'rejected',
      name: 'APPROVE_LINK_INVALID',
    });
  });
});

describe('token handling in calls', () => {
  it('a 401 on a GET refreshes the token once and retries once', async () => {
    let gets = 0;
    let tokens = 0;
    const t = scriptedTransport((r) => {
      if (r.operation === 'oauth_token') {
        return resp(200, {
          access_token: `tok-${++tokens}`,
          expires_in: 3600,
          token_type: 'Bearer',
        });
      }
      gets += 1;
      return gets === 1
        ? resp(401, { name: 'AUTHENTICATION_FAILURE' })
        : resp(404, { name: 'RESOURCE_NOT_FOUND', debug_id: 'd' });
    });
    const { adapter } = harness(t, {
      credentials: { client_id: secret('i'), client_secret: secret('s') },
    });
    expect(await adapter.getOrder('SBXORD00001')).toEqual({ kind: 'not_found', debug_id: 'd' });
    const gs = t.sent.filter((r) => r.operation === 'get_order');
    expect(gs).toHaveLength(2);
    expect(hdr(gs[0]?.headers ?? {}, 'authorization')).toBe('Bearer tok-1');
    expect(hdr(gs[1]?.headers ?? {}, 'authorization')).toBe('Bearer tok-2');
  });

  it('a second 401 on a GET is unavailable and is not retried again', async () => {
    const t = scriptedTransport((r) =>
      r.operation === 'oauth_token'
        ? resp(200, { access_token: 'tok', expires_in: 3600, token_type: 'Bearer' })
        : resp(401, { name: 'AUTHENTICATION_FAILURE' }),
    );
    const { adapter } = harness(t, {
      credentials: { client_id: secret('i'), client_secret: secret('s') },
    });
    expect(await adapter.getOrder('SBXORD00001')).toEqual({
      kind: 'unavailable',
      retry_after_ms: null,
    });
    expect(t.sent.filter((r) => r.operation === 'get_order')).toHaveLength(2);
  });

  it('a POST is never retried by the adapter, even after a 401, 429 or 500', async () => {
    for (const status of [401, 429, 500, 503]) {
      const t = scriptedTransport((r) =>
        r.operation === 'oauth_token'
          ? resp(200, { access_token: 'tok', expires_in: 3600, token_type: 'Bearer' })
          : resp(status, { name: 'X' }),
      );
      const { adapter } = harness(t, {
        credentials: { client_id: secret('i'), client_secret: secret('s') },
      });
      const r = await adapter.captureOrder({
        provider_order_id: 'SBXORD00001',
        request_id: 'umsK-1',
      });
      expect(r.kind, String(status)).toBe('unavailable');
      expect(
        t.sent.filter((x) => x.operation === 'capture_order'),
        String(status),
      ).toHaveLength(1);
    }
  });

  it('a GET 5xx or 429 is not retried either (backoff belongs to the caller)', async () => {
    const t = scriptedTransport(() => resp(429, {}, { 'retry-after': '4' }));
    const { adapter } = harness(t);
    expect(await adapter.getOrder('SBXORD00001')).toEqual({
      kind: 'unavailable',
      retry_after_ms: 4000,
    });
    expect(t.sent).toHaveLength(1);
  });
});

describe('transport outcomes', () => {
  it('timeout, network error and blocked map to the port failures', async () => {
    const outcomes = [
      [{ kind: 'timeout' as const }, { kind: 'timeout' }],
      [{ kind: 'network_error' as const, code: 'ECONNRESET' }, { kind: 'timeout' }],
      [
        { kind: 'blocked' as const, by: 'dry_run_miss' as const },
        { kind: 'blocked', by: 'dry_run_miss' },
      ],
      [
        { kind: 'blocked' as const, by: 'kill_switch' as const },
        { kind: 'blocked', by: 'kill_switch' },
      ],
    ] as const;
    for (const [tr, expected] of outcomes) {
      const { adapter, records } = harness(scriptedTransport(() => tr));
      expect(await adapter.getOrder('SBXORD00001')).toEqual(expected);
      expect(
        await adapter.captureOrder({ provider_order_id: 'SBXORD00001', request_id: 'k' }),
      ).toEqual(expected);
      expect(records).toHaveLength(2);
      expect(records[0]?.http_status).toBeNull();
    }
  });

  it('a record that fails to write does not change the result', async () => {
    const { createPayPalAdapter } = await import('./adapter');
    const { mutableClock, memoryLogger } = await import('./test-support');
    const adapter = createPayPalAdapter({
      transport: scriptedTransport(() => resp(404, { name: 'RESOURCE_NOT_FOUND' })),
      clock: mutableClock(),
      log: memoryLogger(),
      credentials: null,
      record: async () => {
        throw new Error('db down');
      },
    });
    expect(await adapter.getOrder('SBXORD00001')).toEqual({ kind: 'not_found', debug_id: null });
  });

  it('writes one call record per transport call with template path and status', async () => {
    const { adapter, records } = harness(
      scriptedTransport(() => resp(404, { name: 'RESOURCE_NOT_FOUND', debug_id: 'dbg-9' })),
    );
    await adapter.getOrder('SBXORD00001');
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      operation: 'get_order',
      method: 'GET',
      path_template: '/v2/checkout/orders/{id}',
      http_status: 404,
      debug_id: 'dbg-9',
      transport_kind: 'dryrun',
      duration_ms: 3,
    });
    expect(records[0]?.outcome).toContain('not_found');
  });
});

describe('webhook verification (MVP-A)', () => {
  it('returns unverifiable until MVP-C', async () => {
    const { adapter } = harness(scriptedTransport(() => resp(200, {})));
    expect(await adapter.verifyWebhook({ headers: {}, raw_body: '{}' })).toEqual({
      kind: 'unverifiable',
    });
  });
});
