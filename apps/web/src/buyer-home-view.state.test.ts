// INT-BUY / BUY.5: the buyer Home. A buyer session sees, in this order, what needs its OK, what to continue reading,
// the agent spend meter and recent spending. A signed-out visitor, a seller or an operator still gets today's public
// explainer text (N4), so accounts.spec.ts and account-copy.golden.test.ts do not change.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { Actor } from '@umsbx/contracts';
import { bootA } from './api-v1/a-support';
import type { ARig } from './api-v1/a-support';
import { expectOffline } from './api-v1/offline-guard';
import { newAgent } from './app/api/v1/mcp/agent-test-support';
import { seedSales } from './search-support';
import { BUYER_TITLE } from './lib/account-copy';
import { HOME_ORDER, homeAudience, homeModel } from './lib/buyer-home-view';
import { readBuyerHome } from './composition/buyer';

vi.mock('server-only', () => ({}));
vi.mock('node:net', async (orig) => (await import('./api-v1/offline-guard')).netMock(await orig()));
vi.mock('node:dns', async (orig) => (await import('./api-v1/offline-guard')).dnsMock(await orig()));
expectOffline();

const NOW = new Date('2026-11-05T12:00:00.000Z');
const cap = (over: Record<string, unknown> = {}) => ({
  id: 'man_home1',
  agent_key_id: 'key_home1',
  currency: 'USD',
  max_total_minor: 500,
  max_count: 10,
  max_per_purchase_minor: null,
  expires_at: '2026-11-30T12:00:00.000Z',
  revoked_at: null,
  spent_minor: 125,
  used_count: 3,
  remaining_total_minor: 375,
  remaining_count: 7,
  created_at: '2026-11-05T09:00:00.000Z',
  ...over,
});

describe('BUY.5 who sees Home', () => {
  it('only a buyer session gets Home; everyone else gets the public text', () => {
    expect(homeAudience('buyer')).toBe('home');
    for (const k of ['publisher', 'operator', null] as const)
      expect(homeAudience(k)).toBe('public');
  });
  it('the page keeps the public text path and imports the account copy unchanged', () => {
    const src = readFileSync(
      join(fileURLToPath(new URL('.', import.meta.url)), 'app/buyer/page.tsx'),
      'utf8',
    );
    expect(src).toContain('BUYER_TITLE');
    expect(src).toContain('BUYER_NEED_ITEMS');
    expect(src).toContain('homeAudience(');
    expect(BUYER_TITLE.length).toBeGreaterThan(0);
  });
});

describe('BUY.5 the model', () => {
  it('has the four sections in the stated order', () => {
    expect(HOME_ORDER).toEqual(['needs_ok', 'continue_reading', 'agent_spend', 'recent']);
    const m = homeModel({ pending: [], reading: [], caps: [], recent: [], now: NOW });
    expect(m.sections.map((s) => s.id)).toEqual([...HOME_ORDER]);
  });

  it('an empty section has words, not a blank', () => {
    const m = homeModel({ pending: [], reading: [], caps: [], recent: [], now: NOW });
    for (const s of m.sections) {
      expect(s.empty, s.id).toEqual(expect.any(String));
      expect(s.empty!.length, s.id).toBeGreaterThan(10);
      expect(s.items, s.id).toEqual([]);
    }
  });

  it('the spend meter equals the mandate numbers', () => {
    const m = homeModel({ pending: [], reading: [], caps: [cap()], recent: [], now: NOW });
    const spend = m.sections.find((s) => s.id === 'agent_spend')!;
    expect(spend.empty).toBeNull();
    expect(spend.items).toHaveLength(1);
    expect(spend.items[0]).toMatchObject({
      meter: {
        money: { spent_text: '$1.25', cap_text: '$5.00', percent: 25 },
        count: { used: 3, cap: 10, percent: 30 },
      },
    });
  });

  it('a revoked cap is not on the meter', () => {
    const m = homeModel({
      pending: [],
      reading: [],
      caps: [cap({ revoked_at: '2026-11-05T10:00:00.000Z' })],
      recent: [],
      now: NOW,
    });
    expect(m.sections.find((s) => s.id === 'agent_spend')!.items).toEqual([]);
  });

  it('pending approvals link to the approve page and say when they end', () => {
    const m = homeModel({
      pending: [
        {
          approval_id: 'apr_home1',
          titles: ['Tide tables'],
          total_minor: 250,
          currency: 'USD',
          expires_at: '2026-11-05T12:15:00.000Z',
        },
      ],
      reading: [],
      caps: [],
      recent: [],
      now: NOW,
    });
    const ok = m.sections.find((s) => s.id === 'needs_ok')!;
    expect(ok.items[0]).toMatchObject({ href: '/approve/apr_home1', text: 'Tide tables, $2.50' });
    expect(ok.items[0]!.note).toBe('Ends in 15 minutes.');
  });
});

describe('BUY.5 the read from the app', () => {
  let rig: ARig;
  let A: Extract<Actor, { kind: 'buyer' }>;
  let B: Extract<Actor, { kind: 'buyer' }>;
  beforeAll(async () => {
    rig = await bootA();
    A = rig.buyerA as typeof A;
    B = rig.buyerB as typeof B;
    await newAgent(rig.app, A, { mandate: { max_total_minor: 500, max_count: 10 } });
    await seedSales(rig.app.db, {
      buyer_id: A.buyer_id,
      publisher_id: (rig.harbour as Extract<Actor, { kind: 'publisher' }>).publisher_id,
      count: 3,
      from: new Date(rig.app.security.clock.now().getTime() - 3_600_000),
      prefix: 'hm',
    });
  }, 120_000);

  it("shows the buyer's own caps and recent purchases, and none of another buyer's", async () => {
    const mine = await readBuyerHome(A.buyer_id);
    expect(mine.caps).toHaveLength(1);
    expect(mine.recent.map((l) => l.order_ref).sort()).toEqual(['hm000', 'hm001', 'hm002']);
    expect(mine.recent.length).toBeLessThanOrEqual(5);
    const other = await readBuyerHome(B.buyer_id);
    expect(other.caps).toEqual([]);
    expect(other.recent).toEqual([]);
    expect(other.pending).toEqual([]);
  });

  it('lists exactly the unused, unexpired approvals of the buyer', async () => {
    const q = await rig.app.engine.quote({
      offer: { publisher_slug: 'harbour-ledger', offer_code: 'tide-tables' },
      actor: A,
      source: 'direct',
    });
    if (!q.ok || q.value.kind === 'no_match') throw new Error('quote expected');
    const made = await rig.app.engine.requestApproval({
      actor: A,
      selection: { kind: 'quote', quote_id: q.value.quote_id },
      consent: { terms: true, identity_share: false },
    });
    if (!made.ok) throw new Error('approval expected');
    const home = await readBuyerHome(A.buyer_id);
    expect(home.pending.map((p) => p.approval_id)).toEqual([made.value.approval_id]);
    expect((await readBuyerHome(B.buyer_id)).pending).toEqual([]);
  });
});
