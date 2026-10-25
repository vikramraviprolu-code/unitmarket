// CO-Gb (gate review M2): a database fault while a completed refund is booked must not be treated as a
// rule of the ledger. `bookEntry` turns only a LedgerRuleError into an alert; any other error must
// leave the transaction, so the booking rolls back whole and the next read-back books the refund once.
// Kills the mutant at the `instanceof LedgerRuleError` check in refunds.ts. Real PGlite, scripted
// PayPal, synthetic rows only.
import { afterEach, describe, expect, it } from 'vitest';
import type { Database, SqlExecutor } from '@umsbx/contracts';
import { executeRefund, requestRefund } from './index';
import { readBack } from './refunds';
import { OPERATOR, makeWorld, paid } from './ops/support';
import type { OpsWorld } from './ops/support';

let w: OpsWorld;
afterEach(async () => {
  await w.close();
});

/** The same database, except that while `armed.on` an insert into the ledger fails with a plain Error. */
function failingLedger(real: Database, armed: { on: boolean; hits: number }): Database {
  const guard = (tx: SqlExecutor): SqlExecutor => ({
    exec: (sql) => tx.exec(sql),
    query: (sql, params) => {
      if (armed.on && /INSERT INTO ledger_entries/i.test(sql)) {
        armed.hits += 1;
        return Promise.reject(new Error('disk full (injected, not a ledger rule)'));
      }
      return tx.query(sql, params);
    },
  });
  return {
    dialect: real.dialect,
    exec: (sql) => real.exec(sql),
    query: (sql, params) => real.query(sql, params),
    transaction: (fn) => real.transaction((tx) => fn(guard(tx))),
  };
}

describe('a plain database error while booking a completed refund', () => {
  it('rejects, rolls back (request pending, no ledger row, no ledger_rule alert), and the next read-back books it once', async () => {
    w = await makeWorld();
    const a = await paid(w);
    const unit_id = (
      await w.rows<{ id: string }>('SELECT id FROM order_units WHERE order_id = $1', [a.order_id])
    )[0]!.id;
    const armed = { on: true, hits: 0 };
    const deps = { ...w.deps, db: failingLedger(w.deps.db, armed) };

    const asked = await requestRefund(deps, {
      unit_id,
      amount: { currency: 'USD', minor: 100 },
      reason: 'x',
      actor: OPERATOR,
    });
    if (!asked.ok) throw new Error(`refused: ${asked.error.code}`);
    const id = asked.value.refund_request_id;

    // PayPal completes the refund; the read-back's booking meets the database fault and must throw.
    await expect(executeRefund(deps, { refund_request_id: id })).rejects.toThrow(/disk full/);
    expect(armed.hits).toBe(1);
    expect(w.refundCalls).toHaveLength(1);

    // rolled back: the request is still pending, nothing is booked, no alert says a ledger rule failed
    expect(
      await w.rows<{ state: string; refund_id: string | null }>(
        'SELECT state, refund_id FROM refund_requests WHERE id = $1',
        [id],
      ),
    ).toEqual([{ state: 'pending', refund_id: expect.any(String) }]);
    expect(await w.rows("SELECT 1 FROM ledger_entries WHERE kind = 'refund'")).toEqual([]);
    expect(
      await w.rows("SELECT 1 FROM alerts WHERE detail ->> 'reason' LIKE $1", ['ledger_rule%']),
    ).toEqual([]);
    expect(
      (
        await w.rows<{ status: string; refunded_minor: number }>(
          'SELECT status, refunded_minor FROM order_units WHERE id = $1',
          [unit_id],
        )
      )[0],
    ).toMatchObject({ status: 'captured_verified', refunded_minor: 0 });

    // the fault clears; the next read-back books the refund exactly once, and a third does nothing more
    armed.on = false;
    expect(await readBack(deps, id)).toEqual({ ok: true, value: { status: 'COMPLETED' } });
    expect(await readBack(deps, id)).toEqual({ ok: true, value: { status: 'COMPLETED' } });
    const ledger = await w.rows<{ amount_minor: number }>(
      "SELECT amount_minor FROM ledger_entries WHERE kind = 'refund'",
    );
    expect(ledger.map((r) => Number(r.amount_minor))).toEqual([100]);
    expect(
      (await w.rows<{ state: string }>('SELECT state FROM refund_requests WHERE id = $1', [id]))[0]!
        .state,
    ).toBe('completed');
    expect(
      (
        await w.rows<{ status: string; refunded_minor: number }>(
          'SELECT status, refunded_minor FROM order_units WHERE id = $1',
          [unit_id],
        )
      )[0],
    ).toMatchObject({ status: 'partially_refunded', refunded_minor: 100 });
    expect(
      await w.rows("SELECT 1 FROM alerts WHERE detail ->> 'reason' LIKE $1", ['ledger_rule%']),
    ).toEqual([]);
  });
});
