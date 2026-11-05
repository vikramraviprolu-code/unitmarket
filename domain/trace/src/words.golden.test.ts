// INT-TR1 / TR1.1: every event type the journal can write has words. The set of types is the one TR0 writes:
// `<tracked table>.created`, `.updated` and `.imported`. An unmapped type fails here and at run time.
import { describe, expect, it } from 'vitest';
import { TRACKED_TABLES } from '@umsbx/contracts';
import { EVENT_TYPES, WORDS, wordsFor, wordsKeyOf } from './words';

describe('words for every journal event type', () => {
  it('EVENT_TYPES is every tracked table times created, updated and imported', () => {
    const want = TRACKED_TABLES.flatMap((t) =>
      ['created', 'updated', 'imported'].map((o) => `${t.table}.${o}`),
    );
    expect([...EVENT_TYPES].sort()).toEqual(want.sort());
  });
  it.each(EVENT_TYPES)('%s has a sentence', (type) => {
    const words = wordsFor(wordsKeyOf(type, null, null));
    expect(words).toMatch(/^[A-Z].*\.$/);
    expect(words.length).toBeLessThan(120);
  });
  it('every sentence follows D-051: no dash, no italics, no markdown', () => {
    for (const [k, v] of Object.entries(WORDS)) {
      expect(v, k).not.toMatch(/[-–—*_`]/);
    }
  });
  it('a state or access kind with its own sentence refines the key, otherwise the base key stays', () => {
    expect(wordsKeyOf('orders.updated', 'paid', null)).toBe('orders.updated:paid');
    expect(wordsKeyOf('orders.updated', 'some_new_state', null)).toBe('orders.updated');
    expect(wordsKeyOf('access_events.created', null, 'download_completed')).toBe(
      'access_events.created:download_completed',
    );
    expect(wordsKeyOf('ledger_entries.created', null, null)).toBe('ledger_entries.created');
  });
  it('an unmapped event type throws instead of showing a blank', () => {
    expect(() => wordsKeyOf('unknown_table.updated', null, null)).toThrow(/unmapped/);
    expect(() => wordsFor('nope')).toThrow(/unmapped/);
  });
  it('no sentence holds an id, a name or an amount', () => {
    for (const v of Object.values(WORDS)) expect(v).not.toMatch(/\d|ord_|buy_|pub_/);
  });
});
