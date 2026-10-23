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

  it('extra headers that real deliveries carry (host, content-type, user-agent, even repeated ones) are ignored', async () => {
    const f = fixtures[0]!;
    const d = deliver(f);
    const headers = {
      ...d.headers,
      host: 'shop.example.invalid',
      'Content-Type': 'application/json',
      'user-agent': 'PayPal/AUHD-214.0-60000000',
      'X-Forwarded-For': '203.0.113.9',
      'x-twice': 'a',
      'X-Twice': 'b',
      'paypal-auth-version': 'v2',
      'paypal-transmission-sig-extra': 'ignored',
    };
    expect(await verifyWebhook(deps(), { headers, raw_body: d.raw_body })).toMatchObject({
      kind: 'verified',
    });
  });
});

describe('mapping a signed body to the event', () => {
  const base = fixtures.find((x) => x.name === 'capture-completed')!;
  const refunded = fixtures.find((x) => x.name === 'capture-refunded')!;
  const send = async (f: typeof base, body: unknown) => {
    const verdict = await verifyWebhook(
      deps(),
      deliver(f, { raw_body: JSON.stringify(body, null, 2) }),
    );
    return verdict.kind === 'verified' ? verdict.event : verdict;
  };
  const resourceOf = (f: typeof base) => (f.body as { resource: Record<string, unknown> }).resource;
  const withResource = (f: typeof base, patch: Record<string, unknown>) => ({
    ...(f.body as object),
    resource: { ...resourceOf(f), ...patch },
  });
  const up = (href: unknown, rel: unknown = 'up') => ({ href, rel, method: 'GET' });
  const CAP = 'SBXCAP0000000001';

  it('a refund names its capture through the up link, whatever host the link has', async () => {
    const e = await send(
      refunded,
      withResource(refunded, {
        links: [up(`https://elsewhere.example.invalid/v2/payments/captures/${CAP}`)],
      }),
    );
    expect(e).toMatchObject({ capture_id: CAP, refund_id: 'SBXREF0000000001' });
  });

  it('the first up link that names a capture wins; unusable links are skipped', async () => {
    const e = await send(
      refunded,
      withResource(refunded, {
        links: [
          null,
          'text',
          up(undefined),
          up(42),
          up('not a url'),
          up('https://x.example.invalid/v2/payments/refunds/SBXREF0000000001'),
          { href: `https://x.example.invalid/v2/payments/captures/SBXCAP0000000009`, rel: 'self' },
          up(`https://x.example.invalid/v2/payments/captures/${CAP}`),
          up(`https://x.example.invalid/v2/payments/captures/SBXCAP0000000002`),
        ],
      }),
    );
    expect(e).toMatchObject({ capture_id: CAP });
  });

  it('no usable up link: the refund is still verified, with capture_id null (CO-2 falls back to the refund id)', async () => {
    for (const links of [
      undefined,
      'links',
      {},
      [],
      [up(`https://x.example.invalid/v2/payments/captures/${CAP}/refund`)],
      [up(`https://x.example.invalid/v2/payments/captures/`)],
      [up(`https://x.example.invalid/v2/payments/captures/${'A'.repeat(37)}`)],
      [up(`https://x.example.invalid/v2/payments/captures/${CAP}`, 'self')],
    ]) {
      const e = await send(refunded, withResource(refunded, { links }));
      expect(e).toMatchObject({ capture_id: null, refund_id: 'SBXREF0000000001' });
    }
  });

  it('capture events: no related order id gives null; odd shapes give null, not an error', async () => {
    for (const supplementary_data of [
      undefined,
      null,
      'x',
      [],
      {},
      { related_ids: null },
      { related_ids: {} },
      { related_ids: { order_id: 5 } },
    ]) {
      const e = await send(base, withResource(base, { supplementary_data }));
      expect(e).toMatchObject({
        type: 'PAYMENT.CAPTURE.COMPLETED',
        provider_order_id: null,
        capture_id: CAP,
      });
    }
  });

  it('a resource id that is not a string gives a null id', async () => {
    const e = await send(base, withResource(base, { id: 12345 }));
    expect(e).toMatchObject({ capture_id: null });
  });

  it('an event type the contract does not list is OTHER with no ids, even on a capture-shaped resource', async () => {
    const body = { ...(base.body as object), event_type: 'PAYMENT.CAPTURE.SOMETHING.NEW' };
    expect(await send(base, body)).toMatchObject({
      type: 'OTHER',
      capture_id: null,
      refund_id: null,
      provider_order_id: null,
    });
    expect(await send(base, { ...body, event_type: 'OTHER' })).toMatchObject({
      type: 'OTHER',
      capture_id: null,
    });
    expect(await send(base, { ...body, event_type: 42 })).toEqual({ kind: 'malformed' });
  });

  it('order events take the order id from the resource, not from a related id', async () => {
    const order = fixtures.find((x) => x.name === 'order-approved')!;
    const e = await send(
      order,
      withResource(order, { supplementary_data: { related_ids: { order_id: 'SBXOTHER' } } }),
    );
    expect(e).toMatchObject({
      provider_order_id: 'SBXORD0000000001',
      capture_id: null,
      refund_id: null,
    });
  });

  it('occurred_at is the body create_time as UTC with milliseconds, whatever the spelling', async () => {
    for (const [create_time, want] of [
      ['2026-10-23T11:59:58Z', '2026-10-23T11:59:58.000Z'],
      ['2026-10-23T13:59:58+02:00', '2026-10-23T11:59:58.000Z'],
      ['2026-10-23T11:59:58.250Z', '2026-10-23T11:59:58.250Z'],
    ] as const) {
      const e = await send(base, { ...(base.body as object), create_time });
      expect(e).toMatchObject({ occurred_at: want });
    }
  });

  it('transmission_id on the event is the header value, not anything in the body', async () => {
    const e = await send(base, { ...(base.body as object), transmission_id: 'FROM-BODY' });
    expect(e).toMatchObject({ transmission_id: base.headers['paypal-transmission-id'] });
  });
});
