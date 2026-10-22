// FIX-PAY2 LOW: rows of one instant are ordered by their insertion sequence (access_events.seq,
// migration 0008), never by the physical position ctid, which changes with vacuum and updates.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8');

describe('event ordering', () => {
  it('INV4 (payments) and the recovery case reader do not order by ctid', () => {
    expect(read('./invariants.ts')).not.toMatch(/\bctid\b/);
    expect(read('../../recovery/src/cases.ts')).not.toMatch(/\bctid\b/);
  });
  it('they order access events by at, seq', () => {
    expect(read('./invariants.ts')).toMatch(
      /FROM access_events WHERE entitlement_id = \$1 ORDER BY at, seq/,
    );
    expect(read('../../recovery/src/cases.ts')).toMatch(
      /FROM access_events WHERE entitlement_id = \$1 ORDER BY at, seq/,
    );
  });
});
