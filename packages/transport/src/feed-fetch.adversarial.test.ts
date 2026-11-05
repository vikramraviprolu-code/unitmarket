// FEED, E-02 `feed_ssrf` (mvp-plan MVP-E, nfr SOP 18, P19). The feed fetcher against a fake name
// service and a fake request function: nothing resolves a real name and nothing opens a socket. Every
// refusal is table driven. A refusal is a fixed kind and nothing else (no url, address or peer text).
import type https from 'node:https';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FEED_MAX_BYTES, FEED_DEADLINE_MS } from './feed-guard';
import { createFeedFetcher, makeFeedFetcher } from './feed-fetch';
import { fakeRequest } from './https-fake';
import type { Script } from './https-fake';

const HOST = 'feeds.pub-one.invalid';
const URL_OK = `https://${HOST}/offers.json`;
const PUBLIC = '93.184.216.34';
const JSON_HEAD = { 'content-type': 'application/json; charset=utf-8' };
const BODY = JSON.stringify({ items: [] });

interface RigOptions {
  allow?: readonly string[];
  addresses?: string[] | (() => string[]);
  /** What the fake socket reports as its peer; defaults to the address that was dialled. */
  remote?: (dialled: string) => string | undefined;
  resolveError?: boolean;
  resolveNever?: boolean;
  /** The fake stall step carries no headers; this gives the response a head. */
  headers?: Record<string, string>;
}

function rig(script: Script, o: RigOptions = {}) {
  const fake = fakeRequest(script);
  const resolve = vi.fn(async (_host: string): Promise<string[]> => {
    if (o.resolveNever === true) return new Promise<string[]>(() => undefined);
    if (o.resolveError === true) throw new Error('SECRET-DNS-TEXT 10.9.9.9');
    const a = o.addresses ?? [PUBLIC];
    return typeof a === 'function' ? a() : a;
  });
  const request = ((opts: Record<string, unknown>, cb: (res: unknown) => void) =>
    fake.request(opts, (res) => {
      const dialled = String(opts['host']);
      const remote = o.remote === undefined ? dialled : o.remote(dialled);
      Object.assign(res as object, { socket: { remoteAddress: remote } });
      if (o.headers !== undefined) Object.assign(res as object, { headers: o.headers });
      cb(res);
    })) as unknown as typeof https.request;
  const fetcher = makeFeedFetcher({
    allow: o.allow ?? [HOST],
    resolve,
    request,
    agent: {} as https.Agent,
  });
  return { fetcher, resolve, calls: fake.calls };
}

const response = (
  chunks: (string | Uint8Array)[] = [BODY],
  headers: Record<string, string> = JSON_HEAD,
  status = 200,
): Script => ({ kind: 'response', status, headers, chunks });

afterEach(() => {
  vi.useRealTimers();
});

describe('the happy path is exactly one pinned GET', () => {
  it('resolves once, dials the pinned address and sends nothing else', async () => {
    const { fetcher, resolve, calls } = rig(response());
    const r = await fetcher.fetch(URL_OK);
    expect(r).toEqual({ ok: true, body: BODY, content_type: 'application/json', host: HOST });
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith(HOST);
    expect(calls).toHaveLength(1);
    const o = calls[0]!.options;
    expect(o['host']).toBe(PUBLIC);
    expect(o['servername']).toBe(HOST);
    expect(o['port']).toBe(443);
    expect(o['protocol']).toBe('https:');
    expect(o['method']).toBe('GET');
    expect(o['path']).toBe('/offers.json');
    expect(o['rejectUnauthorized']).toBe(true);
    expect(o['minVersion']).toBe('TLSv1.2');
    expect(Object.keys(o['headers'] as object).sort()).toEqual([
      'accept',
      'accept-encoding',
      'host',
      'user-agent',
    ]);
    expect((o['headers'] as Record<string, string>)['host']).toBe(HOST);
    expect((o['headers'] as Record<string, string>)['accept-encoding']).toBe('identity');
    expect(calls[0]!.body).toBe('');
  });

  it('accepts a body of exactly 2 MB and refuses one byte more', async () => {
    const full = 'a'.repeat(FEED_MAX_BYTES);
    const a = await rig(response([full])).fetcher.fetch(URL_OK);
    expect(a.ok && a.body.length).toBe(FEED_MAX_BYTES);
    const b = await rig(response([full, 'a'])).fetcher.fetch(URL_OK);
    expect(b).toEqual({ ok: false, reason: 'too_large' });
  });
});

describe('E-02: refusals before any name is resolved or any socket exists', () => {
  it.each([
    ['http scheme', 'http://feeds.pub-one.invalid/offers.json', 'not_https'],
    ['link-local literal', 'https://169.254.169.254/latest/meta-data/', 'ip_literal'],
    ['localhost', 'https://localhost/offers.json', 'host_not_allowed'],
    ['loopback literal', 'https://127.0.0.1/offers.json', 'ip_literal'],
    ['private literal', 'https://10.0.0.1/offers.json', 'ip_literal'],
    ['decimal encoding', 'https://2852039166/', 'ip_literal'],
    ['hex encoding', 'https://0xa9fea9fe/', 'ip_literal'],
    ['octal encoding', 'https://0251.0376.0251.0376/', 'ip_literal'],
    ['ipv6 loopback', 'https://[::1]/', 'ip_literal'],
    ['ipv4-mapped ipv6', 'https://[::ffff:169.254.169.254]/', 'ip_literal'],
    ['userinfo', `https://user:pw@${HOST}/offers.json`, 'userinfo'],
    ['other port', `https://${HOST}:8443/offers.json`, 'bad_port'],
    ['host off the list', 'https://evil.invalid/offers.json', 'host_not_allowed'],
    ['not a url', 'hello', 'not_https'],
  ])('%s', async (_n, url, reason) => {
    const { fetcher, resolve, calls } = rig(response());
    expect(await fetcher.fetch(url)).toEqual({ ok: false, reason });
    expect(resolve).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it('an empty allow-list is feed_off: no lookup, no request', async () => {
    const { fetcher, resolve, calls } = rig(response(), { allow: [] });
    expect(await fetcher.fetch(URL_OK)).toEqual({ ok: false, reason: 'feed_off' });
    expect(resolve).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it('the production factory refuses to exist with an empty allow-list', () => {
    expect(() => createFeedFetcher({ allow: [] })).toThrow();
    expect(() => createFeedFetcher({ allow: ['8.8.8.8'] })).toThrow();
    expect(() => createFeedFetcher({ allow: ['*.pub-one.invalid'] })).toThrow();
    expect(() => createFeedFetcher({ allow: ['Feeds.Pub-One.invalid'] })).toThrow();
    expect(() => createFeedFetcher({ allow: [HOST] })).not.toThrow();
  });
});

describe('E-02: an allow-listed name that resolves somewhere private is refused', () => {
  it.each([
    ['link-local metadata', ['169.254.169.254']],
    ['loopback', ['127.0.0.1']],
    ['private 10/8', ['10.0.0.1']],
    ['private 172.16/12', ['172.16.5.5']],
    ['private 192.168/16', ['192.168.1.1']],
    ['CGNAT', ['100.64.0.1']],
    ['multicast', ['224.0.0.1']],
    ['ipv6 loopback', ['::1']],
    ['ipv6 unique local', ['fd00::1']],
    ['ipv6 link-local', ['fe80::1']],
    ['ipv4-mapped', ['::ffff:10.0.0.1']],
    ['one public and one private (rebinding mix)', [PUBLIC, '10.0.0.1']],
    ['one private and one public', ['10.0.0.1', PUBLIC]],
    ['an answer that is not an address', ['internal.invalid']],
  ])('%s', async (_n, addresses) => {
    const { fetcher, calls, resolve } = rig(response(), { addresses });
    expect(await fetcher.fetch(URL_OK)).toEqual({ ok: false, reason: 'private_address' });
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(0);
  });

  it('a lookup failure and an empty answer are dns_failed, with no peer text', async () => {
    const a = await rig(response(), { resolveError: true }).fetcher.fetch(URL_OK);
    expect(a).toEqual({ ok: false, reason: 'dns_failed' });
    expect(JSON.stringify(a)).not.toMatch(/SECRET|10\.9\.9\.9/);
    expect(await rig(response(), { addresses: [] }).fetcher.fetch(URL_OK)).toEqual({
      ok: false,
      reason: 'dns_failed',
    });
  });

  it('resolves once per import: a second answer is never asked for (no rebinding window)', async () => {
    let n = 0;
    const { fetcher, calls, resolve } = rig(response(), {
      addresses: () => (++n === 1 ? [PUBLIC] : ['169.254.169.254']),
    });
    const r = await fetcher.fetch(URL_OK);
    expect(r.ok).toBe(true);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(calls.map((c) => c.options['host'])).toEqual([PUBLIC]);
  });

  it('the connected socket must be the pinned address (re-check)', async () => {
    for (const remote of ['10.0.0.1', '169.254.169.254', '93.184.216.35', '::1', undefined]) {
      const { fetcher, calls } = rig(response(), { remote: () => remote });
      expect(await fetcher.fetch(URL_OK)).toEqual({ ok: false, reason: 'pin_mismatch' });
      expect(calls[0]!.resDestroyed).toBe(true);
    }
  });

  it('an ipv6 pin is dialled as given', async () => {
    const { fetcher, calls } = rig(response(), { addresses: ['2606:4700:4700::1111'] });
    expect((await fetcher.fetch(URL_OK)).ok).toBe(true);
    expect(calls[0]!.options['host']).toBe('2606:4700:4700::1111');
  });
});

describe('E-02: a redirect is never followed', () => {
  it.each([301, 302, 303, 307, 308])(
    '%i to a private address is a refusal, one request only',
    async (s) => {
      const { fetcher, calls, resolve } = rig({
        kind: 'response',
        status: s,
        headers: { location: 'https://10.0.0.1/secret', ...JSON_HEAD },
        chunks: ['redirecting'],
      });
      expect(await fetcher.fetch(URL_OK)).toEqual({ ok: false, reason: 'redirect' });
      expect(calls).toHaveLength(1);
      expect(resolve).toHaveBeenCalledTimes(1);
      expect(calls[0]!.resDestroyed).toBe(true);
    },
  );

  it('a redirect to the metadata address by host name is not looked up', async () => {
    const { fetcher, resolve } = rig({
      kind: 'response',
      status: 302,
      headers: { location: 'https://metadata.invalid/' },
      chunks: [],
    });
    await fetcher.fetch(URL_OK);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).not.toHaveBeenCalledWith('metadata.invalid');
  });
});

describe('E-02: size, time, type, status', () => {
  it('more than 2 MB streamed without a length is cut off', async () => {
    const mb = 'a'.repeat(1024 * 1024);
    const { fetcher, calls } = rig(response([mb, mb, mb]));
    expect(await fetcher.fetch(URL_OK)).toEqual({ ok: false, reason: 'too_large' });
    expect(calls[0]!.resDestroyed).toBe(true);
  });

  it('a declared length over 2 MB is refused before the body is read', async () => {
    const { fetcher, calls } = rig(
      response(['x'], { ...JSON_HEAD, 'content-length': String(FEED_MAX_BYTES + 1) }),
    );
    expect(await fetcher.fetch(URL_OK)).toEqual({ ok: false, reason: 'too_large' });
    expect(calls[0]!.resDestroyed).toBe(true);
  });

  it('a body that never arrives ends at 5 seconds', async () => {
    vi.useFakeTimers();
    const { fetcher, calls } = rig(
      { kind: 'stall-body', status: 200, chunks: ['{"items":'] },
      { headers: JSON_HEAD },
    );
    const p = fetcher.fetch(URL_OK);
    await vi.advanceTimersByTimeAsync(FEED_DEADLINE_MS + 1);
    expect(await p).toEqual({ ok: false, reason: 'timeout' });
    expect(calls[0]!.reqDestroyed).toBe(true);
  });

  it('a server that never answers ends at 5 seconds', async () => {
    vi.useFakeTimers();
    const { fetcher } = rig({ kind: 'hang' });
    const p = fetcher.fetch(URL_OK);
    await vi.advanceTimersByTimeAsync(FEED_DEADLINE_MS + 1);
    expect(await p).toEqual({ ok: false, reason: 'timeout' });
  });

  it('a name service that never answers ends at 5 seconds and no request is made', async () => {
    vi.useFakeTimers();
    const { fetcher, calls } = rig(response(), { resolveNever: true });
    const p = fetcher.fetch(URL_OK);
    await vi.advanceTimersByTimeAsync(FEED_DEADLINE_MS + 1);
    expect(await p).toEqual({ ok: false, reason: 'timeout' });
    expect(calls).toHaveLength(0);
  });

  it('the time limit covers the whole exchange, not each step', async () => {
    vi.useFakeTimers();
    let release: (a: string[]) => void = () => undefined;
    const fake = fakeRequest({ kind: 'hang' });
    const fetcher = makeFeedFetcher({
      allow: [HOST],
      resolve: () => new Promise<string[]>((r) => (release = r)),
      request: fake.request as unknown as typeof https.request,
      agent: {} as https.Agent,
    });
    const p = fetcher.fetch(URL_OK);
    await vi.advanceTimersByTimeAsync(FEED_DEADLINE_MS - 1000);
    release([PUBLIC]);
    await vi.advanceTimersByTimeAsync(1500);
    expect(await p).toEqual({ ok: false, reason: 'timeout' });
  });

  it.each([
    ['html', 'text/html'],
    ['plain text', 'text/plain'],
    ['octet stream', 'application/octet-stream'],
    ['javascript', 'application/javascript'],
    ['none', ''],
  ])('wrong content type: %s', async (_n, ct) => {
    const headers: Record<string, string> = ct === '' ? {} : { 'content-type': ct };
    const { fetcher, calls } = rig(response([BODY], headers));
    expect(await fetcher.fetch(URL_OK)).toEqual({ ok: false, reason: 'bad_content_type' });
    expect(calls[0]!.resDestroyed).toBe(true);
  });

  it.each([404, 403, 500, 503, 204])('status %i is bad_status', async (s) => {
    expect(await rig(response([BODY], JSON_HEAD, s)).fetcher.fetch(URL_OK)).toEqual({
      ok: false,
      reason: 'bad_status',
    });
  });

  it('a compressed body is refused', async () => {
    const r = await rig(
      response([BODY], { ...JSON_HEAD, 'content-encoding': 'gzip' }),
    ).fetcher.fetch(URL_OK);
    expect(r).toEqual({ ok: false, reason: 'content_encoding' });
  });

  it('a body that is not valid UTF-8 is refused', async () => {
    const r = await rig(response([new Uint8Array([0x7b, 0xff, 0xfe, 0x7d])])).fetcher.fetch(URL_OK);
    expect(r).toEqual({ ok: false, reason: 'bad_body' });
  });

  it('a reset and a request error are network, with no peer text', async () => {
    const a = await rig({
      kind: 'response',
      status: 200,
      headers: JSON_HEAD,
      chunks: ['{'],
      then: 'reset',
    }).fetcher.fetch(URL_OK);
    expect(a).toEqual({ ok: false, reason: 'network' });
    const b = await rig({
      kind: 'request-error',
      code: 'ECONNREFUSED',
      message: 'SECRET-PEER 10.1.1.1',
    }).fetcher.fetch(URL_OK);
    expect(b).toEqual({ ok: false, reason: 'network' });
    expect(JSON.stringify(b)).not.toMatch(/SECRET|10\.1\.1\.1/);
  });

  it('a body that closes early is network', async () => {
    const r = await rig({
      kind: 'response',
      status: 200,
      headers: JSON_HEAD,
      chunks: ['{'],
      then: 'close',
    }).fetcher.fetch(URL_OK);
    expect(r).toEqual({ ok: false, reason: 'network' });
  });
});

describe('stress: odd and huge input never throws and never reaches the network by accident', () => {
  // A small deterministic generator (no Math.random).
  const lcg = (seed: number) => () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  const PARTS = [
    'https://',
    'http://',
    '@',
    ':',
    '[',
    ']',
    '%',
    '..',
    '/',
    '?',
    '#',
    '\\',
    '\u0000',
    ' ',
    '.',
    HOST,
    'localhost',
    '169.254.169.254',
    '0x7f',
    '::1',
    ':443',
    ':80',
    'A',
    '9',
    '‮',
    'xn--',
    '%00',
    '%2e',
    '\n',
  ];

  it('2000 generated urls: any ok result names an allow-listed host', async () => {
    const next = lcg(7);
    let accepted = 0;
    for (let i = 0; i < 2000; i += 1) {
      let url = '';
      const n = 1 + Math.floor(next() * 8);
      for (let k = 0; k < n; k += 1) url += PARTS[Math.floor(next() * PARTS.length)]!;
      const { fetcher, calls } = rig(response());
      const r = await fetcher.fetch(url);
      if (r.ok) {
        accepted += 1;
        expect(r.host).toBe(HOST);
        expect(calls[0]!.options['host']).toBe(PUBLIC);
      } else {
        expect(Object.keys(r)).toEqual(['ok', 'reason']);
        expect(calls).toHaveLength(0);
      }
    }
    expect(accepted).toBeGreaterThanOrEqual(0);
  });

  it.each([
    ['100000 character host', `https://${'a'.repeat(100_000)}.invalid/`],
    ['100000 character path', `https://${HOST}/${'a'.repeat(100_000)}`],
    ['10000 @ signs', `https://${'@'.repeat(10_000)}${HOST}/`],
    ['10000 dots', `https://${'.'.repeat(10_000)}/`],
    ['10000 brackets', `https://${'['.repeat(10_000)}/`],
    ['deep percent encoding', `https://${HOST}/${'%25'.repeat(5000)}`],
    ['nul byte', `https://${HOST}/\u0000`],
    ['empty', ''],
  ])('%s', async (_n, url) => {
    const { fetcher, calls } = rig(response());
    const r = await fetcher.fetch(url);
    expect(r.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('non-string input is refused', async () => {
    const { fetcher, calls } = rig(response());
    for (const v of [undefined, null, 1, {}, [], Symbol('x')] as unknown[])
      expect(await fetcher.fetch(v as string)).toEqual({ ok: false, reason: 'bad_url' });
    expect(calls).toHaveLength(0);
  });

  it('many small chunks and a huge single chunk both stay under the cap logic', async () => {
    const small = Array.from({ length: 5000 }, () => 'ab');
    const a = await rig(response(small)).fetcher.fetch(URL_OK);
    expect(a.ok && a.body.length).toBe(10_000);
    const b = await rig(response(['a'.repeat(FEED_MAX_BYTES * 3)])).fetcher.fetch(URL_OK);
    expect(b).toEqual({ ok: false, reason: 'too_large' });
  });
});
