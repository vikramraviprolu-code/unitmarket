// MVP-C offline acceptance C-02 to C-05 (docs/design/mvp-plan.md, MVP-C table; nfr.md P1, P2).
// Every delivery goes through the route handler of the real app. The certificate source is injected
// (a key pair made when the module loads), the Wire is a counting stand-in or a fake that plays PayPal
// with the dry-run model, and no byte leaves the process. Real halves of these rows (C-01) need the
// hosted sandbox and are in docs/owner/MVPC-OWNER-STEPS.md.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { signIn } from '../../apps/web/src/support';
import {
  CAPTURE,
  NOW_MS,
  WEBHOOK_ID,
  bootWebhookApp,
  certUrl,
  certsFor,
  delivery,
  eventBody,
  forger,
  seedCapturingOrder,
  signer,
} from '../../apps/web/src/webhook-support';
import type { WebhookRig } from '../../apps/web/src/webhook-support';
import {
  auditCount,
  bootRig,
  buy,
  fingerprint,
  libraryOf,
  nowTransmissionTime,
  openLink,
  orderStatus,
  outcomes,
  postRefund,
} from './c-support';
import type { CRig } from './c-support';

vi.mock('server-only', () => ({}));

// The certificate pin (EXPECTED_CERT_PINS) is empty in the repository (ASM-64). One test needs it
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

const host = (...parts: string[]): string => parts.join('.');
const SANDBOX = host('sandbox', 'paypal', 'com');
const CERT_PATH = '/v1/notifications/certs/CERT-SYNTHETIC-0001';

describe('C-02 to C-05 webhooks (public route, offline)', () => {
  let rig: WebhookRig;
  let crig: CRig | null = null;
  beforeEach(() => {
    pin.pins = [];
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW_MS);
  });
  afterEach(async () => {
    await rig?.close();
    await crig?.close();
    crig = null;
    vi.useRealTimers();
  });

  const readbacks = (order_id: string) =>
    rig.count(`SELECT count(*) AS c FROM operations WHERE order_id = $1 AND kind = 'readback'`, [
      order_id,
    ]);

  describe('C-02 webhook_forged', () => {
    it('C-02 a forged signature, one changed byte, a wrong webhook id and a re-serialised body: 400, one audit row each, no state change', async () => {
      rig = await bootWebhookApp();
      await seedCapturingOrder(rig.app);
      const raw = eventBody({ id: 'WH-C02', summary: 'Synthetic é' });
      const good = delivery(raw, { id: 'TR-C02' });
      const before = await fingerprint(rig.app.db);
      const auditBefore = await auditCount(rig.app.db, 'webhook.rejected');
      const forged = [
        ['forged signature', delivery(raw, { id: 'TR-C02-A', key: forger.privateKey })],
        ['one changed byte', { ...good, raw_body: raw.replace('Synthetic', 'Synthetid') }],
        ['wrong webhook id', delivery(raw, { id: 'TR-C02-C', webhook_id: `OTHER-${WEBHOOK_ID}` })],
        ['re-serialised body', { ...good, raw_body: JSON.stringify(JSON.parse(raw)) }],
      ] as const;
      for (const [i, [name, d]] of forged.entries()) {
        const res = await rig.post(d, { ip: `203.0.113.${10 + i}` });
        expect([name, res.status]).toEqual([name, 400]);
        expect(await res.text()).toBe('{}');
        expect([name, await auditCount(rig.app.db, 'webhook.rejected')]).toEqual([
          name,
          auditBefore + i + 1,
        ]);
      }
      expect(await fingerprint(rig.app.db)).toEqual(before);
      expect(await rig.count('SELECT count(*) AS c FROM webhook_events')).toBe(0);
      expect(rig.wire).toEqual([]);
      // the unchanged original still verifies: the refusals were about the bytes, not the event
      expect((await rig.post(good, { ip: '203.0.113.50' })).status).toBe(200);
    });

    it('C-02 the audit row of a refusal holds no body, no signature and no raw transmission id', async () => {
      rig = await bootWebhookApp();
      const d = delivery(eventBody({ id: 'WH-C02-B' }), {
        id: 'TR-C02-RAW-ID',
        key: forger.privateKey,
      });
      expect((await rig.post(d)).status).toBe(400);
      const rows = await rig.app.db.query(
        `SELECT * FROM audit_log WHERE action = 'webhook.rejected'`,
      );
      const text = JSON.stringify(rows.rows) + rig.lines.join('\n');
      expect(rows.rows).toHaveLength(1);
      for (const secret of [
        d.headers['paypal-transmission-sig']!,
        d.headers['paypal-transmission-id']!,
        'WH-C02-B',
        certUrl(),
      ])
        expect(text).not.toContain(secret);
    });
  });

  describe('C-03 webhook_cert_offlist', () => {
    const offList = [
      `https://${host('evil', 'example', 'invalid')}${CERT_PATH}`,
      `http://${host('certs', SANDBOX)}${CERT_PATH}`,
      `https://${host('certs', SANDBOX, 'evil', 'example', 'invalid')}${CERT_PATH}`,
      `https://${host('certs', SANDBOX)}@${host('evil', 'example', 'invalid')}${CERT_PATH}`,
      `https://${host('certs', SANDBOX)}/other/path/CERT`,
      `https://203.0.113.9${CERT_PATH}`,
      `https://${host('api', 'paypal', 'com')}${CERT_PATH}`,
      `ftp://${host('certs', SANDBOX)}${CERT_PATH}`,
    ];

    it('C-03 an off-list paypal-cert-url is 400 and the certificate source is never asked', async () => {
      rig = await bootWebhookApp();
      await seedCapturingOrder(rig.app);
      const before = await fingerprint(rig.app.db);
      for (const [i, url] of offList.entries()) {
        const d = delivery(eventBody({ id: `WH-C03-${i}` }), {
          id: `TR-C03-${i}`,
          cert_url: url,
        });
        const res = await rig.post(d, { ip: `203.0.113.${20 + i}` });
        expect([url, res.status]).toEqual([url, 400]);
      }
      expect(rig.certs?.calls).toEqual([]);
      expect(rig.wire).toEqual([]);
      expect(await fingerprint(rig.app.db)).toEqual(before);
    });

    it('C-03 with the real certificate source (pin set, nothing injected) an off-list URL makes zero transport calls', async () => {
      pin.pins = [FULL_PIN];
      rig = await bootWebhookApp({ certs: null, scope: 'mvp_c_refunds' });
      for (const [i, url] of offList.entries()) {
        const d = delivery(eventBody({ id: `WH-C03R-${i}` }), {
          id: `TR-C03R-${i}`,
          cert_url: url,
        });
        const res = await rig.post(d, { ip: `203.0.113.${40 + i}` });
        expect([url, res.status]).toEqual([url, 400]);
      }
      expect(rig.wire).toEqual([]);
      expect(await rig.count('SELECT count(*) AS c FROM provider_calls')).toBe(0);
      expect(outcomes(rig.lines)).toEqual(Array(offList.length).fill('rejected'));
    });
  });

  describe('C-04 webhook_cert_unreachable', () => {
    it('C-04 an allow-listed certificate that cannot be fetched is 503, not a forgery record, and PayPal retrying succeeds', async () => {
      let reachable = false;
      const certs = certsFor(undefined, () =>
        reachable
          ? {
              kind: 'ok' as const,
              cert: {
                public_key: signer.publicKey,
                subject: 'CN=synthetic.invalid',
                valid_from: new Date('2026-01-01T00:00:00Z'),
                valid_to: new Date('2036-01-01T00:00:00Z'),
              },
            }
          : { kind: 'unavailable' as const, why: 'fetch' as const },
      );
      rig = await bootWebhookApp({ certs });
      const { order_id } = await seedCapturingOrder(rig.app);
      const before = await fingerprint(rig.app.db);
      const d = delivery(eventBody({ id: 'WH-C04' }), { id: 'TR-C04' });
      for (let i = 0; i < 2; i++) {
        const res = await rig.post(d);
        expect(res.status).toBe(503);
        expect(await res.text()).toBe('{}');
      }
      expect(await auditCount(rig.app.db, 'webhook.rejected')).toBe(0);
      expect(await auditCount(rig.app.db, 'webhook.unverifiable')).toBe(2);
      expect(certs.trusted).toEqual([]);
      expect(await fingerprint(rig.app.db)).toEqual(before);
      expect(outcomes(rig.lines)).toEqual(['unverifiable', 'unverifiable']);
      // the same delivery, the certificate now reachable: it is accepted once
      reachable = true;
      expect((await rig.post(d)).status).toBe(200);
      expect(await rig.count('SELECT count(*) AS c FROM webhook_events')).toBe(1);
      expect(await readbacks(order_id)).toBe(1);
    });
  });

  describe('C-05 webhook_replay', () => {
    it('C-05 the same event three times: 200 each, one stored event, one read-back enqueued', async () => {
      rig = await bootWebhookApp();
      const { order_id } = await seedCapturingOrder(rig.app);
      const before = await fingerprint(rig.app.db);
      const d = delivery(
        eventBody({ id: 'WH-C05', type: 'PAYMENT.CAPTURE.COMPLETED', capture: CAPTURE }),
        {
          id: 'TR-C05',
        },
      );
      const answers: number[] = [];
      for (let i = 0; i < 3; i++)
        answers.push((await rig.post(d, { ip: `203.0.113.${60 + i}` })).status);
      expect(answers).toEqual([200, 200, 200]);
      expect(await rig.count('SELECT count(*) AS c FROM webhook_events')).toBe(1);
      expect(await readbacks(order_id)).toBe(1);
      expect(outcomes(rig.lines)).toEqual(['enqueued', 'duplicate', 'duplicate']);
      // a webhook is only a hint: no money, no access, no PayPal call
      const after = await fingerprint(rig.app.db);
      for (const t of [
        'orders',
        'order_units',
        'ledger_entries',
        'entitlements',
        'receipts',
        'access_windows',
        'access_events',
        'provider_calls',
      ])
        expect([t, after[t]]).toEqual([t, before[t]]);
      expect(rig.wire).toEqual([]);
    });

    it('C-05 a replay after a full refund leaves the access revoked and the books unchanged', async () => {
      crig = await bootRig();
      const op = await crig.operator('vikram');
      const buyerSession = (await signIn(crig.routes.session.POST, 'buyer-a'))!;
      const bought = await buy(crig, { offer: 'knot-notebook', option: 'online_read' }); // 4.50
      expect(await orderStatus(crig, bought.order_id)).toBe('paid');

      const refund = await postRefund(crig, op, {
        unit_id: bought.unit_id,
        amount_minor: null,
        reason: 'C-05 full refund before the replay',
      });
      expect(refund.status).toBe(200);
      const revoked = async () => {
        const item = (await libraryOf(crig!, buyerSession)).find(
          (i) => i.entitlement_id === bought.entitlement_id,
        )!;
        expect(item.can_open).toBe(false);
        expect(item.access).toBe('revoked');
        expect(
          (await openLink(crig!, buyerSession, bought.entitlement_id)).status,
        ).toBeGreaterThanOrEqual(400);
      };
      await revoked();
      const ledgerBefore = await crig.count('SELECT count(*) AS c FROM ledger_entries');
      const unitBefore = await crig.app.db.query(
        'SELECT status, refunded_minor FROM order_units WHERE id = $1',
        [bought.unit_id],
      );

      // PayPal replays the original capture event three times, then a refund event
      const when = nowTransmissionTime();
      const events = [
        ['PAYMENT.CAPTURE.COMPLETED', 'WH-C05R-1', 'TR-C05R-1'],
        ['PAYMENT.CAPTURE.COMPLETED', 'WH-C05R-1', 'TR-C05R-1'],
        ['PAYMENT.CAPTURE.COMPLETED', 'WH-C05R-1', 'TR-C05R-1'],
        ['PAYMENT.CAPTURE.REFUNDED', 'WH-C05R-2', 'TR-C05R-2'],
      ] as const;
      for (const [type, id, tid] of events) {
        const d = delivery(
          eventBody({
            id,
            type,
            order: bought.provider_order_id,
            capture: `${bought.provider_order_id}CAP1`,
          }),
          { id: tid, time: when },
        );
        expect((await crig.post(d)).status).toBe(200);
      }
      await revoked();
      expect(await crig.count('SELECT count(*) AS c FROM ledger_entries')).toBe(ledgerBefore);
      expect(
        (
          await crig.app.db.query('SELECT status, refunded_minor FROM order_units WHERE id = $1', [
            bought.unit_id,
          ])
        ).rows,
      ).toEqual(unitBefore.rows);

      // the read-back the replay made due runs: access is still revoked afterwards
      expect(
        await crig.count(
          `SELECT count(*) AS c FROM operations WHERE kind = 'readback' AND state = 'unknown'`,
        ),
      ).toBe(1);
      await crig.app.db.query(
        `UPDATE operations SET next_retry_at = '2000-01-01T00:00:00Z' WHERE state = 'unknown'`,
      );
      const jobs = await crig.app.startJobs();
      await vi.waitFor(
        async () =>
          expect(
            await crig!.count(
              `SELECT count(*) AS c FROM operations WHERE kind = 'readback' AND state = 'unknown'`,
            ),
          ).toBe(0),
        { timeout: 25_000, interval: 250 },
      );
      await jobs.stop();
      await revoked();
      expect(await crig.count('SELECT count(*) AS c FROM ledger_entries')).toBe(ledgerBefore);
      expect(await orderStatus(crig, bought.order_id)).toBe('paid');
    }, 60_000);
  });
});
