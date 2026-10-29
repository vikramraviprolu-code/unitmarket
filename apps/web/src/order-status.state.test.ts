// DP-5b (M1) over a REAL held pack: one PayPal order captured, the other held after its capture, both
// reached through the engine on the dry-run model (no direct UPDATE of a state). The order is
// `paid_partial` with a hold. A hold must not wear the success banner, and the page must keep
// looking until the case line appears. Dry-run model only; no PayPal.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Actor } from '@umsbx/contracts';
import type { App } from '../composition.server';
import {
  CAPTURED_THEN_HELD,
  HARBOUR_FEES,
  QUAY_WALK,
  bootPackApp,
  buyer,
  runPackByPublisher,
} from './composite-support';
import { keepPolling, orderTone } from './lib/order-status';

vi.mock('server-only', () => ({}));

const HARBOUR = 'Harbour Ledger Review (fictional)';
const QUAYSIDE = 'Quayside Gazette (fictional)';

let app: App;
let B: Actor;
beforeAll(async () => {
  app = await bootPackApp();
  B = await buyer(app, 'b');
});
afterAll(async () => {
  await app.close();
});

describe('a real pack: one payment captured, the other held after its capture', () => {
  it('is paid_partial with one ready and one hold, the warning tone, and polls until the case shows', async () => {
    const run = await runPackByPublisher(app, B, [HARBOUR_FEES, QUAY_WALK], {
      [HARBOUR]: 'happy',
      [QUAYSIDE]: CAPTURED_THEN_HELD,
    });
    const states = (
      await app.db.query<{ state: string }>(
        'SELECT state FROM provider_orders WHERE order_id = $1 ORDER BY position',
        [run.order_id],
      )
    ).rows.map((r) => r.state);
    expect([...states].sort()).toEqual(['captured', 'frozen']);

    const v = (await app.engine.orderView({ order_ref: run.order_ref, actor: B }))!;
    expect(v.status).toBe('paid_partial');
    expect(v.items.map((i) => i.kind).sort()).toEqual(['hold', 'ready']);
    expect(v.buyer_message).toMatch(/on hold/);
    expect(v.buyer_message).not.toMatch(/not charged/i);
    expect(orderTone(v)).toBe('warn');

    // The recovery rules run in the job loop; until the case shows, the page keeps looking.
    expect(v.open_case).toBeNull();
    expect(keepPolling(v)).toBe(true);
    const jobs = await app.startJobs();
    try {
      let seen = v;
      for (let i = 0; i < 100 && seen.open_case === null; i += 1) {
        await new Promise((r) => setTimeout(r, 100));
        seen = (await app.engine.orderView({ order_ref: run.order_ref, actor: B }))!;
      }
      expect(seen.open_case, 'the case line appears').not.toBeNull();
      expect(seen.status).toBe('paid_partial');
      expect(orderTone(seen)).toBe('warn');
      expect(keepPolling(seen)).toBe(false);
    } finally {
      await jobs.stop();
    }
  });
});
