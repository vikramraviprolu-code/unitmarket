// BU-4: every fixture under fixtures/paypal still maps (A-23), and the two synthetic fixtures that
// list refunds (refunds_listed, labelled synthetic, ASM-53 unverified) map to the expected lists,
// both straight through the mapper and through the real adapter over the dry-run transport.
import { describe, expect, it } from 'vitest';
import { OrderReadSchema } from '@umsbx/contracts';
import { loadFixtures } from '@umsbx/transport';
import { mapOrder } from './map-order';
import { FIXTURE_ROOT, dryRunTransport, harness } from './test-support';

const NOW = new Date('2026-02-03T04:05:06Z');

describe('order fixtures and the refund list', () => {
  it('every get_order fixture maps, parses with its schema and lists as many refunds as its body', async () => {
    const fixtures = await loadFixtures(FIXTURE_ROOT);
    expect(fixtures.length).toBeGreaterThanOrEqual(62);
    let ok = 0;
    for (const fx of fixtures) {
      if (fx.meta.operation !== 'get_order' || 'timeout' in fx.response) continue;
      const label = `${fx.meta.scenario}/get_order/${fx.meta.step}`;
      const { result } = mapOrder(
        { status: fx.response.status, headers: fx.response.headers, body: fx.response.body },
        NOW,
      );
      expect(OrderReadSchema.safeParse(result).success, label).toBe(true);
      if (result.kind !== 'order') continue;
      ok += 1;
      const body = fx.response.body as {
        purchase_units?: { payments?: { refunds?: unknown[] } }[];
      };
      const listed = (body.purchase_units ?? []).map((u) => u.payments?.refunds?.length ?? 0);
      expect(
        result.units.map((u) => (u.refunds ?? []).length),
        label,
      ).toEqual(listed);
      for (const u of result.units) expect(Array.isArray(u.refunds), label).toBe(true);
    }
    expect(ok).toBeGreaterThanOrEqual(20);
  });

  it('the two refunds_listed fixtures are labelled synthetic and are not PayPal evidence', async () => {
    const mine = (await loadFixtures(FIXTURE_ROOT)).filter(
      (f) => f.meta.scenario === 'refunds_listed',
    );
    expect(mine.map((f) => `${f.meta.operation}/${f.meta.step}`).sort()).toEqual([
      'get_order/1',
      'get_order/2',
    ]);
    for (const f of mine) {
      expect(f.meta.source).toBe('synthetic');
      expect(f.meta.origin).toMatch(/not PayPal evidence/);
    }
  });

  it('refunds_listed 1 maps to one completed 3.00 refund of a 5.00 capture', async () => {
    const { adapter } = harness(await dryRunTransport('refunds_listed'));
    const r = await adapter.getOrder('SBXREFLISTORD00001');
    expect(r.kind).toBe('order');
    if (r.kind !== 'order') return;
    expect(r.units).toHaveLength(1);
    expect(r.units[0]?.capture?.amount).toEqual({ currency: 'USD', minor: 500 });
    expect(r.units[0]?.capture?.status).toBe('PARTIALLY_REFUNDED');
    expect(r.units[0]?.refunds).toEqual([
      {
        refund_id: 'SBXREFLISTREF00001',
        status: 'COMPLETED',
        amount: { currency: 'USD', minor: 300 },
      },
    ]);
  });

  it('refunds_listed 2 maps to one pending 2.00 refund', async () => {
    const t = await dryRunTransport('refunds_listed');
    const { adapter } = harness(t);
    await adapter.getOrder('SBXREFLISTORD00001'); // step 1
    const r = await adapter.getOrder('SBXREFLISTORD00001'); // step 2
    expect(r.kind).toBe('order');
    if (r.kind !== 'order') return;
    expect(r.units[0]?.capture?.status).toBe('COMPLETED');
    expect(r.units[0]?.refunds).toEqual([
      {
        refund_id: 'SBXREFLISTREF00002',
        status: 'PENDING',
        amount: { currency: 'USD', minor: 200 },
      },
    ]);
  });

  it('the happy scenario order read lists no refunds', async () => {
    const t = await dryRunTransport('happy');
    const { adapter } = harness(t);
    await adapter.getOrder('SBXHAPPYORD00001');
    const r = await adapter.getOrder('SBXHAPPYORD00001');
    expect(r.kind).toBe('order');
    if (r.kind !== 'order') return;
    expect(r.units[0]?.refunds).toEqual([]);
  });
});
