// DP-2c item 1 (MVP-D): when the due pass ends a PayPal order of a pack as declined, frozen, failed or
// abandoned, the receipt of the order is reissued with the same rule apply.ts uses
// (issueReceiptIfChanged), so the receipt shows what was and was not charged. No new receipt content.
// Real PGlite, scripted PayPal. A pack is the approval of ofr_1 (publisher 1) and ofr_3 (publisher 2).
import { afterEach, describe, expect, it } from 'vitest';
import { onBuyerReturn, runDue } from './index';
import { BUYER_A, approved, awaiting, makeWorld } from './ops/support';
import type { Awaiting, OpsWorld } from './ops/support';
import { providerOrdersOf } from './ops/support';

let w: OpsWorld;
afterEach(async () => {
  expect(w.paypal.violations).toEqual([]);
  await w.close();
});

const PACK = { offers: ['ofr_1', 'ofr_3'] };
const H = 3_600_000;
const ret = (ref: string) => onBuyerReturn(w.deps, { order_ref: ref, actor: BUYER_A });
const poIds = (a: Awaiting): string[] =>
  a.provider_orders.map((p) => p.provider_order_id as string);
const states = async (order_id: string): Promise<string[]> =>
  (await providerOrdersOf(w, order_id)).map((p) => p.state);
const pass = () => runDue(w.deps, { max_items: 10 });

interface Line {
  article_id: string;
  capture_id: string | null;
  outcome?: string;
}
interface Stored {
  version: number;
  lines: Line[];
}
/** Every stored version of the receipt, oldest first. */
const receipts = async (order_id: string): Promise<Stored[]> => {
  const rows = await w.rows<{ version: number; body: unknown }>(
    'SELECT version, body FROM receipts WHERE order_id = $1 ORDER BY version',
    [order_id],
  );
  return rows.map((r) => {
    const body = (typeof r.body === 'string' ? JSON.parse(r.body) : r.body) as { lines: Line[] };
    return { version: Number(r.version), lines: body.lines };
  });
};
/** The outcome of each publisher's item in one receipt version. */
const outcomes = async (order_id: string, v: Stored): Promise<Record<string, string>> => {
  const map = await w.rows<{ publisher_id: string; article_id: string }>(
    `SELECT u.publisher_id, e.article_id FROM entitlements e
       JOIN order_units u ON u.id = e.unit_id WHERE u.order_id = $1`,
    [order_id],
  );
  const out: Record<string, string> = {};
  for (const l of v.lines) {
    out[map.find((m) => m.article_id === l.article_id)!.publisher_id] = l.outcome ?? 'none';
  }
  return out;
};

/** PO1 captured and read back, PO2 approved and nothing sent for it (the process dies at its status read). */
async function crashBetweenCaptures(): Promise<Awaiting> {
  const a = await approved(w, PACK);
  const base = w.paypal.count('get');
  w.paypal.beforeGet = async () => {
    if (w.paypal.count('get') === base + 4) {
      w.paypal.beforeGet = null;
      throw new Error('process died between the captures');
    }
  };
  await expect(ret(a.order_ref)).rejects.toThrow('died between the captures');
  w.paypal.beforeGet = null;
  expect(await states(a.order_id)).toEqual(['captured', 'approved']);
  return a;
}

describe('DP-2c item 1: the due pass reissues the receipt when a PayPal order ends without money', () => {
  it('PO2 declined (VOIDED, no send): the receipt shows the paid item as paid and the declined item as not charged, one new version, a second pass changes nothing', async () => {
    w = await makeWorld();
    const a = await crashBetweenCaptures();
    const before = await receipts(a.order_id);
    expect(before.map((r) => r.version)).toEqual([1]);
    expect(await outcomes(a.order_id, before[0]!)).toEqual({ pub_1: 'paid', pub_2: 'waiting' });

    w.paypal.void(poIds(a)[1]!);
    await pass();
    expect(await states(a.order_id)).toEqual(['captured', 'declined']);

    const after = await receipts(a.order_id);
    expect(after.map((r) => r.version)).toEqual([1, 2]);
    expect(await outcomes(a.order_id, after[1]!)).toEqual({
      pub_1: 'paid',
      pub_2: 'not_charged',
    });
    // the declined item has no capture on the receipt
    expect(after[1]!.lines.filter((l) => l.capture_id !== null)).toHaveLength(1);

    // a second pass changes nothing: no call, no new version
    const calls = w.paypal.calls.length;
    await pass();
    expect(w.paypal.calls.length).toBe(calls);
    expect((await receipts(a.order_id)).map((r) => r.version)).toEqual([1, 2]);
  });

  it('PO2 frozen by the continuation (payee tampered): the held item reads on hold, never not charged, one new version, a second pass changes nothing', async () => {
    w = await makeWorld();
    const a = await crashBetweenCaptures();
    w.paypal.tamperBy.set(poIds(a)[1]!, { payee: 'SBXEVILPAYEE' });
    await pass();
    expect(await states(a.order_id)).toEqual(['captured', 'frozen']);

    const after = await receipts(a.order_id);
    expect(after.map((r) => r.version)).toEqual([1, 2]);
    const last = await outcomes(a.order_id, after[1]!);
    expect(last).toEqual({ pub_1: 'paid', pub_2: 'on_hold' });
    // no charge line for the held item
    expect(after[1]!.lines.filter((l) => l.capture_id !== null)).toHaveLength(1);

    const calls = w.paypal.calls.length;
    await pass();
    expect(w.paypal.calls.length).toBe(calls);
    expect((await receipts(a.order_id)).map((r) => r.version)).toEqual([1, 2]);
  });

  it('a pack abandoned before any capture has no receipt, and the abandon sweep does not make one', async () => {
    w = await makeWorld();
    const a = await awaiting(w, PACK);
    w.tick(26 * H);
    await pass();
    expect(await states(a.order_id)).toEqual(['abandoned', 'abandoned']);
    expect(await receipts(a.order_id)).toEqual([]);
  });
});
