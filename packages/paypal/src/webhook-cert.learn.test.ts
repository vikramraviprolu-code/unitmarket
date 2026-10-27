// CO-1d (D-038): the certificate source can describe a certificate (`inspect`) without trusting it, and
// the pin is a full pin (exact host, subject and issuer). No network: a counting stand-in Transport and
// certificates built here around keys made when the module loads.
import { X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CERT_FETCH_BUDGET_PER_HOUR,
  CERT_NEGATIVE_TTL_MS,
  CERT_UNKNOWN_FETCHES_PER_DAY,
  EXPECTED_CERT_PINS,
  createCertificateSource,
  isFullPin,
  parseCertificate,
  pinComplete,
} from './webhook-cert';
import type { CertPin } from './webhook-cert';
import { memoryLogger, mutableClock } from './test-support';
import {
  HOUR,
  SYNTHETIC_DIR,
  certHost,
  certUrl,
  certificatePem,
  fakeTransport,
  generateEc,
  pemResponse,
  signer,
} from './webhook-test-support';

const NOW = '2026-10-23T12:00:00Z';
const PARSE_ONLY = readFileSync(`${SYNTHETIC_DIR}parse-only.pem`, 'utf8');
const HOST = new URL(certUrl()).hostname;
const urlN = (n: number) => certUrl({ path: `/v1/notifications/certs/CERT-LEARN-${n}` });
const pem = (over: Partial<Parameters<typeof certificatePem>[0]> = {}) =>
  certificatePem({
    publicKey: signer.publicKey,
    notBefore: new Date('2026-01-01T00:00:00Z'),
    notAfter: new Date('2027-01-01T00:00:00Z'),
    cn: 'learn.example.invalid',
    issuer_cn: 'Learn Issuer',
    ...over,
  });

describe('the pin is a full pin', () => {
  const full: CertPin = { host: HOST, subject: 'CN=a.invalid', issuer: 'CN=b.invalid' };

  it('holds the one certificate the owner window learned (D-043) and that pin is complete', () => {
    expect(EXPECTED_CERT_PINS).toHaveLength(1);
    expect(EXPECTED_CERT_PINS.every((p) => isFullPin(p))).toBe(true);
    expect(pinComplete(EXPECTED_CERT_PINS)).toBe(true);
  });
  it('a pin with exact host, subject and issuer is full; a list is complete only if every entry is full', () => {
    expect(isFullPin(full)).toBe(true);
    expect(pinComplete([full])).toBe(true);
    expect(pinComplete([full, { ...full, host: certHost(['certs']) }])).toBe(true);
    expect(pinComplete([full, { ...full, issuer: '' }])).toBe(false);
  });
  it.each([
    ['no host', { ...full, host: '' }],
    ['no subject', { ...full, subject: '' }],
    ['no issuer', { ...full, issuer: '' }],
    ['blank issuer', { ...full, issuer: '   ' }],
    [
      'a host outside the sandbox zone',
      { ...full, host: ['evil', 'example', 'invalid'].join('.') },
    ],
    ['a host two labels deep', { ...full, host: certHost(['a', 'b']) }],
    ['the bare sandbox zone', { ...full, host: certHost([]) }],
    ['a host with a port', { ...full, host: `${HOST}:8443` }],
    ['a wildcard host', { ...full, host: `*.${certHost([])}` }],
    ['an upper-case host', { ...full, host: HOST.toUpperCase() }],
  ])('%s is not a full pin', (_n, pin) => {
    expect(isFullPin(pin)).toBe(false);
    expect(pinComplete([pin])).toBe(false);
  });
  it('the old subject-only shape (strings) is never complete', () => {
    expect(pinComplete(['CN=a.invalid'] as unknown as readonly CertPin[])).toBe(false);
    expect(pinComplete([{ subject: 'CN=a.invalid' }] as unknown as readonly CertPin[])).toBe(false);
  });
  it('an empty list is not complete', () => {
    expect(pinComplete([])).toBe(false);
  });
});

describe('parseCertificate carries the facts a pin needs', () => {
  it('the committed parse-only PEM: issuer, CN, fingerprint', () => {
    const x = new X509Certificate(PARSE_ONLY);
    const r = parseCertificate(PARSE_ONLY, new Date(x.validFromDate.getTime() + 86_400_000));
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    expect(r.cert.subject).toBe(
      'CN=synthetic-webhook-cert.invalid, O=UnitMarket SBX synthetic test',
    );
    expect(r.cert.subject_cn).toBe('synthetic-webhook-cert.invalid');
    expect(r.cert.issuer).toBe(
      'CN=synthetic-webhook-cert.invalid, O=UnitMarket SBX synthetic test',
    );
    expect(r.cert.fingerprint256).toBe(x.fingerprint256);
    expect(r.cert.fingerprint256).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
  });
});

describe('inspect: describe, never trust', () => {
  const make = (answer = () => pemResponse(pem()), extra: object = {}) => {
    const t = fakeTransport(answer);
    const clock = mutableClock(NOW);
    const log = memoryLogger();
    const source = createCertificateSource({
      expected_pins: [],
      transport: t,
      clock,
      log,
      ...extra,
    });
    return { t, clock, log, source };
  };

  it('returns the listed facts and nothing else', async () => {
    const { source } = make();
    const r = await source.inspect(urlN(1));
    expect(r).toEqual({
      kind: 'ok',
      facts: {
        host: HOST,
        path: '/v1/notifications/certs/CERT-LEARN-1',
        subject: 'CN=learn.example.invalid',
        subject_cn: 'learn.example.invalid',
        issuer: 'CN=Learn Issuer',
        valid_from: '2026-01-01T00:00:00.000Z',
        valid_to: '2027-01-01T00:00:00.000Z',
        fingerprint_sha256: new X509Certificate(pem()).fingerprint256,
      },
    });
    if (r.kind === 'ok')
      expect(Object.keys(r.facts).sort()).toEqual([
        'fingerprint_sha256',
        'host',
        'issuer',
        'path',
        'subject',
        'subject_cn',
        'valid_from',
        'valid_to',
      ]);
  });

  it('fetches once, through the Transport as fetch_webhook_cert, GET, no token, no body', async () => {
    const { t, source } = make();
    await source.inspect(urlN(1));
    expect(t.calls).toHaveLength(1);
    const req = t.calls[0]!;
    expect(req.operation).toBe('fetch_webhook_cert');
    expect(req.method).toBe('GET');
    expect(req.path).toBe(urlN(1));
    expect(req.body).toBeNull();
    expect(Object.keys(req.headers).map((k) => k.toLowerCase())).not.toContain('authorization');
  });

  it('does not fill the verification cache and does not trust the URL', async () => {
    const { t, source } = make();
    await source.inspect(urlN(1));
    expect(source.stats().certificates).toBe(0);
    expect(source.stats().trusted_urls).toEqual([]);
    // a verification lookup of the same URL has to fetch again: nothing was cached for it
    expect((await source.get(urlN(1))).kind).toBe('ok');
    expect(t.calls).toHaveLength(2);
    expect(source.stats().trusted_urls).toEqual([]);
  });

  it('the pin does not stop a description (a rotated certificate must be learnable) and nothing is pinned by it', async () => {
    const { source } = make(undefined, {
      expected_pins: [{ host: HOST, subject: 'CN=other.invalid', issuer: 'CN=Other Issuer' }],
    });
    expect((await source.inspect(urlN(1))).kind).toBe('ok');
    // verification still refuses the same certificate
    expect(await source.get(urlN(1))).toEqual({ kind: 'unavailable', why: 'pin' });
  });

  it('writes no log line of its own (the caller logs the facts) and never the certificate text', async () => {
    const { log, source } = make();
    await source.inspect(urlN(1));
    expect(log.events).toEqual([]);
  });

  it('a repeat of the same URL is answered from memory: no second fetch, no second budget unit', async () => {
    const { t, source } = make();
    const a = await source.inspect(urlN(1));
    const b = await source.inspect(urlN(1));
    expect(b).toEqual(a);
    expect(t.calls).toHaveLength(1);
    expect(source.stats().fetches_in_window).toBe(1);
  });

  it('two lookups of one URL in flight share one fetch', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const slow = fakeTransport(async () => {
      await gate;
      return pemResponse(pem());
    });
    const s2 = createCertificateSource({
      expected_pins: [],
      transport: slow,
      clock: mutableClock(NOW),
    });
    const p1 = s2.inspect(urlN(1));
    const p2 = s2.inspect(urlN(1));
    release();
    expect((await p1).kind).toBe('ok');
    expect((await p2).kind).toBe('ok');
    expect(slow.calls).toHaveLength(1);
  });

  it('the memory is bounded (8 URLs) and forgets after an hour', async () => {
    const { t, clock, source } = make();
    for (let i = 1; i <= 6; i++) await source.inspect(urlN(i));
    expect(t.calls).toHaveLength(6);
    clock.advance(HOUR);
    await source.inspect(urlN(1)); // memory expired: fetched again (budget window has rolled too)
    expect(t.calls).toHaveLength(7);
  });
});

describe('inspect uses the existing budgets and widens none', () => {
  const NOW_ = NOW;
  const build = () => {
    const t = fakeTransport(() => pemResponse(pem()));
    const clock = mutableClock(NOW_);
    return {
      t,
      clock,
      source: createCertificateSource({ expected_pins: [], transport: t, clock }),
    };
  };

  it('cold start: inspect and get share the 6 an hour; the 7th fetch of either kind is refused without a call', async () => {
    const { t, source } = build();
    expect(CERT_FETCH_BUDGET_PER_HOUR).toBe(6);
    for (let i = 1; i <= 3; i++) expect((await source.inspect(urlN(i))).kind).toBe('ok');
    for (let i = 4; i <= 6; i++) expect((await source.get(urlN(i))).kind).toBe('ok');
    expect(t.calls).toHaveLength(6);
    expect(await source.inspect(urlN(7))).toEqual({ kind: 'unavailable', why: 'fetch' });
    expect(await source.get(urlN(8))).toEqual({ kind: 'unavailable', why: 'fetch' });
    expect(t.calls).toHaveLength(6);
  });

  it('after an hour the budget is back', async () => {
    const { t, clock, source } = build();
    for (let i = 1; i <= 6; i++) await source.inspect(urlN(i));
    clock.advance(HOUR);
    expect((await source.inspect(urlN(7))).kind).toBe('ok');
    expect(t.calls).toHaveLength(7);
  });

  it('once a URL is trusted, unknown URLs get 1 an hour and 12 a day, inspect included', async () => {
    const { t, clock, source } = build();
    await source.get(urlN(1));
    source.trust(urlN(1));
    clock.advance(HOUR); // the cold fetch above counted in the unknown budget of its hour
    expect(CERT_UNKNOWN_FETCHES_PER_DAY).toBe(12);
    expect((await source.inspect(urlN(2))).kind).toBe('ok');
    const before = t.calls.length;
    expect(await source.inspect(urlN(3))).toEqual({ kind: 'unavailable', why: 'fetch' });
    expect(t.calls).toHaveLength(before);
    clock.advance(HOUR);
    expect((await source.inspect(urlN(3))).kind).toBe('ok');
  });

  it('a failed URL is remembered for 10 minutes and is not fetched again by inspect', async () => {
    const t = fakeTransport(() => ({ kind: 'timeout' }));
    const clock = mutableClock(NOW_);
    const source = createCertificateSource({ expected_pins: [], transport: t, clock });
    expect(await source.inspect(urlN(1))).toEqual({ kind: 'unavailable', why: 'fetch' });
    expect(await source.inspect(urlN(1))).toEqual({ kind: 'unavailable', why: 'fetch' });
    expect(t.calls).toHaveLength(1);
    clock.advance(CERT_NEGATIVE_TTL_MS);
    await source.inspect(urlN(1));
    expect(t.calls).toHaveLength(2);
  });
});

describe('inspect: every failure is unavailable, never facts', () => {
  const run = async (answer: Parameters<typeof fakeTransport>[0]) => {
    const t = fakeTransport(answer);
    return {
      t,
      r: await createCertificateSource({
        expected_pins: [],
        transport: t,
        clock: mutableClock(NOW),
      }).inspect(urlN(1)),
    };
  };
  it('blocked, timeout, throwing transport, 404, 500, a redirect answer: fetch', async () => {
    const fail = { kind: 'unavailable', why: 'fetch' };
    expect((await run(() => ({ kind: 'blocked', by: 'no_approval' }))).r).toEqual(fail);
    expect((await run(() => ({ kind: 'timeout' }))).r).toEqual(fail);
    expect(
      (
        await run(() => {
          throw new Error('boom');
        })
      ).r,
    ).toEqual(fail);
    for (const status of [301, 302, 307, 404, 500]) {
      const x = await run(() => pemResponse('', status));
      expect([status, x.r]).toEqual([status, fail]);
      expect(x.t.calls).toHaveLength(1); // no second request: nothing follows a redirect
    }
  });
  it('garbage, an oversized body, an expired or not-yet-valid certificate, an EC key', async () => {
    expect((await run(() => pemResponse('not a certificate'))).r).toEqual({
      kind: 'unavailable',
      why: 'parse',
    });
    expect((await run(() => pemResponse('x'.repeat(64 * 1024 + 1)))).r).toEqual({
      kind: 'unavailable',
      why: 'parse',
    });
    expect(
      (await run(() => pemResponse(pem({ notAfter: new Date('2026-06-01T00:00:00Z') })))).r,
    ).toEqual({ kind: 'unavailable', why: 'validity' });
    expect(
      (await run(() => pemResponse(pem({ notBefore: new Date('2026-12-01T00:00:00Z') })))).r,
    ).toEqual({ kind: 'unavailable', why: 'validity' });
    expect((await run(() => pemResponse(pem({ publicKey: generateEc().publicKey })))).r).toEqual({
      kind: 'unavailable',
      why: 'key',
    });
  });
});
