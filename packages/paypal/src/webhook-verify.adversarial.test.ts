import { describe, expect, it } from 'vitest';
import type { WebhookVerdict } from '@umsbx/contracts';
import { createCertificateSource } from './webhook-cert';
import type { CertificateSource } from './webhook-cert';
import { verifyWebhook } from './webhook-verify';
import { mutableClock } from './test-support';
import type { Delivery, WebhookFixture } from './webhook-test-support';
import {
  DAY,
  HOUR,
  MINUTE,
  NOW_ISO,
  TRANSMISSION_TIME,
  WEBHOOK_ID,
  certHost,
  certUrl,
  certificateOf,
  certificatePem,
  deliver,
  fakeCertificates,
  fakeTransport,
  forger,
  generateEc,
  loadWebhookFixtures,
  okCertificates,
  pemResponse,
  rawBodyOf,
  signer,
} from './webhook-test-support';

const f = loadWebhookFixtures().find((x) => x.name === 'capture-completed') as WebhookFixture;
const T = Date.parse(TRANSMISSION_TIME);
const iso = (ms: number) => new Date(ms).toISOString().replace('.000Z', 'Z');

interface Opts {
  now?: string;
  webhook_id?: string | null;
  certificates?: CertificateSource;
}
const run = (d: Delivery, o: Opts = {}): Promise<WebhookVerdict> =>
  verifyWebhook(
    {
      clock: mutableClock(o.now ?? NOW_ISO),
      webhook_id: o.webhook_id === undefined ? WEBHOOK_ID : o.webhook_id,
      certificates: o.certificates ?? okCertificates(),
    },
    d,
  );
const bad = (why: string) => ({ kind: 'bad_signature', why });

/** The real certificate source over a transport that counts what leaves, serving a valid certificate. */
function realSource() {
  const pem = certificatePem({
    publicKey: signer.publicKey,
    notBefore: new Date('2026-01-01T00:00:00Z'),
    notAfter: new Date('2027-01-01T00:00:00Z'),
  });
  const transport = fakeTransport(() => pemResponse(pem));
  return {
    transport,
    source: createCertificateSource({ transport, clock: mutableClock(NOW_ISO) }),
  };
}

describe('forgery attempts are bad_signature and cost nothing', () => {
  it('control: the untouched delivery verifies', async () => {
    expect(await run(deliver(f))).toMatchObject({ kind: 'verified' });
  });

  it('a signature made with another key', async () => {
    expect(await run(deliver(f, { key: forger.privateKey }))).toEqual(bad('signature'));
  });

  it('one changed body byte (same length), even if the result is no longer JSON', async () => {
    const d = deliver(f);
    const i = d.raw_body.indexOf('5.00');
    for (const raw of [
      d.raw_body.slice(0, i) + '9' + d.raw_body.slice(i + 1),
      d.raw_body.slice(0, 1) + '\t' + d.raw_body.slice(2),
      d.raw_body + ' ',
      d.raw_body.slice(0, -1),
    ]) {
      expect(await run({ ...d, raw_body: raw })).toEqual(bad('signature'));
    }
  });

  it('a wrong webhook id on either side', async () => {
    expect(await run(deliver(f, { webhook_id: 'SOME-OTHER-WEBHOOK' }))).toEqual(bad('signature'));
    expect(await run(deliver(f), { webhook_id: 'SOME-OTHER-WEBHOOK' })).toEqual(bad('signature'));
    expect(await run(deliver(f), { webhook_id: WEBHOOK_ID + ' ' })).toEqual(bad('signature'));
  });

  it('the re-serialised body (JSON.stringify(JSON.parse(raw)))', async () => {
    const d = deliver(f);
    const reserialised = JSON.stringify(JSON.parse(d.raw_body));
    expect(reserialised).not.toBe(d.raw_body);
    expect(await run({ ...d, raw_body: reserialised })).toEqual(bad('signature'));
  });

  it('the signature of one event replayed on another event', async () => {
    const other = loadWebhookFixtures().find((x) => x.name === 'capture-denied') as WebhookFixture;
    const d = deliver(f);
    expect(await run({ ...d, raw_body: rawBodyOf(other) })).toEqual(bad('signature'));
  });

  it('a signature moved to another transmission id or time', async () => {
    const d = deliver(f);
    expect(
      await run({ ...d, headers: { ...d.headers, 'paypal-transmission-id': 'SYN-TRANS-9999' } }),
    ).toEqual(bad('signature'));
    expect(
      await run({
        ...d,
        headers: { ...d.headers, 'paypal-transmission-time': iso(T + 1000) },
      }),
    ).toEqual(bad('signature'));
  });

  it('a signature made over a different hash is not accepted', async () => {
    expect(await run(deliver(f, { hash: 'SHA1' }))).toEqual(bad('signature'));
  });

  it('signature text that is not canonical base64, empty, or far too long', async () => {
    const d = deliver(f);
    const sig = d.headers['paypal-transmission-sig'] as string;
    const certs = okCertificates();
    const urlSafe = sig.replaceAll('+', '-').replaceAll('/', '_');
    for (const s of [
      sig.slice(0, 20) + '!' + sig.slice(21),
      ' ' + sig,
      sig + '\n',
      sig.slice(0, -1),
      sig + 'AAAA',
      'AAAA'.repeat(2000),
      'not base64 at all',
      ...(urlSafe === sig ? [] : [urlSafe]),
    ]) {
      const verdict = await run(
        { ...d, headers: { ...d.headers, 'paypal-transmission-sig': s } },
        {
          certificates: certs,
        },
      );
      expect(verdict).toEqual(bad('signature'));
    }
    // rejected on shape before any certificate is fetched
    expect(certs.calls).toHaveLength(0);
  });

  it('the verdict never echoes the body, the signature or the certificate URL', async () => {
    const d = deliver(f, { key: forger.privateKey });
    const text = JSON.stringify(await run(d));
    expect(text).not.toContain(d.headers['paypal-transmission-sig'] as string);
    expect(text).not.toContain('SBXCAP');
    expect(text).not.toContain('notifications');
  });
});

describe('algorithm', () => {
  it('SHA1withRSA is bad_signature(algo) and nothing is fetched', async () => {
    const certs = okCertificates();
    expect(
      await run(deliver(f, { algo: 'SHA1withRSA', hash: 'SHA1' }), { certificates: certs }),
    ).toEqual(bad('algo'));
    expect(certs.calls).toHaveLength(0);
  });

  it('only the exact string SHA256withRSA passes', async () => {
    for (const algo of [
      'sha256withrsa',
      'SHA256withRSA ',
      ' SHA256withRSA',
      'SHA256',
      'SHA256withECDSA',
      'RS256',
      'none',
    ]) {
      expect(await run(deliver(f, { algo }))).toEqual(bad('algo'));
    }
  });
});

describe('certificate URL: checked before any fetch (0 transport calls)', () => {
  const urls: Record<string, string> = {
    'http scheme': certUrl({ scheme: 'http' }),
    'port 8443': certUrl({ host: certHost() + ':8443' }),
    'sandbox domain followed by another suffix': certUrl({ host: certHost() + '.evil.example' }),
    'the sandbox domain inside a longer name': certUrl({ host: certHost() + 'x' }),
    'two labels deep under the sandbox domain': certUrl({ host: certHost(['a', 'b']) }),
    'the bare sandbox domain': certUrl({ host: certHost([]).replace(/^\./, '') }),
    userinfo: certUrl({ host: 'user:pw@' + certHost() }),
    'userinfo that looks like the host': certUrl({ host: certHost() + '@evil.example' }),
    'dot-dot in the path': certUrl({ path: '/v1/notifications/certs/../../oauth2/token' }),
    'dot-dot at the end': certUrl({ path: '/v1/notifications/certs/..' }),
    'a query': certUrl({ path: '/v1/notifications/certs/CERT-1?x=1' }),
    'a fragment': certUrl({ path: '/v1/notifications/certs/CERT-1#x' }),
    'percent-encoding': certUrl({ path: '/v1/notifications/certs/%2e%2e/x' }),
    'a backslash': certUrl({ path: '/v1/notifications/certs\\CERT-1' }),
    'another path': certUrl({ path: '/v1/oauth2/token' }),
    'the certs path prefix without a file': certUrl({ path: '/v1/notifications/certs/' }),
    'a sibling path prefix': certUrl({ path: '/v1/notifications/certs-extra/CERT-1' }),
    'another host entirely': certUrl({ host: 'evil.example' }),
    'a live-looking host': certUrl({ host: ['api', 'paypal', 'com'].join('.') }),
    'an IP address': certUrl({ host: '127.0.0.1' }),
    'a relative path': '/v1/notifications/certs/CERT-1',
    'a protocol-relative URL': '//' + certHost() + '/v1/notifications/certs/CERT-1',
    'a file URL': 'file:///etc/passwd',
    'not a URL': 'certs please',
    'a control character': certUrl({
      path: '/v1/notifications/certs/CERT-1\r\nHost: evil.example',
    }),
    spaces: certUrl({ path: '/v1/notifications/certs/CERT 1' }),
    'very long': certUrl({ path: '/v1/notifications/certs/' + 'A'.repeat(2000) }),
  };

  for (const [what, cert_url] of Object.entries(urls)) {
    it(`${what}: bad_signature(cert_url), 0 transport calls`, async () => {
      const { transport, source } = realSource();
      const d = deliver(f, { cert_url });
      expect(await run(d, { certificates: source })).toEqual(bad('cert_url'));
      expect(transport.calls).toHaveLength(0);
    });
  }

  it('control: the same delivery with a good URL makes exactly one transport call and verifies', async () => {
    const { transport, source } = realSource();
    expect(await run(deliver(f), { certificates: source })).toMatchObject({ kind: 'verified' });
    expect(transport.calls).toHaveLength(1);
    expect(transport.calls[0]?.operation).toBe('fetch_webhook_cert');
  });

  it('a case-folded host is the same host and passes', async () => {
    const { source } = realSource();
    const host = certHost().toUpperCase();
    expect(
      await run(deliver(f, { cert_url: certUrl({ host }) }), { certificates: source }),
    ).toMatchObject({
      kind: 'verified',
    });
  });
});

describe('certificate cannot be had: unverifiable (503), never a forgery', () => {
  const unverifiable = { kind: 'unverifiable' };

  it('fetch blocked', async () => {
    const t = fakeTransport(() => ({ kind: 'blocked', by: 'egress' }));
    const source = createCertificateSource({ transport: t, clock: mutableClock(NOW_ISO) });
    expect(await run(deliver(f), { certificates: source })).toEqual(unverifiable);
    expect(t.calls).toHaveLength(1);
  });

  it('fetch answers 500, 404, 403, or never answers', async () => {
    for (const answer of [
      pemResponse('oops', 500),
      pemResponse('', 404),
      pemResponse('', 403),
      { kind: 'timeout' } as const,
      { kind: 'network_error', code: 'ECONNRESET' } as const,
    ]) {
      const t = fakeTransport(() => answer);
      const source = createCertificateSource({ transport: t, clock: mutableClock(NOW_ISO) });
      expect(await run(deliver(f), { certificates: source })).toEqual(unverifiable);
    }
  });

  it('the transport throws', async () => {
    const t = fakeTransport(() => {
      throw new Error('socket exploded');
    });
    const source = createCertificateSource({ transport: t, clock: mutableClock(NOW_ISO) });
    expect(await run(deliver(f), { certificates: source })).toEqual(unverifiable);
  });

  it('a certificate source that throws or returns nonsense', async () => {
    const throwing: CertificateSource = {
      get: () => Promise.reject(new Error('boom')),
    };
    expect(await run(deliver(f), { certificates: throwing })).toEqual(unverifiable);
    const nonsense = {
      get: () => Promise.resolve({ kind: 'maybe' }),
    } as unknown as CertificateSource;
    expect(await run(deliver(f), { certificates: nonsense })).toEqual(unverifiable);
    const empty = { get: () => Promise.resolve(undefined) } as unknown as CertificateSource;
    expect(await run(deliver(f), { certificates: empty })).toEqual(unverifiable);
  });

  it('the body is not a certificate, or the certificate is expired or not yet valid', async () => {
    const pems = [
      '<html>',
      certificatePem({
        publicKey: signer.publicKey,
        notBefore: new Date('2025-01-01T00:00:00Z'),
        notAfter: new Date('2026-01-01T00:00:00Z'),
      }),
      certificatePem({
        publicKey: signer.publicKey,
        notBefore: new Date('2026-12-01T00:00:00Z'),
        notAfter: new Date('2027-01-01T00:00:00Z'),
      }),
    ];
    for (const pem of pems) {
      const t = fakeTransport(() => pemResponse(pem));
      const source = createCertificateSource({ transport: t, clock: mutableClock(NOW_ISO) });
      expect(await run(deliver(f), { certificates: source })).toEqual(unverifiable);
    }
  });

  it('a certificate with an EC key cannot verify an RSA-style signature, even a valid ECDSA one', async () => {
    const ec = generateEc();
    const pem = certificatePem({
      publicKey: ec.publicKey,
      notBefore: new Date('2026-01-01T00:00:00Z'),
      notAfter: new Date('2027-01-01T00:00:00Z'),
    });
    const t = fakeTransport(() => pemResponse(pem));
    const source = createCertificateSource({ transport: t, clock: mutableClock(NOW_ISO) });
    expect(await run(deliver(f, { key: ec.privateKey }), { certificates: source })).toEqual(
      unverifiable,
    );
  });

  it('a certificate that is expired by the clock reading in the source result is not trusted', async () => {
    // The verifier does not trust the source's dates blindly: an ok result already past its end is unverifiable.
    const expired = fakeCertificates({
      kind: 'ok',
      cert: certificateOf(signer.publicKey, { valid_to: new Date(T - 1) }),
    });
    expect(await run(deliver(f), { certificates: expired })).toEqual(unverifiable);
    const early = fakeCertificates({
      kind: 'ok',
      cert: certificateOf(signer.publicKey, { valid_from: new Date(T + HOUR) }),
    });
    expect(await run(deliver(f), { certificates: early })).toEqual(unverifiable);
  });

  it('webhook id not configured is unverifiable, and nothing is fetched', async () => {
    const certs = okCertificates();
    expect(await run(deliver(f), { webhook_id: null, certificates: certs })).toEqual(unverifiable);
    expect(certs.calls).toHaveLength(0);
    expect(await run(deliver(f), { webhook_id: '', certificates: certs })).toEqual(unverifiable);
    expect(certs.calls).toHaveLength(0);
  });
});

describe('size and headers: malformed', () => {
  const certs = () => okCertificates();
  const withBody = (raw: string) => {
    const d = deliver(f, { raw_body: raw });
    return d;
  };

  it('64 KiB plus 1 byte is malformed, before anything is fetched', async () => {
    const c = certs();
    const raw = ' '.repeat(65_537);
    expect(await run(withBody(raw), { certificates: c })).toEqual({ kind: 'malformed' });
    expect(c.calls).toHaveLength(0);
  });

  it('exactly 64 KiB is read (and verifies when it is validly signed JSON)', async () => {
    const base = JSON.stringify(f.body);
    const raw = base + ' '.repeat(65_536 - Buffer.byteLength(base));
    expect(Buffer.byteLength(raw)).toBe(65_536);
    expect(await run(withBody(raw))).toMatchObject({ kind: 'verified' });
  });

  it('the cap counts bytes, not characters', async () => {
    const raw = 'ü'.repeat(32_769); // 32,769 characters, 65,538 bytes
    expect(raw.length).toBeLessThan(65_536);
    expect(await run(withBody(raw))).toEqual({ kind: 'malformed' });
  });

  it('two paypal-transmission-sig headers that differ only in case', async () => {
    const d = deliver(f);
    const headers = {
      ...d.headers,
      'PayPal-Transmission-Sig': d.headers['paypal-transmission-sig'] as string,
    };
    expect(await run({ ...d, headers })).toEqual({ kind: 'malformed' });
  });

  for (const name of [
    'paypal-transmission-id',
    'paypal-transmission-time',
    'paypal-transmission-sig',
    'paypal-cert-url',
    'paypal-auth-algo',
  ]) {
    it(`${name}: missing, empty, or duplicated in another case is malformed`, async () => {
      const d = deliver(f);
      const { [name]: dropped, ...rest } = d.headers;
      void dropped;
      expect(await run({ ...d, headers: rest })).toEqual({ kind: 'malformed' });
      expect(await run({ ...d, headers: { ...d.headers, [name]: '' } })).toEqual({
        kind: 'malformed',
      });
      const twin = name.toUpperCase();
      expect(
        await run({ ...d, headers: { ...d.headers, [twin]: d.headers[name] as string } }),
      ).toEqual({ kind: 'malformed' });
    });
  }

  it('a header value that is not a string is malformed', async () => {
    const d = deliver(f);
    for (const v of [undefined, null, 5, ['a'], { a: 1 }]) {
      const headers = { ...d.headers, 'paypal-transmission-id': v } as unknown as Record<
        string,
        string
      >;
      expect(await run({ ...d, headers })).toEqual({ kind: 'malformed' });
    }
  });

  it('a transmission time that does not parse is malformed', async () => {
    for (const time of [
      '',
      'yesterday',
      '2026-10-23',
      '2026-10-23 12:00:00',
      '1761220800',
      '2026-13-01T00:00:00Z',
      '2026-10-23T25:00:00Z',
      'NaN',
      '2026-10-23T12:00:00Z; drop table',
    ]) {
      const d = deliver(f, { time });
      expect(await run(d)).toEqual({ kind: 'malformed' });
    }
  });

  it('a transmission id with the pipe separator or a control character is malformed', async () => {
    for (const id of ['a|b', 'a\nb', 'a b', 'x'.repeat(300)]) {
      expect(await run(deliver(f, { id }))).toEqual({ kind: 'malformed' });
    }
  });

  it('a body that is not a string is malformed', async () => {
    const d = deliver(f);
    expect(await run({ ...d, raw_body: undefined as unknown as string })).toEqual({
      kind: 'malformed',
    });
    expect(await run({ ...d, raw_body: 5 as unknown as string })).toEqual({ kind: 'malformed' });
  });

  it('an empty body that is validly signed is malformed (nothing to parse), not verified', async () => {
    expect(await run(deliver(f, { raw_body: '' }))).toEqual({ kind: 'malformed' });
  });
});

describe('the body is parsed only after the signature', () => {
  it('garbage that is not JSON with a bad signature is bad_signature, not malformed', async () => {
    const d = deliver(f, { key: forger.privateKey, raw_body: '{"id":' });
    expect(await run(d)).toEqual(bad('signature'));
  });

  it('validly signed but not JSON: malformed', async () => {
    for (const raw of ['{"id":', 'not json', 'null', '[]', '"x"', '5', 'true']) {
      expect(await run(deliver(f, { raw_body: raw }))).toEqual({ kind: 'malformed' });
    }
  });

  it('validly signed JSON that does not fit the event schema: malformed', async () => {
    const b = f.body as Record<string, unknown>;
    const cases: unknown[] = [
      { ...b, id: undefined },
      { ...b, id: '' },
      { ...b, id: 5 },
      { ...b, create_time: 'soon' },
      { ...b, create_time: undefined },
      { ...b, event_type: undefined },
      { ...b, resource: undefined },
      { ...b, resource: 'x' },
      {
        ...b,
        resource: {
          ...(b.resource as object),
          supplementary_data: { related_ids: { order_id: 'lower-case!' } },
        },
      },
    ];
    for (const body of cases) {
      const raw = JSON.stringify(body, null, 2);
      expect(await run(deliver(f, { raw_body: raw }))).toEqual({ kind: 'malformed' });
    }
  });

  it('does not call JSON.parse before the signature is known to be good', async () => {
    const real = JSON.parse;
    let calls = 0;
    JSON.parse = ((...a: Parameters<typeof JSON.parse>) => {
      calls += 1;
      return real(...a);
    }) as typeof JSON.parse;
    try {
      await run(deliver(f, { key: forger.privateKey }));
      await run(deliver(f, { algo: 'SHA1withRSA' }));
      await run(deliver(f), { webhook_id: null });
      expect(calls).toBe(0);
    } finally {
      JSON.parse = real;
    }
  });
});

describe('the transmission time window [now - 3 days 1 hour, now + 5 minutes]', () => {
  const at = (ms: number) => iso(ms);
  const now = (ms: number) => ({ now: at(ms) });

  it('exactly 3 days 1 hour old is accepted; one second older is stale', async () => {
    const edge = 3 * DAY + HOUR;
    expect(await run(deliver(f), now(T + edge))).toMatchObject({ kind: 'verified' });
    expect(await run(deliver(f), now(T + edge + 1000))).toEqual(bad('stale'));
  });

  it('exactly 5 minutes in the future is accepted; one second more is stale', async () => {
    expect(await run(deliver(f), now(T - 5 * MINUTE))).toMatchObject({ kind: 'verified' });
    expect(await run(deliver(f), now(T - 5 * MINUTE - 1000))).toEqual(bad('stale'));
  });

  it('a week old and a year ahead are stale, and nothing is fetched', async () => {
    const certs = okCertificates();
    expect(await run(deliver(f), { ...now(T + 7 * DAY), certificates: certs })).toEqual(
      bad('stale'),
    );
    expect(await run(deliver(f), { ...now(T - 365 * DAY), certificates: certs })).toEqual(
      bad('stale'),
    );
    expect(certs.calls).toHaveLength(0);
  });

  it('is judged on the header time, which the signature covers', async () => {
    const old = iso(T - 5 * DAY);
    expect(await run(deliver(f, { time: old }), now(T))).toEqual(bad('stale'));
  });

  it('an offset spelling of the same instant is the same instant', async () => {
    const d = deliver(f, { time: '2026-10-23T14:00:00+02:00' });
    expect(await run(d)).toMatchObject({ kind: 'verified' });
    const old = deliver(f, { time: '2026-10-19T14:00:00+02:00' });
    expect(await run(old)).toEqual(bad('stale'));
  });

  it('fractional seconds are read and kept verbatim in the signed message', async () => {
    const d = deliver(f, { time: '2026-10-23T12:00:00.123Z' });
    expect(await run(d)).toMatchObject({ kind: 'verified' });
  });
});

describe('order of checks: the earlier defect wins', () => {
  const certs = () => okCertificates();
  it('malformed beats algo', async () => {
    const d = deliver(f, { algo: 'SHA1withRSA' });
    const { 'paypal-transmission-id': _drop, ...rest } = d.headers;
    void _drop;
    expect(await run({ ...d, headers: rest })).toEqual({ kind: 'malformed' });
  });
  it('size beats a bad algorithm', async () => {
    expect(await run(deliver(f, { algo: 'SHA1withRSA', raw_body: ' '.repeat(70_000) }))).toEqual({
      kind: 'malformed',
    });
  });
  it('algo beats cert_url', async () => {
    expect(await run(deliver(f, { algo: 'none', cert_url: certUrl({ scheme: 'http' }) }))).toEqual(
      bad('algo'),
    );
  });
  it('cert_url beats stale', async () => {
    expect(
      await run(deliver(f, { cert_url: certUrl({ scheme: 'http' }) }), { now: iso(T + 30 * DAY) }),
    ).toEqual(bad('cert_url'));
  });
  it('stale beats a missing webhook id', async () => {
    expect(await run(deliver(f), { now: iso(T + 30 * DAY), webhook_id: null })).toEqual(
      bad('stale'),
    );
  });
  it('a missing webhook id beats everything after it, and nothing is fetched', async () => {
    const c = certs();
    expect(
      await run(deliver(f, { key: forger.privateKey }), { webhook_id: null, certificates: c }),
    ).toEqual({ kind: 'unverifiable' });
    expect(c.calls).toHaveLength(0);
  });
  it('an unavailable certificate beats a bad signature (nothing to check it with)', async () => {
    const unavailable = fakeCertificates({ kind: 'unavailable', why: 'fetch' });
    expect(
      await run(deliver(f, { key: forger.privateKey }), { certificates: unavailable }),
    ).toEqual({
      kind: 'unverifiable',
    });
  });
  it('a bad signature beats a malformed body', async () => {
    expect(await run(deliver(f, { key: forger.privateKey, raw_body: 'not json' }))).toEqual(
      bad('signature'),
    );
  });
});

describe('many hostile deliveries in a row leave no state behind', () => {
  it('a thousand mixed deliveries: only the untouched ones verify, the certificate is asked for per request', async () => {
    const certs = okCertificates();
    let verified = 0;
    for (let i = 0; i < 1000; i++) {
      const d = deliver(f);
      const kind = i % 4;
      const delivery =
        kind === 0
          ? d
          : kind === 1
            ? { ...d, raw_body: d.raw_body.replace('5.00', '6.00') }
            : kind === 2
              ? deliver(f, { key: forger.privateKey })
              : deliver(f, { webhook_id: 'OTHER' });
      const v = await run(delivery, { certificates: certs });
      if (v.kind === 'verified') verified += 1;
    }
    expect(verified).toBe(250);
  }, 60_000);
});
