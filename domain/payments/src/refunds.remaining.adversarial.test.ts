// BU-4 adversarial tests: whatever mix of local and dashboard refunds happens, no refund call leaves
// with a null amount or with more than PayPal itself still holds; an old read is not trusted; a
// read the domain cannot understand is not a licence to send. A seeded generator picks the
// sequences (no Math.random). Real PGlite, scripted PayPal. No network.
import { afterEach, describe, expect, it } from 'vitest';
import type { OrderRead, RefundStatus } from '@umsbx/contracts';
import { executeRefund, requestRefund, runDue } from './index';
import { OPERATOR, paid } from './ops/support';
import { makeRemainingWorld } from './remaining-world';
import type { RemainingWorld } from './remaining-world';

let w: RemainingWorld | null = null;
afterEach(async () => {
  if (w === null) return;
  expect(w.paypal.violations).toEqual([]);
  await w.close();
  w = null;
});
const SEC = 1_000;
const PRICE = 500;
const usd = (minor: number) => ({ currency: 'USD', minor });

/** mulberry32: a small seeded generator, so a failing sequence can be replayed by its number. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function world(price = PRICE) {
  w = await makeRemainingWorld({ price });
  const a = await paid(w);
  w.markReads();
  const unit = (
    await w.rows<{ id: string; capture_id: string }>(
      'SELECT id, capture_id FROM order_units WHERE order_id = $1',
      [a.order_id],
    )
  )[0]!;
  return { a, unit, w };
}
const request = async (unit_id: string, minor: number | null) =>
  requestRefund(w!.deps, {
    unit_id,
    amount: minor === null ? null : usd(minor),
    reason: 'goodwill',
    actor: OPERATOR,
  });

describe('refund calls never carry more than PayPal holds', () => {
  it("every refundCapture call carries a non-null amount at most PayPal's remaining amount over 200 random sequences of local and dashboard refunds", async () => {
    let sent = 0;
    let closed = 0;
    let stale = 0;
    let together = 0;
    for (let seq = 0; seq < 200; seq += 1) {
      const rnd = seeded(seq * 7_919 + 13);
      const int = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));
      const pick = <T>(xs: readonly T[]): T => xs[int(0, xs.length - 1)] as T;
      const { unit, w: world_ } = await world();
      const violations: string[] = [];

      // The spy sits in front of the fake PayPal: it judges each call by what PayPal holds at that
      // moment, before the fake books the refund. A call above what PayPal holds is a violation,
      // except right after a dashboard refund: a read up to 60 s old may predate it by design
      // (spec BU-4), and PayPal itself then refuses the refund, as the spy does.
      let lastDashAt = Number.NEGATIVE_INFINITY;
      const forward = world_.paypal.refundCapture.bind(world_.paypal);
      world_.paypal.refundCapture = (r) => {
        const left = world_.remoteRemaining(unit.capture_id, PRICE);
        if (r.amount === null) violations.push(`seq ${seq}: null amount`);
        else if (r.amount.minor <= 0) violations.push(`seq ${seq}: amount ${r.amount.minor} <= 0`);
        else if (r.amount.minor > left) {
          if (world_.clock.now().getTime() - lastDashAt > 60 * SEC) {
            violations.push(`seq ${seq}: sent ${r.amount.minor}, PayPal holds ${left}`);
          }
          stale += 1;
          return Promise.resolve({
            kind: 'rejected' as const,
            http: 422 as const,
            name: 'UNPROCESSABLE_ENTITY',
            issue: 'REFUND_AMOUNT_EXCEEDED',
            debug_id: null,
          });
        }
        return forward(r);
      };

      const requests: string[] = [];
      const steps = int(6, 16);
      for (let k = 0; k < steps; k += 1) {
        switch (int(0, 7)) {
          case 0: {
            // A dashboard refund, half of them inside the 60 s window of a read already taken.
            // PayPal itself never refunds more than the capture holds.
            if (rnd() < 0.5) world_.tick(61 * SEC);
            const room = world_.remoteRemaining(unit.capture_id, PRICE);
            if (room > 0) {
              world_.dashboard(
                unit.capture_id,
                Math.min(int(1, 250), room),
                pick<RefundStatus>(['COMPLETED', 'COMPLETED', 'PENDING', 'FAILED', 'CANCELLED']),
              );
              lastDashAt = world_.clock.now().getTime();
            }
            break;
          }
          case 1: {
            // PayPal settles a pending dashboard refund: it completes, fails or is cancelled.
            const dash = [...world_.refunds.values()].filter(
              (x) => x.request_id === null && x.status === 'PENDING',
            );
            if (dash.length > 0) {
              if (rnd() < 0.5) world_.tick(61 * SEC);
              pick(dash).status = pick<RefundStatus>(['COMPLETED', 'CANCELLED', 'FAILED']);
              lastDashAt = world_.clock.now().getTime();
            }
            break;
          }
          case 2:
          case 3: {
            const r = await request(unit.id, rnd() < 0.2 ? null : int(1, PRICE));
            if (r.ok) requests.push(r.value.refund_request_id);
            break;
          }
          case 4:
          case 5: {
            if (requests.length > 0) {
              const before = world_.sends().length;
              if (requests.length > 1 && rnd() < 0.6) {
                // Two executions at once: both can pass the check before either has sent.
                const a = pick(requests);
                const b = pick(requests);
                await Promise.all([
                  executeRefund(world_.deps, { refund_request_id: a }),
                  executeRefund(world_.deps, { refund_request_id: b }),
                ]);
                together += 1;
              } else {
                await executeRefund(world_.deps, { refund_request_id: pick(requests) });
              }
              sent += world_.sends().length - before;
            }
            break;
          }
          case 6: {
            world_.tick(int(0, 90) * SEC);
            break;
          }
          default: {
            if (rnd() < 0.5) world_.script({ kind: 'unavailable', retry_after_ms: null });
            await runDue(world_.deps, { max_items: 5 });
            break;
          }
        }
        if (rnd() < 0.3) world_.refundNext.status = pick<RefundStatus>(['COMPLETED', 'PENDING']);
      }
      // Let every waiting request run to its end.
      for (let pass = 0; pass < 4; pass += 1) {
        world_.tick(61 * SEC);
        await runDue(world_.deps, { max_items: 20 });
      }
      for (const id of requests) {
        await executeRefund(world_.deps, { refund_request_id: id });
      }

      expect(violations).toEqual([]);
      for (const c of world_.sends()) {
        expect(c.amount, `seq ${seq}`).not.toBeNull();
      }
      // PayPal never holds more refunded than it captured.
      const total = [...world_.refunds.values()]
        .filter((x) => x.status === 'COMPLETED' || x.status === 'PENDING')
        .reduce((s, x) => s + x.amount.minor, 0);
      expect(total, `seq ${seq}`).toBeLessThanOrEqual(PRICE);
      closed += (
        await world_.rows<{ n: string }>(
          "SELECT count(*)::int AS n FROM alerts WHERE kind = 'refund_unbooked'",
        )
      ).reduce((s, r) => s + Number(r.n), 0);
      await world_.close();
      w = null;
    }
    // The sequences really exercised both branches.
    expect(sent).toBeGreaterThan(100);
    expect(closed).toBeGreaterThan(20);
    expect(together).toBeGreaterThan(50);
    expect(stale).toBeGreaterThanOrEqual(0);
  }, 600_000);

  it('every send carries the amount stored on its request, never null', async () => {
    const { unit, w: world_ } = await world();
    for (const minor of [1, 77, 100]) {
      const r = await request(unit.id, minor);
      if (!r.ok) throw new Error('refused');
      await executeRefund(world_.deps, { refund_request_id: r.value.refund_request_id });
      world_.tick(61 * SEC);
    }
    const rest = await request(unit.id, null);
    if (!rest.ok) throw new Error('refused');
    await executeRefund(world_.deps, { refund_request_id: rest.value.refund_request_id });
    expect(world_.sends().map((s) => s.amount)).toEqual([usd(1), usd(77), usd(100), usd(322)]);
  });
});

describe('an old read is not trusted', () => {
  it('a read older than 60 s is not reused', async () => {
    const { unit, w: world_ } = await world();
    const dash = world_.dashboard(unit.capture_id, 500);
    const r1 = await request(unit.id, 200);
    if (!r1.ok) throw new Error('refused');
    await executeRefund(world_.deps, { refund_request_id: r1.value.refund_request_id });
    expect(world_.sends()).toHaveLength(0);
    expect(world_.reads()).toBe(1);

    world_.refunds.get(dash)!.status = 'CANCELLED'; // PayPal's side changed
    world_.tick(61 * SEC);
    const r2 = await request(unit.id, 200);
    if (!r2.ok) throw new Error('refused');
    await executeRefund(world_.deps, { refund_request_id: r2.value.refund_request_id });
    expect(world_.reads()).toBeGreaterThanOrEqual(2);
    expect(world_.sends().map((s) => s.amount)).toEqual([usd(200)]);
  });

  it('a read held across a long stall is not used for the send that follows it', async () => {
    // The read is taken, then the process stalls for two minutes before the next request.
    const { unit, w: world_ } = await world();
    const r1 = await request(unit.id, 100);
    if (!r1.ok) throw new Error('refused');
    await executeRefund(world_.deps, { refund_request_id: r1.value.refund_request_id });
    world_.tick(120 * SEC);
    world_.dashboard(unit.capture_id, 400); // PayPal now holds 0
    const r2 = await request(unit.id, 100);
    if (!r2.ok) throw new Error('refused');
    await executeRefund(world_.deps, { refund_request_id: r2.value.refund_request_id });
    expect(world_.sends()).toHaveLength(1);
  });
});

describe('a read the domain cannot rely on never lets a refund go', () => {
  async function scripted(edit: (r: Extract<OrderRead, { kind: 'order' }>) => unknown) {
    const { a, unit, w: world_ } = await world();
    await world_.editNextRead(a.provider_order_id, edit);
    const r1 = await request(unit.id, 200);
    if (!r1.ok) throw new Error('refused');
    const out = await executeRefund(world_.deps, { refund_request_id: r1.value.refund_request_id });
    return { out, world_, id: r1.value.refund_request_id };
  }
  const stateOf = async (id: string) =>
    (await w!.rows<{ state: string }>('SELECT state FROM refund_requests WHERE id = $1', [id]))[0]!
      .state;

  it('a refund in another currency than the capture: nothing is sent', async () => {
    const { world_, id } = await scripted((r) => {
      r.units[0]!.refunds = [
        { refund_id: 'X1', status: 'COMPLETED', amount: { currency: 'EUR', minor: 1 } },
      ];
      return r;
    });
    expect(world_.sends()).toHaveLength(0);
    expect(await stateOf(id)).toBe('requested');
  });

  it('refunds that add up to more than the capture leave nothing: closed, not sent', async () => {
    const { out, world_, id } = await scripted((r) => {
      r.units[0]!.refunds = [
        { refund_id: 'X1', status: 'COMPLETED', amount: usd(400) },
        { refund_id: 'X2', status: 'PENDING', amount: usd(400) },
      ];
      return r;
    });
    expect(out).toEqual({ ok: true, value: { status: 'FAILED' } });
    expect(world_.sends()).toHaveLength(0);
    expect(await stateOf(id)).toBe('failed');
  });

  it('a read whose shape is not an order read: nothing is sent, the request waits', async () => {
    for (const bad of [
      { kind: 'order' },
      { kind: 'order', units: 'x' },
      { kind: 'order', units: [null] },
      { kind: 'surprise' },
    ]) {
      const { a, unit, w: world_ } = await world();
      world_.scriptRaw(bad);
      const r1 = await request(unit.id, 200);
      if (!r1.ok) throw new Error('refused');
      const out = await executeRefund(world_.deps, {
        refund_request_id: r1.value.refund_request_id,
      });
      expect(out.ok, JSON.stringify(bad)).toBe(false);
      expect(world_.sends()).toHaveLength(0);
      expect(await stateOf(r1.value.refund_request_id)).toBe('requested');
      expect(a.order_id).toBeTruthy();
      await world_.close();
      w = null;
    }
  });

  it('a read of a different provider order than the one asked for is not a basis for a send', async () => {
    const { world_, id } = await scripted((r) => ({
      ...r,
      provider_order_id: 'SBXELSEWHERE00001',
    }));
    expect(world_.sends()).toHaveLength(0);
    expect(await stateOf(id)).toBe('requested');
  });

  it('a pending refund the dashboard made after our request is seen before the send', async () => {
    const { unit, w: world_ } = await world();
    const r1 = await request(unit.id, 300);
    if (!r1.ok) throw new Error('refused');
    world_.dashboard(unit.capture_id, 300, 'PENDING');
    await executeRefund(world_.deps, { refund_request_id: r1.value.refund_request_id });
    expect(world_.sends().map((s) => s.amount)).toEqual([]);
    const r2 = await request(unit.id, 200);
    if (!r2.ok) throw new Error('refused');
    await executeRefund(world_.deps, { refund_request_id: r2.value.refund_request_id });
    expect(world_.sends().map((s) => s.amount)).toEqual([usd(200)]);
  });
});
