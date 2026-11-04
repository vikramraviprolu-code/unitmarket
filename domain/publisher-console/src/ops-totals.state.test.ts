// MC2-L7 (D-084 item 5): the operator's booked totals per currency and stored environment, read only.
// PGlite with synthetic rows in USD, GBP and EUR. Sales and refunds are sums of ledger rows; exposure is
// what the publishers page already shows (paid and not refunded, plus held), summed over publishers.
// Nothing is converted here and nothing is written.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { opsTotalsFor } from './ops-totals';
import { publisherExposure } from './exposure';
import { makeWorld } from './world';
import type { World } from './world';

let w: World;
const OP = { kind: 'operator', operator_id: 'opr_x', mfa: true } as const;
const OP_NO_MFA = { kind: 'operator', operator_id: 'opr_y', mfa: false } as const;
const AT = '2026-10-22T12:00:00.000Z';

const TABLES = ['ledger_entries', 'orders', 'order_units', 'refund_requests', 'fx_rates'];
const counts = async (): Promise<number[]> =>
  Promise.all(
    TABLES.map(async (t) =>
      Number(
        (await w.db.query<{ c: string | number }>(`SELECT count(*) AS c FROM ${t}`)).rows[0]!.c,
      ),
    ),
  );

beforeAll(async () => {
  w = await makeWorld();
  const sale = async (
    n: number,
    publisher: 'pub_1' | 'pub_2',
    currency: 'USD' | 'EUR' | 'GBP',
    minor: number,
    over: { environment?: 'dryrun' | 'sandbox'; status?: string } = {},
  ) => {
    const u = await w.unit({ n, publisher, amount_minor: minor, currency, ...over });
    await w.ledger(u.unit_id, u.capture_id!, 'sale', minor);
    return u;
  };
  // USD dry run: 1000 and 500 sold, 150 of the 500 refunded; one pending 400 (held, no ledger row).
  await sale(1, 'pub_1', 'USD', 1000);
  const b = await sale(2, 'pub_2', 'USD', 500, { status: 'partially_refunded' });
  await w.ledger(b.unit_id, b.capture_id!, 'refund', 150, { refund_id: 'rf_b' });
  await w.db.query("UPDATE order_units SET refunded_minor = 150 WHERE id = 'unt_2'");
  await w.unit({ n: 3, publisher: 'pub_1', amount_minor: 400, status: 'pending', captured: false });
  // GBP dry run: 300 sold.
  await sale(4, 'pub_1', 'GBP', 300);
  // EUR dry run: 250 sold.
  await sale(5, 'pub_2', 'EUR', 250);
  // USD sandbox: its own row, never added to the dry run row.
  await sale(6, 'pub_1', 'USD', 700, { environment: 'sandbox' });
  // A declined unit has no ledger row and no exposure.
  await w.unit({ n: 7, publisher: 'pub_1', amount_minor: 99, status: 'declined', captured: false });
});
afterAll(async () => {
  await w.close();
});

describe('opsTotalsFor', () => {
  it('has one row per environment and currency with sales, refunds and exposure', async () => {
    const rows = await opsTotalsFor(w.db, OP);
    expect(rows).toEqual([
      {
        environment: 'dryrun',
        currency: 'EUR',
        sales_minor: 250,
        refunds_minor: 0,
        exposure_minor: 250,
      },
      {
        environment: 'dryrun',
        currency: 'GBP',
        sales_minor: 300,
        refunds_minor: 0,
        exposure_minor: 300,
      },
      // exposure: 1000 + (500 - 150) paid and not refunded, plus 400 held.
      {
        environment: 'dryrun',
        currency: 'USD',
        sales_minor: 1500,
        refunds_minor: 150,
        exposure_minor: 1750,
      },
      {
        environment: 'sandbox',
        currency: 'USD',
        sales_minor: 700,
        refunds_minor: 0,
        exposure_minor: 700,
      },
    ]);
  });

  it('the exposure is the sum of the publishers page blocks (same numbers by construction)', async () => {
    const rows = (await opsTotalsFor(w.db, OP))!;
    const pubs = (await publisherExposure(w.db, OP, AT, {
      own_merchant_id: 'OWNERMERCH001',
      environment: 'dryrun',
    }))!;
    for (const r of rows) {
      const blocks = pubs
        .flatMap((p) => p.by_currency)
        .filter((x) => x.currency === r.currency && x.environment === r.environment);
      const sum = blocks.reduce((t, x) => t + x.captured_not_refunded_minor + x.held_minor, 0);
      expect(r.exposure_minor).toBe(sum);
    }
  });

  it('an operator without the second factor sees the same orders-level totals; any other actor gets null', async () => {
    expect(await opsTotalsFor(w.db, OP_NO_MFA)).toEqual(await opsTotalsFor(w.db, OP));
    expect(await opsTotalsFor(w.db, { kind: 'publisher', publisher_id: 'pub_1' })).toBeNull();
    expect(await opsTotalsFor(w.db, { kind: 'buyer', buyer_id: 'buy_1' })).toBeNull();
  });

  it('is read only: no table gains or loses a row', async () => {
    const before = await counts();
    await opsTotalsFor(w.db, OP);
    expect(await counts()).toEqual(before);
  });

  it('an empty database gives no rows', async () => {
    const empty = await makeWorld();
    try {
      expect(await opsTotalsFor(empty.db, OP)).toEqual([]);
    } finally {
      await empty.close();
    }
  });
});
