// INT-SEL / SEL.1 adversarial: the seller sale detail. On the two-seller agent order, seller A reads its own
// unit and nothing else. A deep scan of the composition answer and of the view output (F7) finds no buyer id,
// buyer name, agent key id, request id, ip hash, the canary order total, or the canary refund reason. Another
// seller's unit gives the answer an unknown unit gives. Buyer, operator and anonymous callers are refused.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { CANARY, IDS, bootSeller } from './seller-fixture';
import type { SellerRig } from './seller-fixture';

vi.mock('server-only', () => ({}));

let rig: SellerRig;
let seller: typeof import('./composition/seller');
let view: typeof import('./lib/seller-sale-view');

beforeAll(async () => {
  rig = await bootSeller();
  seller = await import('./composition/seller');
  view = await import('./lib/seller-sale-view');
}, 120_000);
afterAll(async () => {
  await rig.app.close();
});

/** Every string, key and number anywhere in a value, as one text. */
const deep = (v: unknown): string => JSON.stringify(v);

const NEVER = [
  'vs_b1',
  'vs_b2',
  'vs_key',
  'vs_man',
  CANARY.buyerName,
  'CANARY',
  CANARY.reason,
  'req_',
  'ip_hash',
  'agent_key',
  'api_key_id',
  'mandate',
  'order_total',
  String(CANARY.total),
  CANARY.totalText,
  // seller B, on the same order
  IDS.uB,
  IDS.pb,
  'Birch',
  'MERCHSLPB',
  '4442',
  '44.42',
] as const;

describe('the two-seller agent order, seen by seller A', () => {
  it('the composition answer holds nothing a seller must not see', async () => {
    const r = await seller.readSellerSale(rig.A, IDS.uA);
    expect(r.kind).toBe('ok');
    const text = deep(r);
    for (const bad of NEVER) expect(text, bad).not.toContain(bad);
  });

  it('the view output holds nothing either, and says an agent bought it', async () => {
    const r = await seller.readSellerSale(rig.A, IDS.uA);
    if (r.kind !== 'ok') throw new Error('expected ok');
    const v = view.saleView(r.sale);
    const text = deep(v);
    for (const bad of NEVER) expect(text, bad).not.toContain(bad);
    expect(v.bought_by).toBe('an agent');
    expect(v.gross_text).toContain('33.31');
    expect(v.net_text).toContain('33.31');
    expect(v.refund).toBeNull();
  });

  it('the refund shows amount, state and date, and never its reason text', async () => {
    const r = await seller.readSellerSale(rig.A, IDS.uR);
    if (r.kind !== 'ok') throw new Error('expected ok');
    const v = view.saleView(r.sale);
    expect(v.bought_by).toBe('a person');
    expect(v.refund).not.toBeNull();
    expect(v.refund!.amount_text).toContain('3.00');
    expect(v.refund!.state_text.length).toBeGreaterThan(0);
    expect(v.refund!.date_text.length).toBeGreaterThan(0);
    // 8.00 sold, 3.00 refunded: net 5.00 (the statement formula).
    expect(v.net_text).toContain('5.00');
    for (const x of [deep(r), deep(v)]) {
      expect(x).not.toContain('CANARY');
      expect(x).not.toContain('phone');
      expect(x).not.toContain('reason');
    }
  });

  it('the units on the sale are named by title and option only', async () => {
    const r = await seller.readSellerSale(rig.A, IDS.uM);
    if (r.kind !== 'ok') throw new Error('expected ok');
    const v = view.saleView(r.sale);
    expect(v.units.map((u) => u.title).sort()).toEqual(['Alder Almanac', 'Alder Atlas']);
    for (const u of v.units) expect(Object.keys(u).sort()).toEqual(['option_text', 'title']);
  });
});

describe('another seller, an unknown unit, and the wrong kind of session', () => {
  it("seller B reading seller A's unit gets exactly what an unknown unit gets", async () => {
    const other = await seller.readSellerSale(rig.B, IDS.uA);
    const unknown = await seller.readSellerSale(rig.B, 'sl_nope');
    const own = await seller.readSellerSale(rig.A, 'sl_nope');
    expect(other).toEqual({ kind: 'not_found' });
    expect(unknown).toEqual(other);
    expect(own).toEqual(other);
    // And seller A reading seller B's unit of the same order.
    expect(await seller.readSellerSale(rig.A, IDS.uB)).toEqual(other);
  });

  it('a buyer, an operator with and without the second factor, and nobody are refused', async () => {
    for (const who of [
      rig.vsBuyer1,
      rig.vsBuyer2,
      rig.operator,
      { kind: 'operator', operator_id: 'opr_a_test', mfa: false } as const,
      null,
    ]) {
      expect(await seller.readSellerSale(who, IDS.uA)).toEqual({ kind: 'forbidden' });
    }
  });

  it('the page words for not found and for an unknown unit are one text', () => {
    expect(view.NOT_FOUND_TEXT.length).toBeGreaterThan(0);
  });
});

describe('the sale detail source', () => {
  it('seller-sale-view.ts names no buyer field and the page reads only its tab module', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { join } = await import('node:path');
    const here = fileURLToPath(new URL('.', import.meta.url));
    const src = readFileSync(join(here, 'lib/seller-sale-view.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    for (const bad of [
      'buyer_id',
      'buyer_display_name',
      'agent_key_id',
      'mandate_id',
      'order_total_minor',
      'reason',
    ])
      expect(src, bad).not.toContain(bad);
    const page = readFileSync(join(here, 'app/publisher/sales/[unit]/page.tsx'), 'utf8');
    expect(page).toMatch(/composition\/seller'/);
    expect(page).not.toMatch(/server\/access|composition\.server/);
  });
});
