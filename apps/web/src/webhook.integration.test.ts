// CO-3 integration: a signed delivery through the route handler of the real app. A webhook is a hint
// only: it stores one event and makes one read-back due. It never sets paid, never books money,
// never calls PayPal. The certificate source is injected and the key pair is made at run time.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CAPTURE,
  NOW_MS,
  PROVIDER_ORDER,
  bootWebhookApp,
  certsFor,
  delivery,
  eventBody,
  seedCapturingOrder,
} from './webhook-support';
import type { WebhookRig } from './webhook-support';

vi.mock('server-only', () => ({}));

// L1: the certificate pin (EXPECTED_CERT_PINS) is empty in the repository. One test needs it
// non-empty to reach the real certificate source; the holder is read on every access.
const pin = vi.hoisted(() => ({
  pins: [] as Array<{ host: string; subject: string; issuer: string }>,
}));
vi.mock('@umsbx/paypal', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@umsbx/paypal')>();
  return {
    ...actual,
    get EXPECTED_CERT_PINS() {
      return pin.pins;
    },
  };
});

// A complete pin (exact host, subject and issuer): the gate needs all three (CO-1d).
const FULL_PIN = {
  host: ['certs', 'sandbox', 'paypal', 'com'].join('.'),
  subject: 'CN=synthetic.invalid',
  issuer: 'CN=synthetic-issuer.invalid',
};

let rig: WebhookRig;
beforeEach(() => {
  pin.pins = [];
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW_MS);
});
afterEach(async () => {
  await rig?.close();
  vi.useRealTimers();
});

/** The `outcome` of every webhook.delivery log line, in order. */
const outcomes = (): string[] =>
  rig.lines
    .map((l) => JSON.parse(l) as { msg?: string; outcome?: string })
    .filter((l) => l.msg === 'webhook.delivery')
    .map((l) => l.outcome ?? '');

const readbacks = (order_id: string) =>
  rig.app.db.query<{ state: string; next_retry_at: unknown; updated_at: unknown }>(
    `SELECT state, next_retry_at, updated_at FROM operations WHERE order_id = $1 AND kind = 'readback'`,
    [order_id],
  );
const orderStatus = async (order_id: string) =>
  (
    await rig.app.db.query<{ status: string }>('SELECT status FROM orders WHERE id = $1', [
      order_id,
    ])
  ).rows[0]?.status;

describe('a signed delivery', () => {
  it('enqueues one read-back; the same delivery again answers 200 and enqueues nothing', async () => {
    rig = await bootWebhookApp();
    const { order_id } = await seedCapturingOrder(rig.app);
    const d = delivery(eventBody({ id: 'WH-INT-1', type: 'CHECKOUT.ORDER.APPROVED' }), {
      id: 'TR-INT-1',
    });

    const first = await rig.post(d);
    expect(first.status).toBe(200);
    expect(await first.text()).toBe('{}');
    expect(await rig.count('SELECT count(*) AS c FROM webhook_events')).toBe(1);
    const queued = await readbacks(order_id);
    expect(queued.rows).toHaveLength(1);
    expect(queued.rows[0]?.state).toBe('unknown');
    expect(new Date(queued.rows[0]?.next_retry_at as string | Date).getTime()).toBeLessThanOrEqual(
      NOW_MS + 60_000,
    );
    expect(rig.certs?.trusted).toHaveLength(1);

    const again = await rig.post(d);
    expect(again.status).toBe(200);
    expect(await rig.count('SELECT count(*) AS c FROM webhook_events')).toBe(1);
    expect((await readbacks(order_id)).rows).toEqual(queued.rows);

    // a different event for the same order within 60 s is stored, but the read-back is coalesced
    vi.setSystemTime(NOW_MS + 5_000);
    const other = delivery(
      eventBody({ id: 'WH-INT-2', type: 'PAYMENT.CAPTURE.COMPLETED', capture: CAPTURE }),
      { id: 'TR-INT-2', time: '2026-10-23T12:00:05Z' },
    );
    expect((await rig.post(other)).status).toBe(200);
    expect(await rig.count('SELECT count(*) AS c FROM webhook_events')).toBe(2);
    expect((await readbacks(order_id)).rows).toHaveLength(1);
  });

  it('never sets paid, books money, grants access or calls PayPal', async () => {
    rig = await bootWebhookApp();
    const { order_id } = await seedCapturingOrder(rig.app);
    const before = await orderStatus(order_id);
    const tables = [
      'ledger_entries',
      'entitlements',
      'receipts',
      'access_windows',
      'access_events',
    ];
    const moneyCounts = async () =>
      Promise.all(tables.map((t) => rig.count(`SELECT count(*) AS c FROM ${t}`)));
    const countsBefore = await moneyCounts();
    const unitsBefore = await rig.app.db.query(
      'SELECT id, status, capture_id, refunded_minor FROM order_units WHERE order_id = $1 ORDER BY id',
      [order_id],
    );
    for (const [i, type] of [
      'PAYMENT.CAPTURE.COMPLETED',
      'PAYMENT.CAPTURE.REVERSED',
      'PAYMENT.CAPTURE.REFUNDED',
      'CHECKOUT.ORDER.APPROVED',
    ].entries()) {
      const d = delivery(eventBody({ id: `WH-NOP-${i}`, type, order: PROVIDER_ORDER }), {
        id: `TR-NOP-${i}`,
      });
      expect((await rig.post(d)).status).toBe(200);
    }
    expect(await orderStatus(order_id)).toBe(before);
    expect(await moneyCounts()).toEqual(countsBefore);
    const unitsAfter = await rig.app.db.query(
      'SELECT id, status, capture_id, refunded_minor FROM order_units WHERE order_id = $1 ORDER BY id',
      [order_id],
    );
    expect(unitsAfter.rows).toEqual(unitsBefore.rows);
    expect(rig.wire).toEqual([]);
    expect(await rig.count('SELECT count(*) AS c FROM provider_calls')).toBe(0);
  });

  it('an event for an order that is not ours is stored and changes nothing else', async () => {
    rig = await bootWebhookApp();
    const d = delivery(
      eventBody({
        id: 'WH-INT-X',
        type: 'PAYMENT.CAPTURE.COMPLETED',
        order: 'SBXNOTOURS0001',
        capture: 'SBXNOTOURS0002',
      }),
      { id: 'TR-INT-X' },
    );
    expect((await rig.post(d)).status).toBe(200);
    expect(await rig.count('SELECT count(*) AS c FROM webhook_events')).toBe(1);
    expect(await rig.count('SELECT count(*) AS c FROM operations')).toBe(0);
  });

  it('the delivery is verified with the webhook id from the configuration', async () => {
    rig = await bootWebhookApp({ webhook_id: 'SYN-OTHER-WEBHOOK-ID' });
    const d = delivery(eventBody({ id: 'WH-INT-W' }), { id: 'TR-INT-W' });
    expect((await rig.post(d)).status).toBe(400); // signed for another webhook id
    expect(await rig.count('SELECT count(*) AS c FROM webhook_events')).toBe(0);
  });
});

describe('without a certificate source of its own', () => {
  it('under mvp_b_polling with no injected source and an empty pin the answer is 503 `disabled`, nothing is stored', async () => {
    rig = await bootWebhookApp({ certs: null, scope: 'mvp_b_polling' });
    const { order_id } = await seedCapturingOrder(rig.app);
    const res = await rig.post(delivery(eventBody({ id: 'WH-B-1' }), { id: 'TR-B-1' }));
    expect(res.status).toBe(503);
    expect(await res.text()).toBe('{}');
    // the empty-pin gate answers, before any verification (the next test reaches the transport)
    expect(outcomes()).toEqual(['disabled']);
    expect(await rig.count('SELECT count(*) AS c FROM webhook_events')).toBe(0);
    expect((await readbacks(order_id)).rows).toHaveLength(0);
    expect(rig.wire).toEqual([]);
    expect(await rig.count('SELECT count(*) AS c FROM provider_calls')).toBe(0);
  });

  it('under mvp_b_polling with a pin set and no injected source the certificate fetch is blocked: 503 `unverifiable`', async () => {
    pin.pins = [FULL_PIN];
    rig = await bootWebhookApp({ certs: null, scope: 'mvp_b_polling' });
    const { order_id } = await seedCapturingOrder(rig.app);
    const res = await rig.post(delivery(eventBody({ id: 'WH-B-2' }), { id: 'TR-B-2' }));
    expect(res.status).toBe(503);
    expect(await res.text()).toBe('{}');
    // the real certificate source asked the transport, which refused the operation
    expect(outcomes()).toEqual(['unverifiable']);
    expect(
      await rig.count('SELECT count(*) AS c FROM audit_log WHERE action = $1', [
        'webhook.unverifiable',
      ]),
    ).toBe(1);
    expect(await rig.count('SELECT count(*) AS c FROM webhook_events')).toBe(0);
    expect((await readbacks(order_id)).rows).toHaveLength(0);
    expect(rig.wire).toEqual([]);
    expect(await rig.count('SELECT count(*) AS c FROM provider_calls')).toBe(0);
  });

  it('under mvp_c_refunds the webhook stays off while the certificate pin is empty (ASM-64)', async () => {
    rig = await bootWebhookApp({ certs: null, scope: 'mvp_c_refunds' });
    const res = await rig.post(delivery(eventBody({ id: 'WH-C-1' }), { id: 'TR-C-1' }));
    expect(res.status).toBe(503);
    expect(await rig.count('SELECT count(*) AS c FROM webhook_events')).toBe(0);
    expect(rig.wire).toEqual([]);
    // refused before any verification: no audit row either
    expect(
      await rig.count('SELECT count(*) AS c FROM audit_log WHERE action LIKE $1', ['webhook.%']),
    ).toBe(0);
  });

  it.each([
    ['a subject-only pin (the old shape)', [{ subject: 'CN=synthetic.invalid' }]],
    ['a pin without an issuer', [{ host: FULL_PIN.host, subject: FULL_PIN.subject, issuer: '' }]],
    ['a pin without a host', [{ host: '', subject: FULL_PIN.subject, issuer: FULL_PIN.issuer }]],
    [
      'a pin whose host the certificate rules refuse',
      [{ host: 'evil.example.invalid', subject: FULL_PIN.subject, issuer: FULL_PIN.issuer }],
    ],
    ['one full pin beside one partial pin', [FULL_PIN, { ...FULL_PIN, issuer: '' }]],
  ])(
    'CO-1d: %s keeps the webhook off under mvp_c_refunds (503 disabled, nothing fetched or stored)',
    async (_name, pins) => {
      pin.pins = pins as typeof pin.pins;
      rig = await bootWebhookApp({ certs: null, scope: 'mvp_c_refunds' });
      const res = await rig.post(delivery(eventBody({ id: 'WH-C-PARTIAL' }), { id: 'TR-C-P' }));
      expect(res.status).toBe(503);
      expect(outcomes()).toEqual(['disabled']);
      expect(await rig.count('SELECT count(*) AS c FROM webhook_events')).toBe(0);
      expect(rig.wire).toEqual([]);
      expect(
        await rig.count('SELECT count(*) AS c FROM audit_log WHERE action LIKE $1', ['webhook.%']),
      ).toBe(0);
    },
  );

  it('CO-1d: a full pin lets the gate through (the delivery then reaches the certificate source)', async () => {
    pin.pins = [FULL_PIN];
    rig = await bootWebhookApp({ certs: null, scope: 'mvp_c_refunds' });
    const res = await rig.post(delivery(eventBody({ id: 'WH-C-FULL' }), { id: 'TR-C-F' }));
    expect(res.status).toBe(503);
    expect(outcomes()).toEqual(['unverifiable']);
  });

  it('no webhook id configured: 503, and the certificate source is never asked', async () => {
    const certs = certsFor();
    rig = await bootWebhookApp({ certs, webhook_id: null });
    const res = await rig.post(delivery(eventBody({ id: 'WH-N-1' }), { id: 'TR-N-1' }));
    expect(res.status).toBe(503);
    expect(certs.calls).toEqual([]);
    expect(await rig.count('SELECT count(*) AS c FROM webhook_events')).toBe(0);
  });

  it('a dry run (offline mode) never verifies a delivery', async () => {
    rig = await bootWebhookApp({ mode: 'offline', certs: null });
    const res = await rig.post(delivery(eventBody({ id: 'WH-O-1' }), { id: 'TR-O-1' }));
    expect(res.status).toBe(503);
    expect(await rig.count('SELECT count(*) AS c FROM webhook_events')).toBe(0);
  });
});
