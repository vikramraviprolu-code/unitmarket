// CO-1b: certificate URLs that have verified a delivery are trusted and get a reserved fetch budget.
import { describe, expect, it } from 'vitest';
import type { OutboundRequest, TransportResult } from '@umsbx/contracts';
import {
  CERT_TRUSTED_FETCHES_PER_HOUR,
  CERT_TRUSTED_MAX_AGE_MS,
  CERT_TRUSTED_MAX_URLS,
  CERT_UNKNOWN_FETCHES_PER_DAY,
  CERT_UNKNOWN_FETCHES_PER_HOUR,
  createCertificateSource,
} from './webhook-cert';
import { mutableClock } from './test-support';
import {
  DAY,
  HOUR,
  MINUTE,
  certUrl,
  certificatePem,
  fakeTransport,
  pemResponse,
  signer,
} from './webhook-test-support';

const T0 = '2026-10-23T12:00:00Z';
const url = (n: string) => certUrl({ path: `/v1/notifications/certs/CERT-${n}` });
const pemUntil = (iso: string) =>
  certificatePem({
    publicKey: signer.publicKey,
    notBefore: new Date('2026-01-01T00:00:00Z'),
    notAfter: new Date(iso),
  });
const NOT_FOUND: TransportResult = pemResponse('', 404);

/** serves a certificate for every URL except those whose path contains FAIL */
function world(validUntil = '2036-01-01T00:00:00Z') {
  const clock = mutableClock(T0);
  const stamps: { path: string; at: number }[] = [];
  const t = fakeTransport((r: OutboundRequest) => {
    stamps.push({ path: r.path, at: clock.now().getTime() });
    return r.path.includes('FAIL') ? NOT_FOUND : pemResponse(pemUntil(validUntil));
  });
  const source = createCertificateSource({ transport: t, clock });
  return { clock, t, source, stamps };
}

describe('constants', () => {
  it('4 trusted URLs for 7 days, 2 reserved fetches an hour; unknown: 1 an hour and 12 a day', () => {
    expect(CERT_TRUSTED_MAX_URLS).toBe(4);
    expect(CERT_TRUSTED_MAX_AGE_MS).toBe(7 * DAY);
    expect(CERT_TRUSTED_FETCHES_PER_HOUR).toBe(2);
    expect(CERT_UNKNOWN_FETCHES_PER_HOUR).toBe(1);
    expect(CERT_UNKNOWN_FETCHES_PER_DAY).toBe(12);
  });
});

describe('the trusted list', () => {
  it('starts empty; a URL is trusted only by trust(), and only if the allow-list accepts it', async () => {
    const { source } = world();
    expect(source.stats().trusted_urls).toEqual([]);
    await source.get(url('A'));
    expect(source.stats().trusted_urls).toEqual([]); // fetching does not trust
    source.trust(url('A'));
    expect(source.stats().trusted_urls).toEqual([url('A')]);
    source.trust('https://evil.example/v1/notifications/certs/X');
    source.trust('not a url');
    source.trust(certUrl({ scheme: 'http' }));
    expect(source.stats().trusted_urls).toEqual([url('A')]);
  });

  it('is kept by the normalised URL', async () => {
    const { source } = world();
    const host = certUrl().split('/')[2] as string;
    source.trust(url('A').replace(host, host.toUpperCase()));
    expect(source.stats().trusted_urls).toEqual([url('A')]);
  });

  it('holds at most 4: a fifth replaces the oldest (rotation)', async () => {
    const { source } = world();
    for (const n of ['A', 'B', 'C', 'D']) {
      await source.get(url(n));
      source.trust(url(n));
    }
    expect(source.stats().trusted_urls).toEqual([url('A'), url('B'), url('C'), url('D')]);
    await source.get(url('E'));
    source.trust(url('E'));
    expect(source.stats().trusted_urls).toEqual([url('B'), url('C'), url('D'), url('E')]);
  });

  it('trusting a URL again refreshes it and makes it the newest', async () => {
    const { source } = world();
    for (const n of ['A', 'B', 'C', 'D']) {
      await source.get(url(n));
      source.trust(url(n));
    }
    source.trust(url('A'));
    expect(source.stats().trusted_urls).toEqual([url('B'), url('C'), url('D'), url('A')]);
    await source.get(url('E'));
    source.trust(url('E')); // replaces B, now the oldest
    expect(source.stats().trusted_urls).toEqual([url('C'), url('D'), url('A'), url('E')]);
  });

  it('a trusted URL is kept until the certificate ends when that is before 7 days', async () => {
    const { clock, source } = world('2026-10-26T12:00:00Z'); // 3 days
    await source.get(url('A'));
    source.trust(url('A'));
    clock.advance(3 * DAY);
    expect(source.stats().trusted_urls).toEqual([url('A')]);
    clock.advance(1);
    expect(source.stats().trusted_urls).toEqual([]);
  });

  it('and for 7 days when the certificate lasts longer', async () => {
    const { clock, source } = world();
    await source.get(url('A'));
    source.trust(url('A'));
    clock.advance(7 * DAY);
    expect(source.stats().trusted_urls).toEqual([url('A')]);
    clock.advance(1);
    expect(source.stats().trusted_urls).toEqual([]);
  });

  it('a fresh verified delivery extends the 7 days', async () => {
    const { clock, source } = world();
    await source.get(url('A'));
    source.trust(url('A'));
    clock.advance(6 * DAY);
    source.trust(url('A'));
    clock.advance(6 * DAY);
    expect(source.stats().trusted_urls).toEqual([url('A')]);
  });

  it('trust works when the certificate is no longer in the cache (7 days from now)', async () => {
    const { clock, source } = world();
    await source.get(url('A'));
    clock.advance(25 * HOUR); // cache entry expired
    source.trust(url('A'));
    expect(source.stats().trusted_urls).toEqual([url('A')]);
    clock.advance(7 * DAY);
    expect(source.stats().trusted_urls).toEqual([url('A')]);
    clock.advance(1);
    expect(source.stats().trusted_urls).toEqual([]);
  });

  it('a restart clears it: a new source starts with nothing trusted', async () => {
    const { source, clock, t } = world();
    await source.get(url('A'));
    source.trust(url('A'));
    const restarted = createCertificateSource({ transport: t, clock });
    expect(restarted.stats().trusted_urls).toEqual([]);
  });
});

describe('budgets by class', () => {
  it('cold start (nothing trusted): the CO-1 budget of 6 an hour applies to every URL', async () => {
    const { t, source } = world();
    for (let i = 0; i < 10; i++) await source.get(url(`FAIL-${i}`));
    expect(t.calls).toHaveLength(6);
  });

  it('once a URL is trusted, unknown URLs get 1 fetch an hour', async () => {
    const { t, source, clock } = world();
    await source.get(url('A'));
    source.trust(url('A'));
    clock.advance(HOUR); // the cold-start fetch of A leaves the unknown window
    const before = t.calls.length;
    for (let i = 0; i < 10; i++) await source.get(url(`FAIL-${i}`));
    expect(t.calls.length - before).toBe(1);
    clock.advance(HOUR - 1);
    await source.get(url('FAIL-X'));
    expect(t.calls.length - before).toBe(1);
    clock.advance(1);
    await source.get(url('FAIL-Y'));
    expect(t.calls.length - before).toBe(2);
  });

  it('trusted URLs have 2 fetches an hour that unknown URLs cannot use, and the reverse', async () => {
    const { t, source, clock } = world();
    // the trusted URL fails (so it must be fetched again) and is remembered as failed for 10 minutes
    const trusted = url('FAIL-TRUSTED');
    await source.get(trusted); // cold start: counts as an unknown fetch, fails
    source.trust(trusted);
    clock.advance(HOUR); // the unknown hour is free again
    const base = t.calls.length;
    // an attacker uses the unknown slot of this hour
    await source.get(url('FAIL-ATTACK-1'));
    await source.get(url('FAIL-ATTACK-2'));
    expect(t.calls.length - base).toBe(1);
    // the trusted URL still has both of its slots, 11 minutes apart (past the failure memory)
    clock.advance(11 * MINUTE);
    await source.get(trusted);
    clock.advance(11 * MINUTE);
    await source.get(trusted);
    expect(t.calls.length - base).toBe(3);
    clock.advance(11 * MINUTE);
    await source.get(trusted); // third in the hour: refused without a call
    expect(t.calls.length - base).toBe(3);
    // and trusted fetches did not take the unknown slot back: still only the one unknown fetch
    await source.get(url('FAIL-ATTACK-3'));
    expect(t.calls.length - base).toBe(3);
  });

  it('the reserved hour rolls at exactly one hour', async () => {
    const { t, source, clock } = world();
    const trusted = url('FAIL-TRUSTED');
    await source.get(trusted);
    source.trust(trusted);
    clock.advance(HOUR);
    const base = t.calls.length;
    await source.get(trusted); // slot 1 at t
    clock.advance(11 * MINUTE);
    await source.get(trusted); // slot 2
    clock.advance(11 * MINUTE);
    await source.get(trusted); // refused
    expect(t.calls.length - base).toBe(2);
    clock.advance(HOUR - 22 * MINUTE - 1); // 1 ms before the first slot leaves the window
    await source.get(trusted);
    expect(t.calls.length - base).toBe(2);
    clock.advance(1);
    await source.get(trusted);
    expect(t.calls.length - base).toBe(3);
  });

  it('unknown fetches: never more than 12 in any rolling 24 hours, never more than 1 in any hour', async () => {
    const { t, stamps, source, clock } = world();
    await source.get(url('A'));
    source.trust(url('A'));
    stamps.length = 0;
    for (let i = 0; i < 72; i++) {
      await source.get(url(`FAIL-DAY-${i}`));
      clock.advance(HOUR + MINUTE);
    }
    expect(t.calls.length).toBeGreaterThan(1);
    for (const s of stamps) {
      expect(stamps.filter((o) => o.at > s.at - HOUR && o.at <= s.at).length).toBeLessThanOrEqual(
        1,
      );
      expect(stamps.filter((o) => o.at > s.at - DAY && o.at <= s.at).length).toBeLessThanOrEqual(
        12,
      );
    }
    expect(stamps.length).toBeGreaterThanOrEqual(33); // not stricter than 12 a day over 3 days
  });

  it('the daily cap counts the cold-start fetches too, and frees them after 24 hours', async () => {
    const { t, source, clock } = world();
    for (let i = 0; i < 6; i++) await source.get(url(`FAIL-COLD-${i}`)); // 6 in the cold hour
    clock.advance(HOUR + 1);
    source.trust(url('A'));
    const base = t.calls.length;
    for (let i = 0; i < 12; i++) {
      await source.get(url(`FAIL-NEXT-${i}`));
      clock.advance(HOUR + 1);
    }
    // 6 were already spent in the last 24 h, so only 6 more fit before the cold ones age out
    expect(t.calls.length - base).toBe(6);
  });

  it('when the trusted list empties (expiry) the source is cold again: 6 an hour', async () => {
    const { t, source, clock } = world('2026-10-24T12:00:00Z');
    await source.get(url('A'));
    source.trust(url('A'));
    clock.advance(DAY + 1);
    expect(source.stats().trusted_urls).toEqual([]);
    clock.advance(DAY); // earlier unknown fetches have aged out of the day
    const base = t.calls.length;
    for (let i = 0; i < 10; i++) await source.get(url(`FAIL-AGAIN-${i}`));
    expect(t.calls.length - base).toBe(6);
  });

  it('a trusted URL answered from the cache costs nothing', async () => {
    const { t, source } = world();
    await source.get(url('A'));
    source.trust(url('A'));
    for (let i = 0; i < 100; i++) await source.get(url('A'));
    expect(t.calls).toHaveLength(1);
  });

  it('the daily window for unknown URLs is exactly 24 hours', async () => {
    const { t, source, clock } = world();
    await source.get(url('A')); // fetch 1, at T0, while cold
    source.trust(url('A'));
    for (let i = 1; i <= 11; i++) {
      clock.advance(HOUR + MINUTE);
      await source.get(url(`FAIL-DAILY-${i}`)); // fetches 2 to 12
    }
    expect(t.calls).toHaveLength(12);
    clock.advance(DAY - 1 - 11 * (HOUR + MINUTE)); // 1 ms before the first fetch is 24 hours old
    await source.get(url('FAIL-LATE'));
    expect(t.calls).toHaveLength(12); // 12 in the window: refused
    clock.advance(1);
    await source.get(url('FAIL-LATE-2'));
    expect(t.calls).toHaveLength(13); // the first fetch has left
  });

  it('an old trusted fetch is forgotten: two more are allowed after the hour', async () => {
    const { t, source, clock } = world();
    const trusted = url('FAIL-TRUSTED');
    await source.get(trusted);
    source.trust(trusted);
    clock.advance(HOUR);
    await source.get(trusted); // one reserved fetch
    clock.advance(2 * HOUR);
    const base = t.calls.length;
    await source.get(trusted);
    clock.advance(11 * MINUTE);
    await source.get(trusted);
    expect(t.calls.length - base).toBe(2);
    clock.advance(11 * MINUTE);
    await source.get(trusted);
    expect(t.calls.length - base).toBe(2); // and the third is refused
  });

  it('stats forget a lone fetch once it is out of its window', async () => {
    const { source, clock } = world();
    const trusted = url('FAIL-TRUSTED');
    await source.get(trusted); // one unknown fetch, while cold
    source.trust(trusted);
    clock.advance(HOUR);
    await source.get(trusted); // one trusted fetch
    expect(source.stats().fetches_in_window).toBe(1);
    expect(source.stats().unknown_fetches_today).toBe(1);
    clock.advance(HOUR);
    expect(source.stats().fetches_in_window).toBe(0);
    expect(source.stats().unknown_fetches_today).toBe(1);
    clock.advance(DAY);
    expect(source.stats().unknown_fetches_today).toBe(0);
  });
});
