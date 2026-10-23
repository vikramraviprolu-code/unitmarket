// CO-1b: the reviewer's probes R2 and R6 against the CO-1 budget, now expected to fail to hurt.
import { describe, expect, it } from 'vitest';
import type { OutboundRequest, TransportResult } from '@umsbx/contracts';
import { createCertificateSource } from './webhook-cert';
import { verifyWebhook } from './webhook-verify';
import { mutableClock } from './test-support';
import type { WebhookFixture } from './webhook-test-support';
import {
  DAY,
  HOUR,
  NOW_ISO,
  WEBHOOK_ID,
  certUrl,
  certificatePem,
  deliver,
  fakeTransport,
  forger,
  loadWebhookFixtures,
  pemResponse,
  signer,
} from './webhook-test-support';

const f = loadWebhookFixtures().find((x) => x.name === 'capture-completed') as WebhookFixture;
const LEGIT = certUrl();
const attacker = (n: number) => certUrl({ path: `/v1/notifications/certs/CERT-ATTACK-${n}` });
const pem = () =>
  certificatePem({
    publicKey: signer.publicKey,
    notBefore: new Date('2026-01-01T00:00:00Z'),
    notAfter: new Date('2036-01-01T00:00:00Z'),
  });
const iso = (ms: number) => new Date(ms).toISOString().replace('.000Z', 'Z');

function setup(answer: (r: OutboundRequest) => TransportResult) {
  const clock = mutableClock(NOW_ISO);
  const stamps: { path: string; at: number }[] = [];
  const t = fakeTransport((r) => {
    stamps.push({ path: r.path, at: clock.now().getTime() });
    return answer(r);
  });
  const source = createCertificateSource({ transport: t, clock });
  /** one POST with a signature made now, as a PayPal retry would carry */
  const post = (cert_url: string, key = signer.privateKey) =>
    verifyWebhook(
      { clock, webhook_id: WEBHOOK_ID, certificates: source },
      deliver(f, { cert_url, time: iso(clock.now().getTime()), key }),
    );
  return { clock, t, stamps, source, post };
}
/** the legitimate URL answers with a certificate; every attacker URL answers 404 */
const legitOnly = (r: OutboundRequest) =>
  r.path === LEGIT ? pemResponse(pem()) : pemResponse('', 404);
const callsIn = (stamps: { at: number }[], from: number, to: number) =>
  stamps.filter((s) => s.at > from && s.at <= to).length;

describe('R2: a low-rate attacker spends the unknown budget every time the hour frees', () => {
  it('the legitimate certificate is trusted after one verified delivery and keeps refreshing for 3 days', async () => {
    const { clock, stamps, post, source } = setup(legitOnly);
    expect((await post(LEGIT)).kind).toBe('verified');
    expect(source.stats().trusted_urls).toEqual([LEGIT]);
    const start = clock.now().getTime();
    let legitVerified = 0;
    let legitTotal = 0;
    for (let hour = 1; hour <= 72; hour++) {
      clock.advance(HOUR);
      // the attacker posts 6 new URLs as soon as the hour frees
      for (let k = 0; k < 6; k++) await post(attacker(hour * 10 + k));
      // PayPal retries the legitimate delivery
      legitTotal += 1;
      if ((await post(LEGIT)).kind === 'verified') legitVerified += 1;
    }
    expect(legitVerified).toBe(legitTotal);
    // the 24-hour cache expired at hours 24 and 49, and each refresh went through
    expect(stamps.filter((s) => s.path === LEGIT).length).toBeGreaterThanOrEqual(3);
    // approval calls from this path: at most 24 in any rolling day
    for (const s of stamps) expect(callsIn(stamps, s.at - DAY, s.at)).toBeLessThanOrEqual(24);
    // and the attacker got at most 12 a day, 1 an hour
    const unknown = stamps.filter((s) => s.path !== LEGIT);
    for (const s of unknown) {
      expect(callsIn(unknown, s.at - DAY, s.at)).toBeLessThanOrEqual(12);
      expect(callsIn(unknown, s.at - HOUR, s.at)).toBeLessThanOrEqual(1);
    }
    expect(clock.now().getTime() - start).toBe(72 * HOUR);
  }, 120_000);

  it('78 attempts over 3 days (about one every 55 minutes) never stop the 24-hour refresh', async () => {
    const { clock, post, stamps } = setup(legitOnly);
    expect((await post(LEGIT)).kind).toBe('verified');
    let refused = 0;
    for (let i = 0; i < 78; i++) {
      clock.advance(55 * 60_000);
      await post(attacker(i));
      if ((await post(LEGIT)).kind !== 'verified') refused += 1;
    }
    expect(refused).toBe(0);
    expect(stamps.filter((s) => s.path === LEGIT).length).toBeGreaterThanOrEqual(3);
  });
});

describe('R6: attacker URLs that return valid certificates cannot push the legitimate one out', () => {
  it('30 attacker URLs over 5 hours: the legitimate delivery still verifies, within the reserved budget', async () => {
    const { clock, stamps, post, source } = setup(() => pemResponse(pem()));
    expect((await post(LEGIT)).kind).toBe('verified');
    for (let hour = 0; hour < 5; hour++) {
      for (let k = 0; k < 6; k++) await source.get(attacker(hour * 6 + k));
      clock.advance(HOUR);
    }
    expect((await post(LEGIT)).kind).toBe('verified');
    expect(stamps.filter((s) => s.path === LEGIT)).toHaveLength(1); // never evicted: no refetch
    const unknown = stamps.filter((s) => s.path !== LEGIT);
    expect(unknown.length).toBeLessThanOrEqual(5); // 1 an hour
    expect(source.stats().certificates).toBeLessThanOrEqual(8);
  });

  it('even if the cache entry is gone, the trusted URL is fetched from the reserved budget', async () => {
    const { clock, stamps, post, source } = setup(() => pemResponse(pem()));
    expect((await post(LEGIT)).kind).toBe('verified');
    clock.advance(25 * HOUR); // cache expiry
    for (let k = 0; k < 20; k++) await source.get(attacker(k));
    expect((await post(LEGIT)).kind).toBe('verified');
    expect(stamps.filter((s) => s.path === LEGIT)).toHaveLength(2);
  });
});

describe('trust is earned by a genuine signature only', () => {
  it('forged signatures, wrong webhook ids and stale deliveries never make a URL trusted', async () => {
    const { clock, post, source } = setup(() => pemResponse(pem()));
    clock.advance(4 * DAY); // the fixture's own transmission time is now stale
    for (let i = 0; i < 5; i++) {
      clock.advance(HOUR);
      await post(attacker(i), forger.privateKey);
      await verifyWebhook(
        { clock, webhook_id: 'OTHER', certificates: source },
        deliver(f, { cert_url: attacker(i + 100), time: iso(clock.now().getTime()) }),
      );
      await verifyWebhook(
        { clock, webhook_id: WEBHOOK_ID, certificates: source },
        deliver(f, { cert_url: attacker(i + 200) }), // fixture time: stale by now
      );
    }
    expect(source.stats().trusted_urls).toEqual([]);
  });

  it('while nothing is trusted the CO-1 budget of 6 an hour holds', async () => {
    const { t, post } = setup(() => pemResponse('', 404));
    for (let i = 0; i < 50; i++) await post(attacker(i));
    expect(t.calls).toHaveLength(6);
  });

  it('after a restart the list is empty and the cold budget applies again', async () => {
    const { clock, t, post, source } = setup(legitOnly);
    await post(LEGIT);
    expect(source.stats().trusted_urls).toEqual([LEGIT]);
    const restarted = createCertificateSource({ transport: t, clock });
    expect(restarted.stats().trusted_urls).toEqual([]);
    const base = t.calls.length;
    for (let i = 0; i < 10; i++) await restarted.get(attacker(i + 500));
    expect(t.calls.length - base).toBe(6);
  });
});

describe('F1: a dead trusted URL can only burn its own budget', () => {
  const B = certUrl({ path: '/v1/notifications/certs/CERT-B' });

  it('probe: A (trusted, live) verifies at every refresh while the attacker posts the dead trusted B every 10 minutes', async () => {
    let bDead = false;
    const { clock, stamps, post, source } = setup((r) =>
      r.path === B && bDead ? pemResponse('', 404) : pemResponse(pem()),
    );
    expect((await post(LEGIT)).kind).toBe('verified');
    clock.advance(HOUR + 1); // B is unknown now: 1 fetch an hour, and the first fetch used this hour
    expect((await post(B)).kind).toBe('verified'); // the same certificate served at a second URL
    expect(source.stats().trusted_urls).toEqual([LEGIT, B]);
    bDead = true;
    clock.advance(25 * HOUR); // both cache entries are gone
    stamps.length = 0;
    let aVerified = 0;
    let aTotal = 0;
    for (let step = 0; step < 3 * 24 * 6; step++) {
      clock.advance(10 * 60_000);
      await post(B);
      if (step % 6 === 0) {
        aTotal += 1;
        if ((await post(LEGIT)).kind === 'verified') aVerified += 1;
      }
    }
    expect(aVerified).toBe(aTotal);
    expect(stamps.filter((s) => s.path === LEGIT).length).toBeGreaterThanOrEqual(3);
    const bCalls = stamps.filter((s) => s.path === B);
    for (const s of bCalls) {
      expect(callsIn(bCalls, s.at - DAY, s.at)).toBeLessThanOrEqual(4);
      expect(callsIn(bCalls, s.at - HOUR, s.at)).toBeLessThanOrEqual(1);
    }
    expect(bCalls.length).toBeGreaterThanOrEqual(10); // not stricter than 4 a day
    // worst case with a trusted URL: 12 unknown + 4 x 4 trusted = 28 calls in any rolling day
    for (const s of stamps) expect(callsIn(stamps, s.at - DAY, s.at)).toBeLessThanOrEqual(28);
  }, 120_000);

  it('three dead trusted URLs and a live fourth: the live one is still fetched', async () => {
    const dead = [1, 2, 3].map((n) => certUrl({ path: `/v1/notifications/certs/CERT-DEAD-${n}` }));
    let allDead = false;
    const { clock, post, stamps } = setup((r) =>
      allDead && dead.includes(r.path) ? pemResponse('', 404) : pemResponse(pem()),
    );
    for (const u of [...dead, LEGIT]) {
      expect((await post(u)).kind).toBe('verified');
      clock.advance(HOUR + 1); // each is unknown when it first appears: 1 fetch an hour
    }
    allDead = true;
    clock.advance(25 * HOUR);
    stamps.length = 0;
    for (let step = 0; step < 24 * 6; step++) {
      clock.advance(10 * 60_000);
      for (const u of dead) await post(u);
    }
    expect((await post(LEGIT)).kind).toBe('verified');
  }, 120_000);
});
