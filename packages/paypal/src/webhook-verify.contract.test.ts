import { describe, expect, it } from 'vitest';
import {
  ProviderEventSchema,
  ProviderEventTypeSchema,
  WebhookVerdictSchema,
} from '@umsbx/contracts';
import { verifyWebhook } from './webhook-verify';
import { mutableClock } from './test-support';
import {
  NOW_ISO,
  WEBHOOK_ID,
  deliver,
  loadWebhookFixtures,
  okCertificates,
} from './webhook-test-support';

const fixtures = loadWebhookFixtures();
const deps = () => ({
  clock: mutableClock(NOW_ISO),
  webhook_id: WEBHOOK_ID as string | null,
  certificates: okCertificates(),
});

describe('synthetic webhook fixtures, signed at run time with a generated key', () => {
  it('there is one fixture per handled event type plus an unhandled one', () => {
    const types = new Set(fixtures.map((f) => f.expect.type));
    for (const t of ProviderEventTypeSchema.options) expect(types.has(t)).toBe(true);
    expect(fixtures.length).toBeGreaterThanOrEqual(ProviderEventTypeSchema.options.length);
  });

  it('every fixture is labelled synthetic and carries no signature or certificate URL', () => {
    for (const f of fixtures) {
      expect(f.meta.source).toBe('synthetic');
      expect(f.meta.label).toBe('synthetic');
      expect(f.headers['paypal-transmission-sig']).toBe('[redacted]');
      expect(Object.keys(f.headers)).not.toContain('paypal-cert-url');
    }
  });

  for (const f of fixtures) {
    it(`${f.name}: verifies to verified with the expected event`, async () => {
      const d = deps();
      const verdict = await verifyWebhook(d, deliver(f));
      expect(verdict).toEqual({ kind: 'verified', event: f.expect });
      expect(WebhookVerdictSchema.safeParse(verdict).success).toBe(true);
      if (verdict.kind === 'verified') {
        expect(ProviderEventSchema.safeParse(verdict.event).success).toBe(true);
        expect(verdict.event.type).toBe(f.expect.type);
        expect(verdict.event.capture_id).toBe(f.expect.capture_id);
        expect(verdict.event.refund_id).toBe(f.expect.refund_id);
        expect(verdict.event.provider_order_id).toBe(f.expect.provider_order_id);
      }
      expect(d.certificates.calls).toHaveLength(1);
    });
  }

  it('header names are matched without regard to case (as PayPal and proxies may spell them)', async () => {
    const f = fixtures[0]!;
    const d = deliver(f);
    const spelled = Object.fromEntries(
      Object.entries(d.headers).map(([k, v]) => [
        k.replace(/(^|-)([a-z])/g, (_m, a: string, b: string) => a + b.toUpperCase()),
        v,
      ]),
    );
    expect(Object.keys(spelled)).toContain('Paypal-Transmission-Id');
    expect(await verifyWebhook(deps(), { headers: spelled, raw_body: d.raw_body })).toMatchObject({
      kind: 'verified',
    });
  });

  it('the certificate is asked for by the URL in the header, normalised', async () => {
    const f = fixtures[0]!;
    const d = deps();
    const delivery = deliver(f);
    await verifyWebhook(d, delivery);
    expect(d.certificates.calls).toEqual([delivery.headers['paypal-cert-url']]);
  });

  it('unknown fields in the body are ignored; the event holds only the contract fields', async () => {
    const f = fixtures.find((x) => x.name === 'capture-completed')!;
    const body = JSON.stringify(
      { ...(f.body as object), extra: { nested: [1, 2, 3] }, links: [] },
      null,
      2,
    );
    const verdict = await verifyWebhook(deps(), deliver(f, { raw_body: body }));
    expect(verdict).toEqual({ kind: 'verified', event: f.expect });
  });

  it('a body PayPal sends compact or with a trailing newline verifies the same way', async () => {
    const f = fixtures.find((x) => x.name === 'order-approved')!;
    for (const raw of [JSON.stringify(f.body), JSON.stringify(f.body, null, 2) + '\n']) {
      expect(await verifyWebhook(deps(), deliver(f, { raw_body: raw }))).toMatchObject({
        kind: 'verified',
      });
    }
  });
});
