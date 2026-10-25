// CO-1d (D-038) integration: the learn window through the route handler of the real app. The Wire is a
// counting stand-in that answers certificate fetches with a public test certificate; nothing leaves
// the process. While the window is open a delivery is answered 503 and acts on nothing; the app
// records the certificate facts (one audit row, one log line) and no more.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CERT_HOST,
  LEARN_OPERATIONS,
  NOW_MS,
  PARSE_ONLY_FACTS,
  bootLearnApp,
  bootWebhookApp,
  certUrlN,
  certWire,
  certsFor,
  delivery,
  eventBody,
  forger,
  learnRows,
  logLines,
  seedCapturingOrder,
  signer,
  stateOf,
} from './webhook-support';
import type { WebhookRig } from './webhook-support';

vi.mock('server-only', () => ({}));

const FACT_KEYS = [
  'fingerprint_sha256',
  'host',
  'issuer',
  'path',
  'subject',
  'subject_cn',
  'valid_from',
  'valid_to',
];
const EXPECTED = (n: number) => ({
  host: CERT_HOST,
  path: `/v1/notifications/certs/CERT-LEARN-${String(n).padStart(4, '0')}`,
  ...PARSE_ONLY_FACTS,
});
/** a delivery as PayPal would send one, naming certificate number n */
const sent = (n: number, id = `TR-LEARN-${n}`) =>
  delivery(eventBody({ id: `WH-LEARN-${n}` }), { id, cert_url: certUrlN(n) });

let rig: WebhookRig;
let fetchCalls: unknown[][];
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW_MS);
  fetchCalls = [];
  vi.stubGlobal('fetch', (...a: unknown[]) => {
    fetchCalls.push(a);
    return Promise.reject(new Error('the learn tests are offline'));
  });
});
afterEach(async () => {
  await rig?.close();
  rig = undefined as unknown as WebhookRig;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('window open', () => {
  it('answers 503 with an empty body and records exactly the listed facts, once, in the audit log and the log', async () => {
    rig = await bootLearnApp();
    const res = await rig.post(sent(1));
    expect(res.status).toBe(503);
    expect(await res.text()).toBe('{}');

    const rows = await learnRows(rig.app);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      actor_kind: 'system',
      actor_id: null,
      target: null,
      reason: null,
      detail: EXPECTED(1),
    });
    expect(Object.keys(rows[0]?.detail ?? {}).sort()).toEqual(FACT_KEYS);

    const lines = logLines(rig.lines, 'webhook.cert_learned');
    expect(lines).toHaveLength(1);
    const { host, path, subject, subject_cn, issuer, valid_from, valid_to, fingerprint_sha256 } =
      lines[0] as Record<string, unknown>;
    expect({
      host,
      path,
      subject,
      subject_cn,
      issuer,
      valid_from,
      valid_to,
      fingerprint_sha256,
    }).toEqual(EXPECTED(1));
    // the delivery line carries the class only
    const delivered = logLines(rig.lines, 'webhook.delivery');
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({ http: 503, outcome: 'learning', verdict: 'not_checked' });
  });

  it('fetches the certificate once, through the sealed transport: one GET to the named path, no token, no body', async () => {
    rig = await bootLearnApp();
    await rig.post(sent(1));
    expect(rig.wire).toHaveLength(1);
    const r = rig.wire[0]!;
    expect(r.method).toBe('GET');
    expect(new URL(r.url).hostname).toBe(CERT_HOST);
    expect(new URL(r.url).pathname).toBe(EXPECTED(1).path);
    expect(new URL(r.url).search).toBe('');
    expect(Object.keys(r.headers).map((k) => k.toLowerCase())).not.toContain('authorization');
    expect(r.body ?? null).toBeNull();
    expect(fetchCalls).toEqual([]);
  });

  it('acts on nothing: no event, no read-back, no order, ledger, entitlement or other state row changes', async () => {
    rig = await bootLearnApp();
    const { order_id } = await seedCapturingOrder(rig.app);
    const before = await stateOf(rig.app);
    // a genuine-looking, correctly signed delivery for that order: if it were verified it would enqueue a read-back
    const res = await rig.post(
      delivery(eventBody({ id: 'WH-ACT', type: 'CHECKOUT.ORDER.APPROVED' }), {
        id: 'TR-ACT',
        cert_url: certUrlN(1),
      }),
    );
    expect(res.status).toBe(503);
    expect(await stateOf(rig.app)).toEqual(before);
    expect(await rig.count('SELECT count(*) AS c FROM webhook_events')).toBe(0);
    expect(
      await rig.count(
        `SELECT count(*) AS c FROM operations WHERE order_id = $1 AND kind = 'readback'`,
        [order_id],
      ),
    ).toBe(0);
    expect(
      await rig.count('SELECT count(*) AS c FROM audit_log WHERE action LIKE $1', ['webhook.%']),
    ).toBe(1);
    expect(
      await rig.count('SELECT count(*) AS c FROM audit_log WHERE action IN ($1, $2)', [
        'webhook.rejected',
        'webhook.unverifiable',
      ]),
    ).toBe(0);
  });

  it('uses no verification verdict: a good signature, a forged one and junk give the same answer and the same single row', async () => {
    for (const [i, d] of [
      delivery(eventBody({ id: 'WH-V1' }), {
        id: 'TR-V1',
        cert_url: certUrlN(1),
        key: signer.privateKey,
      }),
      delivery(eventBody({ id: 'WH-V2' }), {
        id: 'TR-V2',
        cert_url: certUrlN(1),
        key: forger.privateKey,
      }),
      {
        headers: {
          ...delivery(eventBody({ id: 'WH-V3' }), { id: 'TR-V3', cert_url: certUrlN(1) }).headers,
          'paypal-transmission-sig': 'not-a-signature',
          'paypal-auth-algo': 'SHA1withRSA',
        },
        raw_body: 'not json at all',
      },
    ].entries()) {
      if (i === 0) rig = await bootLearnApp();
      const res = await rig.post(d, { ip: `203.0.113.${20 + i}` });
      expect([i, res.status]).toEqual([i, 503]);
    }
    expect(await learnRows(rig.app)).toHaveLength(1);
    expect(rig.wire).toHaveLength(1);
    expect(await rig.count('SELECT count(*) AS c FROM webhook_events')).toBe(0);
  });

  it('a repeat of the same certificate is answered 503 with no fetch and no new row; another certificate is a new row', async () => {
    rig = await bootLearnApp();
    await rig.post(sent(1));
    await rig.post(sent(1, 'TR-AGAIN'), { ip: '203.0.113.2' });
    expect(rig.wire).toHaveLength(1);
    expect(await learnRows(rig.app)).toHaveLength(1);
    const res = await rig.post(sent(2), { ip: '203.0.113.3' });
    expect(res.status).toBe(503);
    expect(rig.wire).toHaveLength(2);
    const rows = await learnRows(rig.app);
    expect(rows.map((r) => r.detail['path'])).toEqual([EXPECTED(1).path, EXPECTED(2).path]);
  });

  it('respects the certificate fetch budget: 6 an hour from a cold start, then nothing is fetched or recorded', async () => {
    rig = await bootLearnApp();
    for (let n = 1; n <= 9; n++) {
      const res = await rig.post(sent(n), { ip: `203.0.113.${n}` });
      expect([n, res.status]).toEqual([n, 503]);
    }
    expect(rig.wire).toHaveLength(6);
    expect(await learnRows(rig.app)).toHaveLength(6);
  });

  it('after an hour of a longer window the budget is back and a new certificate is recorded', async () => {
    rig = await bootLearnApp({ learn_until: new Date(NOW_MS + 3 * 3_600_000).toISOString() });
    for (let n = 1; n <= 7; n++) await rig.post(sent(n), { ip: `203.0.113.${n}` });
    expect(rig.wire).toHaveLength(6);
    vi.setSystemTime(NOW_MS + 61 * 60_000);
    await rig.post(sent(7), { ip: '203.0.113.99' });
    expect(rig.wire).toHaveLength(7);
    expect(await learnRows(rig.app)).toHaveLength(7);
  });

  it('a certificate host off the allow list: 503, nothing fetched, nothing recorded', async () => {
    rig = await bootLearnApp();
    const off = [
      certUrlN(1, { host: 'evil.example.invalid' }),
      certUrlN(1).replace('https:', 'http:'),
      certUrlN(1, { query: '?x=1' }),
      certUrlN(1, { host: `a.b.${CERT_HOST.split('.').slice(1).join('.')}` }),
      certUrlN(1, { host: ['api', 'paypal', 'com'].join('.') }),
      `https://${CERT_HOST}@${'evil.example.invalid'}/v1/notifications/certs/CERT-1`,
    ];
    for (const [i, u] of off.entries()) {
      const res = await rig.post(
        delivery(eventBody({ id: `WH-OFF-${i}` }), { id: `TR-OFF-${i}`, cert_url: u }),
        { ip: `203.0.113.${40 + i}` },
      );
      expect([u, res.status]).toEqual([u, 503]);
    }
    expect(rig.wire).toEqual([]);
    expect(await learnRows(rig.app)).toEqual([]);
  });

  it('a delivery with no certificate URL header: 503, nothing fetched, nothing recorded', async () => {
    rig = await bootLearnApp();
    const d = sent(1);
    delete d.headers['paypal-cert-url'];
    expect((await rig.post(d)).status).toBe(503);
    expect(rig.wire).toEqual([]);
    expect(await learnRows(rig.app)).toEqual([]);
  });

  it('a certificate the host refuses (404) or that is not a certificate: 503, nothing recorded', async () => {
    rig = await bootLearnApp({ wire_answer: certWire('not a certificate') });
    expect((await rig.post(sent(1))).status).toBe(503);
    expect(await learnRows(rig.app)).toEqual([]);
    expect(logLines(rig.lines, 'webhook.cert_learned')).toEqual([]);
  });

  it('an injected certificate source has no inspect: 503, nothing fetched, nothing recorded, nothing verified', async () => {
    const certs = certsFor();
    rig = await bootLearnApp({ certs });
    const { order_id } = await seedCapturingOrder(rig.app);
    const res = await rig.post(
      delivery(eventBody({ id: 'WH-INJ' }), { id: 'TR-INJ', key: signer.privateKey }),
    );
    expect(res.status).toBe(503);
    expect(certs.calls).toEqual([]);
    expect(rig.wire).toEqual([]);
    expect(await learnRows(rig.app)).toEqual([]);
    expect(await rig.count('SELECT count(*) AS c FROM webhook_events')).toBe(0);
    expect(
      await rig.count(
        `SELECT count(*) AS c FROM operations WHERE order_id = $1 AND kind = 'readback'`,
        [order_id],
      ),
    ).toBe(0);
  });

  it('an open window wins over a complete pin: still learn only, still nothing verified', async () => {
    // (the pin constant is empty in the repository; the composition test seam for a pin is the module
    // constant, so this case is covered with an injected source that would verify if it were asked)
    const certs = certsFor();
    rig = await bootLearnApp({ certs });
    const res = await rig.post(delivery(eventBody({ id: 'WH-PIN' }), { id: 'TR-PIN' }));
    expect(res.status).toBe(503);
    expect(certs.calls).toEqual([]);
    expect(certs.trusted).toEqual([]);
  });
});

describe('the locks stay shut: the learn fetch is an ordinary outbound call', () => {
  const learned = async () => (rig === undefined ? [] : await learnRows(rig.app));
  it.each([
    ['UMS_PAYPAL_CONNECT off', { connect: 'off' as const }],
    ['no approval row', { approval: null }],
    [
      'an approval that does not name fetch_webhook_cert',
      { approval: { operations: LEARN_OPERATIONS.filter((x) => x !== 'fetch_webhook_cert') } },
    ],
    [
      'the paypal_outbound kill switch off',
      { approval: { operations: LEARN_OPERATIONS, outbound_on: false } },
    ],
    ['the mvp_b_polling scope', { scope: 'mvp_b_polling' as const }],
  ])('%s: 503, the Wire sees nothing, nothing is recorded', async (_name, over) => {
    rig = await bootLearnApp(over);
    const res = await rig.post(sent(1));
    expect(res.status).toBe(503);
    expect(rig.wire).toEqual([]);
    expect(await learned()).toEqual([]);
    expect(logLines(rig.lines, 'webhook.cert_learned')).toEqual([]);
  });
  it('the webhook_enabled switch off: 503, nothing fetched, nothing recorded', async () => {
    rig = await bootLearnApp();
    await rig.app.db.query(
      `UPDATE safety_switches SET "on" = false WHERE name = 'webhook_enabled'`,
    );
    expect((await rig.post(sent(1))).status).toBe(503);
    expect(rig.wire).toEqual([]);
    expect(await learned()).toEqual([]);
  });
});

describe('window closed, expired, capped, refused', () => {
  it('no variable: unchanged (503 disabled while the pin is empty), nothing recorded, nothing fetched', async () => {
    rig = await bootLearnApp({ learn_until: null });
    const res = await rig.post(sent(1));
    expect(res.status).toBe(503);
    expect(logLines(rig.lines, 'webhook.delivery').map((l) => l['outcome'])).toEqual(['disabled']);
    expect(rig.wire).toEqual([]);
    expect(await learnRows(rig.app)).toEqual([]);
    expect(
      await rig.count('SELECT count(*) AS c FROM audit_log WHERE action LIKE $1', ['webhook.%']),
    ).toBe(0);
  });
  it('a value in the past is ignored: the same as no variable', async () => {
    rig = await bootLearnApp({ learn_until: new Date(NOW_MS - 1000).toISOString() });
    expect((await rig.post(sent(1))).status).toBe(503);
    expect(logLines(rig.lines, 'webhook.delivery').map((l) => l['outcome'])).toEqual(['disabled']);
    expect(rig.wire).toEqual([]);
    expect(await learnRows(rig.app)).toEqual([]);
  });
  it('the window closes by itself: the end moment and later are the closed behaviour', async () => {
    rig = await bootLearnApp({ learn_until: new Date(NOW_MS + 10 * 60_000).toISOString() });
    await rig.post(sent(1));
    expect(await learnRows(rig.app)).toHaveLength(1);
    vi.setSystemTime(NOW_MS + 10 * 60_000 - 1);
    await rig.post(sent(2), { ip: '203.0.113.2' });
    expect(await learnRows(rig.app)).toHaveLength(2);
    vi.setSystemTime(NOW_MS + 10 * 60_000);
    const res = await rig.post(sent(3), { ip: '203.0.113.3' });
    expect(res.status).toBe(503);
    expect(rig.wire).toHaveLength(2);
    expect(await learnRows(rig.app)).toHaveLength(2);
    expect(logLines(rig.lines, 'webhook.delivery').map((l) => l['outcome'])).toEqual([
      'learning',
      'learning',
      'disabled',
    ]);
  });
  it('exactly 24 h ahead boots; one second more is refused at boot, naming the variable and not the value', async () => {
    const edge = await bootLearnApp({
      learn_until: new Date(NOW_MS + 24 * 3_600_000).toISOString(),
    });
    await edge.close();
    const tooFar = new Date(NOW_MS + 24 * 3_600_000 + 1000).toISOString();
    const err = await bootLearnApp({ learn_until: tooFar }).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(err?.message).toBe('boot refused: invalid_value UMS_WEBHOOK_CERT_LEARN_UNTIL');
    expect(err?.message).not.toContain(tooFar);
  });
  it('offline mode refuses the variable at boot', async () => {
    const err = await bootWebhookApp({
      mode: 'offline',
      certs: null,
      env: { UMS_WEBHOOK_CERT_LEARN_UNTIL: new Date(NOW_MS + 60_000).toISOString() },
    }).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(err?.message).toBe('boot refused: invalid_value UMS_WEBHOOK_CERT_LEARN_UNTIL');
  });
  it('a malformed value is refused at boot', async () => {
    const err = await bootLearnApp({ learn_until: 'in half an hour' }).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(err?.message).toBe('boot refused: invalid_value UMS_WEBHOOK_CERT_LEARN_UNTIL');
  });
});
