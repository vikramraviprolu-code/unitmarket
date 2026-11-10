// CAT-2.1: collectionsOf is pure. An offer's collection is the topic, among its own topics, with the highest
// count in its publisher; ties go to the first by code unit; no topic goes to `other`. The cover is chosen
// among the given rows. Input order never changes the answer.
import { describe, expect, it } from 'vitest';
import { collectionsOf } from './collections';
import type { CollectionRow, TopicCounts } from './collections';

const counts = (o: Record<string, Record<string, number>>): TopicCounts =>
  new Map(Object.entries(o).map(([p, t]) => [p, new Map(Object.entries(t))]));
const row = (
  offer_id: string,
  topics: string[],
  mime = 'image/jpeg',
  publisher_id = 'p1',
): CollectionRow => ({ offer_id, publisher_id, topics, mime });

describe('1,000 photos with 6 topics', () => {
  const NAMES = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot'];
  const rows: CollectionRow[] = [];
  for (let i = 0; i < 1000; i++) {
    const id = `ofr_${String(i).padStart(4, '0')}`;
    // 996 photos carry one of 6 topics, 4 carry none.
    rows.push(row(id, i < 996 ? [NAMES[i % 6]!] : []));
  }
  const tc = counts({ p1: Object.fromEntries(NAMES.map((n) => [n, 166])) });

  it('gives 6 collections plus other', () => {
    const got = collectionsOf(rows, tc);
    expect(got.size).toBe(1000);
    const names = new Set([...got.values()].map((c) => c.name));
    expect(names).toEqual(new Set([...NAMES, 'other']));
    expect(got.get('ofr_0000')).toEqual({ name: 'alpha', size: 166, cover_offer_id: 'ofr_0000' });
    expect(got.get('ofr_0001')!.cover_offer_id).toBe('ofr_0001');
  });

  it('sizes other by the publisher offers with no topic', () => {
    const got = collectionsOf(rows, tc);
    expect(got.get('ofr_0999')).toEqual({ name: 'other', size: 4, cover_offer_id: 'ofr_0996' });
  });

  it('prefers an explicit count of topic-less offers over counting the rows', () => {
    const withOther = counts({ p1: { alpha: 166, '': 40 } });
    const got = collectionsOf([row('ofr_a', []), row('ofr_b', ['alpha'])], withOther);
    expect(got.get('ofr_a')).toEqual({ name: 'other', size: 40, cover_offer_id: 'ofr_a' });
  });

  it('gives the same answer for a shuffled input', () => {
    const shuffled = [...rows].sort(
      (a, b) => ((a.offer_id.charCodeAt(6) * 7919) % 13) - ((b.offer_id.charCodeAt(6) * 7919) % 13),
    );
    expect(shuffled.map((r) => r.offer_id)).not.toEqual(rows.map((r) => r.offer_id));
    expect([...collectionsOf(shuffled, tc)].sort()).toEqual([...collectionsOf(rows, tc)].sort());
    expect([...collectionsOf([...rows].reverse(), tc)].sort()).toEqual(
      [...collectionsOf(rows, tc)].sort(),
    );
  });
});

describe('the cover', () => {
  const tc = counts({ p1: { harbour: 9 } });
  it('is an image even when a non-image has a smaller id', () => {
    const got = collectionsOf(
      [
        row('ofr_a', ['harbour'], 'text/plain'),
        row('ofr_c', ['harbour'], 'image/png'),
        row('ofr_b', ['harbour'], 'image/jpeg'),
      ],
      tc,
    );
    expect(got.get('ofr_a')!.cover_offer_id).toBe('ofr_b');
    expect(got.get('ofr_c')!.cover_offer_id).toBe('ofr_b');
  });

  it('is the smallest id overall when none is an image', () => {
    const got = collectionsOf(
      [row('ofr_z', ['harbour'], 'text/plain'), row('ofr_m', ['harbour'], 'application/pdf')],
      tc,
    );
    expect(got.get('ofr_z')!.cover_offer_id).toBe('ofr_m');
  });

  it('compares ids by code unit, not by locale', () => {
    const got = collectionsOf([row('ofr_B', ['harbour']), row('ofr_a', ['harbour'])], tc);
    expect(got.get('ofr_a')!.cover_offer_id).toBe('ofr_B');
  });

  it('is chosen among the given rows and the collection of the publisher only', () => {
    const two = counts({ p1: { harbour: 9 }, p2: { harbour: 4 } });
    const got = collectionsOf(
      [
        row('ofr_2', ['harbour'], 'image/jpeg', 'p2'),
        row('ofr_1', ['harbour'], 'image/jpeg', 'p1'),
      ],
      two,
    );
    expect(got.get('ofr_2')).toEqual({ name: 'harbour', size: 4, cover_offer_id: 'ofr_2' });
    expect(got.get('ofr_1')).toEqual({ name: 'harbour', size: 9, cover_offer_id: 'ofr_1' });
  });
});

describe('the collection of one offer', () => {
  it('breaks a tie by the first topic by code unit', () => {
    const got = collectionsOf(
      [row('ofr_1', ['sea', 'harbour', 'tide'])],
      counts({ p1: { sea: 5, harbour: 5, tide: 5 } }),
    );
    expect(got.get('ofr_1')!.name).toBe('harbour');
  });

  it('takes the topic with the highest count', () => {
    const got = collectionsOf(
      [row('ofr_1', ['harbour', 'sea'])],
      counts({ p1: { harbour: 3, sea: 7 } }),
    );
    expect(got.get('ofr_1')).toEqual({ name: 'sea', size: 7, cover_offer_id: 'ofr_1' });
  });

  it('chooses only among the offer own topics', () => {
    const got = collectionsOf([row('ofr_1', ['small'])], counts({ p1: { small: 2, huge: 1000 } }));
    expect(got.get('ofr_1')!.name).toBe('small');
  });

  it('lower-cases and trims the topics, and ignores empty ones', () => {
    const got = collectionsOf(
      [row('ofr_1', ['  Harbour ', '', '   '])],
      counts({ p1: { harbour: 12 } }),
    );
    expect(got.get('ofr_1')).toEqual({ name: 'harbour', size: 12, cover_offer_id: 'ofr_1' });
  });

  it('puts an offer whose topics are all empty into other', () => {
    const got = collectionsOf([row('ofr_1', [' ']), row('ofr_2', [])], counts({}));
    expect(got.get('ofr_1')).toEqual({ name: 'other', size: 2, cover_offer_id: 'ofr_1' });
  });

  it('answers an empty map for no rows', () => {
    expect(collectionsOf([], counts({})).size).toBe(0);
  });
});

describe('the cover among many ids, in any order', () => {
  const tc = counts({ p1: { harbour: 9 } });
  const ids = ['ofr_d', 'ofr_b', 'ofr_e', 'ofr_a', 'ofr_c'];
  const orders = [ids, [...ids].reverse(), [ids[3]!, ids[1]!, ids[4]!, ids[0]!, ids[2]!]];
  it('is the smallest id for an image set and for a non-image set', () => {
    for (const o of orders) {
      const imgs = collectionsOf(
        o.map((id) => row(id, ['harbour'], 'image/png')),
        tc,
      );
      const docs = collectionsOf(
        o.map((id) => row(id, ['harbour'], 'application/pdf')),
        tc,
      );
      for (const id of ids) {
        expect(imgs.get(id)!.cover_offer_id).toBe('ofr_a');
        expect(docs.get(id)!.cover_offer_id).toBe('ofr_a');
      }
    }
  });

  it('picks the first topic by code unit among three, in any order, when counts are missing', () => {
    for (const t of [
      ['c', 'a', 'b'],
      ['a', 'b', 'c'],
      ['b', 'c', 'a'],
    ]) {
      expect(collectionsOf([row('ofr_1', t)], counts({})).get('ofr_1')).toEqual({
        name: 'a',
        size: 0,
        cover_offer_id: 'ofr_1',
      });
    }
  });

  it('treats the same topic written twice as one', () => {
    const got = collectionsOf([row('ofr_1', ['Sea', 'sea ', 'SEA'])], counts({ p1: { sea: 3 } }));
    expect(got.get('ofr_1')).toEqual({ name: 'sea', size: 3, cover_offer_id: 'ofr_1' });
  });

  it('gives a topic with count 0 a size of 0 and an unknown publisher a size of 0', () => {
    const got = collectionsOf(
      [row('ofr_1', ['sea'], 'image/png', 'p9')],
      counts({ p1: { sea: 4 } }),
    );
    expect(got.get('ofr_1')!.size).toBe(0);
  });
});

describe('a topic with no stored count loses to one with a count', () => {
  it('chooses b (count 1) over a (missing, so 0)', () => {
    const got = collectionsOf([row('ofr_1', ['a', 'b'])], counts({ p1: { b: 1 } }));
    expect(got.get('ofr_1')).toEqual({ name: 'b', size: 1, cover_offer_id: 'ofr_1' });
  });
});
