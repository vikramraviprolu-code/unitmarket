// MC2-L7 (D-084 item 5): the reporting totals never change what a seller sees. The statement and the CSV
// exports of a publisher with sales in USD, GBP and EUR stay in the original currency, one block each,
// with no converted figure and no rate. These literals were taken from the code before MC2-L7; the test
// passes before and after the change.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { salesExport, statementExport } from './csv';
import { salesFor } from './sales';
import { statementFor } from './statement';
import { makeWorld } from './world';
import type { World } from './world';

let w: World;
const P1 = { kind: 'publisher', publisher_id: 'pub_1' } as const;

beforeAll(async () => {
  w = await makeWorld();
  const sale = async (n: number, currency: 'USD' | 'EUR' | 'GBP', minor: number) => {
    const u = await w.unit({ n, publisher: 'pub_1', amount_minor: minor, currency });
    await w.ledger(u.unit_id, u.capture_id!, 'sale', minor);
    return u;
  };
  await sale(1, 'USD', 1000);
  const gbp = await sale(2, 'GBP', 300);
  await sale(3, 'EUR', 250);
  await w.ledger(gbp.unit_id, gbp.capture_id!, 'refund', 100, { refund_id: 'rf_g' });
});
afterAll(async () => {
  await w.close();
});

const STATEMENT_CSV =
  'date,order_ref_last6,kind,currency,amount_minor,amount,environment\r\n' +
  '2026-10-22T10:00:00.000Z,abc003,sale,EUR,250,2.50,dryrun\r\n' +
  ',,total_sales,EUR,250,2.50,dryrun\r\n' +
  ',,total_refunds,EUR,0,0.00,dryrun\r\n' +
  ',,total_reversals,EUR,0,0.00,dryrun\r\n' +
  ',,total_net,EUR,250,2.50,dryrun\r\n' +
  '2026-10-22T10:00:00.000Z,abc002,sale,GBP,300,3.00,dryrun\r\n' +
  '2026-10-22T10:00:00.000Z,abc002,refund,GBP,100,1.00,dryrun\r\n' +
  ',,total_sales,GBP,300,3.00,dryrun\r\n' +
  ',,total_refunds,GBP,100,1.00,dryrun\r\n' +
  ',,total_reversals,GBP,0,0.00,dryrun\r\n' +
  ',,total_net,GBP,200,2.00,dryrun\r\n' +
  '2026-10-22T10:00:00.000Z,abc001,sale,USD,1000,10.00,dryrun\r\n' +
  ',,total_sales,USD,1000,10.00,dryrun\r\n' +
  ',,total_refunds,USD,0,0.00,dryrun\r\n' +
  ',,total_reversals,USD,0,0.00,dryrun\r\n' +
  ',,total_net,USD,1000,10.00,dryrun\r\n';

const SALES_CSV =
  'date,order_ref_last6,article,access,currency,amount_minor,amount,paypal_fee_minor,paypal_fee,status,environment\r\n' +
  '2026-10-22T10:03:00.000Z,abc003,Article 3,keep_retrieve,EUR,250,2.50,,,Paid,dryrun\r\n' +
  '2026-10-22T10:02:00.000Z,abc002,Article 2,keep_retrieve,GBP,300,3.00,,,Paid,dryrun\r\n' +
  '2026-10-22T10:01:00.000Z,abc001,Article 1,keep_retrieve,USD,1000,10.00,,,Paid,dryrun\r\n';

describe('seller statement and CSV exports (pinned, original currency)', () => {
  it('the statement export is the same literal, one block per currency, nothing converted', async () => {
    const st = await statementFor(w.db, P1, {
      own_merchant_id: 'OWNERMERCH001',
      environment: 'dryrun',
    });
    expect(st.blocks.map((b) => b.currency)).toEqual(['EUR', 'GBP', 'USD']);
    expect(statementExport(st)).toEqual({ csv: STATEMENT_CSV, truncated: false });
  });

  it('the sales export is the same literal', async () => {
    expect(salesExport(await salesFor(w.db, P1))).toEqual({ csv: SALES_CSV, truncated: false });
  });

  it('neither export carries a rate, an about or a reporting column', () => {
    for (const csv of [STATEMENT_CSV, SALES_CSV]) {
      expect(csv).not.toMatch(/about|rate|reporting|converted/i);
    }
  });
});
