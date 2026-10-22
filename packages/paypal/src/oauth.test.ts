import { describe, expect, it } from 'vitest';
import { createTokenCache } from './oauth';
import { mutableClock, resp, scriptedTransport, secret } from './test-support';
import type { ProviderCallRecord } from './adapter';

const creds = { client_id: secret('test-client-id'), client_secret: secret('test-client-secret') };
const tokenBody = (token: string, expires_in = 3600) => ({
  access_token: token,
  token_type: 'Bearer',
  expires_in,
  scope: 'ignored',
});

function setup(expires_in = 3600) {
  const clock = mutableClock();
  let n = 0;
  const transport = scriptedTransport(() => resp(200, tokenBody(`tok-${++n}`, expires_in)));
  const records: ProviderCallRecord[] = [];
  const cache = createTokenCache({
    transport,
    clock,
    credentials: creds,
    record: async (c) => {
      records.push(c);
    },
  });
  return { clock, transport, cache, records };
}

describe('oauth token cache', () => {
  it('requests a token with basic auth and client_credentials, once', async () => {
    const { transport, cache } = setup();
    const t = await cache.get();
    expect(t).toEqual({ ok: true, value: 'tok-1' });
    const sent = transport.sent[0];
    expect(sent).toMatchObject({
      operation: 'oauth_token',
      method: 'POST',
      path: '/v1/oauth2/token',
      body: 'grant_type=client_credentials',
    });
    const auth = Object.entries(sent?.headers ?? {}).find(
      ([k]) => k.toLowerCase() === 'authorization',
    );
    expect(auth?.[1]).toBe(
      `Basic ${Buffer.from('test-client-id:test-client-secret').toString('base64')}`,
    );
    const ct = Object.entries(sent?.headers ?? {}).find(
      ([k]) => k.toLowerCase() === 'content-type',
    );
    expect(ct?.[1]).toBe('application/x-www-form-urlencoded');
  });

  it('token refreshed 300 s before expiry, single-flight under 20 concurrent calls', async () => {
    const { clock, transport, cache } = setup(3600);

    // 20 concurrent first calls: one request.
    const first = await Promise.all(Array.from({ length: 20 }, () => cache.get()));
    expect(transport.sent).toHaveLength(1);
    expect(new Set(first.map((r) => (r.ok ? r.value : 'x')))).toEqual(new Set(['tok-1']));

    // Still valid one second before issued + expires_in - 300 s.
    clock.advance((3600 - 300) * 1000 - 1000);
    expect(await cache.get()).toEqual({ ok: true, value: 'tok-1' });
    expect(transport.sent).toHaveLength(1);

    // At issued + expires_in - 300 s: refresh, again single flight under 20 callers.
    clock.advance(1000);
    const second = await Promise.all(Array.from({ length: 20 }, () => cache.get()));
    expect(transport.sent).toHaveLength(2);
    expect(new Set(second.map((r) => (r.ok ? r.value : 'x')))).toEqual(new Set(['tok-2']));
  });

  it('a short-lived token (FIX-BPREP L6) is refreshed at half its life, not on every call', async () => {
    const { clock, transport, cache } = setup(200);
    await cache.get();
    await cache.get();
    await cache.get();
    expect(transport.sent).toHaveLength(1);
    clock.advance(99_000);
    await cache.get();
    expect(transport.sent).toHaveLength(1);
    clock.advance(1_000);
    await cache.get();
    expect(transport.sent).toHaveLength(2);
  });

  it('expires_in of exactly 300 s and 301 s also keep the token for half its life', async () => {
    for (const life of [300, 301]) {
      const { clock, transport, cache } = setup(life);
      await cache.get();
      clock.advance((life / 2) * 1000 - 1000);
      await cache.get();
      expect(transport.sent, `life ${life}`).toHaveLength(1);
    }
  });

  it('invalidate forces one new request', async () => {
    const { transport, cache } = setup();
    await cache.get();
    cache.invalidate();
    expect(await cache.get()).toEqual({ ok: true, value: 'tok-2' });
    expect(transport.sent).toHaveLength(2);
  });

  it('a failed fetch is shared by the waiting callers and not cached', async () => {
    const clock = mutableClock();
    let n = 0;
    const transport = scriptedTransport(() =>
      ++n === 1
        ? resp(401, { error: 'invalid_client', error_description: 'Client Authentication failed' })
        : resp(200, tokenBody('tok-ok')),
    );
    const cache = createTokenCache({
      transport,
      clock,
      credentials: creds,
      record: async () => {},
    });
    const bad = await Promise.all(Array.from({ length: 5 }, () => cache.get()));
    expect(transport.sent).toHaveLength(1);
    for (const r of bad)
      expect(r).toEqual({ ok: false, error: { kind: 'unavailable', retry_after_ms: null } });
    expect(await cache.get()).toEqual({ ok: true, value: 'tok-ok' });
    expect(transport.sent).toHaveLength(2);
  });

  it('timeout, blocked and a malformed token body fail without throwing', async () => {
    const clock = mutableClock();
    const cases = [
      [{ kind: 'timeout' as const }, { kind: 'timeout' }],
      [
        { kind: 'blocked' as const, by: 'egress' as const },
        { kind: 'blocked', by: 'egress' },
      ],
      [resp(200, { token_type: 'Bearer' }), { kind: 'unavailable', retry_after_ms: null }],
      [resp(200, 'not json'), { kind: 'unavailable', retry_after_ms: null }],
      [resp(200, tokenBody('t', 0)), { kind: 'unavailable', retry_after_ms: null }],
    ] as const;
    for (const [result, expected] of cases) {
      const cache = createTokenCache({
        transport: scriptedTransport(() => result),
        clock,
        credentials: creds,
        record: async () => {},
      });
      expect(await cache.get()).toEqual({ ok: false, error: expected });
    }
  });

  it('writes a call record that holds no token', async () => {
    const { cache, records } = setup();
    await cache.get();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      operation: 'oauth_token',
      method: 'POST',
      path_template: '/v1/oauth2/token',
      http_status: 200,
      transport_kind: 'dryrun',
    });
    const text = JSON.stringify(records);
    expect(text).not.toContain('tok-1');
    expect(text).not.toContain('test-client-secret');
    expect(text).not.toContain(Buffer.from('test-client-id:test-client-secret').toString('base64'));
  });
});
