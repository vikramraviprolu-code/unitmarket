import { X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { OutboundRequest } from '@umsbx/contracts';
import {
  CERT_CACHE_MAX_AGE_MS,
  CERT_CACHE_MAX_ENTRIES,
  CERT_FETCH_BUDGET_PER_HOUR,
  CERT_FETCH_WINDOW_MS,
  CERT_NEGATIVE_MAX_ENTRIES,
  CERT_NEGATIVE_TTL_MS,
  EXPECTED_CERT_PINS,
  createCertCache,
  createCertificateSource,
  parseCertificate,
} from './webhook-cert';
import { memoryLogger, mutableClock } from './test-support';
import {
  DAY,
  HOUR,
  SYNTHETIC_DIR,
  certHost,
  certUrl,
  certificateOf,
  certificatePem,
  fakeTransport,
  generateEc,
  generateRsa,
  pemResponse,
  signer,
} from './webhook-test-support';

const PARSE_ONLY = readFileSync(`${SYNTHETIC_DIR}parse-only.pem`, 'utf8');
const parseOnly = new X509Certificate(PARSE_ONLY);
const FROM = parseOnly.validFromDate;
const TO = parseOnly.validToDate;
const inside = new Date(FROM.getTime() + DAY);

describe('limits', () => {
  it('the cache keeps 8 entries for at most 24 hours', () => {
    expect(CERT_CACHE_MAX_ENTRIES).toBe(8);
    expect(CERT_CACHE_MAX_AGE_MS).toBe(24 * HOUR);
  });
  it('outbound fetches: at most 6 an hour, failures remembered 10 minutes, at most 32 of them', () => {
    expect(CERT_FETCH_BUDGET_PER_HOUR).toBe(6);
    expect(CERT_FETCH_WINDOW_MS).toBe(HOUR);
    expect(CERT_NEGATIVE_TTL_MS).toBe(10 * 60_000);
    expect(CERT_NEGATIVE_MAX_ENTRIES).toBe(32);
  });
  it('exactly one certificate is pinned: the sandbox message verification certificate learned on 2026-10-27', () => {
    expect(EXPECTED_CERT_PINS).toHaveLength(1);
    expect(EXPECTED_CERT_PINS[0]).toEqual({
      host: ['api', 'sandbox', 'paypal', 'com'].join('.'),
      subject:
        'jurisdictionC=US, jurisdictionST=Delaware, businessCategory=Private Organization, serialNumber=3014267, C=US, ST=California, L=San Jose, O=PayPal\\, Inc., CN=messageverificationcerts.sandbox.paypal.com',
      issuer: 'C=US, O=DigiCert Inc, CN=DigiCert EV RSA CA G2',
    });
  });
});

describe('parseCertificate: the committed parse-only PEM (its key was discarded)', () => {
  it('parses to an RSA public key, a subject and the dates', () => {
    const r = parseCertificate(PARSE_ONLY, inside);
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    expect(r.cert.public_key.type).toBe('public');
    expect(r.cert.public_key.asymmetricKeyType).toBe('rsa');
    expect(r.cert.subject).toContain('synthetic-webhook-cert.invalid');
    expect(r.cert.valid_from.getTime()).toBe(FROM.getTime());
    expect(r.cert.valid_to.getTime()).toBe(TO.getTime());
  });

  it('is valid on both boundary milliseconds and refused one millisecond outside', () => {
    expect(parseCertificate(PARSE_ONLY, FROM).kind).toBe('ok');
    expect(parseCertificate(PARSE_ONLY, TO).kind).toBe('ok');
    expect(parseCertificate(PARSE_ONLY, new Date(FROM.getTime() - 1))).toEqual({
      kind: 'unavailable',
      why: 'validity',
    });
    expect(parseCertificate(PARSE_ONLY, new Date(TO.getTime() + 1))).toEqual({
      kind: 'unavailable',
      why: 'validity',
    });
  });

  it('refuses a date far before and far after', () => {
    expect(parseCertificate(PARSE_ONLY, new Date('2001-01-01T00:00:00Z'))).toMatchObject({
      why: 'validity',
    });
    expect(parseCertificate(PARSE_ONLY, new Date('2100-01-01T00:00:00Z'))).toMatchObject({
      why: 'validity',
    });
  });
});

describe('parseCertificate: certificates built in the test around generated keys', () => {
  const now = new Date('2026-10-23T12:00:00Z');
  const pemWith = (over: Partial<Parameters<typeof certificatePem>[0]> = {}) =>
    certificatePem({
      publicKey: signer.publicKey,
      notBefore: new Date('2026-01-01T00:00:00Z'),
      notAfter: new Date('2027-01-01T00:00:00Z'),
      ...over,
    });

  it('returns the key that is inside the certificate', () => {
    const r = parseCertificate(pemWith(), now);
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    expect(r.cert.public_key.equals(signer.publicKey)).toBe(true);
    expect(r.cert.valid_to.toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });

  it('refuses not-yet-valid and expired certificates', () => {
    expect(parseCertificate(pemWith({ notBefore: new Date('2026-10-24T00:00:00Z') }), now)).toEqual(
      { kind: 'unavailable', why: 'validity' },
    );
    expect(parseCertificate(pemWith({ notAfter: new Date('2026-10-22T00:00:00Z') }), now)).toEqual({
      kind: 'unavailable',
      why: 'validity',
    });
  });

  it('refuses a non-RSA key (no algorithm confusion) and an RSA key under 2048 bits', () => {
    const ec = generateEc();
    expect(parseCertificate(pemWith({ publicKey: ec.publicKey }), now)).toEqual({
      kind: 'unavailable',
      why: 'key',
    });
    const small = generateRsa(1024);
    expect(parseCertificate(pemWith({ publicKey: small.publicKey }), now)).toEqual({
      kind: 'unavailable',
      why: 'key',
    });
  });

  it('the size cap is 64 KiB of text: exactly that is read, one byte more is refused', () => {
    const exact = PARSE_ONLY.padEnd(64 * 1024, '\n');
    expect(Buffer.byteLength(exact)).toBe(64 * 1024);
    expect(parseCertificate(exact, inside).kind).toBe('ok');
    expect(parseCertificate(exact + '\n', inside)).toEqual({ kind: 'unavailable', why: 'parse' });
  });

  it('refuses text that is not a certificate', () => {
    for (const bad of [
      '',
      'not a pem',
      '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n',
      '<html>500</html>',
      PARSE_ONLY.replace(/[A-Za-z0-9]{8}\n/, 'AAAAAAAA\n').slice(0, 200),
    ]) {
      expect(parseCertificate(bad, now)).toEqual({ kind: 'unavailable', why: 'parse' });
    }
  });
});

describe('createCertCache', () => {
  const cert = (over = {}) => certificateOf(signer.publicKey, over);
  const T0 = '2026-10-23T12:00:00Z';

  it('returns what was stored, and null for an unknown URL', () => {
    const cache = createCertCache(mutableClock(T0));
    const c = cert();
    cache.set('u1', c);
    expect(cache.get('u1')).toBe(c);
    expect(cache.get('u2')).toBeNull();
    expect(cache.size()).toBe(1);
  });

  it('keeps 8 entries: the 9th evicts the oldest', () => {
    const cache = createCertCache(mutableClock(T0));
    for (let i = 1; i <= 8; i++) cache.set(`u${i}`, cert());
    expect(cache.size()).toBe(8);
    cache.set('u9', cert());
    expect(cache.size()).toBe(8);
    expect(cache.get('u1')).toBeNull();
    for (const k of ['u2', 'u3', 'u4', 'u5', 'u6', 'u7', 'u8', 'u9'])
      expect(cache.get(k)).not.toBeNull();
  });

  it('is least-recently-used: a lookup keeps an entry, the 9th evicts the one unused longest', () => {
    const cache = createCertCache(mutableClock(T0));
    for (let i = 1; i <= 8; i++) cache.set(`u${i}`, cert());
    expect(cache.get('u1')).not.toBeNull(); // u1 is now the newest, u2 the oldest
    cache.set('u9', cert());
    expect(cache.get('u2')).toBeNull();
    expect(cache.get('u1')).not.toBeNull();
    for (const k of ['u3', 'u4', 'u5', 'u6', 'u7', 'u8', 'u9']) expect(cache.get(k)).not.toBeNull();
  });

  it('re-setting a URL replaces it and does not evict another', () => {
    const cache = createCertCache(mutableClock(T0));
    for (let i = 1; i <= 8; i++) cache.set(`u${i}`, cert());
    cache.set('u8', cert());
    expect(cache.size()).toBe(8);
    expect(cache.get('u1')).not.toBeNull();
  });

  it('expires after 24 hours when the certificate lasts longer', () => {
    const clock = mutableClock(T0);
    const cache = createCertCache(clock);
    cache.set('u', cert({ valid_to: new Date('2036-01-01T00:00:00Z') }));
    clock.advance(24 * HOUR);
    expect(cache.get('u')).not.toBeNull(); // the bound itself is still inside
    clock.advance(1);
    expect(cache.get('u')).toBeNull();
    expect(cache.size()).toBe(0);
  });

  it('expires at validTo when that comes before 24 hours', () => {
    const clock = mutableClock(T0);
    const cache = createCertCache(clock);
    cache.set('u', cert({ valid_to: new Date('2026-10-23T14:00:00Z') }));
    clock.advance(2 * HOUR);
    expect(cache.get('u')).not.toBeNull();
    clock.advance(1);
    expect(cache.get('u')).toBeNull();
  });

  it('a full cache drops expired entries before it drops a live one', () => {
    const clock = mutableClock(T0);
    const cache = createCertCache(clock);
    cache.set('short', cert({ valid_to: new Date('2026-10-23T12:30:00Z') }));
    for (let i = 1; i <= 7; i++) cache.set(`u${i}`, cert());
    clock.advance(HOUR);
    cache.set('new', cert());
    expect(cache.get('u1')).not.toBeNull();
    expect(cache.get('short')).toBeNull();
    expect(cache.size()).toBe(8);
  });

  it('does not store a certificate that has already expired', () => {
    const cache = createCertCache(mutableClock(T0));
    cache.set('u', cert({ valid_to: new Date('2026-10-23T11:00:00Z') }));
    expect(cache.get('u')).toBeNull();
    expect(cache.size()).toBe(0);
  });
});

describe('createCertificateSource: the request', () => {
  const NOW = '2026-10-23T12:00:00Z';
  const goodPem = () =>
    certificatePem({
      publicKey: signer.publicKey,
      notBefore: new Date('2026-01-01T00:00:00Z'),
      notAfter: new Date('2027-01-01T00:00:00Z'),
    });

  it('fetches through the Transport as fetch_webhook_cert, GET, absolute URL, no token, no body', async () => {
    const t = fakeTransport(() => pemResponse(goodPem()));
    const source = createCertificateSource({
      expected_pins: [],
      transport: t,
      clock: mutableClock(NOW),
    });
    const r = await source.get(certUrl());
    expect(r.kind).toBe('ok');
    expect(t.calls).toHaveLength(1);
    const req = t.calls[0] as OutboundRequest;
    expect(req.operation).toBe('fetch_webhook_cert');
    expect(req.method).toBe('GET');
    expect(req.path).toBe(certUrl());
    expect(req.body).toBeNull();
    expect(Object.keys(req.headers).map((k) => k.toLowerCase())).not.toContain('authorization');
    expect(req.order_ref).toBeNull();
    expect(req.amount_minor).toBeNull();
  });

  it('sends the normalised URL the guard accepted, not the caller spelling', async () => {
    const t = fakeTransport(() => pemResponse(goodPem()));
    const source = createCertificateSource({
      expected_pins: [],
      transport: t,
      clock: mutableClock(NOW),
    });
    await source.get(certUrl({ host: certUrl().split('/')[2]!.toUpperCase() }));
    expect(t.calls[0]?.path).toBe(certUrl());
  });

  it('refuses an off-list URL without sending (defence in depth: the Transport guards too)', async () => {
    const t = fakeTransport(() => pemResponse(goodPem()));
    const source = createCertificateSource({
      expected_pins: [],
      transport: t,
      clock: mutableClock(NOW),
    });
    for (const u of [
      certUrl({ scheme: 'http' }),
      certUrl({ host: 'evil.example' }),
      certUrl({ path: '/v1/oauth2/token' }),
      'not a url',
    ]) {
      expect(await source.get(u)).toEqual({ kind: 'unavailable', why: 'fetch' });
    }
    expect(t.calls).toHaveLength(0);
  });
});

describe('createCertificateSource: every failure is unavailable, never ok', () => {
  const NOW = '2026-10-23T12:00:00Z';
  const run = async (answer: Parameters<typeof fakeTransport>[0]) => {
    const t = fakeTransport(answer);
    return createCertificateSource({
      expected_pins: [],
      transport: t,
      clock: mutableClock(NOW),
    }).get(certUrl());
  };
  const pem = (over = {}) =>
    certificatePem({
      publicKey: signer.publicKey,
      notBefore: new Date('2026-01-01T00:00:00Z'),
      notAfter: new Date('2027-01-01T00:00:00Z'),
      ...over,
    });

  it('blocked, timeout, network error, a throwing transport: fetch', async () => {
    const fetchFail = { kind: 'unavailable', why: 'fetch' };
    expect(await run(() => ({ kind: 'blocked', by: 'egress' }))).toEqual(fetchFail);
    expect(await run(() => ({ kind: 'blocked', by: 'kill_switch' }))).toEqual(fetchFail);
    expect(await run(() => ({ kind: 'timeout' }))).toEqual(fetchFail);
    expect(await run(() => ({ kind: 'network_error', code: 'ECONNRESET' }))).toEqual(fetchFail);
    expect(
      await run(() => {
        throw new Error('boom');
      }),
    ).toEqual(fetchFail);
  });

  it('any status other than 200: fetch', async () => {
    for (const status of [201, 204, 301, 302, 304, 401, 403, 404, 429, 500, 503]) {
      expect(await run(() => pemResponse(pem(), status))).toEqual({
        kind: 'unavailable',
        why: 'fetch',
      });
    }
  });

  it('a body that is not a certificate: parse; an oversized body: parse', async () => {
    expect(await run(() => pemResponse('<html>oops</html>'))).toEqual({
      kind: 'unavailable',
      why: 'parse',
    });
    expect(await run(() => pemResponse(pem() + 'x'.repeat(70_000)))).toEqual({
      kind: 'unavailable',
      why: 'parse',
    });
  });

  it('an expired or not-yet-valid certificate: validity', async () => {
    expect(
      await run(() => pemResponse(pem({ notAfter: new Date('2026-10-01T00:00:00Z') }))),
    ).toEqual({ kind: 'unavailable', why: 'validity' });
    expect(
      await run(() => pemResponse(pem({ notBefore: new Date('2026-11-01T00:00:00Z') }))),
    ).toEqual({ kind: 'unavailable', why: 'validity' });
  });

  it('an EC key: key', async () => {
    expect(await run(() => pemResponse(pem({ publicKey: generateEc().publicKey })))).toEqual({
      kind: 'unavailable',
      why: 'key',
    });
  });
});

describe('createCertificateSource: subject pin and log', () => {
  const NOW = '2026-10-23T12:00:00Z';
  const pem = certificatePem({
    publicKey: signer.publicKey,
    notBefore: new Date('2026-01-01T00:00:00Z'),
    notAfter: new Date('2027-01-01T00:00:00Z'),
    cn: 'pinned.example.invalid',
  });

  it('with an empty list the subject is logged once and not checked', async () => {
    const log = memoryLogger();
    const t = fakeTransport(() => pemResponse(pem));
    const source = createCertificateSource({
      expected_pins: [],
      transport: t,
      clock: mutableClock(NOW),
      log,
    });
    expect((await source.get(certUrl())).kind).toBe('ok');
    const events = log.events.filter((e) => e.msg === 'paypal.webhook_cert');
    expect(events).toHaveLength(1);
    expect(String(events[0]?.fields['subject'])).toContain('pinned.example.invalid');
    // a cache hit logs nothing more
    await source.get(certUrl());
    expect(log.events.filter((e) => e.msg === 'paypal.webhook_cert')).toHaveLength(1);
  });

  it('the log never carries the certificate text or key material', async () => {
    const log = memoryLogger();
    const t = fakeTransport(() => pemResponse(pem));
    await createCertificateSource({
      expected_pins: [],
      transport: t,
      clock: mutableClock(NOW),
      log,
    }).get(certUrl());
    const text = JSON.stringify(log.events);
    expect(text).not.toContain('BEGIN CERTIFICATE');
    expect(text).not.toContain(pem.split('\n')[1]!);
  });

  it('with a pinned list, only a certificate whose URL host, subject and issuer all match passes (unavailable: pin)', async () => {
    const host = new URL(certUrl()).hostname;
    const pinned = {
      host,
      subject: 'CN=pinned.example.invalid',
      issuer: 'CN=Synthetic Issuer',
    };
    const run = async (pin: typeof pinned, url = certUrl()) =>
      createCertificateSource({
        transport: fakeTransport(() => pemResponse(pem)),
        clock: mutableClock(NOW),
        expected_pins: [pin],
      }).get(url);
    expect((await run(pinned)).kind).toBe('ok');
    const refused = { kind: 'unavailable', why: 'pin' };
    expect(await run({ ...pinned, subject: 'CN=someone.else.invalid' })).toEqual(refused);
    expect(await run({ ...pinned, issuer: 'CN=Other Issuer' })).toEqual(refused);
    expect(await run({ ...pinned, host: certHost(['other']) })).toEqual(refused);
    // the same certificate served from another allowed host is not the pinned host
    expect(await run(pinned, certUrl({ host: certHost(['other']) }))).toEqual(refused);
  });
});
