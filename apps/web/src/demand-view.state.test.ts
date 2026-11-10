// CAT-2.6 views and CAT-2.5 composition: the chips and the card are built from plain data, an empty list shows no
// heading, and the engine answers the same for the whole UTC day.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { bootA } from './api-v1/a-support';
import type { ARig } from './api-v1/a-support';
import { expectOffline } from './api-v1/offline-guard';
import * as copy from './lib/demand-copy';

vi.mock('server-only', () => ({}));
vi.mock('node:net', async (orig) => (await import('./api-v1/offline-guard')).netMock(await orig()));
vi.mock('node:dns', async (orig) => (await import('./api-v1/offline-guard')).dnsMock(await orig()));
expectOffline();

describe('popularRequestsView', () => {
  it('is null for no terms, so no heading is rendered', () => {
    expect(copy.popularRequestsView([])).toBeNull();
  });

  it('has the heading, the hint and one chip per term, at most 10', () => {
    const many = Array.from({ length: 14 }, (_, i) => ({ term: `term${i}`, band: '5-9' as const }));
    const v = copy.popularRequestsView(many)!;
    expect(v.heading).toBe(copy.POPULAR_HEADING);
    expect(v.hint).toBe(copy.POPULAR_HINT);
    expect(v.chips).toHaveLength(10);
    expect(v.chips[0]).toEqual({ term: 'term0', fill: 'term0' });
  });

  it('shows no count and no band on a chip', () => {
    const v = copy.popularRequestsView([{ term: 'harbour', band: '50+' }])!;
    expect(JSON.stringify(v)).not.toContain('50+');
  });
});

describe('demandCardView', () => {
  it('says the empty line and keeps the heading when there are no terms', () => {
    const v = copy.demandCardView([]);
    expect(v.heading).toBe(copy.DEMAND_CARD_HEADING);
    expect(v.empty).toBe(copy.DEMAND_CARD_EMPTY);
    expect(v.lines).toEqual([]);
  });

  it('lists up to 5 lines', () => {
    const rows = Array.from({ length: 8 }, (_, i) => ({
      term: `term${i}`,
      band: '10-49' as const,
      matching: i,
    }));
    const v = copy.demandCardView(rows);
    expect(v.empty).toBeNull();
    expect(v.lines).toHaveLength(5);
    expect(v.lines[2]).toBe('term2: 10-49 buyers asked; 2 of your offers match');
  });
});

describe('the screens read the views and the engine only', () => {
  const here = fileURLToPath(new URL('.', import.meta.url));
  const read = (p: string) => readFileSync(join(here, p), 'utf8');
  it('the components use demand-copy and no domain package', () => {
    for (const f of ['app/discover/PopularRequests.tsx', 'app/publisher/DemandCard.tsx']) {
      const src = read(f);
      expect(src).toContain('demand-copy');
      expect(src).not.toMatch(/@umsbx\/(discovery|catalogue|db)/);
    }
  });
  it('the pages reach demand through the engine', () => {
    expect(read('app/discover/page.tsx')).toContain('engine.demand.forBuyers');
    expect(read('app/publisher/page.tsx')).toContain('engine.demand.forPublisher');
  });
});

describe('engine.demand', () => {
  let rig: ARig;
  const db = () => rig.app.db;
  beforeAll(async () => {
    rig = await bootA();
    // Two publishers get the same made-up topic on one authorised offer each.
    for (const pub of [rig.harbour, rig.quayside]) {
      if (pub.kind !== 'publisher') throw new Error('publisher expected');
      await db().query(
        `UPDATE articles SET topics = topics || ARRAY['zebrawords']
          WHERE id = (SELECT o.article_id FROM offers o WHERE o.publisher_id = $1 AND o.status = 'authorised'
                        AND o.superseded_by IS NULL ORDER BY o.id LIMIT 1)`,
        [pub.publisher_id],
      );
    }
    const now = rig.app.security.clock.now();
    const old = new Date(now.getTime() - 40 * 86_400_000).toISOString();
    const asked = new Date(now.getTime() - 3 * 86_400_000).toISOString();
    for (let i = 0; i < 5; i++) {
      await db().query(
        `INSERT INTO buyers (id, display_name, auth_subject, country, created_at, updated_at) VALUES ($1,$2,$3,'US',$4,$4)`,
        [`buy_dv${i}`, `DV ${i}`, `sub-dv-${i}`, old],
      );
      await db().query(
        `INSERT INTO briefs (id, buyer_id, raw_text, structured, version, confirmed_at, created_at, updated_at)
         VALUES ($1,$2,'a request',$3::jsonb,'scripted-v1',NULL,$4,$4)`,
        [
          `brf_dv${i}`,
          `buy_dv${i}`,
          JSON.stringify({
            need: 'n',
            ceiling: null,
            option: null,
            language: null,
            terms: ['zebrawords'],
          }),
          asked,
        ],
      );
    }
  }, 120_000);

  it('forBuyers answers the band and nothing else', async () => {
    expect(await rig.app.engine.demand.forBuyers()).toEqual([{ term: 'zebrawords', band: '5-9' }]);
  });

  it('forPublisher adds how many of the publisher offers match, and is null for anyone else', async () => {
    expect(await rig.app.engine.demand.forPublisher(rig.harbour)).toEqual([
      { term: 'zebrawords', band: '5-9', matching: 1 },
    ]);
    expect(await rig.app.engine.demand.forPublisher(rig.buyerA)).toBeNull();
    expect(await rig.app.engine.demand.forPublisher(rig.operator)).toBeNull();
  });

  it('answers the same for the whole day: more buyers asking does not change the cached answer', async () => {
    const now = rig.app.security.clock.now();
    const old = new Date(now.getTime() - 40 * 86_400_000).toISOString();
    const asked = new Date(now.getTime() - 3 * 86_400_000).toISOString();
    for (let i = 10; i < 20; i++) {
      await db().query(
        `INSERT INTO buyers (id, display_name, auth_subject, country, created_at, updated_at) VALUES ($1,$2,$3,'US',$4,$4)`,
        [`buy_dv${i}`, `DV ${i}`, `sub-dv-${i}`, old],
      );
      await db().query(
        `INSERT INTO briefs (id, buyer_id, raw_text, structured, version, confirmed_at, created_at, updated_at)
         VALUES ($1,$2,'a request',$3::jsonb,'scripted-v1',NULL,$4,$4)`,
        [
          `brf_dv${i}`,
          `buy_dv${i}`,
          JSON.stringify({
            need: 'n',
            ceiling: null,
            option: null,
            language: null,
            terms: ['zebrawords'],
          }),
          asked,
        ],
      );
    }
    expect(await rig.app.engine.demand.forBuyers()).toEqual([{ term: 'zebrawords', band: '5-9' }]);
  });
});
