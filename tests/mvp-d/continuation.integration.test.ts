// MVP-D offline acceptance, continuation and pack window (overview section 3; ASM-75; P4, P17).
// A pack whose first capture was sent always finishes: a kill switch or a crash between the two
// captures ends with exactly one capture of the second PayPal order, and the order never goes back to
// awaiting_buyer. A pack that was never fully approved within the window is abandoned and nothing is
// charged. Real routes and engine over the approved sandbox transport and a fake Wire playing the
// dry-run model; the job loop is the app's own (startJobs). No byte leaves the process.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkInvariants } from '@umsbx/payments';
import {
  HARBOUR_TIDE,
  QUAY_MARKET,
  approveStep,
  bootDRig,
  libraryOf,
  newModel,
  orderStatus,
  poStates,
  startPack,
  waitFor,
} from './d-support';
import type { DRig, Placed } from './d-support';

vi.mock('server-only', () => ({}));

const rigs: DRig[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const r of rigs.splice(0)) await r.close().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const keep = (r: DRig): DRig => {
  rigs.push(r);
  return r;
};

/** The captures PayPal took, by PayPal order: one each, never two. */
const captureCounts = (rig: DRig): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const p of rig.played)
    if (p.operation === 'capture_order') out[p.po!] = (out[p.po!] ?? 0) + 1;
  return out;
};

async function finishedClean(rig: DRig, placed: Placed): Promise<void> {
  expect(await orderStatus(rig, placed.order_id)).toBe('paid');
  expect(await poStates(rig, placed.order_id)).toEqual(['captured', 'captured']);
  expect(captureCounts(rig)).toEqual({ [placed.pos[0]!]: 1, [placed.pos[1]!]: 1 });
  expect(await rig.count(`SELECT count(*) AS c FROM ledger_entries WHERE kind = 'sale'`)).toBe(2);
  expect(
    await rig.count(`SELECT count(*) AS c FROM order_units WHERE status = 'captured_verified'`),
  ).toBe(2);
  expect((await libraryOf(rig, 'A')).filter((l) => l.can_open).length).toBe(2);
  expect((await checkInvariants(rig.app.db)).filter((i) => !i.ok)).toEqual([]);
}

describe('continuation after the first capture', () => {
  it('D-continuation the kill switch is pulled while the first capture is in flight: the pack finishes with exactly one capture of each PayPal order', async () => {
    let caps = 0;
    let ref: DRig | null = null;
    const rig = keep(
      await bootDRig({
        domain: { operation_lease_ms: 1000 },
        wire: {
          after: async (p) => {
            if (p.operation === 'capture_order' && ++caps === 1) await ref!.switchOutbound(false);
          },
        },
      }),
    );
    ref = rig;
    const placed = await startPack(rig, 'A', [HARBOUR_TIDE, QUAY_MARKET]);
    await approveStep(rig, 'A', placed, 1, 'happy');
    const r = await approveStep(rig, 'A', placed, 2, 'happy');
    // The switch was off for the rest of the pass: the answer of capture 1 was not taken, PO2 never sent.
    expect(r.ok && r.value.status).toBe('unresolved');
    expect(await poStates(rig, placed.order_id)).toEqual(['unresolved', 'approved']);
    expect(rig.calls('capture_order')).toBe(1);
    expect(await rig.count('SELECT count(*) AS c FROM ledger_entries')).toBe(0);

    await rig.switchOutbound(true);
    const jobs = await rig.app.startJobs();
    await waitFor(async () => (await orderStatus(rig, placed.order_id)) === 'paid', 'paid', 40_000);
    await jobs.stop();
    await finishedClean(rig, placed);
  }, 90_000);

  it('D-continuation the kill switch is pulled between the two captures: the order stays capture_requested (never awaiting_buyer) and the pack finishes with one PO2 capture', async () => {
    let caps = 0;
    let killed = false;
    let ref: DRig | null = null;
    const seen: string[] = [];
    const rig = keep(
      await bootDRig({
        wire: {
          after: async (p) => {
            if (p.operation === 'capture_order') caps += 1;
            else if (caps === 1 && p.operation === 'get_order' && !killed) {
              killed = true;
              await ref!.switchOutbound(false);
            }
          },
        },
      }),
    );
    ref = rig;
    const placed = await startPack(rig, 'A', [HARBOUR_TIDE, QUAY_MARKET]);
    await approveStep(rig, 'A', placed, 1, 'happy');
    const r = await approveStep(rig, 'A', placed, 2, 'happy');
    expect(r.ok && r.value.status).toBe('capture_requested');
    expect(await poStates(rig, placed.order_id)).toEqual(['captured', 'approved']);
    expect(rig.calls('capture_order')).toBe(1);
    seen.push((await orderStatus(rig, placed.order_id)) ?? '');
    // The captured item is already the buyer's; the other waits.
    expect(
      await rig.count(`SELECT count(*) AS c FROM entitlements WHERE access_state = 'available'`),
    ).toBe(1);

    await rig.switchOutbound(true);
    const jobs = await rig.app.startJobs();
    const poll = async () => {
      seen.push((await orderStatus(rig, placed.order_id)) ?? '');
      return seen.at(-1) === 'paid';
    };
    await waitFor(poll, 'paid', 40_000);
    await jobs.stop();
    expect(seen).not.toContain('awaiting_buyer');
    await finishedClean(rig, placed);
  }, 90_000);

  it('D-continuation the process is killed between the captures and restarted on the same disk: the second app finishes the pack with one PO2 capture', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dp6-disk-'));
    dirs.push(dir);
    const disk = join(dir, 'db');
    const model = newModel(); // PayPal's side of the story outlives our process
    let caps = 0;
    let killed = false;
    let ref: DRig | null = null;
    const first = await bootDRig({
      disk,
      model,
      wire: {
        after: async (p) => {
          if (p.operation === 'capture_order') caps += 1;
          else if (caps === 1 && p.operation === 'get_order' && !killed) {
            killed = true;
            await ref!.switchOutbound(false);
          }
        },
      },
    });
    ref = first;
    const placed = await startPack(first, 'A', [HARBOUR_TIDE, QUAY_MARKET]);
    await approveStep(first, 'A', placed, 1, 'happy');
    await approveStep(first, 'A', placed, 2, 'happy');
    expect(await poStates(first, placed.order_id)).toEqual(['captured', 'approved']);
    const firstOps = first.played.map((p) => `${p.operation}:${p.po}`);
    await first.close(); // the old process is gone

    const second = keep(await bootDRig({ disk, model }));
    await second.switchOutbound(true); // `safety:resume`, which is the owner's terminal in the real run
    const jobs = await second.app.startJobs();
    await waitFor(
      async () => (await orderStatus(second, placed.order_id)) === 'paid',
      'paid',
      40_000,
    );
    await jobs.stop();
    // One capture of each PayPal order across both processes.
    const all = [...firstOps, ...second.played.map((p) => `${p.operation}:${p.po}`)].filter((x) =>
      x.startsWith('capture_order:'),
    );
    expect(all.sort()).toEqual(
      [`capture_order:${placed.pos[0]}`, `capture_order:${placed.pos[1]}`].sort(),
    );
    expect(await poStates(second, placed.order_id)).toEqual(['captured', 'captured']);
    expect(await second.count(`SELECT count(*) AS c FROM ledger_entries WHERE kind = 'sale'`)).toBe(
      2,
    );
    expect((await checkInvariants(second.app.db)).filter((i) => !i.ok)).toEqual([]);
  }, 90_000);

  it('D-continuation once paid, more returns and job passes capture nothing again', async () => {
    const rig = keep(await bootDRig());
    const placed = await startPack(rig, 'A', [HARBOUR_TIDE, QUAY_MARKET]);
    await approveStep(rig, 'A', placed, 1, 'happy');
    await approveStep(rig, 'A', placed, 2, 'happy');
    await finishedClean(rig, placed);
    for (let i = 0; i < 3; i++)
      await rig.app.engine.payments.onBuyerReturn({
        order_ref: placed.order_ref,
        actor: rig.A,
        scenario: null,
      });
    const jobs = await rig.app.startJobs();
    await new Promise((r) => setTimeout(r, 1500));
    await jobs.stop();
    await finishedClean(rig, placed);
  }, 90_000);
});

describe('the pack window', () => {
  it('D-pack-window one approval and no second one within the window: the whole pack is abandoned, nothing is charged, no capture is sent', async () => {
    const rig = keep(await bootDRig({ domain: { pack_approval_window_ms: 1500 } }));
    const placed = await startPack(rig, 'A', [HARBOUR_TIDE, QUAY_MARKET]);
    const r = await approveStep(rig, 'A', placed, 1, 'happy');
    expect(r.ok && r.value.status).toBe('awaiting_buyer');
    await new Promise((res) => setTimeout(res, 1800)); // the window runs out; the buyer never comes back
    const jobs = await rig.app.startJobs();
    await waitFor(
      async () => (await orderStatus(rig, placed.order_id)) === 'abandoned',
      'abandoned',
      40_000,
    );
    await jobs.stop();

    expect(await poStates(rig, placed.order_id)).toEqual(['abandoned', 'abandoned']);
    expect(rig.calls('capture_order')).toBe(0);
    expect(
      await rig.count('SELECT count(*) AS c FROM order_units WHERE capture_id IS NOT NULL'),
    ).toBe(0);
    expect(await rig.count('SELECT count(*) AS c FROM ledger_entries')).toBe(0);
    expect(
      await rig.count(`SELECT count(*) AS c FROM entitlements WHERE access_state <> 'locked'`),
    ).toBe(0);
    expect((await libraryOf(rig, 'A')).filter((l) => l.can_open).length).toBe(0);
    const v = await rig.app.engine.orderView({ order_ref: placed.order_ref, actor: rig.A });
    expect((v?.items ?? []).every((i) => i.kind === 'abandoned')).toBe(true);
    expect((await checkInvariants(rig.app.db)).filter((i) => !i.ok)).toEqual([]);
    // A later return does not revive it or take money.
    await rig.app.engine.payments.onBuyerReturn({
      order_ref: placed.order_ref,
      actor: rig.A,
      scenario: null,
    });
    expect(await orderStatus(rig, placed.order_id)).toBe('abandoned');
    expect(rig.calls('capture_order')).toBe(0);
  }, 90_000);
});
