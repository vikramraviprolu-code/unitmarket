// BU-5b: an operation that is still unknown after its step, past the end of its reconcile window,
// must not be picked again on every pass. nextPollAt capped the next poll at the window end, which
// is in the past once the window is over, so a blocked attempt (budget, kill switch, no approval,
// no connect) left the operation due "now", forever: processed=1 on every pass and a loop that
// wakes every 100 ms. Past the window the next poll is one last backoff step away instead.
// Real PGlite, scripted PayPal, fake clock. Synthetic rows only, no network.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PaymentsDeps } from '@umsbx/contracts';
import { beginCheckout, executeRefund, nextDueAt, requestRefund, runDue } from './index';
import { BUYER_A, OPERATOR, opOf, paid, place } from './ops/support';
import { makeRemainingWorld } from './remaining-world';
import type { RemainingWorld } from './remaining-world';

vi.setConfig({ testTimeout: 120_000 });

let w: RemainingWorld;
afterEach(async () => {
  expect(w.paypal.violations).toEqual([]);
  await w.close();
});
const H = 3_600_000;
const REASONS = ['budget', 'kill_switch', 'connect_off', 'no_approval'] as const;
/** The same deps with a provider that answers `blocked` to every call (the gate said no). */
function blocking(deps: PaymentsDeps, by: (typeof REASONS)[number]): PaymentsDeps {
  const paypal = new Proxy(deps.paypal, {
    get(target, key, receiver) {
      const value: unknown = Reflect.get(target, key, receiver);
      if (typeof value !== 'function') return value;
      return () => Promise.resolve({ kind: 'blocked', by });
    },
  });
  return { ...deps, paypal };
}

describe('create past its reconcile window, resend blocked', () => {
  for (const reason of REASONS) {
    it(`${reason}: the first pass tries once, the next ones 1 s apart do not, and the op is due again after the last backoff step`, async () => {
      w = await makeRemainingWorld({ price: 500 });
      // a 1 h reconcile window inside the 5 h key window: the resend is still allowed after it
      const deps = { ...w.deps, config: { ...w.deps.config, reconcile_window_ms: H } };
      const p = await place({ ...w, deps } as RemainingWorld, { buyer_id: 'buy_A' });
      w.faults.loseCreateResponse = true;
      await beginCheckout(deps, { order_id: p.order_id, actor: BUYER_A });
      w.faults.loseCreateResponse = false;
      expect((await opOf(w, p.order_id, 'create')).state).toBe('unknown');
      w.tick(2 * H); // past the 1 h window, inside the 5 h key window
      const processed: number[] = [];
      for (let i = 0; i < 5; i += 1) {
        processed.push((await runDue(blocking(deps, reason), { max_items: 5 })).processed);
        w.tick(1000);
      }
      expect(processed).toEqual([1, 0, 0, 0, 0]);
      const next = (
        await w.rows<{ next_retry_at: Date }>(
          "SELECT next_retry_at FROM operations WHERE order_id = $1 AND kind = 'create'",
          [p.order_id],
        )
      )[0]!.next_retry_at.getTime();
      expect(next).toBeGreaterThan(w.clock.now().getTime()); // in the future, not the window end
      expect(next - w.clock.now().getTime()).toBeGreaterThan(30 * 60_000); // about the last step (1 h)
      expect(Date.parse((await nextDueAt(w.db, deps.config)) ?? '')).toBeGreaterThan(
        w.clock.now().getTime(),
      );
    });
  }

  it('after the backoff step the operation is picked again, and a free provider then settles it', async () => {
    w = await makeRemainingWorld({ price: 500 });
    const deps = { ...w.deps, config: { ...w.deps.config, reconcile_window_ms: H } };
    const p = await place({ ...w, deps } as RemainingWorld, { buyer_id: 'buy_A' });
    w.faults.loseCreateResponse = true;
    await beginCheckout(deps, { order_id: p.order_id, actor: BUYER_A });
    w.faults.loseCreateResponse = false;
    w.tick(2 * H);
    const stopped = blocking(deps, 'budget');
    expect((await runDue(stopped, { max_items: 5 })).processed).toBe(1);
    w.tick(H - 1000); // not yet
    expect((await runDue(stopped, { max_items: 5 })).processed).toBe(0);
    w.tick(2000); // the last backoff step (1 h) is over
    expect((await runDue(deps, { max_items: 5 })).processed).toBe(1);
    expect((await opOf(w, p.order_id, 'create')).state).toBe('confirmed');
  });
});

describe('R8: a refund whose answer was lost, 25 h later, reads blocked', () => {
  for (const reason of REASONS) {
    it(`${reason}: 5 passes 1 s apart do not re-pick it (processed drops to 0 after the first)`, async () => {
      w = await makeRemainingWorld({ price: 500 });
      const a = await paid(w);
      const unit = (
        await w.rows<{ id: string }>('SELECT id FROM order_units WHERE order_id = $1', [a.order_id])
      )[0]!;
      w.refundNext.lose_response = true;
      const r = await requestRefund(w.deps, {
        unit_id: unit.id,
        amount: { currency: 'USD', minor: 200 },
        reason: 'goodwill',
        actor: OPERATOR,
      });
      if (!r.ok) throw new Error('refused');
      await executeRefund(w.deps, { refund_request_id: r.value.refund_request_id });
      w.tick(25 * H);
      const sends = w.sends().length;
      const processed: number[] = [];
      for (let i = 0; i < 5; i += 1) {
        processed.push((await runDue(blocking(w.deps, reason), { max_items: 5 })).processed);
        w.tick(1000);
      }
      expect(processed.slice(1)).toEqual([0, 0, 0, 0]);
      expect(w.sends()).toHaveLength(sends); // never sent again
      // every operation still open is due in the future, never "now"
      const open = await w.rows<{ next_retry_at: Date | null }>(
        "SELECT next_retry_at FROM operations WHERE order_id = $1 AND kind IN ('refund', 'refund_readback') AND state = 'unknown'",
        [a.order_id],
      );
      for (const o of open) {
        expect(o.next_retry_at!.getTime()).toBeGreaterThan(w.clock.now().getTime());
      }
    });
  }
});
