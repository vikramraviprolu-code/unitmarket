// FEED (E-02, SOP 18, P19): the pure feed guards. Table driven; nothing here resolves a name or opens a
// socket. Host names use the invalid top level domain only.
import { describe, expect, it } from 'vitest';
import {
  FEED_DEADLINE_MS,
  FEED_MAX_BYTES,
  FEED_MAX_URL_CHARS,
  checkFeedHead,
  checkFeedUrl,
  checkResolved,
  isPublicAddress,
} from './feed-guard';

const HOST = 'feeds.pub-one.invalid';
const ALLOW = [HOST, 'other.pub-two.invalid'];
const ok = (url: string, allow: readonly string[] = ALLOW) => checkFeedUrl(url, allow);

describe('limits are the documented ones', () => {
  it('2 MB, 5 s, 2048 characters', () => {
    expect(FEED_MAX_BYTES).toBe(2 * 1024 * 1024);
    expect(FEED_DEADLINE_MS).toBe(5000);
    expect(FEED_MAX_URL_CHARS).toBe(2048);
  });
});

describe('checkFeedUrl accepts', () => {
  it.each([
    [`https://${HOST}/feed.json`, '/feed.json'],
    [`https://${HOST.toUpperCase()}/a/b.xml?x=1`, '/a/b.xml?x=1'],
    [`https://${HOST}:443/feed`, '/feed'],
    [`https://${HOST}`, '/'],
    [`https://${HOST}./feed`, '/feed'],
    [`https://${HOST}/feed#frag`, '/feed'],
    [`https://other.pub-two.invalid/x`, '/x'],
  ])('%s', (url, path) => {
    const r = ok(url);
    expect(r).toEqual({ ok: true, host: expect.any(String), path });
    if (r.ok) expect(ALLOW).toContain(r.host);
  });
});

describe('checkFeedUrl refuses', () => {
  const refuse = (reason: string, urls: string[]) =>
    it.each(urls)(`${reason}: %j`, (url) => {
      expect(ok(url)).toEqual({ ok: false, reason });
    });

  refuse('not_https', [
    `http://${HOST}/feed`,
    `ftp://${HOST}/feed`,
    `file:///etc/passwd`,
    `gopher://${HOST}/`,
    `HTTP://${HOST}/feed`,
    `javascript:alert(1)`,
    `data:text/plain,hello`,
    `//${HOST}/feed`,
  ]);
  refuse('userinfo', [
    `https://user@${HOST}/feed`,
    `https://user:pw@${HOST}/feed`,
    `https://${HOST}@evil.invalid/feed`,
    `https://:@${HOST}/feed`,
    `https://${HOST}%40evil.invalid@${HOST}/`,
  ]);
  refuse('bad_port', [
    `https://${HOST}:8443/feed`,
    `https://${HOST}:80/feed`,
    `https://${HOST}:0/feed`,
    `https://${HOST}:65535/feed`,
    `https://${HOST}:4430/feed`,
  ]);
  refuse('ip_literal', [
    'https://169.254.169.254/latest/meta-data',
    'https://127.0.0.1/feed',
    'https://2130706433/feed',
    'https://0x7f000001/feed',
    'https://0x7f.0.0.1/feed',
    'https://0177.0.0.1/feed',
    'https://017700000001/feed',
    'https://127.1/feed',
    'https://10.0.0.1/feed',
    'https://172.16.0.1/feed',
    'https://192.168.0.1/feed',
    'https://100.64.0.1/feed',
    'https://8.8.8.8/feed',
    'https://[::1]/feed',
    'https://[::ffff:127.0.0.1]/feed',
    'https://[::ffff:7f00:1]/feed',
    'https://[fe80::1]/feed',
    'https://[fc00::1]/feed',
    'https://[2001:db8::1]/feed',
    'https://0/feed',
    'https://4294967295/feed',
  ]);
  refuse('host_not_allowed', [
    'https://localhost/feed',
    'https://LOCALHOST./feed',
    'https://foo.localhost/feed',
    `https://evil.invalid/feed`,
    `https://sub.${HOST}/feed`,
    `https://${HOST}.evil.invalid/feed`,
    `https://x${HOST}/feed`,
    'https://metadata.google.internal/computeMetadata/v1/',
    'https://xn--80ak6aa92e.invalid/feed',
  ]);
  refuse('bad_url', [
    '',
    'not a url',
    `https://${HOST}/fe ed`.replace(' ', '\u0000'),
    `https://${HOST}/feed\r\nHost: evil.invalid`,
    `https://${HOST}\\@evil.invalid/feed`,
    ` https://${HOST}/feed`,
    `https://${HOST}/feed `,
    `https://${HOST}/‮feed`,
    `https://`,
    `https:///feed`,
    `https://${HOST}/${'a'.repeat(FEED_MAX_URL_CHARS)}`,
  ]);

  it('refuses a value that is not a string', () => {
    for (const v of [
      undefined,
      null,
      5,
      {},
      [],
      ['https://' + HOST],
      new String(`https://${HOST}/`),
    ])
      expect(checkFeedUrl(v, ALLOW)).toEqual({ ok: false, reason: 'bad_url' });
  });
  it('an empty allow-list refuses every url as feed_off', () => {
    expect(checkFeedUrl(`https://${HOST}/feed`, [])).toEqual({ ok: false, reason: 'feed_off' });
    expect(checkFeedUrl('https://127.0.0.1/', [])).toEqual({ ok: false, reason: 'feed_off' });
  });
  it('an IP literal or a wildcard in the allow-list never matches', () => {
    expect(checkFeedUrl('https://8.8.8.8/x', ['8.8.8.8'])).toEqual({
      ok: false,
      reason: 'ip_literal',
    });
    expect(checkFeedUrl(`https://a.pub-one.invalid/x`, ['*.pub-one.invalid'])).toEqual({
      ok: false,
      reason: 'host_not_allowed',
    });
  });
});

describe('isPublicAddress', () => {
  it.each([
    '93.184.216.34',
    '8.8.8.8',
    '1.1.1.1',
    '11.0.0.1',
    '172.15.255.255',
    '172.32.0.1',
    '100.63.255.255',
    '100.128.0.1',
    '192.169.0.1',
    '169.253.1.1',
    '223.255.255.255',
    '2606:4700:4700::1111',
    '2001:4860:4860::8888',
    '2a00:1450:4001:81b::200e',
  ])('public: %s', (ip) => {
    expect(isPublicAddress(ip)).toBe(true);
  });

  it.each([
    '127.0.0.1',
    '127.1.2.3',
    '127.255.255.255',
    '0.0.0.0',
    '0.1.2.3',
    '10.0.0.1',
    '10.255.255.255',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '192.168.255.255',
    '169.254.169.254',
    '169.254.0.1',
    '100.64.0.1',
    '100.100.100.200',
    '100.127.255.255',
    '224.0.0.1',
    '239.255.255.255',
    '240.0.0.1',
    '255.255.255.255',
    '198.18.0.1',
    '198.19.255.255',
    '192.0.2.1',
    '198.51.100.1',
    '203.0.113.1',
    '192.0.0.1',
    '::',
    '::1',
    '0:0:0:0:0:0:0:1',
    '0000:0000:0000:0000:0000:0000:0000:0001',
    'fc00::1',
    'fd12:3456:789a::1',
    'fdff:ffff::1',
    'fe80::1',
    'fe80::1%eth0',
    'febf::1',
    'ff00::1',
    'ff02::1',
    '2001:db8::1',
    '2001::1',
    '2002:7f00:1::',
    '2002:c0a8:101::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '::ffff:10.0.0.1',
    '::ffff:a9fe:a9fe',
    '::ffff:192.168.0.1',
    '0:0:0:0:0:ffff:127.0.0.1',
    '::FFFF:7F00:1',
    '64:ff9b::7f00:1',
    '64:ff9b::a9fe:a9fe',
    '64:ff9b::10.0.0.1',
    '::127.0.0.1',
    '::10.0.0.1',
  ])('not public: %s', (ip) => {
    expect(isPublicAddress(ip)).toBe(false);
  });

  it.each([
    '',
    ' ',
    'abc',
    'localhost',
    '1.2.3',
    '1.2.3.4.5',
    '256.1.1.1',
    '1.2.3.256',
    '01.2.3.4',
    '1.2.3.04',
    '0x7f.0.0.1',
    '2130706433',
    '0x7f000001',
    ' 8.8.8.8',
    '8.8.8.8 ',
    '8.8.8.8\n',
    '8.8.8.8/32',
    '[::1]',
    '::g',
    '1::2::3',
    '12345::1',
    ':::',
    '8.8.8.8.',
    '-1.2.3.4',
    '1.2.3.-4',
    '8.8.8.8%eth0',
    'a'.repeat(5000),
  ])('malformed is not public: %j', (ip) => {
    expect(isPublicAddress(ip)).toBe(false);
  });

  it('never throws on odd input', () => {
    for (const v of [undefined, null, 5, {}, [], Symbol.iterator] as unknown[])
      expect(isPublicAddress(v as string)).toBe(false);
  });
});

describe('checkResolved', () => {
  it('pins the first address when every address is public', () => {
    expect(checkResolved(['93.184.216.34', '2606:4700:4700::1111'])).toEqual({
      ok: true,
      address: '93.184.216.34',
      family: 4,
    });
    expect(checkResolved(['2606:4700:4700::1111'])).toEqual({
      ok: true,
      address: '2606:4700:4700::1111',
      family: 6,
    });
  });
  it.each([
    [['127.0.0.1']],
    [['93.184.216.34', '10.0.0.1']],
    [['10.0.0.1', '93.184.216.34']],
    [['93.184.216.34', '::1']],
    [['169.254.169.254']],
    [[]],
    [['not an address']],
  ])('refuses %j', (list) => {
    expect(checkResolved(list as string[])).toEqual({ ok: false, reason: 'private_address' });
  });
  it('refuses a list that is too long', () => {
    expect(checkResolved(Array.from({ length: 33 }, () => '93.184.216.34'))).toEqual({
      ok: false,
      reason: 'private_address',
    });
  });
});

describe('checkFeedHead', () => {
  const good = { 'content-type': 'application/json' };
  it.each([
    [200, { 'content-type': 'application/json' }],
    [200, { 'content-type': 'application/json; charset=utf-8' }],
    [200, { 'content-type': 'Application/JSON;charset=UTF-8' }],
    [200, { 'content-type': 'application/atom+xml' }],
    [200, { 'content-type': 'application/rss+xml; charset=utf-8' }],
    [200, { 'content-type': 'application/xml' }],
    [200, { 'content-type': 'text/xml; charset=utf-8' }],
    [200, { 'content-type': 'application/feed+json' }],
    [200, { 'content-type': 'application/json', 'content-encoding': 'identity' }],
    [200, { 'content-type': 'application/json', 'content-length': '2097152' }],
  ])('accepts %j %j', (status, headers) => {
    expect(checkFeedHead(status, headers)).toBeNull();
  });

  it.each([300, 301, 302, 303, 307, 308, 399])('redirect %i is a refusal', (status) => {
    expect(checkFeedHead(status, { ...good, location: 'https://10.0.0.1/' })).toBe('redirect');
  });
  it.each([100, 199, 201, 204, 206, 400, 401, 403, 404, 429, 500, 503, 0, 600, NaN, 200.5])(
    'status %s is bad_status',
    (status) => {
      expect(checkFeedHead(status, good)).toBe('bad_status');
    },
  );
  it.each([
    [{}],
    [{ 'content-type': 'text/html' }],
    [{ 'content-type': 'text/html; charset=utf-8' }],
    [{ 'content-type': 'text/plain' }],
    [{ 'content-type': 'application/octet-stream' }],
    [{ 'content-type': 'application/javascript' }],
    [{ 'content-type': 'image/png' }],
    [{ 'content-type': 'application/json2' }],
    [{ 'content-type': 'application/jsonp' }],
    [{ 'content-type': 'xapplication/json' }],
    [{ 'content-type': '' }],
    [{ 'content-type': ['application/json', 'text/html'] }],
    [{ 'content-type': 'application/json; charset=utf-7' }],
    [{ 'content-type': 'application/json; charset=latin1' }],
  ])('wrong content type %j', (headers) => {
    expect(checkFeedHead(200, headers as Record<string, string>)).toBe('bad_content_type');
  });
  it.each(['gzip', 'br', 'deflate', 'compress', 'zstd', 'gzip, identity'])(
    'content encoding %s is refused',
    (enc) => {
      expect(checkFeedHead(200, { ...good, 'content-encoding': enc })).toBe('content_encoding');
    },
  );
  it.each(['2097153', '99999999999', '9007199254740993'])('declared size %s is too_large', (n) => {
    expect(checkFeedHead(200, { ...good, 'content-length': n })).toBe('too_large');
  });
  it.each(['abc', '-1', '1e3', ''])('a malformed content-length %j is refused', (n) => {
    expect(checkFeedHead(200, { ...good, 'content-length': n })).toBe('too_large');
  });
});
