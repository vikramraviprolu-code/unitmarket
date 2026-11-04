// API-B (opus gate F2, spec G5): search_catalogue reuses lane A's search. For one query an agent and a human API
// client see the same offers in the same order; the only difference is that offers whose rights say
// `ai_scope: not_allowed` never reach the agent.
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { Actor } from '@umsbx/contracts';
import { bootPackApp, buyer } from '../../../../composite-support';
import type { App } from '../../../../../composition.server';
import { expectOffline } from '../../../../api-v1/offline-guard';
import { extraOffers, newAgent, newClientKey, setAiScope, tool } from './agent-test-support';

vi.mock('server-only', () => ({}));
vi.mock('node:net', async (orig) =>
  (await import('../../../../api-v1/offline-guard')).netMock(await orig()),
);
vi.mock('node:dns', async (orig) =>
  (await import('../../../../api-v1/offline-guard')).dnsMock(await orig()),
);
expectOffline();

const H = 'harbour-ledger';
let app: App;
let owner: Actor;
let agentToken: string;
let clientToken: string;
let banned: string;

type Get = (r: Request) => Promise<Response>;

beforeAll(async () => {
  app = await bootPackApp();
  owner = await buyer(app, 'a');
  // Two price bands of units whose title never says "lighthouse" but whose abstract does (see below), plus one
  // the publisher keeps away from agents.
  const dear = await extraOffers(app, {
    publisher: H,
    from: 'tide-tables',
    count: 4,
    price_minor: 90,
    prefix: 'dear',
  });
  const cheap = await extraOffers(app, {
    publisher: H,
    from: 'tide-tables',
    count: 4,
    price_minor: 10,
    prefix: 'cheap',
  });
  for (const code of [...dear, ...cheap]) {
    await app.db.query(`UPDATE articles SET abstract = $2 WHERE id = $1`, [
      `art_${H}_${code}`,
      `A lighthouse keeper's note, ${code}.`,
    ]);
  }
  banned = cheap[0]!;
  await setAiScope(app, H, banned, 'not_allowed');
  agentToken = (await newAgent(app, owner, { mandate: { max_count: 5 } })).token;
  clientToken = (await newClientKey(app, owner)).token;
}, 120_000);

const human = async (query: string): Promise<{ ids: string[]; next: string | null }> => {
  const get = (await import('../catalogue/search/route')).GET as Get;
  const res = await get(
    new Request(`http://localhost:3000/api/v1/catalogue/search${query}`, {
      headers: { authorization: `Bearer ${clientToken}` },
    }),
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { items: { offer_id: string }[]; next_cursor: string | null };
  return { ids: body.items.map((i) => i.offer_id), next: body.next_cursor };
};

const agent = async (args: object): Promise<{ ids: string[]; next: string | null }> => {
  const r = await tool(agentToken, 'search_catalogue', args);
  expect(r.out.status).toBe('ok');
  return {
    ids: (r.out['items'] as { offer_id: string }[]).map((i) => i.offer_id),
    next: r.out['next_cursor'] as string | null,
  };
};

describe('search_catalogue is lane A search', () => {
  it('a query that only the abstract matches finds the same offers in the same order as GET /api/v1/catalogue/search', async () => {
    const h = await human('?q=lighthouse&limit=50');
    const a = await agent({ q: 'lighthouse', limit: 50 });
    const bannedId = `ofr_${H}_${banned}`;
    expect(h.ids).toContain(bannedId);
    expect(a.ids).not.toContain(bannedId);
    expect(a.ids).toEqual(h.ids.filter((id) => id !== bannedId));
    expect(a.ids).toHaveLength(7);
    // price first (the 10-cent units), then offer id inside a price band
    expect(a.ids.slice(0, 3).every((id) => id.includes('cheap'))).toBe(true);
    expect(a.ids.slice(3).every((id) => id.includes('dear'))).toBe(true);
    expect(a.ids).toEqual(
      [...a.ids].sort((x, y) =>
        x.includes('cheap') === y.includes('cheap')
          ? x < y
            ? -1
            : 1
          : x.includes('cheap')
            ? -1
            : 1,
      ),
    );
  });

  it('no text, a publisher and a price ceiling order and filter like the human route', async () => {
    const bannedId = `ofr_${H}_${banned}`;
    const h = await human(`?publisher=${H}&max_price=50&limit=50`);
    const a = await agent({ publisher: H, max_price_minor: 50, limit: 50 });
    expect(a.ids).toEqual(h.ids.filter((id) => id !== bannedId));
    expect(a.ids.length).toBeGreaterThan(0);
  });

  it('paging through the agent search gives the whole ordered list', async () => {
    const whole = await agent({ q: 'lighthouse', limit: 50 });
    const paged: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 10; i += 1) {
      const page = await agent({ q: 'lighthouse', limit: 2, ...(cursor ? { cursor } : {}) });
      paged.push(...page.ids);
      if (page.next === null) break;
      cursor = page.next;
    }
    expect(paged).toEqual(whole.ids);
  });
});
