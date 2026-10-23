// CO-5 (ASM-59) golden: the whole money transition table, 6 states x 7 events = 42 cells, against
// the hand-written file golden/money-table.golden.txt. "=" is an allowed no-op, "x" a refused
// event, a state name is the new money state. A change to the file is a change to the rules.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MoneyEventSchema, MoneyStateSchema } from '@umsbx/contracts';
import { nextMoneyState } from './table';

const EVENTS = [...MoneyEventSchema.options, 'partial_refund_verified'] as const;

describe('money transition table (golden)', () => {
  it('matches golden/money-table.golden.txt', () => {
    const lines = [`state | ${EVENTS.join(' | ')}`];
    for (const m of MoneyStateSchema.options) {
      lines.push(`${m} | ${EVENTS.map((e) => nextMoneyState(m, e)).join(' | ')}`);
    }
    const expected = readFileSync(
      new URL('./golden/money-table.golden.txt', import.meta.url),
      'utf8',
    )
      .split('\n')
      .filter((l) => l !== '' && !l.startsWith('#'));
    expect(lines).toEqual(expected);
  });
});
