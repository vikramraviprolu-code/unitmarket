// FIX-PAY2 M-3: one lock order for every money transaction. PGlite serialises everything, so a
// deadlock cannot show here; this test records the statements of each transaction (a spy on the
// SqlExecutor) and asserts that the rows they lock follow the documented order, which a real
// Postgres needs to be free of deadlocks between the capture, the poll, the refund and the sweeper.
//
// The order (docs/READINESS.md "Lock order"): 1 orders (and provider_orders) -> 2 operations ->
// 3 order_units -> 4 refund_requests -> 4.5 recovery_cases -> 5 entitlements (and their windows and
// events) -> 6 ledger_entries and receipts. Alerts, audit and provider call rows are leaf inserts
// and are not part of the order. A recovery case (CO-4) locks the case, then the entitlement (credit),
// so it sits between the refund request and the entitlement; recovery's own tests run the spy on it.
import { afterEach, describe, expect, it } from 'vitest';
import type { PaymentsDeps, SqlExecutor } from '@umsbx/contracts';
import {
  executeRefund,
  onBuyerReturn,
  recoverOnStartup,
  requestRefund,
  runDue,
  suspectReversal,
} from './index';
import { BUYER_A, OPERATOR, approved, makeWorld, paid, sentCapture } from './ops/support';
import type { OpsWorld } from './ops/support';

let w: OpsWorld;
afterEach(async () => {
  await w?.close();
});
const H = 3_600_000;

const RANK: Record<string, number> = {
  orders: 1,
  provider_orders: 1,
  operations: 2,
  order_units: 3,
  refund_requests: 4,
  recovery_cases: 4.5,
  entitlements: 5,
  access_windows: 5,
  access_events: 5,
  access_links: 5,
  ledger_entries: 6,
  receipts: 6,
  receipt_versions: 6,
};

/** The table a statement locks or writes, or null when it takes no row lock in the order. */
export function lockTarget(sql: string): string | null {
  const s = sql.replace(/\s+/g, ' ').trim();
  const write = /^(?:UPDATE|INSERT INTO|DELETE FROM) (\w+)/i.exec(s);
  // A new recovery case row (INSERT) is a row nobody else can hold: no lock event (a case is opened
  // with its entitlement locked first; only UPDATE and FOR UPDATE of a case count).
  if (write !== null) {
    const table = write[1]!.toLowerCase();
    return table === 'recovery_cases' && /^INSERT/i.test(s) ? null : table;
  }
  if (!/ FOR UPDATE\b/i.test(s)) return null;
  const of = / FOR UPDATE OF (\w+)/i.exec(s);
  if (of !== null) {
    const alias = of[1]!;
    const hit = new RegExp(`(?:FROM|JOIN) (\\w+)(?: AS)? ${alias}\\b`, 'i').exec(s);
    return (hit?.[1] ?? alias).toLowerCase();
  }
  return /FROM (\w+)/i.exec(s)?.[1]?.toLowerCase() ?? null;
}

interface Tx {
  locks: { table: string; sql: string }[];
}
function spy(d: PaymentsDeps, log: Tx[]): PaymentsDeps {
  const wrap = (tx: SqlExecutor, rec: Tx): SqlExecutor => ({
    query: (sql, params) => {
      const t = lockTarget(sql);
      if (t !== null)
        rec.locks.push({ table: t, sql: sql.replace(/\s+/g, ' ').trim().slice(0, 110) });
      return tx.query(sql, params);
    },
    exec: (sql) => tx.exec(sql),
  });
  return {
    ...d,
    db: {
      ...d.db,
      transaction: (fn) => {
        const rec: Tx = { locks: [] };
        log.push(rec);
        return d.db.transaction((tx) => fn(wrap(tx, rec)));
      },
    },
  };
}

/**
 * A transaction may take the lock of a row class (the first statement that targets it) only when
 * no class of a higher rank is held yet. A later statement on a class that is already held takes
 * no new lock and is not an event.
 */
function violations(log: Tx[]): string[] {
  const bad: string[] = [];
  for (const tx of log) {
    const held = new Map<number, string>();
    for (const l of tx.locks) {
      const r = RANK[l.table];
      if (r === undefined) continue; // leaf tables: alerts, audit, provider calls
      if (held.has(r)) continue;
      const above = [...held.entries()].filter(([k]) => k > r);
      if (above.length > 0) {
        bad.push(`${l.table}(${r}) after rank ${above[0]![0]} [${above[0]![1]}] by [${l.sql}]`);
      }
      held.set(r, l.sql);
    }
  }
  return [...new Set(bad)];
}

describe('M-3: every money transaction locks in the documented order', () => {
  it('lockTarget reads the statements the code uses', () => {
    expect(lockTarget('SELECT * FROM orders WHERE id = $1 FOR UPDATE')).toBe('orders');
    expect(
      lockTarget(
        'SELECT u.id FROM order_units u JOIN orders o ON o.id = u.order_id WHERE u.id = $1 FOR UPDATE OF u',
      ),
    ).toBe('order_units');
    expect(lockTarget('UPDATE operations SET state = 1')).toBe('operations');
    expect(lockTarget('SELECT * FROM operations WHERE id = $1')).toBeNull();
  });

  it('capture, poll, retry, refund, read-back, sweep, recovery and reversal follow the order', async () => {
    w = await makeWorld();
    const log: Tx[] = [];
    const d = spy(w.deps, log);

    // Set-up (quotes expire at 12:00, so every order is made before the clock moves).
    const a = await approved(w);
    const b = await approved(w, { buyer_id: 'buy_A', offers: ['ofr_2'] });
    await sentCapture(w, { buyer_id: 'buy_B', offers: ['ofr_3'] });
    await paid(w, { buyer_id: 'buy_B' });
    const e = await approved(w, { buyer_id: 'buy_A', offers: ['ofr_3'] });

    // 1. A normal return (gate, record, apply).
    await onBuyerReturn(d, { order_ref: a.order_ref, actor: BUYER_A });

    // 2. A lost answer, the poll, the one re-send and its read.
    w.paypal.queue.capture.push({ kind: 'timeout' });
    await onBuyerReturn(d, { order_ref: b.order_ref, actor: BUYER_A });
    w.tick(60_000);
    await runDue(d, { max_items: 10 });

    // 3. A dead process: recovery marks the operation unknown and the pass reads.
    w.tick(61_000);
    await recoverOnStartup(d);

    // 4. Refunds: request, execute, a pending one read back later, a reversal, a dashboard refund.
    const unit = (
      await w.rows<{ id: string; capture_id: string | null }>(
        "SELECT id, capture_id FROM order_units WHERE status = 'captured_verified' ORDER BY id",
      )
    )[0]!;
    const r = await requestRefund(d, {
      unit_id: unit.id,
      amount: { currency: 'USD', minor: 100 },
      reason: 'x',
      actor: OPERATOR,
    });
    if (!r.ok) throw new Error('refund request refused');
    w.refundNext.status = 'PENDING';
    await executeRefund(d, { refund_request_id: r.value.refund_request_id });
    for (const f of w.refunds.values()) f.status = 'COMPLETED';
    w.refundNext.status = 'COMPLETED';
    for (let k = 0; k < 3; k += 1) {
      w.tick(H);
      await runDue(d, { max_items: 10 });
    }
    await suspectReversal(d, { capture_id: unit.capture_id as string, source: 'manual' });
    w.dashboardRefund(unit.capture_id as string, 1000);
    w.tick(H);
    await runDue(d, { max_items: 10 });

    // 5. The window ends on an order nobody can read.
    w.paypal.queue.capture.push({ kind: 'timeout' });
    await onBuyerReturn(d, { order_ref: e.order_ref, actor: BUYER_A });
    w.paypal.queue.get.push(
      ...Array.from({ length: 60 }, () => ({ kind: 'not_found' as const, debug_id: null })),
    );
    for (let k = 0; k < 30; k += 1) {
      w.tick(H);
      await runDue(d, { max_items: 10 });
    }

    expect(log.length).toBeGreaterThan(20);
    expect(violations(log)).toEqual([]);
  });
});
