import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeRequest, testDeps } from './https-fake';
import type { Script } from './https-fake';
import { CERT_HOST, SANDBOX_HOST, netSpies } from './test-support';
import { CONNECT_TIMEOUT_MS, TOTAL_DEADLINE_MS, makeHttpsWire } from './wire-https';
import { MAX_RESPONSE_BYTES } from './wire-map';
import type { WireRequest } from './wire';

// BU-1. The production Wire on node:https. Every test drives makeHttpsWire with an in-memory
// request function: no socket, no lookup, no fetch. netSpies() proves nothing real is touched.
let spies: ReturnType<typeof netSpies>;
beforeEach(() => {
  spies = netSpies();
});
afterEach(() => {
  vi.useRealTimers();
  spies.assertZero();
  spies.spies['global fetch'].mockRestore();
});

function build(script?: Script) {
  const { request, calls } = fakeRequest(script);
  const wire = makeHttpsWire(testDeps(request));
  return { wire, calls };
}
const get = (over: Partial<WireRequest> = {}): WireRequest => ({
  method: 'GET',
  url: `https://${SANDBOX_HOST}/v2/checkout/orders/ABC123`,
  headers: { authorization: 'Bearer placeholder', accept: 'application/json' },
  body: null,
  timeout_ms: 10_000,
  ...over,
});
const other = { kind: 'error', error: 'other' } as const;

describe('limits are the architecture 7.6 numbers', () => {
  it('3 s to connect, 10 s in total, 1 MiB of response', () => {
    expect(CONNECT_TIMEOUT_MS).toBe(3000);
    expect(TOTAL_DEADLINE_MS).toBe(10_000);
    expect(MAX_RESPONSE_BYTES).toBe(1024 * 1024);
  });
});

describe('a response', () => {
  it('GET returns status, lower-case headers (duplicates joined) and the decoded body', async () => {
    const { wire, calls } = build({
      kind: 'response',
      status: 201,
      headers: { 'Content-Type': 'application/json', 'X-Dup': ['a', 'b'] },
      chunks: ['{"ok":', 'true}'],
    });
    const r = await wire.request(get());
    expect(r).toEqual({
      kind: 'response',
      status: 201,
      headers: { 'content-type': 'application/json', 'x-dup': 'a, b' },
      body: '{"ok":true}',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.options['method']).toBe('GET');
    expect(calls[0]?.ended).toBe(true);
  });
  it('POST sends the body once, as given', async () => {
    const { wire, calls } = build();
    const body = '{"intent":"CAPTURE"}';
    await wire.request(get({ method: 'POST', body }));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body).toBe(body);
    expect(calls[0]?.options['method']).toBe('POST');
  });
  it('decodes UTF-8 across chunk boundaries and handles an empty body', async () => {
    const bytes = new TextEncoder().encode('é');
    const split = build({ kind: 'response', chunks: [bytes.slice(0, 1), bytes.slice(1)] });
    expect(await split.wire.request(get())).toMatchObject({ kind: 'response', body: 'é' });
    const empty = build({ kind: 'response', status: 204 });
    expect(await empty.wire.request(get())).toMatchObject({
      kind: 'response',
      status: 204,
      body: '',
    });
  });
  it('a body of exactly 1 MiB is accepted', async () => {
    const { wire } = build({ kind: 'response', chunks: ['a'.repeat(MAX_RESPONSE_BYTES)] });
    const r = await wire.request(get());
    expect(r).toMatchObject({ kind: 'response', status: 200 });
    expect(r.kind === 'response' && r.body.length).toBe(MAX_RESPONSE_BYTES);
  });
  it('never retries: one request per call, also after an error', async () => {
    const { wire, calls } = build({ kind: 'request-error', code: 'ECONNRESET' });
    expect(await wire.request(get())).toEqual({ kind: 'error', error: 'reset' });
    expect(calls).toHaveLength(1);
  });
});

describe('non-https, userinfo, port and fragment refused before any request', () => {
  const host = SANDBOX_HOST;
  it.each([
    ['http', `http://${host}/v2/checkout/orders/ABC123`],
    ['ftp', `ftp://${host}/x`],
    ['userinfo', `https://user:pw@${host}/v2/checkout/orders/ABC123`],
    ['user only', `https://user@${host}/v2/checkout/orders/ABC123`],
    ['port', `https://${host}:8443/v2/checkout/orders/ABC123`],
    ['fragment', `https://${host}/v2/checkout/orders/ABC123#x`],
    ['not a url', 'v2/checkout/orders/ABC123'],
    ['empty', ''],
  ])('%s', async (_name, url) => {
    const { wire, calls } = build();
    expect(await wire.request(get({ url }))).toEqual(other);
    expect(calls).toHaveLength(0);
  });
});

describe('only the sandbox hosts are ever contacted (BU-1 review L6)', () => {
  const refusedUrls: [string, string][] = [
    ['another host', 'https://evil.example/v2/checkout/orders/ABC123'],
    ['an IPv4 literal', 'https://192.0.2.1/v2/checkout/orders/ABC123'],
    ['an IPv6 literal', 'https://[2001:db8::1]/v2/checkout/orders/ABC123'],
    ['a decimal IPv4 spelling', 'https://3221225985/v2/checkout/orders/ABC123'],
    ['a look-alike prefix', `https://${SANDBOX_HOST}.evil.example/v2/checkout/orders/ABC123`],
    ['a look-alike suffix', `https://evil-${SANDBOX_HOST}/v2/checkout/orders/ABC123`],
    ['a trailing-dot host', `https://${SANDBOX_HOST}./v2/checkout/orders/ABC123`],
    ['the certificate host on an API path', `https://${CERT_HOST}/v2/checkout/orders/ABC123`],
    [
      'a certificate-style host two labels deep',
      `https://a.b.${CERT_HOST}/v1/notifications/certs/C1`,
    ],
    ['the API host on a certificate path', `https://${SANDBOX_HOST}/v1/notifications/certs/C1`],
    ['a certificate path under another domain', 'https://certs.example/v1/notifications/certs/C1'],
  ];
  it.each(refusedUrls)('%s is refused before any request', async (_n, url) => {
    const { wire, calls } = build();
    expect(await wire.request(get({ url }))).toEqual(other);
    expect(calls).toHaveLength(0);
  });
  it('the API host and a one-label sandbox certificate host on the certificate path are allowed', async () => {
    const { wire, calls } = build();
    expect((await wire.request(get())).kind).toBe('response');
    const cert = `https://${CERT_HOST}/v1/notifications/certs/CERT-1`;
    expect((await wire.request(get({ url: cert }))).kind).toBe('response');
    expect(calls.map((c) => c.options['hostname'])).toEqual([SANDBOX_HOST, CERT_HOST]);
  });
  it('a certificate host is GET only', async () => {
    const { wire, calls } = build();
    const url = `https://${CERT_HOST}/v1/notifications/certs/CERT-1`;
    expect(await wire.request(get({ url, method: 'POST', body: '{}' }))).toEqual(other);
    expect(calls).toHaveLength(0);
  });
});

describe('duplicate header names are refused, not resolved by order (BU-1 review L5)', () => {
  it.each([
    [
      'authorization twice, different case',
      { Authorization: 'Bearer a', authorization: 'Bearer b' },
    ],
    ['accept twice, upper case', { Accept: 'a', ACCEPT: 'b' }],
    ['a dropped header twice (still ambiguous)', { Cookie: 'a=b', cookie: 'c=d' }],
  ])('%s', async (_n, headers) => {
    const { wire, calls } = build();
    expect(await wire.request(get({ headers }))).toEqual(other);
    expect(calls).toHaveLength(0);
  });
  it('the same header spelled once in any case is fine', async () => {
    const { wire, calls } = build();
    expect((await wire.request(get({ headers: { AUTHORIZATION: 'Bearer a' } }))).kind).toBe(
      'response',
    );
    expect(Object.keys(calls[0]?.options['headers'] as object)).toEqual(['authorization']);
  });
});

describe('3xx is returned as a response and its Location is never requested', () => {
  it.each([300, 301, 302, 303, 304, 307, 308, 399])('status %i', async (status) => {
    const { wire, calls } = build({
      kind: 'response',
      status,
      headers: { Location: 'https://elsewhere.invalid/x' },
      chunks: ['moved'],
    });
    const r = await wire.request(get());
    expect(r).toMatchObject({ kind: 'response', status, body: '' });
    expect(r.kind === 'response' && r.headers['location']).toBe('https://elsewhere.invalid/x');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.options['hostname']).toBe(SANDBOX_HOST);
    expect(calls[0]?.resDestroyed).toBe(true);
  });
});

describe('body over 1 MiB gives too_large and the socket is destroyed', () => {
  it('streamed: one byte past the cap', async () => {
    const { wire, calls } = build({
      kind: 'response',
      chunks: ['a'.repeat(MAX_RESPONSE_BYTES), 'b'],
    });
    expect(await wire.request(get())).toEqual({ kind: 'error', error: 'too_large' });
    expect(calls[0]?.resDestroyed).toBe(true);
    expect(calls[0]?.reqDestroyed).toBe(true);
    expect(calls[0]?.socketDestroyed).toBe(true);
  });
  it('declared: a content-length over the cap is refused before the body is read', async () => {
    const { wire, calls } = build({
      kind: 'response',
      headers: { 'Content-Length': String(MAX_RESPONSE_BYTES + 1) },
      chunks: ['x'],
    });
    expect(await wire.request(get())).toEqual({ kind: 'error', error: 'too_large' });
    expect(calls[0]?.resDestroyed).toBe(true);
    expect(calls[0]?.reqDestroyed).toBe(true);
  });
});

describe('total deadline gives timeout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  it('a server that never answers', async () => {
    const { wire, calls } = build({ kind: 'hang' });
    const p = wire.request(get({ timeout_ms: 500 }));
    await vi.advanceTimersByTimeAsync(499);
    let settled = false;
    void p.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await p).toEqual({ kind: 'error', error: 'timeout' });
    expect(calls[0]?.reqDestroyed).toBe(true);
    expect(calls[0]?.socketDestroyed).toBe(true);
  });
  it('a server that sends the head and then stalls the body', async () => {
    const { wire, calls } = build({ kind: 'stall-body', chunks: ['{"par'] });
    const p = wire.request(get({ timeout_ms: 2000 }));
    await vi.advanceTimersByTimeAsync(2000);
    expect(await p).toEqual({ kind: 'error', error: 'timeout' });
    expect(calls[0]?.resDestroyed).toBe(true);
    expect(calls[0]?.reqDestroyed).toBe(true);
  });
  it('the caller cannot lengthen the deadline past 10 s', async () => {
    const { wire } = build({ kind: 'hang' });
    const p = wire.request(get({ timeout_ms: 600_000 }));
    await vi.advanceTimersByTimeAsync(TOTAL_DEADLINE_MS);
    expect(await p).toEqual({ kind: 'error', error: 'timeout' });
  });
  it('a socket that never finishes connecting times out after 3 s, not at the total deadline', async () => {
    const { wire, calls } = build({ kind: 'connect-hang' });
    const p = wire.request(get());
    await vi.advanceTimersByTimeAsync(CONNECT_TIMEOUT_MS - 1);
    let settled = false;
    void p.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await p).toEqual({ kind: 'error', error: 'timeout' });
    expect(calls[0]?.reqDestroyed).toBe(true);
  });
  it('the connect timer stops once the handshake is done: a slow body is not cut at 3 s', async () => {
    const { wire } = build({ kind: 'stall-body', chunks: ['{"par'] });
    const p = wire.request(get());
    let settled = false;
    void p.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(CONNECT_TIMEOUT_MS + 2000);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(TOTAL_DEADLINE_MS);
    expect(await p).toEqual({ kind: 'error', error: 'timeout' });
  });
  it('no timer is left behind after a response, an error or a redirect', async () => {
    const scripts: Script[] = [
      { kind: 'response', chunks: ['ok'] },
      { kind: 'request-error', code: 'ECONNREFUSED' },
      { kind: 'response', status: 302 },
    ];
    for (const script of scripts) {
      const { wire } = build(script);
      const p = wire.request(get());
      await vi.advanceTimersByTimeAsync(0);
      await p;
      expect(vi.getTimerCount(), JSON.stringify(script)).toBe(0);
    }
  });
  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    'a timeout of %s is refused before any request',
    async (timeout_ms) => {
      const { wire, calls } = build();
      expect(await wire.request(get({ timeout_ms }))).toEqual(other);
      expect(calls).toHaveLength(0);
    },
  );
});

describe('error codes map: ENOTFOUND dns, ECONNREFUSED connect, CERT_* and ERR_TLS_* tls, ECONNRESET reset', () => {
  it.each([
    ['ENOTFOUND', 'dns'],
    ['EAI_AGAIN', 'dns'],
    ['ECONNREFUSED', 'connect'],
    ['EHOSTUNREACH', 'connect'],
    ['ENETUNREACH', 'connect'],
    ['CERT_HAS_EXPIRED', 'tls'],
    ['ERR_TLS_CERT_ALTNAME_INVALID', 'tls'],
    ['DEPTH_ZERO_SELF_SIGNED_CERT', 'tls'],
    ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'tls'],
    ['ERR_SSL_WRONG_VERSION_NUMBER', 'tls'],
    ['ECONNRESET', 'reset'],
    ['EPIPE', 'reset'],
    ['ETIMEDOUT', 'timeout'],
    ['SOMETHING_NEW', 'other'],
  ] as const)('%s gives %s', async (code, error) => {
    const { wire } = build({
      kind: 'request-error',
      code,
      message: 'detail that names https://host.invalid and must not leak',
    });
    expect(await wire.request(get())).toEqual({ kind: 'error', error });
  });
  it('an error without a code gives other, and its message is never kept', async () => {
    const { wire } = build({ kind: 'request-error', message: 'secret-looking text' });
    const r = await wire.request(get());
    expect(r).toEqual(other);
    expect(JSON.stringify(r)).not.toContain('secret');
  });
  it('a response that is cut off before its end gives reset', async () => {
    const { wire } = build({ kind: 'response', chunks: ['{"par'], then: 'reset' });
    expect(await wire.request(get())).toEqual({ kind: 'error', error: 'reset' });
  });
  it('a connection that closes before the end of the body, with no error, also gives reset', async () => {
    const { wire } = build({ kind: 'response', chunks: ['{"par'], then: 'close' });
    expect(await wire.request(get())).toEqual({ kind: 'error', error: 'reset' });
  });
});

describe('what is sent', () => {
  it('only allow-listed headers go; names are lower case', async () => {
    const { wire, calls } = build();
    await wire.request(
      get({
        headers: {
          Authorization: 'Bearer placeholder',
          Accept: 'application/json',
          'Content-Type': 'application/json',
          Prefer: 'return=representation',
          'PayPal-Request-Id': 'rid-1',
          Host: 'evil.example',
          Cookie: 'a=b',
          Connection: 'keep-alive',
          'Content-Length': '999',
          'Transfer-Encoding': 'chunked',
          'X-HTTP-Method-Override': 'DELETE',
          'Accept-Encoding': 'gzip',
        },
      }),
    );
    expect(Object.keys(calls[0]?.options['headers'] as object).sort()).toEqual([
      'accept',
      'authorization',
      'content-type',
      'paypal-request-id',
      'prefer',
    ]);
  });
  it.each(['a\r\nX-Evil: 1', 'a\nb', 'a\rb', 'a\u0000b'])(
    'a header value with a control character (%j) is refused before any request',
    async (value) => {
      const { wire, calls } = build();
      expect(await wire.request(get({ headers: { authorization: value } }))).toEqual(other);
      expect(calls).toHaveLength(0);
    },
  );
  it.each([
    ['PUT', 'PUT'],
    ['DELETE', 'DELETE'],
    ['lower case get', 'get'],
  ])('method %s is refused', async (_n, method) => {
    const { wire, calls } = build();
    expect(await wire.request(get({ method: method as 'GET' }))).toEqual(other);
    expect(calls).toHaveLength(0);
  });
  it('a GET with a body is refused', async () => {
    const { wire, calls } = build();
    expect(await wire.request(get({ body: '{}' }))).toEqual(other);
    expect(calls).toHaveLength(0);
  });
});

describe('the gates the Wire asks before every request', () => {
  it('a replaced builtin or an override stops the request; clearing it lets the next through', async () => {
    const { request, calls } = fakeRequest();
    let intact = true;
    let overridden = false;
    const wire = makeHttpsWire(
      testDeps(request, { builtinsIntact: () => intact, envOverridden: () => overridden }),
    );
    expect((await wire.request(get())).kind).toBe('response');
    intact = false;
    expect(await wire.request(get())).toEqual(other);
    intact = true;
    overridden = true;
    expect(await wire.request(get())).toEqual(other);
    overridden = false;
    expect((await wire.request(get())).kind).toBe('response');
    expect(calls).toHaveLength(2);
  });
  it('a gate that throws is a refusal', async () => {
    const { request, calls } = fakeRequest();
    const wire = makeHttpsWire(
      testDeps(request, {
        builtinsIntact: () => {
          throw new Error('boom');
        },
      }),
    );
    expect(await wire.request(get())).toEqual(other);
    expect(calls).toHaveLength(0);
  });
  it('a request function that throws is an error result, not an exception', async () => {
    const wire = makeHttpsWire(
      testDeps((() => {
        throw new Error('boom');
      }) as never),
    );
    expect(await wire.request(get())).toEqual(other);
  });
});

// ---- the production network call lives in exactly one file (moved from wire-fetch.test.ts) ----

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.next' || name === 'dist' || name.startsWith('.'))
      continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}
const rel = (p: string) => relative(REPO, p).split(sep).join('/');
const isTest = (f: string) =>
  /\.test\.tsx?$/.test(f) || f.endsWith('/test-support.ts') || f.endsWith('/https-fake.ts');
// Built at run time: this file does not itself name the production Wire module.
const MODULE = ['wire', 'https'].join('-');
const FUNCTION = ['create', 'Https', 'Wire'].join('');
const code = (f: string) => readFileSync(f, 'utf8').replace(/^\s*\/\/.*$/gm, '');

describe('the production network call lives in exactly one file', () => {
  const pkgFiles = walk(join(REPO, 'packages')).filter((f) => /\.(ts|tsx|mts|js|mjs)$/.test(f));
  const prod = pkgFiles.filter((f) => !isTest(rel(f)));

  it('only the production Wire file imports node:https in non-test package code', () => {
    const hits = prod.filter((f) => /from\s+['"](?:node:)?https['"]/.test(code(f)));
    expect(hits.map(rel)).toEqual([`packages/transport/src/${MODULE}.ts`]);
  });
  it('no non-test file of the transport package calls fetch', () => {
    const hits = prod
      .filter((f) => rel(f).startsWith('packages/transport/src/'))
      .filter((f) => /(^|[^.\w$])fetch\s*\(|globalThis\s*\.\s*fetch\s*\(/m.test(code(f)));
    expect(hits.map(rel)).toEqual([]);
  });
  it('the production Wire file reads the global fetch only to compare it, never to call it', () => {
    const src = code(join(REPO, `packages/transport/src/${MODULE}.ts`));
    expect(src).not.toMatch(/(^|[^.\w$])fetch\s*\(/m);
    expect(src.match(/'fetch'/g) ?? []).toHaveLength(1);
    expect(src).not.toMatch(/\bundici\b|new Request\(/);
  });
  it('only sandbox.ts imports the production Wire file among non-test files of the package', () => {
    const importers = prod
      .filter((f) => rel(f).startsWith('packages/transport/'))
      .filter((f) => new RegExp(`from\\s+['"]\\./${MODULE}['"]`).test(code(f)));
    expect(importers.map(rel)).toEqual(['packages/transport/src/sandbox.ts']);
  });
  it('the package index does not export the production Wire', () => {
    const idx = readFileSync(join(REPO, 'packages/transport/src/index.ts'), 'utf8');
    expect(idx).not.toContain(MODULE);
    expect(idx).not.toContain(FUNCTION);
  });
  it('no other workspace code names the production Wire module or function', () => {
    const others = walk(REPO)
      .filter(
        (f) =>
          /\.(ts|tsx|mts|mjs)$/.test(f) &&
          !rel(f).startsWith('packages/transport/') &&
          !rel(f).startsWith('node_modules') &&
          !rel(f).startsWith('docs/'),
      )
      .filter((f) => !['eslint.config.mjs', 'scripts/lint-rules.test.ts'].includes(rel(f)))
      .filter((f) => new RegExp(`${MODULE}|${FUNCTION}`).test(readFileSync(f, 'utf8')));
    expect(others.map(rel)).toEqual([]);
  });
});
