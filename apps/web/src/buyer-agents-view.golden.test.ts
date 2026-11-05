// INT-BUY / BUY.1 and BUY.2: the words and numbers of the Agents page and of the cap line on the agent hand-off
// page. The pure part (lib/buyer-copy.ts, lib/buyer-agents-view.ts) is pinned exactly; the read part
// (composition/buyer.ts) is checked against a booted offline app with two buyers.
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { Actor } from '@umsbx/contracts';
import { bootA } from './api-v1/a-support';
import type { ARig } from './api-v1/a-support';
import { expectOffline } from './api-v1/offline-guard';
import { newAgent } from './app/api/v1/mcp/agent-test-support';
import { seedSales } from './search-support';
import { capConfirmSentence } from './lib/buyer-copy';
import { CAP_STATE_WORDS, agentsModel, capCard, capLine } from './lib/buyer-agents-view';
import { listCaps, readCapLine } from './composition/buyer';

vi.mock('server-only', () => ({}));
vi.mock('node:net', async (orig) => (await import('./api-v1/offline-guard')).netMock(await orig()));
vi.mock('node:dns', async (orig) => (await import('./api-v1/offline-guard')).dnsMock(await orig()));
expectOffline();

const NOW = new Date('2026-11-05T12:00:00.000Z');
const mandate = (over: Record<string, unknown> = {}) => ({
  id: 'man_golden1',
  agent_key_id: 'key_golden1',
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

describe('BUY.1 the confirm sentence', () => {
  const until = '2026-11-30T23:59:00.000Z';
  it('money and count', () => {
    expect(
      capConfirmSentence({
        currency: 'USD',
        max_total_minor: 500,
        max_count: 50,
        expires_at: until,
      }),
    ).toBe('Your agent may spend up to $5.00 and make up to 50 purchases until 30 Nov.');
  });
  it('money only', () => {
    expect(
      capConfirmSentence({
        currency: 'USD',
        max_total_minor: 1250,
        max_count: null,
        expires_at: until,
      }),
    ).toBe('Your agent may spend up to $12.50 until 30 Nov.');
  });
  it('count only, one and many', () => {
    expect(
      capConfirmSentence({
        currency: 'USD',
        max_total_minor: null,
        max_count: 1,
        expires_at: until,
      }),
    ).toBe('Your agent may make up to 1 purchase until 30 Nov.');
    expect(
      capConfirmSentence({
        currency: 'USD',
        max_total_minor: null,
        max_count: 7,
        expires_at: until,
      }),
    ).toBe('Your agent may make up to 7 purchases until 30 Nov.');
  });
  it('has no dash and no italics marks', () => {
    const s = capConfirmSentence({
      currency: 'USD',
      max_total_minor: 500,
      max_count: 50,
      expires_at: until,
    });
    expect(s).not.toMatch(/[‒-―−]| - |--|\*/);
  });
});

describe('BUY.1 the cap card', () => {
  it('an open cap shows spent, cap and left in money and in count', () => {
    const c = capCard(mandate(), NOW);
    expect(c).toMatchObject({
      id: 'man_golden1',
      state: 'open',
      state_word: 'Open',
      until_text: 'Until 30 Nov',
      can_revoke: true,
      money: { spent_text: '$1.25', cap_text: '$5.00', left_text: '$3.75', percent: 25 },
      count: { used: 3, cap: 10, left: 7, percent: 30 },
    });
  });
  it('a cap with no count has no count block, and the other way round', () => {
    expect(capCard(mandate({ max_count: null, remaining_count: null }), NOW).count).toBeNull();
    expect(
      capCard(mandate({ max_total_minor: null, remaining_total_minor: null }), NOW).money,
    ).toBeNull();
  });
  it('revoked, expired and used up are told apart, and only an open cap can be revoked', () => {
    expect(capCard(mandate({ revoked_at: '2026-11-05T10:00:00.000Z' }), NOW)).toMatchObject({
      state: 'revoked',
      state_word: 'Revoked',
      can_revoke: false,
    });
    expect(capCard(mandate({ expires_at: '2026-11-05T11:59:59.000Z' }), NOW)).toMatchObject({
      state: 'expired',
      state_word: 'Expired',
      can_revoke: false,
    });
    expect(
      capCard(mandate({ remaining_count: 0, used_count: 10, spent_minor: 500 }), NOW),
    ).toMatchObject({ state: 'used_up', state_word: 'Used up' });
  });
  it('the state words are four plain words', () => {
    expect(CAP_STATE_WORDS).toEqual({
      open: 'Open',
      used_up: 'Used up',
      expired: 'Expired',
      revoked: 'Revoked',
    });
  });
});

describe('BUY.2 the cap line', () => {
  it('shows what is left in money and in count', () => {
    expect(capLine(mandate(), NOW)).toBe('Agent cap left: $3.75 and 7 purchases.');
    expect(capLine(mandate({ max_count: null, remaining_count: null }), NOW)).toBe(
      'Agent cap left: $3.75.',
    );
    expect(capLine(mandate({ max_total_minor: null, remaining_total_minor: null }), NOW)).toBe(
      'Agent cap left: 7 purchases.',
    );
    expect(capLine(mandate({ remaining_count: 1 }), NOW)).toBe(
      'Agent cap left: $3.75 and 1 purchase.',
    );
  });
  it('an ended cap says so, and no cap gives no line', () => {
    expect(capLine(mandate({ revoked_at: '2026-11-05T10:00:00.000Z' }), NOW)).toBe(
      'Agent cap: revoked.',
    );
    expect(capLine(null, NOW)).toBeNull();
  });
});

describe('BUY.1 the page model', () => {
  it('lists each agent key once with its newest cap, and offers a new cap only for a key with none open', () => {
    const m = agentsModel({
      keys: [
        { id: 'key_golden1', label: 'Research agent', revoked: false },
        { id: 'key_golden2', label: 'Reading agent', revoked: false },
        { id: 'key_golden3', label: 'Old agent', revoked: true },
      ],
      caps: [
        mandate(),
        mandate({
          id: 'man_old',
          revoked_at: '2026-11-01T00:00:00.000Z',
          agent_key_id: 'key_golden2',
        }),
      ],
      now: NOW,
    });
    expect(m.rows.map((r) => [r.key_id, r.cap?.id ?? null])).toEqual([
      ['key_golden1', 'man_golden1'],
      ['key_golden2', 'man_old'],
    ]);
    expect(m.newCapKeys.map((k) => k.id)).toEqual(['key_golden2']);
    expect(m.empty).toBeNull();
  });
  it('no agent keys gives words, not a blank', () => {
    const m = agentsModel({ keys: [], caps: [], now: NOW });
    expect(m.rows).toEqual([]);
    expect(m.empty).toMatch(/agent key/i);
  });
});

describe('BUY.1 and BUY.2 reads from the app', () => {
  let rig: ARig;
  let A: Extract<Actor, { kind: 'buyer' }>;
  let B: Extract<Actor, { kind: 'buyer' }>;
  let capA: string;
  let capB: string;
  beforeAll(async () => {
    rig = await bootA();
    A = rig.buyerA as typeof A;
    B = rig.buyerB as typeof B;
    capA = (await newAgent(rig.app, A, { mandate: { max_total_minor: 500, max_count: 10 } }))
      .mandate!.id;
    capB = (await newAgent(rig.app, B, { mandate: { max_count: 3 } })).mandate!.id;
  }, 120_000);

  it("buyer A's listCaps holds none of buyer B's caps, newest first", async () => {
    const a = await listCaps(A.buyer_id);
    const b = await listCaps(B.buyer_id);
    expect(a.map((m) => m.id)).toContain(capA);
    expect(a.map((m) => m.id)).not.toContain(capB);
    expect(b.map((m) => m.id)).toContain(capB);
    expect(b.map((m) => m.id)).not.toContain(capA);
    const times = a.map((m) => m.created_at);
    expect([...times].sort().reverse()).toEqual(times);
  });

  it('the cap line of a seeded order is exact, and another buyer sees no line', async () => {
    const [ref] = await seedSales(rig.app.db, {
      buyer_id: A.buyer_id,
      publisher_id: (rig.harbour as Extract<Actor, { kind: 'publisher' }>).publisher_id,
      count: 1,
      from: new Date('2026-11-05T08:00:00.000Z'),
      prefix: 'buyline',
      amount_minor: 125,
    });
    const orderId = (
      await rig.app.db.query<{ id: string }>('SELECT id FROM orders WHERE order_ref = $1', [ref])
    ).rows[0]!.id;
    await rig.app.db.query(
      `INSERT INTO mandate_reservations (id, mandate_id, order_id, amount_minor, state, created_at, settled_at)
       VALUES ('rsv_buyline1', $1, $2, 125, 'committed', now(), now())`,
      [capA, orderId],
    );
    await rig.app.db.query('UPDATE mandates SET spent_minor = 125, used_count = 3 WHERE id = $1', [
      capA,
    ]);
    const mine = await readCapLine(A.buyer_id, ref!);
    expect(mine).toBe('Agent cap left: $3.75 and 7 purchases.');
    expect(await readCapLine(B.buyer_id, ref!)).toBeNull();
    expect(await readCapLine(A.buyer_id, 'no-such-order')).toBeNull();
  });
});
