// INT-UI0 / UI0.5: one dictionary gives every raw order, unit, refund and case state a word, a meaning, who
// acts next and a usual time. The key sets are read from the contracts, so a new state fails this test until
// it has words. The six group words (paid, refunded and so on) are SR0's STATUS_GROUPS; they are not here.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CaseStateSchema,
  OrderStatusSchema,
  REFUND_REQUEST_STATES,
  UnitStatusSchema,
} from '@umsbx/contracts';
import { STATUS_ACTORS, STATUS_DICTIONARY, statusEntry } from './lib/status-dictionary';

const sorted = (xs: readonly string[]) => [...xs].sort();

describe('the dictionary covers every state, exactly', () => {
  it('order statuses', () => {
    expect(sorted(Object.keys(STATUS_DICTIONARY.order))).toEqual(sorted(OrderStatusSchema.options));
  });
  it('unit statuses', () => {
    expect(sorted(Object.keys(STATUS_DICTIONARY.unit))).toEqual(sorted(UnitStatusSchema.options));
  });
  it('refund request states', () => {
    expect(sorted(Object.keys(STATUS_DICTIONARY.refund))).toEqual(sorted(REFUND_REQUEST_STATES));
  });
  it('case states', () => {
    expect(sorted(Object.keys(STATUS_DICTIONARY.case))).toEqual(sorted(CaseStateSchema.options));
  });
  it('has four families and no other', () => {
    expect(Object.keys(STATUS_DICTIONARY)).toEqual(['order', 'unit', 'refund', 'case']);
  });
});

describe('REFUND_REQUEST_STATES comes from the code that writes them', () => {
  // refund_requests.state has no database CHECK (migration 0004 line 220), so the list is read from
  // domain/payments/src/refunds.ts: every state it writes is in the const, and the const holds no other.
  const here = fileURLToPath(new URL('.', import.meta.url));
  const src = readFileSync(join(here, '../../../domain/payments/src/refunds.ts'), 'utf8');
  const written = new Set<string>();
  for (const m of src.matchAll(/UPDATE refund_requests SET[^`"']*?state = '([a-z_]+)'/g))
    written.add(m[1]!);
  for (const m of src.matchAll(/VALUES \([^)]*'([a-z_]+)', NULL/g)) written.add(m[1]!);
  for (const m of src.matchAll(/\? '([a-z_]+)' : '([a-z_]+)'/g)) {
    written.add(m[1]!);
    written.add(m[2]!);
  }
  it('finds the states in the source', () => {
    expect(written.size).toBeGreaterThanOrEqual(7);
  });
  it('every state the source writes is in the const', () => {
    for (const s of written) expect(REFUND_REQUEST_STATES, s).toContain(s);
  });
  it('the const holds the eight cited states and the one the engine writes on a PayPal refusal', () => {
    expect(sorted(REFUND_REQUEST_STATES)).toEqual(
      sorted([
        'requested',
        'sent',
        'unknown',
        'pending',
        'unresolved',
        'completed',
        'failed',
        'cancelled',
        'rejected',
      ]),
    );
  });
});

describe('each entry', () => {
  const all = Object.entries(STATUS_DICTIONARY).flatMap(([family, entries]) =>
    Object.entries(entries).map(([state, e]) => ({ family, state, e })),
  );
  it('has 36 entries (10 order, 9 unit, 9 refund, 8 case)', () => {
    expect(all).toHaveLength(36);
  });
  it.each(all.map((x) => [`${x.family}.${x.state}`, x.e] as const))(
    '%s has a word, a meaning, who acts next and a usual time',
    (_k, e) => {
      expect(e.word.length).toBeGreaterThan(1);
      expect(e.word.length).toBeLessThanOrEqual(24);
      expect(e.meaning).toMatch(/^[A-Z][^.]*\.$/);
      expect(STATUS_ACTORS).toContain(e.next);
      expect(e.usual.length).toBeGreaterThan(1);
      for (const t of [e.word, e.meaning, e.usual]) {
        expect(t).not.toMatch(/[‒-―]|--|\s-\s/);
        expect(t).not.toMatch(/_/);
      }
    },
  );
  it('a word is unique inside its family, so two states are never told apart by colour alone', () => {
    for (const entries of Object.values(STATUS_DICTIONARY)) {
      const words = Object.values(entries).map((e) => e.word);
      expect(new Set(words).size).toBe(words.length);
    }
  });
  it('a settled state says nobody acts next', () => {
    expect(STATUS_DICTIONARY.order.paid.next).toBe('Nobody');
    expect(STATUS_DICTIONARY.order.abandoned.next).toBe('Nobody');
    expect(STATUS_DICTIONARY.unit.refunded.next).toBe('Nobody');
    expect(STATUS_DICTIONARY.refund.completed.next).toBe('Nobody');
    expect(STATUS_DICTIONARY.case.closed.next).toBe('Nobody');
  });
  it('an order waiting on the buyer says the buyer acts next, and a frozen order says an operator', () => {
    expect(STATUS_DICTIONARY.order.awaiting_buyer.next).toBe('Buyer');
    expect(STATUS_DICTIONARY.order.frozen.next).toBe('Operator');
    expect(STATUS_DICTIONARY.order.unresolved.next).toBe('Operator');
  });
});

describe('statusEntry', () => {
  it('looks a state up by family', () => {
    expect(statusEntry('order', 'awaiting_buyer')?.word).toBe(
      STATUS_DICTIONARY.order.awaiting_buyer.word,
    );
  });
  it('returns null for a state it does not know, so the caller falls back to the raw word', () => {
    expect(statusEntry('order', 'not_a_state')).toBeNull();
    expect(statusEntry('order', '__proto__')).toBeNull();
    expect(statusEntry('order', 'constructor')).toBeNull();
  });
});
