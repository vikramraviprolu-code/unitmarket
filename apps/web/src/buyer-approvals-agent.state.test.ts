// FIX-B5 (E2E finding B2 follow-up): a refused agent buy writes an approvals row whose snapshot carries the
// mandate id. Agent approvals are never for the buyer to act on, so the buyer's "needs your OK" list (Home and
// /buyer/approvals, both through readPendingApprovals) must leave them out. A person's own pending approval
// still appears. Offline, dry-run; synthetic values only.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { Actor } from '@umsbx/contracts';
import { HARBOUR_TIDE, approvalFor, bootPackApp, buyer } from './composite-support';
import type { App } from '../composition.server';
import { expectOffline } from './api-v1/offline-guard';
import { readPendingApprovals } from './composition/buyer';
import {
  buyArgs,
  extraOffers,
  newAgent,
  setAgentBuy,
  tool,
} from './app/api/v1/mcp/agent-test-support';

vi.mock('server-only', () => ({}));
vi.mock('node:net', async (orig) => (await import('./api-v1/offline-guard')).netMock(await orig()));
vi.mock('node:dns', async (orig) => (await import('./api-v1/offline-guard')).dnsMock(await orig()));
expectOffline();

const H = 'harbour-ledger';
let app: App;
let owner: Extract<Actor, { kind: 'buyer' }>;

/** Unused, unexpired approvals of the buyer whose snapshot names a mandate. */
const agentPending = async (buyer_id: string): Promise<string[]> =>
  (
    await app.db.query<{ id: string }>(
      `SELECT id FROM approvals
        WHERE buyer_id = $1 AND used_at IS NULL AND expires_at > $2
          AND snapshot->>'mandate_id' IS NOT NULL`,
      [buyer_id, app.security.clock.now().toISOString()],
    )
  ).rows.map((r) => r.id);

beforeAll(async () => {
  app = await bootPackApp();
  owner = (await buyer(app, 'b')) as typeof owner;
  await setAgentBuy(app, true);
}, 120_000);

describe('B5: agent approvals stay out of the buyer list', () => {
  it('a refused 11th agent buy leaves nothing pending for the buyer', async () => {
    const before = await readPendingApprovals(owner.buyer_id);
    const codes = await extraOffers(app, {
      publisher: H,
      from: 'tide-tables',
      count: 11,
      price_minor: 30,
      prefix: 'bfive',
    });
    const agent = await newAgent(app, owner, {
      mandate: { max_count: 10, max_total_minor: 1_000_000 },
    });
    const statuses: string[] = [];
    for (const c of codes) {
      const r = await tool(agent.token, 'buy_unit', buyArgs(H, c));
      statuses.push((r.out as { status: string }).status);
    }
    expect(statuses.slice(0, 10).every((s) => s === 'bought')).toBe(true);
    expect(statuses[10]).toBe('cap_exhausted');
    // The refusal is journaled as an unused agent approval (E2E B2) ...
    const refused = await agentPending(owner.buyer_id);
    expect(refused.length).toBeGreaterThan(0);
    // ... but the buyer is not asked to act on it.
    const after = await readPendingApprovals(owner.buyer_id);
    for (const id of refused) expect(after.map((p) => p.approval_id)).not.toContain(id);
    expect(after).toEqual(before);
  }, 120_000);

  it("a person's own pending approval still appears", async () => {
    const mine = await approvalFor(app, owner, [HARBOUR_TIDE]);
    if (!mine.ok) throw new Error(`approval refused: ${JSON.stringify(mine)}`);
    const list = await readPendingApprovals(owner.buyer_id);
    expect(list.map((p) => p.approval_id)).toContain(mine.value.approval_id);
  });

  it('Home and /buyer/approvals both read through readPendingApprovals', () => {
    const here = fileURLToPath(new URL('.', import.meta.url));
    const page = readFileSync(join(here, 'app/buyer/approvals/page.tsx'), 'utf8');
    expect(page).toContain('readPendingApprovals(actor.buyer_id)');
    const comp = readFileSync(join(here, 'composition/buyer.ts'), 'utf8');
    expect(comp).toMatch(/readBuyerHome[\s\S]*readPendingApprovals\(buyer_id\)/);
  });
});
