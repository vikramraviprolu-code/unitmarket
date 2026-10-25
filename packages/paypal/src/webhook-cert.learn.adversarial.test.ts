// CO-1d adversarial: the learn path reads one header, fetches only what the allow rules permit, keeps
// the facts small and never turns a described certificate into a trusted one. No network.
import { describe, expect, it } from 'vitest';
import { createCertificateSource } from './webhook-cert';
import type { CertificateSourceWithStats } from './webhook-cert';
import { learnWebhookCertificate } from './webhook-learn';
import { mutableClock } from './test-support';
import {
  CERT_PATH,
  certHost,
  certUrl,
  certificatePem,
  fakeTransport,
  pemResponse,
  signer,
} from './webhook-test-support';

const NOW = '2026-10-23T12:00:00Z';
const host = (...p: string[]) => p.join('.');
const SANDBOX = host('sandbox', 'paypal', 'com');
const pem = (over: Partial<Parameters<typeof certificatePem>[0]> = {}) =>
  certificatePem({
    publicKey: signer.publicKey,
    notBefore: new Date('2026-01-01T00:00:00Z'),
    notAfter: new Date('2027-01-01T00:00:00Z'),
    ...over,
  });
const build = (answer: Parameters<typeof fakeTransport>[0] = () => pemResponse(pem())) => {
  const t = fakeTransport(answer);
  const source = createCertificateSource({ transport: t, clock: mutableClock(NOW) });
  return { t, source };
};

describe('inspect fetches nothing the allow rules refuse', () => {
  const offList = [
    `https://${host('evil', 'example', 'invalid')}${CERT_PATH}`,
    `http://${host('certs', SANDBOX)}${CERT_PATH}`,
    `https://${host('certs', SANDBOX, 'evil', 'example', 'invalid')}${CERT_PATH}`,
    `https://${host('certs', SANDBOX)}@${host('evil', 'example', 'invalid')}${CERT_PATH}`,
    `https://${host('evil', 'example', 'invalid')}@${host('certs', SANDBOX)}${CERT_PATH}`,
    `https://${host('certs', SANDBOX)}/other/path/CERT`,
    `https://${host('certs', SANDBOX)}${CERT_PATH}?x=1`,
    `https://${host('certs', SANDBOX)}${CERT_PATH}#frag`,
    `https://${host('certs', SANDBOX)}:8443${CERT_PATH}`,
    `https://${host('certs', SANDBOX)}/v1/notifications/certs/../../oauth2/token`,
    `https://${host('a', 'b', SANDBOX)}${CERT_PATH}`,
    `https://${SANDBOX}${CERT_PATH}`,
    `https://203.0.113.9${CERT_PATH}`,
    `https://${host('api', 'paypal', 'com')}${CERT_PATH}`,
    `https://${host('certs', 'paypal', 'com')}${CERT_PATH}`,
    `ftp://${host('certs', SANDBOX)}${CERT_PATH}`,
    `//${host('certs', SANDBOX)}${CERT_PATH}`,
    CERT_PATH,
    '',
    'not a url',
  ];
  it.each(offList.map((u) => [u]))('%s: unavailable, zero transport calls', async (u) => {
    const { t, source } = build();
    expect(await source.inspect(u)).toEqual({ kind: 'unavailable', why: 'fetch' });
    expect(t.calls).toHaveLength(0);
    expect(source.stats().fetches_in_window).toBe(0);
  });
});

describe('inspect keeps the facts small', () => {
  it('a subject or issuer over 512 characters is refused, not truncated', async () => {
    for (const over of [{ cn: 'x'.repeat(600) }, { issuer_cn: 'y'.repeat(600) }]) {
      const { source } = build(() => pemResponse(pem(over)));
      expect(await source.inspect(certUrl())).toEqual({ kind: 'unavailable', why: 'parse' });
    }
  });
  it('the facts hold no certificate text and no key material', async () => {
    const { source } = build();
    const r = await source.inspect(certUrl());
    const text = JSON.stringify(r);
    expect(text).not.toContain('BEGIN CERTIFICATE');
    expect(text).not.toContain('PRIVATE');
    expect(text).not.toContain(pem().split('\n')[1] ?? 'unreachable');
  });
});

describe('inspect never trusts', () => {
  it('describing a URL leaves the trust list, the cache and the failure memory as they were', async () => {
    const { source } = build();
    const before = JSON.stringify({ ...source.stats(), fetches_in_window: 0 });
    await source.inspect(certUrl());
    expect(JSON.stringify({ ...source.stats(), fetches_in_window: 0 })).toBe(before);
  });
  it('a certificate that fails to describe is not remembered as anything but a failure of that URL', async () => {
    const { source } = build(() => pemResponse('junk'));
    await source.inspect(certUrl());
    expect(source.stats().trusted_urls).toEqual([]);
    expect(source.stats().certificates).toBe(0);
  });
});

describe('learnWebhookCertificate reads one header and nothing else', () => {
  const SENTINELS = {
    'paypal-transmission-id': 'SENTINEL-TRANSMISSION-ID',
    'paypal-transmission-sig': 'SENTINEL-SIGNATURE-BASE64==',
    'paypal-transmission-time': '2026-10-23T12:00:00Z',
    'paypal-auth-algo': 'SHA256withRSA',
    cookie: 'SENTINEL-COOKIE',
    authorization: 'Bearer SENTINEL-TOKEN',
  };
  const spy = (): CertificateSourceWithStats & { seen: string[] } => {
    const seen: string[] = [];
    const real = build().source;
    return Object.assign(real, {
      seen,
      async inspect(u: string) {
        seen.push(u);
        return {
          kind: 'ok' as const,
          facts: {
            host: 'h',
            path: '/p',
            subject: 's',
            subject_cn: null,
            issuer: 'i',
            valid_from: 'a',
            valid_to: 'b',
            fingerprint_sha256: 'f',
          },
        };
      },
    });
  };

  it('asks the source for the certificate URL only', async () => {
    const s = spy();
    const r = await learnWebhookCertificate(s, { ...SENTINELS, 'paypal-cert-url': certUrl() });
    expect(r.kind).toBe('facts');
    expect(s.seen).toEqual([certUrl()]);
    expect(JSON.stringify(r)).not.toContain('SENTINEL');
  });
  it('header name case does not matter', async () => {
    const s = spy();
    expect((await learnWebhookCertificate(s, { 'PayPal-Cert-URL': certUrl() })).kind).toBe('facts');
    expect(s.seen).toEqual([certUrl()]);
  });
  it.each([
    ['missing', {}],
    ['empty', { 'paypal-cert-url': '' }],
    [
      'over 512 characters',
      { 'paypal-cert-url': certUrl({ path: `/v1/notifications/certs/${'A'.repeat(600)}` }) },
    ],
    ['repeated', { 'paypal-cert-url': certUrl(), 'PAYPAL-CERT-URL': certUrl() }],
    ['not a string', { 'paypal-cert-url': 7 as unknown as string }],
  ])('a %s certificate URL header: nothing, and the source is not asked', async (_n, headers) => {
    const s = spy();
    const r = await learnWebhookCertificate(s, headers as Record<string, string>);
    expect(r.kind).toBe('nothing');
    expect(s.seen).toEqual([]);
  });
  it('an off-list URL header: nothing, zero transport calls', async () => {
    const { t, source } = build();
    const r = await learnWebhookCertificate(source, {
      'paypal-cert-url': `https://${host('evil', 'example', 'invalid')}${CERT_PATH}`,
    });
    expect(r.kind).toBe('nothing');
    expect(t.calls).toHaveLength(0);
  });
  it('a source with no inspect (a test stand-in): nothing', async () => {
    const r = await learnWebhookCertificate(
      { get: async () => ({ kind: 'unavailable', why: 'fetch' }) },
      { 'paypal-cert-url': certUrl() },
    );
    expect(r).toEqual({ kind: 'nothing', why: 'unsupported' });
  });
  it('a source that throws: nothing, never a throw', async () => {
    const r = await learnWebhookCertificate(
      {
        get: async () => ({ kind: 'unavailable', why: 'fetch' }),
        inspect: () => Promise.reject(new Error('boom')),
      },
      { 'paypal-cert-url': certUrl() },
    );
    expect(r.kind).toBe('nothing');
  });
  it('the fetched facts carry the host and path of the URL and no query', async () => {
    const { source } = build();
    const r = await learnWebhookCertificate(source, {
      'paypal-cert-url': certUrl({ host: certHost(['certs']) }),
    });
    expect(r.kind).toBe('facts');
    if (r.kind === 'facts') {
      expect(r.facts.host).toBe(certHost(['certs']));
      expect(r.facts.path).toBe(CERT_PATH);
    }
  });
});
