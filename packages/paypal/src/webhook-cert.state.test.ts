import { describe, expect, it } from 'vitest';
import type { TransportResult } from '@umsbx/contracts';
import { createCertificateSource } from './webhook-cert';
import { mutableClock } from './test-support';
import {
  HOUR,
  MINUTE,
  certHost,
  certUrl,
  certificatePem,
  fakeTransport,
  pemResponse,
  signer,
} from './webhook-test-support';

const T0 = '2026-10-23T12:00:00Z';
const pemValidUntil = (iso: string) =>
  certificatePem({
    publicKey: signer.publicKey,
    notBefore: new Date('2026-01-01T00:00:00Z'),
    notAfter: new Date(iso),
  });

describe('certificate source state over time (fake clock, fake transport)', () => {
  it('one fetch serves many lookups of one URL within 24 hours; the 25th hour fetches again', async () => {
    const clock = mutableClock(T0);
    const t = fakeTransport(() => pemResponse(pemValidUntil('2036-01-01T00:00:00Z')));
    const source = createCertificateSource({ expected_pins: [], transport: t, clock });
    for (let i = 0; i < 20; i++) expect((await source.get(certUrl())).kind).toBe('ok');
    expect(t.calls).toHaveLength(1);
    clock.advance(24 * HOUR);
    await source.get(certUrl());
    expect(t.calls).toHaveLength(1);
    clock.advance(1);
    await source.get(certUrl());
    expect(t.calls).toHaveLength(2);
  });

  it('a certificate that ends in 2 hours is fetched again after 2 hours, not after 24', async () => {
    const clock = mutableClock(T0);
    let n = 0;
    const t = fakeTransport(() => {
      n += 1;
      return pemResponse(pemValidUntil(n === 1 ? '2026-10-23T14:00:00Z' : '2036-01-01T00:00:00Z'));
    });
    const source = createCertificateSource({ expected_pins: [], transport: t, clock });
    await source.get(certUrl());
    clock.advance(2 * HOUR);
    expect((await source.get(certUrl())).kind).toBe('ok');
    expect(t.calls).toHaveLength(1);
    clock.advance(1);
    expect((await source.get(certUrl())).kind).toBe('ok');
    expect(t.calls).toHaveLength(2);
  });

  it('the cache holds 8 URLs: after 9 distinct URLs the first is fetched again, the last 8 are not', async () => {
    const clock = mutableClock(T0);
    const t = fakeTransport(() => pemResponse(pemValidUntil('2036-01-01T00:00:00Z')));
    const source = createCertificateSource({ expected_pins: [], transport: t, clock });
    const urls = Array.from({ length: 9 }, (_, i) =>
      certUrl({ path: `/v1/notifications/certs/CERT-SYN-${i + 1}` }),
    );
    // 11 minutes apart: never more than the 6 fetches an hour the budget allows
    for (const u of urls) {
      await source.get(u);
      clock.advance(11 * MINUTE);
    }
    expect(t.calls).toHaveLength(9);
    for (const u of urls.slice(1)) await source.get(u);
    expect(t.calls).toHaveLength(9);
    await source.get(urls[0] as string);
    expect(t.calls).toHaveLength(10);
  });

  // H1 (review of CO-1): a failure IS cached, deliberately. An anonymous caller can name any
  // allow-listed URL, and every fetch costs one of the approval's daily calls. Before this rule a
  // URL that answers 404 was fetched again by every request. Successes are cached by URL as before.
  it('a failure is cached for 10 minutes, then the URL is tried again and can succeed', async () => {
    const clock = mutableClock(T0);
    const answers: TransportResult[] = [
      { kind: 'timeout' },
      pemResponse('<html>', 500),
      pemResponse(pemValidUntil('2036-01-01T00:00:00Z')),
    ];
    const t = fakeTransport((_r, n) => answers[n - 1] as TransportResult);
    const source = createCertificateSource({ expected_pins: [], transport: t, clock });
    expect(await source.get(certUrl())).toEqual({ kind: 'unavailable', why: 'fetch' });
    clock.advance(10 * MINUTE - 1);
    expect(await source.get(certUrl())).toEqual({ kind: 'unavailable', why: 'fetch' });
    expect(t.calls).toHaveLength(1); // still inside the negative window: no call
    clock.advance(1);
    expect(await source.get(certUrl())).toEqual({ kind: 'unavailable', why: 'fetch' });
    expect(t.calls).toHaveLength(2); // the window ended: one new try, which fails again
    clock.advance(10 * MINUTE);
    expect((await source.get(certUrl())).kind).toBe('ok');
    expect(t.calls).toHaveLength(3);
    await source.get(certUrl()); // success is cached
    expect(t.calls).toHaveLength(3);
  });

  it('every kind of failure is cached with its reason', async () => {
    const clock = mutableClock(T0);
    const t = fakeTransport(() => pemResponse(pemValidUntil('2026-10-01T00:00:00Z')));
    const source = createCertificateSource({ expected_pins: [], transport: t, clock });
    expect(await source.get(certUrl())).toEqual({ kind: 'unavailable', why: 'validity' });
    expect(await source.get(certUrl())).toEqual({ kind: 'unavailable', why: 'validity' });
    expect(t.calls).toHaveLength(1);
  });

  it('a certificate that is expired when fetched is not cached as a success', async () => {
    const clock = mutableClock(T0);
    const t = fakeTransport(() => pemResponse(pemValidUntil('2026-10-01T00:00:00Z')));
    const source = createCertificateSource({ expected_pins: [], transport: t, clock });
    expect(await source.get(certUrl())).toEqual({ kind: 'unavailable', why: 'validity' });
    clock.advance(10 * MINUTE);
    await source.get(certUrl());
    expect(t.calls).toHaveLength(2);
  });

  it('50 simultaneous lookups of one URL make one fetch (single flight)', async () => {
    const clock = mutableClock(T0);
    let release: (r: TransportResult) => void = () => undefined;
    const gate = new Promise<TransportResult>((res) => {
      release = res;
    });
    const t = fakeTransport(() => gate);
    const source = createCertificateSource({ expected_pins: [], transport: t, clock });
    const all = Array.from({ length: 50 }, () => source.get(certUrl()));
    await Promise.resolve();
    release(pemResponse(pemValidUntil('2036-01-01T00:00:00Z')));
    const results = await Promise.all(all);
    expect(results.every((r) => r.kind === 'ok')).toBe(true);
    expect(t.calls).toHaveLength(1);
  });

  it('simultaneous lookups of different URLs fetch each once; a failed flight leaves no flight behind', async () => {
    const clock = mutableClock(T0);
    const t = fakeTransport((r) =>
      r.path.includes('CERT-A')
        ? { kind: 'timeout' }
        : pemResponse(pemValidUntil('2036-01-01T00:00:00Z')),
    );
    const source = createCertificateSource({ expected_pins: [], transport: t, clock });
    const a = certUrl({ path: '/v1/notifications/certs/CERT-A' });
    const b = certUrl({ path: '/v1/notifications/certs/CERT-B' });
    const [ra1, ra2, rb] = await Promise.all([source.get(a), source.get(a), source.get(b)]);
    expect(ra1.kind).toBe('unavailable');
    expect(ra2.kind).toBe('unavailable');
    expect(rb.kind).toBe('ok');
    expect(t.calls).toHaveLength(2);
    await source.get(a); // the failed flight is in the negative cache, not in flight
    expect(t.calls).toHaveLength(2);
    clock.advance(10 * MINUTE);
    await source.get(a);
    expect(t.calls).toHaveLength(3);
  });

  it('the host is part of the cache key', async () => {
    const clock = mutableClock(T0);
    const t = fakeTransport(() => pemResponse(pemValidUntil('2036-01-01T00:00:00Z')));
    const source = createCertificateSource({ expected_pins: [], transport: t, clock });
    await source.get(certUrl());
    await source.get(certUrl({ host: certHost(['certs']) }));
    expect(t.calls).toHaveLength(2);
  });
});
