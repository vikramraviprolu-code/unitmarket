// INT-BUY / BUY.6, BUY.7 and BUY.9: the receipts list, the approvals inbox and the return copy. The pure part
// (lib/buyer-should-view.ts) is pinned exactly; the reads (composition/buyer.ts) run on a booted offline app with
// two buyers. The order page shows the return notice, so the page source is read as text.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { Actor } from '@umsbx/contracts';
import { bootA } from './api-v1/a-support';
import type { ARig } from './api-v1/a-support';
import { expectOffline } from './api-v1/offline-guard';
import { seedSales } from './search-support';
import {
  APPROVALS_EMPTY,
  PENDING_EXPECTED_MINUTES,
  RECEIPTS_EMPTY,
  approvalsModel,
  receiptsModel,
  returnNotice,
} from './lib/buyer-should-view';
import { readPendingApprovals, readReceipts } from './composition/buyer';

vi.mock('server-only', () => ({}));
vi.mock('node:net', async (orig) => (await import('./api-v1/offline-guard')).netMock(await orig()));
vi.mock('node:dns', async (orig) => (await import('./api-v1/offline-guard')).dnsMock(await orig()));
expectOffline();

const NOW = new Date('2026-11-05T12:00:00.000Z');

describe('BUY.6 the receipts model', () => {
  const row = {
    order_id: 'ord_rc1',
    order_ref: 'rcp001',
    provider_order_ids: ['PPS00000001'],
    sellers: ['Harbour Ledger'],
    currency: 'USD',
    total_minor: 250,
    created_at: '2026-11-05T09:30:00.000Z',
  };
  it('each receipt has the order ref, the provider order id, the seller of record and links back', () => {
    const m = receiptsModel([row]);
    expect(m.empty).toBeNull();
    expect(m.rows[0]).toMatchObject({
      order_ref: 'rcp001',
      provider_order_id: 'PPS00000001',
      seller: 'Harbour Ledger',
      money_text: '$2.50',
      receipt_href: '/receipts/ord_rc1',
      order_href: '/orders/rcp001',
    });
  });
  it('a pack lists every provider order id and every seller, in the given order', () => {
    const m = receiptsModel([
      { ...row, provider_order_ids: ['PPS1', 'PPS2'], sellers: ['Harbour Ledger', 'Quayside'] },
    ]);
    expect(m.rows[0]).toMatchObject({
      provider_order_id: 'PPS1, PPS2',
      seller: 'Harbour Ledger, Quayside',
    });
  });
  it('a receipt with no provider order id yet says so in words', () => {
    expect(receiptsModel([{ ...row, provider_order_ids: [] }]).rows[0]!.provider_order_id).toBe(
      'Not issued yet',
    );
  });
  it('no receipts gives words, not a blank', () => {
    expect(receiptsModel([])).toMatchObject({ rows: [], empty: RECEIPTS_EMPTY });
    expect(RECEIPTS_EMPTY.length).toBeGreaterThan(10);
  });
});

describe('BUY.7 the approvals inbox model', () => {
  const p = (id: string, expires_at: string) => ({
    approval_id: id,
    titles: ['Tide tables'],
    total_minor: 250,
    currency: 'USD',
    expires_at,
  });
  it('lists exactly the pending approvals, each linking to the approve page, with when it ends', () => {
    const m = approvalsModel([p('apr_in1', '2026-11-05T12:15:00.000Z')], NOW);
    expect(m.empty).toBeNull();
    expect(m.rows).toEqual([
      {
        key: 'apr_in1',
        href: '/approve/apr_in1',
        text: 'Tide tables, $2.50',
        note: 'Ends in 15 minutes.',
      },
    ]);
  });
  it('none pending gives words, not a blank', () => {
    expect(approvalsModel([], NOW)).toMatchObject({ rows: [], empty: APPROVALS_EMPTY });
  });
});

describe('BUY.9 the return notice', () => {
  it('a ready order offers Open now to its library item', () => {
    expect(
      returnNotice({ status: 'paid', entitlement_id: 'ent_r1', order_ref: 'rcp001' }),
    ).toMatchObject({
      kind: 'ready',
      open_now: { href: '/library/ent_r1', label: 'Open now' },
      order_href: '/orders/rcp001',
    });
  });
  it('a pending order shows the expected time and the order link, and no Open now', () => {
    for (const status of ['created', 'awaiting_buyer', 'capture_requested', 'capture_claimed']) {
      const n = returnNotice({ status, entitlement_id: null, order_ref: 'rcp001' });
      expect(n.kind, status).toBe('pending');
      expect(n.open_now, status).toBeNull();
      expect(n.text, status).toBe(
        `We are confirming your payment. This usually takes less than ${String(PENDING_EXPECTED_MINUTES)} minutes.`,
      );
      expect(n.order_href, status).toBe('/orders/rcp001');
    }
  });
  it('a frozen, failed or abandoned order gets no notice here: the order page says where it stands', () => {
    for (const status of ['frozen', 'failed', 'abandoned'])
      expect(returnNotice({ status, entitlement_id: null, order_ref: 'rcp001' }).kind).toBe('none');
  });
  it('the copy has no dash and no italics marks', () => {
    const n = returnNotice({ status: 'created', entitlement_id: null, order_ref: 'x' });
    expect(n.text).not.toMatch(/[‒-―−]| - |--|\*/);
  });
  it('the order page shows the notice', () => {
    const src = readFileSync(
      join(fileURLToPath(new URL('.', import.meta.url)), 'app/orders/[ref]/page.tsx'),
      'utf8',
    );
    expect(src).toContain('returnNotice(');
    expect(src).toContain('return-notice');
  });
});

describe('BUY.6 and BUY.7 the reads from the app', () => {
  let rig: ARig;
  let A: Extract<Actor, { kind: 'buyer' }>;
  let B: Extract<Actor, { kind: 'buyer' }>;
  beforeAll(async () => {
    rig = await bootA();
    A = rig.buyerA as typeof A;
    B = rig.buyerB as typeof B;
    await seedSales(rig.app.db, {
      buyer_id: A.buyer_id,
      publisher_id: (rig.harbour as Extract<Actor, { kind: 'publisher' }>).publisher_id,
      count: 2,
      from: new Date(rig.app.security.clock.now().getTime() - 3_600_000),
      prefix: 'rcr',
    });
  }, 120_000);

  it("holds the buyer's own paid orders with provider order id and seller, and none of another buyer's", async () => {
    const mine = await readReceipts(A.buyer_id);
    expect(mine.map((r) => r.order_ref).sort()).toEqual(['rcr000', 'rcr001']);
    for (const r of mine) {
      expect(r.provider_order_ids).toHaveLength(1);
      expect(r.provider_order_ids[0]).toMatch(/^PPS\d+$/);
      expect(r.sellers).toEqual(['Harbour Ledger Review (fictional)']);
    }
    expect(await readReceipts(B.buyer_id)).toEqual([]);
  });

  it('the pending approvals read is per buyer', async () => {
    expect(await readPendingApprovals(B.buyer_id)).toEqual([]);
  });
});
