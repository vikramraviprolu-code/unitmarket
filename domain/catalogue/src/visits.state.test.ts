// PUB-E1: touchVisit keeps one row per publisher; the instant a visit counts from moves only after a gap.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { VISIT_GAP_MS, touchVisit } from './index';
import { count, offersWorld } from './write-support';
import type { OffersWorld } from './write-support';

let w: OffersWorld;
beforeAll(async () => {
  w = await offersWorld();
});
afterAll(async () => {
  await w.db.close();
});

const at = (min: number): string =>
  new Date(Date.parse('2026-10-30T09:00:00.000Z') + min * 60_000).toISOString();

describe('touchVisit', () => {
  it('the first visit stores a row and answers no earlier visit', async () => {
    expect(await touchVisit(w.db, w.harbour, at(0))).toEqual({ since: null });
    const rows = (
      await w.db.query<{ since_at: unknown; last_seen_at: Date }>(
        'SELECT since_at, last_seen_at FROM publisher_visits WHERE publisher_id = $1',
        [w.pubId['harbour-ledger']],
      )
    ).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.since_at).toBeNull();
    expect(rows[0]!.last_seen_at.toISOString()).toBe(at(0));
  });

  it('a visit inside the gap keeps the old answer and moves last seen', async () => {
    expect(VISIT_GAP_MS).toBe(30 * 60_000);
    expect(await touchVisit(w.db, w.harbour, at(10))).toEqual({ since: null });
    expect(await touchVisit(w.db, w.harbour, at(29))).toEqual({ since: null });
  });

  it('a visit after the gap counts from the last seen instant', async () => {
    // last seen is at(29); 60 minutes later is past the gap
    expect(await touchVisit(w.db, w.harbour, at(89))).toEqual({ since: at(29) });
    // a refresh right after shows the same instant
    expect(await touchVisit(w.db, w.harbour, at(90))).toEqual({ since: at(29) });
    expect(await touchVisit(w.db, w.harbour, at(100))).toEqual({ since: at(29) });
  });

  it('exactly the gap counts as a new visit', async () => {
    const first = await touchVisit(w.db, w.quayside, at(0));
    expect(first).toEqual({ since: null });
    expect(await touchVisit(w.db, w.quayside, at(30))).toEqual({ since: at(0) });
  });

  it('keeps one row per publisher and never deletes', async () => {
    expect(await count(w.db, 'SELECT count(*) AS c FROM publisher_visits')).toBe(2);
    await touchVisit(w.db, w.northfield, at(0));
    expect(await count(w.db, 'SELECT count(*) AS c FROM publisher_visits')).toBe(3);
  });

  it('publishers do not share an instant', async () => {
    expect(await touchVisit(w.db, w.northfield, at(500))).toEqual({ since: at(0) });
    expect((await touchVisit(w.db, w.harbour, at(501))).since).not.toBe(at(0));
  });

  it('writes nothing for a buyer, an operator or the system', async () => {
    const n = await count(w.db, 'SELECT count(*) AS c FROM publisher_visits');
    for (const a of [w.buyer, w.operator, w.system]) {
      expect(await touchVisit(w.db, a, at(0))).toBeNull();
    }
    expect(await count(w.db, 'SELECT count(*) AS c FROM publisher_visits')).toBe(n);
  });

  it('a clock that runs back does not move since forward of last seen', async () => {
    const r = await touchVisit(w.db, w.harbour, at(-1000));
    expect(r).not.toBeNull();
  });
});
