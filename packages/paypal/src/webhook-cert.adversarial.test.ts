// H1 (review of CO-1): an anonymous POST with well-formed headers must not be able to spend the
// approval's outbound call budget. Every fetch_webhook_cert is one call against max_calls_per_day.
import { describe, expect, it } from 'vitest';
import type { TransportResult } from '@umsbx/contracts';
import { createCertificateSource } from './webhook-cert';
import { verifyWebhook } from './webhook-verify';
import { mutableClock } from './test-support';
import type { WebhookFixture } from './webhook-test-support';
import {
  HOUR,
  MINUTE,
  NOW_ISO,
  WEBHOOK_ID,
  certUrl,
  certificatePem,
  deliver,
  fakeTransport,
  loadWebhookFixtures,
  pemResponse,
  signer,
} from './webhook-test-support';

const f = loadWebhookFixtures().find((x) => x.name === 'capture-completed') as WebhookFixture;
const pem = () =>
  certificatePem({
    publicKey: signer.publicKey,
    notBefore: new Date('2026-01-01T00:00:00Z'),
    notAfter: new Date('2036-01-01T00:00:00Z'),
  });
const urlN = (n: number) => certUrl({ path: `/v1/notifications/certs/CERT-ATTACK-${n}` });
const NOT_FOUND: TransportResult = pemResponse('', 404);

/** One anonymous POST: well-formed headers, a signature that is the right shape, a chosen URL. */
function post(
  source: ReturnType<typeof createCertificateSource>,
  clock: ReturnType<typeof mutableClock>,
  cert_url: string,
) {
  return verifyWebhook(
    { clock, webhook_id: WEBHOOK_ID, certificates: source },
    deliver(f, { cert_url }),
  );
}

describe('probe 1: 50 posts, 50 distinct allow-listed URLs, all answered 404', () => {
  it('at most 6 transport calls, and every post is unverifiable', async () => {
    const clock = mutableClock(NOW_ISO);
    const t = fakeTransport(() => NOT_FOUND);
    const source = createCertificateSource({ transport: t, clock });
    const verdicts = [];
    for (let i = 0; i < 50; i++) verdicts.push(await post(source, clock, urlN(i)));
    expect(t.calls.length).toBeLessThanOrEqual(6);
    expect(t.calls).toHaveLength(6);
    expect(verdicts.every((v) => v.kind === 'unverifiable')).toBe(true);
  });
});

describe('probe 2: 50 posts for one URL that answers 404', () => {
  it('one transport call', async () => {
    const clock = mutableClock(NOW_ISO);
    const t = fakeTransport(() => NOT_FOUND);
    const source = createCertificateSource({ transport: t, clock });
    for (let i = 0; i < 50; i++)
      expect((await post(source, clock, urlN(1))).kind).toBe('unverifiable');
    expect(t.calls).toHaveLength(1);
  });

  it('spelling the same URL differently does not get past the negative cache', async () => {
    const clock = mutableClock(NOW_ISO);
    const t = fakeTransport(() => NOT_FOUND);
    const source = createCertificateSource({ transport: t, clock });
    const host = certUrl().split('/')[2] as string;
    await post(source, clock, urlN(1));
    await post(source, clock, urlN(1).replace(host, host.toUpperCase()));
    expect(t.calls).toHaveLength(1);
  });
});

describe('probe 3: 20 posts cycling 10 valid URLs (more than the 8-entry cache holds)', () => {
  it('at most 6 transport calls', async () => {
    const clock = mutableClock(NOW_ISO);
    const t = fakeTransport(() => pemResponse(pem()));
    const source = createCertificateSource({ transport: t, clock });
    for (let i = 0; i < 20; i++) await post(source, clock, urlN(i % 10));
    expect(t.calls.length).toBeLessThanOrEqual(6);
  });
});

describe('the global budget: 6 fetches per rolling hour of the injected clock', () => {
  it('the 7th fetch inside an hour makes no transport call and is unverifiable', async () => {
    const clock = mutableClock(NOW_ISO);
    const t = fakeTransport(() => NOT_FOUND);
    const source = createCertificateSource({ transport: t, clock });
    for (let i = 0; i < 6; i++) await source.get(urlN(i));
    expect(t.calls).toHaveLength(6);
    expect(await source.get(urlN(6))).toEqual({ kind: 'unavailable', why: 'fetch' });
    expect(t.calls).toHaveLength(6);
  });

  it('the hour rolls: the first fetch leaves the window at exactly one hour', async () => {
    const clock = mutableClock(NOW_ISO);
    const t = fakeTransport(() => NOT_FOUND);
    const source = createCertificateSource({ transport: t, clock });
    for (let i = 0; i < 6; i++) {
      await source.get(urlN(i));
      clock.advance(i === 0 ? 10 * MINUTE : 1000);
    }
    // the oldest fetch is now 10 min + 5 s old; the newest 1 s old. Move to 1 h - 1 ms after the first.
    clock.set(new Date(Date.parse(NOW_ISO) + HOUR - 1).toISOString());
    await source.get(urlN(100));
    expect(t.calls).toHaveLength(6); // still 6 inside the window: refused
    clock.advance(1); // exactly one hour after the first fetch: it no longer counts
    await source.get(urlN(100));
    expect(t.calls).toHaveLength(7);
    await source.get(urlN(101)); // and the window is full again (5 recent + the new one)
    expect(t.calls).toHaveLength(7);
  });

  it('one old fetch is forgotten after the hour: six more are then allowed', async () => {
    const clock = mutableClock(NOW_ISO);
    const t = fakeTransport(() => NOT_FOUND);
    const source = createCertificateSource({ transport: t, clock });
    await source.get(urlN(0));
    clock.advance(2 * HOUR);
    for (let i = 1; i <= 7; i++) await source.get(urlN(i));
    expect(t.calls).toHaveLength(7); // 1 + 6, the 7th new URL was refused
    expect(source.stats().fetches_in_window).toBe(6);
  });

  it('all 6 slots are usable again after the hour', async () => {
    const clock = mutableClock(NOW_ISO);
    const t = fakeTransport(() => NOT_FOUND);
    const source = createCertificateSource({ transport: t, clock });
    for (let i = 0; i < 6; i++) await source.get(urlN(i));
    expect(t.calls).toHaveLength(6);
    clock.advance(HOUR);
    for (let i = 10; i < 16; i++) await source.get(urlN(i));
    expect(t.calls).toHaveLength(12); // all six old fetches left the window together
    await source.get(urlN(99));
    expect(t.calls).toHaveLength(12);
  });

  it('a refused lookup is not remembered as a failure: it can be fetched once the budget is back', async () => {
    const clock = mutableClock(NOW_ISO);
    const t = fakeTransport((r) => (r.path.includes('GOOD') ? pemResponse(pem()) : NOT_FOUND));
    const source = createCertificateSource({ transport: t, clock });
    for (let i = 0; i < 6; i++) await source.get(urlN(i));
    const good = certUrl({ path: '/v1/notifications/certs/CERT-GOOD' });
    expect((await source.get(good)).kind).toBe('unavailable');
    clock.advance(HOUR + 1);
    expect((await source.get(good)).kind).toBe('ok');
    expect(t.calls).toHaveLength(7);
  });

  it('a lookup answered from either cache costs nothing against the budget', async () => {
    const clock = mutableClock(NOW_ISO);
    const t = fakeTransport((r) => (r.path.includes('GOOD') ? pemResponse(pem()) : NOT_FOUND));
    const source = createCertificateSource({ transport: t, clock });
    const good = certUrl({ path: '/v1/notifications/certs/CERT-GOOD' });
    await source.get(good);
    await source.get(urlN(1));
    for (let i = 0; i < 100; i++) {
      await source.get(good);
      await source.get(urlN(1));
    }
    expect(t.calls).toHaveLength(2);
  });

  it('50 simultaneous lookups of one new URL are one fetch and one unit of budget', async () => {
    const clock = mutableClock(NOW_ISO);
    let release: (r: TransportResult) => void = () => undefined;
    const gate = new Promise<TransportResult>((res) => {
      release = res;
    });
    const t = fakeTransport((_r, n) => (n === 1 ? gate : NOT_FOUND));
    const source = createCertificateSource({ transport: t, clock });
    const all = Array.from({ length: 50 }, () => source.get(urlN(1)));
    await Promise.resolve();
    release(pemResponse(pem()));
    expect((await Promise.all(all)).every((r) => r.kind === 'ok')).toBe(true);
    expect(t.calls).toHaveLength(1);
    for (let i = 2; i <= 6; i++) await source.get(urlN(i)); // five more are still allowed
    expect(t.calls).toHaveLength(6);
  });

  it('a transport that throws still counts as a fetch', async () => {
    const clock = mutableClock(NOW_ISO);
    const t = fakeTransport(() => {
      throw new Error('boom');
    });
    const source = createCertificateSource({ transport: t, clock });
    for (let i = 0; i < 20; i++) await source.get(urlN(i));
    expect(t.calls).toHaveLength(6);
  });
});

describe('a legitimate delivery survives an attack', () => {
  it('after the legitimate certificate is cached, 50 attacker URLs that all answer with a valid certificate do not evict it', async () => {
    const clock = mutableClock(NOW_ISO);
    const t = fakeTransport(() => pemResponse(pem()));
    const source = createCertificateSource({ transport: t, clock });
    expect((await post(source, clock, certUrl())).kind).toBe('verified');
    expect(t.calls).toHaveLength(1);
    for (let i = 0; i < 50; i++) await post(source, clock, urlN(i));
    // CO-1b: the legitimate URL is trusted after its first verified delivery, so unknown URLs get
    // 1 fetch an hour from then on (CO-1 alone allowed 5 more). That first fetch was made while
    // cold and still counts in the hour, so the attacker gets none at all here.
    expect(t.calls).toHaveLength(1);
    expect((await post(source, clock, certUrl())).kind).toBe('verified');
    expect(t.calls).toHaveLength(1); // served from the cache, no fetch
  });

  it('hour after hour of attack, a legitimate delivery that keeps arriving is never fetched again', async () => {
    const clock = mutableClock(NOW_ISO);
    const t = fakeTransport(() => pemResponse(pem()));
    const source = createCertificateSource({ transport: t, clock });
    await post(source, clock, certUrl());
    const legit = t.calls.length;
    for (let hour = 0; hour < 20; hour++) {
      for (let i = 0; i < 50; i++) await post(source, clock, urlN(hour * 50 + i));
      expect((await post(source, clock, certUrl())).kind).toBe('verified');
      clock.advance(HOUR + 1);
    }
    expect(t.calls.filter((c) => c.path === certUrl())).toHaveLength(legit);
  });

  it('attack first, legitimate later: the legitimate URL is fetched as soon as the budget allows', async () => {
    const clock = mutableClock(NOW_ISO);
    const t = fakeTransport(() => pemResponse(pem()));
    const source = createCertificateSource({ transport: t, clock });
    for (let i = 0; i < 50; i++) await post(source, clock, urlN(i));
    expect((await post(source, clock, certUrl())).kind).toBe('unverifiable'); // PayPal retries
    clock.advance(HOUR + 1);
    expect((await post(source, clock, certUrl())).kind).toBe('verified');
  });
});

describe('nothing grows without bound', () => {
  it('a day of attacker URLs leaves at most 8 certificates, 32 failures and no flights', async () => {
    const clock = mutableClock(NOW_ISO);
    // half the URLs answer 404, half a valid certificate
    const t = fakeTransport((r) => (r.path.endsWith('0') ? pemResponse(pem()) : NOT_FOUND));
    const source = createCertificateSource({ transport: t, clock });
    let n = 0;
    for (let minute = 0; minute < 24 * 60; minute += 5) {
      for (let k = 0; k < 20; k++) await source.get(urlN(n++));
      clock.advance(5 * MINUTE);
    }
    const s = source.stats();
    expect(s.certificates).toBeLessThanOrEqual(8);
    expect(s.failures).toBeLessThanOrEqual(32);
    expect(s.in_flight).toBe(0);
    expect(s.fetches_in_window).toBeLessThanOrEqual(6);
    expect(t.calls.length).toBeLessThanOrEqual(6 * 24 + 6);
  });

  it('the failure memory is bounded and drops the oldest entry', async () => {
    const clock = mutableClock(NOW_ISO);
    const t = fakeTransport(() => NOT_FOUND);
    const source = createCertificateSource({
      transport: t,
      clock,
      limits: { fetches_per_hour: 1000, failures_max: 3 },
    });
    for (let i = 0; i < 5; i++) await source.get(urlN(i));
    expect(source.stats().failures).toBe(3);
    expect(t.calls).toHaveLength(5);
    await source.get(urlN(4)); // newest: remembered
    await source.get(urlN(2)); // oldest kept: remembered
    expect(t.calls).toHaveLength(5);
    await source.get(urlN(1)); // dropped: fetched again
    expect(t.calls).toHaveLength(6);
  });

  it('the production limits are the documented ones', () => {
    const source = createCertificateSource({
      transport: fakeTransport(() => NOT_FOUND),
      clock: mutableClock(NOW_ISO),
    });
    expect(source.stats()).toEqual({
      certificates: 0,
      failures: 0,
      in_flight: 0,
      fetches_in_window: 0,
      unknown_fetches_today: 0,
      trusted_urls: [],
    });
  });
});
