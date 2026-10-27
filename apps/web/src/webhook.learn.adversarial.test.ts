// CO-1d adversarial: what a hostile caller, a hostile certificate answer or a forgotten window can and
// cannot make the learn path do. The Wire is a counting stand-in; nothing leaves the process.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CERT_HOST,
  NOW_MS,
  PARSE_ONLY_PEM,
  bootLearnApp,
  certUrlN,
  certWire,
  delivery,
  eventBody,
  eventBodyOfSize,
  learnRows,
  logLines,
  stateOf,
} from './webhook-support';
import type { WebhookRig } from './webhook-support';

vi.mock('server-only', () => ({}));

// The learn window is tested with no pin (the state it exists for). The repository now carries the
// learned PayPal sandbox pin (D-043), so these tests hold the pin empty, the same way webhook.integration
// holds it through a holder.
vi.mock('@umsbx/paypal', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@umsbx/paypal')>();
  return {
    ...actual,
    get EXPECTED_CERT_PINS() {
      return [];
    },
  };
});

let rig: WebhookRig;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW_MS);
});
afterEach(async () => {
  await rig?.close();
  rig = undefined as unknown as WebhookRig;
  vi.useRealTimers();
});

const sent = (n: number, id = `TR-ADV-${n}`) =>
  delivery(eventBody({ id: `WH-ADV-${n}` }), { id, cert_url: certUrlN(n) });
const HOUR = 3_600_000;

describe('the limiter, the size cap and the method check come first', () => {
  it('a body of 64 KiB plus 1 byte is 413: no fetch, no row', async () => {
    rig = await bootLearnApp();
    const big = delivery(eventBodyOfSize({ id: 'WH-BIG' }, 65_537), {
      id: 'TR-BIG',
      cert_url: certUrlN(1),
    });
    for (const [i, len] of ['65537', '10'].entries()) {
      const res = await rig.route.POST(
        new Request('http://localhost:3000/api/webhooks/paypal', {
          method: 'POST',
          body: big.raw_body,
          headers: {
            ...big.headers,
            'content-length': len,
            'x-forwarded-for': `203.0.113.${i + 1}`,
          },
        }),
      );
      expect(res.status).toBe(413);
    }
    expect(rig.wire).toEqual([]);
    expect(await learnRows(rig.app)).toEqual([]);
  });

  it('GET, PUT, DELETE and PATCH are 405: no fetch, no row', async () => {
    rig = await bootLearnApp();
    for (const method of ['GET', 'PUT', 'DELETE', 'PATCH'])
      expect((await rig.post(sent(1), { method })).status).toBe(405);
    expect(rig.wire).toEqual([]);
    expect(await learnRows(rig.app)).toEqual([]);
  });

  it('after 60 refused answers from one address in a minute the 61st is 429 and reaches nothing', async () => {
    rig = await bootLearnApp();
    for (let i = 1; i <= 60; i++) {
      const res = await rig.post(sent(1 + (i % 3), `TR-LIM-${i}`), { ip: '198.51.100.7' });
      expect([i, res.status]).toEqual([i, 503]);
    }
    const wire = rig.wire.length;
    const rows = (await learnRows(rig.app)).length;
    const state = await stateOf(rig.app);
    const res = await rig.post(sent(50), { ip: '198.51.100.7' });
    expect(res.status).toBe(429);
    expect(rig.wire).toHaveLength(wire);
    expect(await learnRows(rig.app)).toHaveLength(rows);
    expect(await stateOf(rig.app)).toEqual(state);
    // another address is not limited by it
    expect((await rig.post(sent(51), { ip: '198.51.100.8' })).status).toBe(503);
  });
});

describe('only the listed facts are written, never the request', () => {
  const BODY = 'SENTINEL-BODY-TEXT';
  it('no body, signature, transmission id, cert URL or query reaches the audit log or any log line', async () => {
    rig = await bootLearnApp();
    const d = delivery(JSON.stringify({ id: 'WH-S', event_type: 'X', resource: {}, note: BODY }), {
      id: 'SENTINEL-TRANSMISSION-ID',
      cert_url: certUrlN(1),
    });
    expect((await rig.post(d)).status).toBe(503);
    const audit = JSON.stringify((await rig.app.db.query('SELECT * FROM audit_log')).rows);
    const text = `${audit}\n${rig.lines.join('\n')}`;
    for (const secret of [
      BODY,
      'SENTINEL-TRANSMISSION-ID',
      d.headers['paypal-transmission-sig']!,
      certUrlN(1),
      'https://',
      'BEGIN CERTIFICATE',
    ])
      expect([secret, text.includes(secret)]).toEqual([secret, false]);
    // host and path are there, as asked
    expect(text).toContain(CERT_HOST);
    expect(text).toContain('/v1/notifications/certs/CERT-LEARN-0001');
  });

  it('a certificate URL with a query is refused whole: nothing fetched, the query is nowhere', async () => {
    rig = await bootLearnApp();
    const d = delivery(eventBody({ id: 'WH-Q' }), {
      id: 'TR-Q',
      cert_url: certUrlN(1, { query: '?token=SENTINEL-QUERY' }),
    });
    expect((await rig.post(d)).status).toBe(503);
    expect(rig.wire).toEqual([]);
    expect(await learnRows(rig.app)).toEqual([]);
    expect(rig.lines.join('\n')).not.toContain('SENTINEL-QUERY');
  });

  it('the row holds the eight facts and an empty reason; nothing else the request carried', async () => {
    rig = await bootLearnApp();
    await rig.post(sent(1));
    const all = (
      await rig.app.db.query<{ detail: unknown; reason: string | null }>(
        `SELECT detail, reason FROM audit_log WHERE action = 'webhook.cert_learned'`,
      )
    ).rows;
    expect(all).toHaveLength(1);
    expect(all[0]?.reason).toBeNull();
    const detail = (
      typeof all[0]?.detail === 'string' ? JSON.parse(all[0].detail) : all[0]?.detail
    ) as object;
    expect(Object.keys(detail)).toHaveLength(8);
  });
});

describe('a hostile certificate answer records nothing and goes nowhere', () => {
  it.each([
    [
      'a redirect to another host',
      () => ({
        kind: 'response' as const,
        status: 302,
        headers: { location: 'https://evil.example.invalid/x' },
        body: '',
      }),
    ],
    ['a 500', () => ({ kind: 'response' as const, status: 500, headers: {}, body: 'x' })],
    ['a timeout', () => ({ kind: 'error' as const, error: 'timeout' as const })],
    [
      'a 70 KB body',
      () => ({ kind: 'response' as const, status: 200, headers: {}, body: 'x'.repeat(70_000) }),
    ],
    [
      'a PEM that is half a certificate',
      () => ({
        kind: 'response' as const,
        status: 200,
        headers: {},
        body: PARSE_ONLY_PEM.slice(0, 400),
      }),
    ],
  ])('%s: 503, one request only, no row, no log line of facts', async (_n, answer) => {
    rig = await bootLearnApp({ wire_answer: answer });
    expect((await rig.post(sent(1))).status).toBe(503);
    expect(rig.wire).toHaveLength(1);
    expect(await learnRows(rig.app)).toEqual([]);
    expect(logLines(rig.lines, 'webhook.cert_learned')).toEqual([]);
  });

  it('every request the Wire ever sees goes to the certificate host under the certificate path, and only there', async () => {
    rig = await bootLearnApp({ wire_answer: certWire() });
    for (let n = 1; n <= 4; n++) await rig.post(sent(n), { ip: `203.0.113.${n}` });
    await rig.post(
      delivery(eventBody({ id: 'WH-X' }), {
        id: 'TR-X',
        cert_url: certUrlN(9, { host: 'evil.example.invalid' }),
      }),
      { ip: '203.0.113.9' },
    );
    expect(rig.wire.length).toBeGreaterThan(0);
    for (const r of rig.wire) {
      const u = new URL(r.url);
      expect([u.protocol, u.hostname, u.port, u.search]).toEqual(['https:', CERT_HOST, '', '']);
      expect(u.pathname.startsWith('/v1/notifications/certs/')).toBe(true);
      expect(r.method).toBe('GET');
    }
  });

  it('ten deliveries at once for one certificate: one fetch, one row', async () => {
    rig = await bootLearnApp();
    const all = await Promise.all(
      Array.from({ length: 10 }, (_v, i) =>
        rig.post(sent(1, `TR-PAR-${i}`), { ip: `203.0.113.${i + 1}` }),
      ),
    );
    expect(all.map((r) => r.status)).toEqual(Array(10).fill(503));
    expect(rig.wire).toHaveLength(1);
    expect(await learnRows(rig.app)).toHaveLength(1);
  });
});

describe('the window cannot be left open', () => {
  it('open to the last millisecond of a 24 h window, closed from the end, whatever happened before', async () => {
    const end = NOW_MS + 24 * HOUR;
    rig = await bootLearnApp({ learn_until: new Date(end).toISOString() });
    vi.setSystemTime(end - 1);
    await rig.post(sent(1));
    expect(await learnRows(rig.app)).toHaveLength(1);
    vi.setSystemTime(end);
    await rig.post(sent(2), { ip: '203.0.113.2' });
    vi.setSystemTime(end + 30 * 24 * HOUR);
    await rig.post(sent(3), { ip: '203.0.113.3' });
    expect(await learnRows(rig.app)).toHaveLength(1);
    expect(rig.wire).toHaveLength(1);
    expect(logLines(rig.lines, 'webhook.delivery').map((l) => l['outcome'])).toEqual([
      'learning',
      'disabled',
      'disabled',
    ]);
  });

  it('a restart does not extend it: the same value booted later ends at the same moment', async () => {
    const end = NOW_MS + 24 * HOUR;
    const later = NOW_MS + 23 * HOUR;
    vi.setSystemTime(later);
    rig = await bootLearnApp({ learn_until: new Date(end).toISOString() });
    await rig.post(sent(1));
    expect(await learnRows(rig.app)).toHaveLength(1);
    vi.setSystemTime(end);
    await rig.post(sent(2), { ip: '203.0.113.2' });
    expect(await learnRows(rig.app)).toHaveLength(1);
  });

  it('a value that is already in the past at boot opens nothing, however far in the past', async () => {
    for (const ago of [1000, HOUR, 400 * 24 * HOUR]) {
      const r = await bootLearnApp({ learn_until: new Date(NOW_MS - ago).toISOString() });
      expect((await r.post(sent(1))).status).toBe(503);
      expect(r.wire).toEqual([]);
      expect(await learnRows(r.app)).toEqual([]);
      await r.close();
    }
  });

  it('a window longer than 24 h from boot never starts, so it can never be "open for days"', async () => {
    for (const hours of [24.01, 25, 48, 24 * 365]) {
      const err = await bootLearnApp({
        learn_until: new Date(NOW_MS + hours * HOUR).toISOString(),
      }).then(
        (r) => {
          void r.close();
          return null;
        },
        (e: unknown) => e as Error,
      );
      expect([hours, err?.message]).toEqual([
        hours,
        'boot refused: invalid_value UMS_WEBHOOK_CERT_LEARN_UNTIL',
      ]);
    }
  });
});
