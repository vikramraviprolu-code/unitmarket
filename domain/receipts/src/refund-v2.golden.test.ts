// CO-4 golden: receipt version 2 after a partial refund. One order of two items (4.00 keep, 2.50
// online) on one unit, a refund of 2.00 booked by refund id, the receipt issued again. The rendered
// lines are compared with the hand-reviewed file golden/refund-v2.golden.txt. Version 1 must be
// unchanged by the refund. A change to the file is a change to what the buyer is shown for a refund.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { getReceiptForBuyer, issueReceiptIfChanged } from './index';
import { makeWorld } from './world';

const money = (m: { currency: string; minor: number }): string =>
  `${m.currency} ${(m.minor / 100).toFixed(2)}`;

describe('receipt version 2 after a partial refund (golden)', () => {
  it('matches golden/refund-v2.golden.txt', async () => {
    const w = await makeWorld('rcg');
    try {
      const o = await w.order(1);
      const issue = () =>
        w.db.transaction((tx) => issueReceiptIfChanged(tx, w.deps, { order_id: o.order_id }));
      await issue();
      w.clock.advance(3_600_000);
      const booked = await w.refund(o, 'SBXGOLDENREF01', 200);
      expect(booked.ok).toBe(true);
      await issue();
      const v1 = (await getReceiptForBuyer(w.db, {
        order_id: o.order_id,
        buyer_id: 'buy_A',
        version: 1,
      }))!;
      const v2 = (await getReceiptForBuyer(w.db, { order_id: o.order_id, buyer_id: 'buy_A' }))!;
      const lines = [
        `version: ${v2.version}`,
        `environment: ${v2.environment}`,
        `total: ${money({ currency: v2.snapshot.currency, minor: v2.snapshot.total_minor })}`,
        ...v2.lines.map(
          (l) =>
            `line: ${l.article_id} | ${l.option} | ${money({ currency: v2.snapshot.currency, minor: l.amount_minor })} | window=${l.window.state}`,
        ),
        ...v2.refunds.map((r) => `refund: ${r.refund_id} | ${money(r.amount)} | at ${r.at}`),
        `debug_ids: ${v2.debug_ids.join(',')}`,
        `v1 refunds: ${v1.refunds.length}`,
        `v1 sha256: ${v1.sha256}`,
        `v2 sha256: ${v2.sha256}`,
      ];
      const expected = readFileSync(
        new URL('./golden/refund-v2.golden.txt', import.meta.url),
        'utf8',
      )
        .split('\n')
        .filter((l) => l !== '' && !l.startsWith('#'));
      expect(lines).toEqual(expected);
      expect(v1.sha256).not.toBe(v2.sha256);
    } finally {
      await w.close();
    }
  });
});
