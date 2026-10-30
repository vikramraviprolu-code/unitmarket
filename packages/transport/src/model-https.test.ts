import https from 'node:https';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Secret } from '@umsbx/contracts';
import { fakeRequest } from './https-fake';
import type { Script } from './https-fake';
import { netSpies } from './test-support';
import {
  MODEL_API,
  MODEL_API_VERSION,
  MODEL_DEADLINE_MS,
  MODEL_MAX_REQUEST_BYTES,
  MODEL_MAX_RESPONSE_BYTES,
  MODEL_PATH,
  ModelWireError,
  makeModelHttps,
} from './model-https';

// AI-A. The Claude egress on node:https. Every test drives makeModelHttps with an in-memory request
// function: no socket, no lookup, no fetch, no key. netSpies() proves nothing real is touched.
const KEY = 'SYNTHETIC-MODEL-KEY-not-a-credential-0001';
const secret = (v: string = KEY): Secret => ({
  reveal: () => v,
  toString: () => '[redacted]',
  toJSON: () => '[redacted]',
});

let spies: ReturnType<typeof netSpies>;
beforeEach(() => {
  spies = netSpies();
});
afterEach(() => {
  vi.useRealTimers();
  spies.assertZero();
  spies.spies['global fetch'].mockRestore();
});

function build(script?: Script, apiKey: Secret = secret()) {
  const { request, calls } = fakeRequest(script);
  const wire = makeModelHttps({
    request: request as unknown as typeof https.request,
    agent: new https.Agent({ keepAlive: false }),
    apiKey,
  });
  return { wire, calls };
}
const kindOf = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
  } catch (e) {
    return e instanceof ModelWireError ? e.kind : `other:${String(e)}`;
  }
  return 'resolved';
};

describe('the limits are the AI-A numbers', () => {
  it('one host, one path, 64 KB out, 256 KB in, 20 s, fixed version', () => {
    expect(MODEL_API).toBe('https://api.anthropic.com');
    expect(MODEL_PATH).toBe('/v1/messages');
    expect(MODEL_MAX_REQUEST_BYTES).toBe(64 * 1024);
    expect(MODEL_MAX_RESPONSE_BYTES).toBe(256 * 1024);
    expect(MODEL_DEADLINE_MS).toBe(20_000);
    expect(MODEL_API_VERSION).toBe('2026-10-21');
  });
});

describe('send', () => {
  it('POSTs the body once to the one host and path with exactly the three headers', async () => {
    const { wire, calls } = build({ kind: 'response', status: 200, chunks: ['{"ok":true}'] });
    const body = '{"model":"claude-haiku-5-5"}';
    const r = await wire.send(body);
    expect(r).toEqual({ status: 200, body: '{"ok":true}' });
    expect(calls).toHaveLength(1);
    const o = calls[0]!.options;
    expect(o['method']).toBe('POST');
    expect(o['protocol']).toBe('https:');
    expect(o['hostname']).toBe('api.anthropic.com');
    expect(o['port']).toBe(443);
    expect(o['path']).toBe('/v1/messages');
    expect(o['headers']).toEqual({
      'x-api-key': KEY,
      'anthropic-version': '2026-10-21',
      'content-type': 'application/json',
    });
    expect(calls[0]!.body).toBe(body);
    expect(calls[0]!.ended).toBe(true);
  });
  it('checks certificates, wants TLS 1.2 or newer and uses the agent it was given', async () => {
    const { wire, calls } = build();
    await wire.send('{}');
    const o = calls[0]!.options;
    expect(o['rejectUnauthorized']).toBe(true);
    expect(o['minVersion']).toBe('TLSv1.2');
    expect(o['servername']).toBe('api.anthropic.com');
    expect(o['auth']).toBeUndefined();
    expect(o['insecureHTTPParser']).toBe(false);
  });
  it('hands back any status as it is (429, 500, 529) with the decoded body', async () => {
    for (const status of [400, 401, 429, 500, 529]) {
      const { wire } = build({ kind: 'response', status, chunks: ['{"type":"error"}'] });
      expect(await wire.send('{}')).toEqual({ status, body: '{"type":"error"}' });
    }
  });
  it('decodes UTF-8 across chunk boundaries', async () => {
    const bytes = new TextEncoder().encode('é');
    const { wire } = build({ kind: 'response', chunks: [bytes.slice(0, 1), bytes.slice(1)] });
    expect(await wire.send('{}')).toEqual({ status: 200, body: 'é' });
  });
  it('returns a redirect as a status with an empty body and requests nothing more', async () => {
    const { wire, calls } = build({
      kind: 'response',
      status: 302,
      headers: { Location: 'https://elsewhere.invalid/x' },
      chunks: ['moved'],
    });
    expect(await wire.send('{}')).toEqual({ status: 302, body: '' });
    expect(calls).toHaveLength(1);
  });
});

describe('size caps', () => {
  it('a body of exactly 64 KB goes; one byte more is refused before a socket opens', async () => {
    const ok = build();
    await ok.wire.send('x'.repeat(MODEL_MAX_REQUEST_BYTES));
    expect(ok.calls).toHaveLength(1);
    const big = build();
    expect(await kindOf(big.wire.send('x'.repeat(MODEL_MAX_REQUEST_BYTES + 1)))).toBe(
      'request_too_large',
    );
    expect(big.calls).toHaveLength(0);
  });
  it('the request cap counts bytes, not characters', async () => {
    const { wire, calls } = build();
    expect(await kindOf(wire.send('é'.repeat(MODEL_MAX_REQUEST_BYTES / 2 + 1)))).toBe(
      'request_too_large',
    );
    expect(calls).toHaveLength(0);
  });
  it('a response over 256 KB is refused, declared or streamed', async () => {
    const declared = build({
      kind: 'response',
      headers: { 'content-length': String(MODEL_MAX_RESPONSE_BYTES + 1) },
      chunks: ['{}'],
    });
    expect(await kindOf(declared.wire.send('{}'))).toBe('response_too_large');
    const streamed = build({
      kind: 'response',
      chunks: ['a'.repeat(MODEL_MAX_RESPONSE_BYTES), 'b'],
    });
    expect(await kindOf(streamed.wire.send('{}'))).toBe('response_too_large');
    expect(streamed.calls[0]!.resDestroyed).toBe(true);
  });
  it('a response of exactly 256 KB is accepted', async () => {
    const { wire } = build({ kind: 'response', chunks: ['a'.repeat(MODEL_MAX_RESPONSE_BYTES)] });
    const r = await wire.send('{}');
    expect(r.body).toHaveLength(MODEL_MAX_RESPONSE_BYTES);
  });
});

describe('deadline and failures', () => {
  it('a request that never answers fails after 20 s and is destroyed', async () => {
    vi.useFakeTimers();
    const { wire, calls } = build({ kind: 'hang' });
    const p = kindOf(wire.send('{}'));
    await vi.advanceTimersByTimeAsync(MODEL_DEADLINE_MS - 1);
    expect(calls[0]!.reqDestroyed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await p).toBe('timeout');
    expect(calls[0]!.reqDestroyed).toBe(true);
  });
  it('a body that stalls fails at the same deadline', async () => {
    vi.useFakeTimers();
    const { wire } = build({ kind: 'stall-body', chunks: ['{"par'] });
    const p = kindOf(wire.send('{}'));
    await vi.advanceTimersByTimeAsync(MODEL_DEADLINE_MS);
    expect(await p).toBe('timeout');
  });
  it('a request error and a reset are network failures with fixed words', async () => {
    const a = build({ kind: 'request-error', code: 'ECONNREFUSED', message: 'refused' });
    expect(await kindOf(a.wire.send('{}'))).toBe('network');
    const b = build({ kind: 'response', chunks: ['{"a"'], then: 'reset' });
    expect(await kindOf(b.wire.send('{}'))).toBe('network');
  });
  it('a connection that closes before the end is a network failure', async () => {
    const { wire } = build({ kind: 'response', chunks: ['{"a"'], then: 'close' });
    expect(await kindOf(wire.send('{}'))).toBe('network');
  });
});
