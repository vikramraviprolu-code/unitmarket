import { readFileSync } from 'node:fs';
import https from 'node:https';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Secret } from '@umsbx/contracts';
import { fakeRequest } from './https-fake';
import type { Script } from './https-fake';
import { LIVE_HOST, SANDBOX_HOST, netSpies } from './test-support';
import { MODEL_API, ModelWireError, makeModelHttps } from './model-https';

// AI-A adversarial. Whatever is asked of the Claude egress, it either goes to the one host and path
// or it is refused before a socket opens; the key never leaves in an error, a log or the body.
const KEY = 'SYNTHETIC-MODEL-KEY-not-a-credential-0002';
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
  vi.restoreAllMocks();
  spies.assertZero();
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
const failure = async (p: Promise<unknown>): Promise<unknown> => {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error('expected a refusal');
};
const GOOD = `${MODEL_API}/v1/messages`;

describe('host, path, method and shape: anything else is refused before a socket opens', () => {
  const urls: [string, string][] = [
    ['another host', 'https://api.anthropic.com.evil.invalid/v1/messages'],
    ['a sub domain', 'https://eu.api.anthropic.com/v1/messages'],
    ['the bare domain', 'https://anthropic.com/v1/messages'],
    ['the sandbox PayPal host', `https://${SANDBOX_HOST}/v1/messages`],
    ['the live PayPal host', `https://${LIVE_HOST}/v1/messages`],
    ['http', 'http://api.anthropic.com/v1/messages'],
    ['a port', 'https://api.anthropic.com:8443/v1/messages'],
    ['user info', 'https://user:pw@api.anthropic.com/v1/messages'],
    ['an IP literal', 'https://192.0.2.1/v1/messages'],
    ['another path', 'https://api.anthropic.com/v1/complete'],
    ['a trailing slash', 'https://api.anthropic.com/v1/messages/'],
    ['a sub path', 'https://api.anthropic.com/v1/messages/batches'],
    ['an encoded path', 'https://api.anthropic.com/v1/%6Dessages'],
    ['a query', 'https://api.anthropic.com/v1/messages?beta=true'],
    ['an empty query', 'https://api.anthropic.com/v1/messages?'],
    ['a fragment', 'https://api.anthropic.com/v1/messages#x'],
    ['a relative url', '/v1/messages'],
    ['not a url', 'not a url'],
    ['an empty url', ''],
  ];
  it.each(urls)('refuses %s', async (_name, url) => {
    const { wire, calls } = build();
    const e = await failure(wire.exchange({ method: 'POST', url, body: '{}' }));
    expect(e).toBeInstanceOf(ModelWireError);
    expect((e as ModelWireError).kind).toBe('refused');
    expect(calls).toHaveLength(0);
  });
  it.each(['GET', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'post', 'POST '])(
    'refuses the method %j',
    async (method) => {
      const { wire, calls } = build();
      const e = await failure(wire.exchange({ method, url: GOOD, body: '{}' }));
      expect((e as ModelWireError).kind).toBe('refused');
      expect(calls).toHaveLength(0);
    },
  );
  it('the one good request is allowed through exchange', async () => {
    const { wire, calls } = build();
    expect(await wire.exchange({ method: 'POST', url: GOOD, body: '{}' })).toMatchObject({
      status: 200,
    });
    expect(calls).toHaveLength(1);
  });
  it('a body that is not a string is refused', async () => {
    const { wire, calls } = build();
    for (const bad of [123, null, undefined, {}, Buffer.from('{}')]) {
      const e = await failure(wire.send(bad as unknown as string));
      expect((e as ModelWireError).kind).toBe('refused');
    }
    expect(calls).toHaveLength(0);
  });
});

describe('redirects are never followed', () => {
  it.each([301, 302, 303, 307, 308])('a %i to another host makes no second request', async (s) => {
    const { wire, calls } = build({
      kind: 'response',
      status: s,
      headers: { location: `https://${SANDBOX_HOST}/v1/messages` },
    });
    expect(await wire.send('{}')).toEqual({ status: s, body: '' });
    expect(calls).toHaveLength(1);
  });
});

describe('the key', () => {
  it('goes only in the x-api-key header: not in the url, the body, or any other header', async () => {
    const { wire, calls } = build();
    await wire.send('{"model":"m"}');
    const c = calls[0]!;
    const headers = c.options['headers'] as Record<string, string>;
    expect(Object.entries(headers).filter(([, v]) => v.includes(KEY))).toEqual([
      ['x-api-key', KEY],
    ]);
    expect(String(c.options['path'])).not.toContain(KEY);
    expect(c.body).not.toContain(KEY);
    expect(JSON.stringify({ ...c.options, headers: undefined })).not.toContain(KEY);
  });
  it('is absent from every kind of failure: message, string, JSON and stack', async () => {
    const scripts: Script[] = [
      { kind: 'request-error', code: 'ECONNRESET', message: `socket hang up ${KEY}` },
      { kind: 'response', chunks: ['{"a"'], then: 'reset' },
      { kind: 'response', headers: { 'content-length': '9999999' } },
    ];
    for (const script of scripts) {
      const { wire } = build(script);
      const e = (await failure(wire.send('{}'))) as Error;
      for (const s of [e.message, String(e), JSON.stringify(e), e.stack ?? '', e.name]) {
        expect(s).not.toContain(KEY);
        expect(s).not.toMatch(/SYNTHETIC-MODEL-KEY/);
      }
    }
    const big = build();
    const e2 = (await failure(big.wire.send('x'.repeat(70_000)))) as Error;
    expect(`${e2.message}${e2.stack}${JSON.stringify(e2)}`).not.toContain(KEY);
  });
  it('is absent from the console when a request fails', async () => {
    const spy = [
      vi.spyOn(console, 'log'),
      vi.spyOn(console, 'error'),
      vi.spyOn(console, 'warn'),
      vi.spyOn(console, 'info'),
    ];
    const { wire } = build({ kind: 'request-error', message: KEY });
    await failure(wire.send('{}'));
    expect(
      spy
        .flatMap((s) => s.mock.calls)
        .flat()
        .join(' '),
    ).not.toContain(KEY);
  });
  it('a key that cannot be a header value is refused before a socket opens', async () => {
    for (const bad of ['', 'line\nbreak', 'tab\there', 'café', 'x'.repeat(5000)]) {
      const { wire, calls } = build(undefined, secret(bad));
      const e = (await failure(wire.send('{}'))) as ModelWireError;
      expect(e.kind).toBe('refused');
      expect(e.message).not.toContain(bad === '' ? '\u0000' : bad);
      expect(calls).toHaveLength(0);
    }
  });
  it('a key whose reveal throws is refused without leaking the thrown text', async () => {
    const throwing: Secret = {
      reveal: () => {
        throw new Error(`boom ${KEY}`);
      },
      toString: () => '[redacted]',
      toJSON: () => '[redacted]',
    };
    const { wire, calls } = build(undefined, throwing);
    const e = (await failure(wire.send('{}'))) as Error;
    expect((e as ModelWireError).kind).toBe('refused');
    expect(`${e.message}${e.stack}`).not.toContain(KEY);
    expect(calls).toHaveLength(0);
  });
});

describe('what the file does not do', () => {
  const dir = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(dir, 'model-https.ts'), 'utf8').replace(/^\s*\/\/.*$/gm, '');
  it('imports neither the PayPal Wire, nor the sandbox transport, nor the approval minter', () => {
    expect(src).not.toMatch(/wire-https|sandbox|approval|safety|endpoints|guard/);
  });
  it('never calls fetch, reads no environment, uses no clock or randomness', () => {
    expect(src).not.toMatch(/(^|[^.\w$])fetch\s*\(|globalThis\s*\.\s*fetch|\bundici\b/m);
    expect(src).not.toMatch(/process\.env|process\.execArgv/);
    expect(src).not.toMatch(/Date\.now|new Date\(\)|Math\.random|performance\.now|randomUUID/);
  });
  it('names the one host once and no PayPal host', () => {
    expect(src.match(/api\.anthropic\.com/g)).toHaveLength(1);
    expect(src).not.toMatch(/pay\s*pal/i);
  });
  it('is exported from the package root under its factory name only', () => {
    const idx = readFileSync(join(dir, 'index.ts'), 'utf8');
    expect(idx).toMatch(/createModelHttps/);
    expect(idx).not.toMatch(/makeModelHttps/);
  });
});
