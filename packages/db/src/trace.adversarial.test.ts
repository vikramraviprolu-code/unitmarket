// INT-TR0 / TR0.5: tamper tests. Each case switches the guard triggers off (test target only, the way an
// attacker with table rights but no trigger rights could not), changes the data one way, and expects
// trace_verify to name the chain and the row. Every case runs in a transaction that is rolled back, so one
// seeded database serves them all. One case per check: chain, head, seal, digest, drift (R2-7).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SqlExecutor } from '@umsbx/contracts';
import { traceInvariants, verifyTrace } from './trace-verify';
import type { TraceFinding, TraceReport } from './trace-verify';
import {
  EVENTS_GUARD,
  captureOf,
  chainOf,
  freshDb,
  ins,
  j,
  seedWorld,
  updateWorld,
} from './trace-test-support';
import type { Db } from './trace-test-support';

let db: Db;
beforeAll(async () => {
  db = await freshDb();
  await seedWorld(db);
  await updateWorld(db);
});
afterAll(async () => {
  await db.close();
});

class Rollback extends Error {}

/** Runs `fn` with the named triggers off inside a transaction, verifies, rolls everything back. */
async function tampered(
  triggers: { table: string; trigger: string }[],
  fn: (tx: SqlExecutor) => Promise<void>,
): Promise<TraceReport> {
  let report: TraceReport | undefined;
  await db
    .transaction(async (tx) => {
      for (const t of triggers)
        await tx.exec(`ALTER TABLE ${t.table} DISABLE TRIGGER ${t.trigger}`);
      await fn(tx);
      report = await verifyTrace(tx);
      throw new Rollback();
    })
    .catch((e: unknown) => {
      if (!(e instanceof Rollback)) throw e;
    });
  return report!;
}

const seqOf = async (table: string, id: string, chain = 'ord:ord_1'): Promise<number> =>
  (
    await db.query<{ seq: number }>(
      'SELECT seq::int FROM trace_events WHERE chain_key = $1 AND source_table = $2 AND source_id = $3 ORDER BY seq LIMIT 1',
      [chain, table, id],
    )
  ).rows[0]!.seq;

const named = (r: TraceReport, check: string, chain: string, seq?: number): TraceFinding[] =>
  r.findings.filter(
    (f) => f.check === check && f.chain_key === chain && (seq === undefined || f.seq === seq),
  );

describe('the control: nothing is reported on the untouched journal', () => {
  it('and the rollback leaves it untouched', async () => {
    const r = await tampered([EVENTS_GUARD], async (tx) => {
      await tx.exec(
        "UPDATE trace_events SET mfa = NOT mfa WHERE chain_key = 'ord:ord_1' AND seq = 2",
      );
    });
    expect(r.findings.length).toBeGreaterThan(0);
    expect((await verifyTrace(db)).findings).toEqual([]);
  });
});

describe('check chain: the journal itself', () => {
  it('a journal body edited in place is reported at that chain and seq', async () => {
    const r = await tampered([EVENTS_GUARD], async (tx) => {
      await tx.exec(
        `UPDATE trace_events SET body = jsonb_set(body, '{cols,status}', '["paid","refunded"]'::jsonb) WHERE chain_key = 'ord:ord_1' AND seq = 3`,
      );
    });
    const hit = named(r, 'chain', 'ord:ord_1', 3);
    expect(hit).toHaveLength(1);
    expect(hit[0]!.detail).toMatch(/row_hash/);
  });

  it('mfa flipped on a row is reported at that row', async () => {
    const r = await tampered([EVENTS_GUARD], async (tx) => {
      await tx.exec(
        "UPDATE trace_events SET mfa = NOT mfa WHERE chain_key = 'buy:buy_1' AND seq = 1",
      );
    });
    expect(named(r, 'chain', 'buy:buy_1', 1)).toHaveLength(1);
  });

  it('on_behalf_of changed on a row is reported at that row', async () => {
    const r = await tampered([EVENTS_GUARD], async (tx) => {
      await tx.exec(
        "UPDATE trace_events SET on_behalf_of = 'buy_2' WHERE chain_key = 'ord:ord_1' AND seq = 4",
      );
    });
    expect(named(r, 'chain', 'ord:ord_1', 4)).toHaveLength(1);
  });

  it('actor_kind rewritten from operator to system is reported', async () => {
    const r = await tampered([EVENTS_GUARD], async (tx) => {
      await tx.exec(
        "UPDATE trace_events SET actor_kind = 'system', actor_id = NULL WHERE chain_key = 'plat' AND seq = 8",
      );
    });
    expect(named(r, 'chain', 'plat', 8).length).toBeGreaterThan(0);
  });

  it('a row deleted from the middle is reported where the chain jumps', async () => {
    const r = await tampered([EVENTS_GUARD], async (tx) => {
      await tx.exec("DELETE FROM trace_events WHERE chain_key = 'ord:ord_1' AND seq = 5");
    });
    const hit = r.findings.filter(
      (f) => f.chain_key === 'ord:ord_1' && (f.seq === 5 || f.seq === 6),
    );
    expect(hit.length).toBeGreaterThan(0);
    expect(hit.some((f) => /seq|prev_hash|gap/.test(f.detail))).toBe(true);
  });

  it('two seqs swapped are reported on both rows', async () => {
    const r = await tampered([EVENTS_GUARD], async (tx) => {
      await tx.exec(
        `UPDATE trace_events SET seq = seq + 1000 WHERE chain_key = 'ord:ord_1' AND seq IN (2, 3)`,
      );
      await tx.exec(
        `UPDATE trace_events SET seq = CASE seq WHEN 1002 THEN 3 ELSE 2 END WHERE chain_key = 'ord:ord_1' AND seq IN (1002, 1003)`,
      );
    });
    expect(
      named(r, 'chain', 'ord:ord_1', 2).length + named(r, 'chain', 'ord:ord_1', 3).length,
    ).toBeGreaterThanOrEqual(2);
  });

  it('a forged row appended to a chain with the wrong prev_hash is reported', async () => {
    const last = (await chainOf(db, 'buy:buy_1')).at(-1)!;
    const r = await tampered([], async (tx) => {
      await tx.query(
        `INSERT INTO trace_events (chain_key, seq, prev_hash, row_hash, occurred_at, actor_kind, mfa, event_type, source_table, source_id, body)
         VALUES ('buy:buy_1', $1, $2, $3, '2026-11-04T12:00:00Z', 'operator', true, 'approvals.updated', 'approvals', 'apr_1', '{"op":"updated","n":99,"cols":{},"hashed":{}}')`,
        [last.seq + 1, 'd'.repeat(64), 'e'.repeat(64)],
      );
    });
    expect(named(r, 'chain', 'buy:buy_1', last.seq + 1).length).toBeGreaterThan(0);
  });
});

describe('check head', () => {
  it('a head that points past the last row is reported', async () => {
    const r = await tampered([], async (tx) => {
      await tx.exec("UPDATE trace_heads SET seq = seq + 1 WHERE chain_key = 'ord:ord_1'");
    });
    expect(named(r, 'head', 'ord:ord_1').length).toBeGreaterThan(0);
  });

  it('a head whose hash is not the last row’s hash is reported', async () => {
    const r = await tampered([], async (tx) => {
      await tx.exec(
        `UPDATE trace_heads SET row_hash = '${'9'.repeat(64)}' WHERE chain_key = 'mdt:man_1'`,
      );
    });
    expect(named(r, 'head', 'mdt:man_1').length).toBeGreaterThan(0);
  });

  it('a chain with rows and no head is reported', async () => {
    const r = await tampered([], async (tx) => {
      await tx.exec("DELETE FROM trace_heads WHERE chain_key = 'key:key_1'");
    });
    expect(named(r, 'head', 'key:key_1').length).toBeGreaterThan(0);
  });
});

describe('check seal: a sealed tail cannot be cut', () => {
  // A seal written by hand, not by trace_seal(): heads read from trace_heads, root from the spec formula.
  const handSeal = async (tx: SqlExecutor): Promise<void> => {
    await tx.exec(`
      INSERT INTO trace_seals (day, at, prev_root_hash, heads, root_hash)
      SELECT d, '2026-11-05T00:00:05Z', z, h,
             encode(sha256(convert_to(z || '|' || d::text || '|' || h::text, 'UTF8')), 'hex')
        FROM (SELECT DATE '2026-11-04' AS d, repeat('0', 64) AS z,
                     (SELECT jsonb_agg(jsonb_build_object('chain_key', chain_key, 'seq', seq, 'row_hash', row_hash) ORDER BY chain_key COLLATE "C") FROM trace_heads) AS h) s`);
  };

  it('the hand written seal itself verifies', async () => {
    const r = await tampered([], handSeal);
    expect(r.findings).toEqual([]);
    expect(r.seals).toBe(1);
  });

  it('deleting the sealed tail and rewinding its head is reported', async () => {
    const r = await tampered([EVENTS_GUARD], async (tx) => {
      await handSeal(tx);
      const n = (
        await tx.query<{ seq: number }>(
          "SELECT seq::int FROM trace_heads WHERE chain_key = 'ord:ord_1'",
        )
      ).rows[0]!.seq;
      await tx.exec(`DELETE FROM trace_events WHERE chain_key = 'ord:ord_1' AND seq = ${n}`);
      await tx.exec(
        `UPDATE trace_heads h SET seq = e.seq, row_hash = e.row_hash FROM trace_events e
          WHERE h.chain_key = 'ord:ord_1' AND e.chain_key = h.chain_key AND e.seq = ${n - 1}`,
      );
    });
    const hit = named(r, 'seal', 'ord:ord_1');
    expect(hit.length).toBeGreaterThan(0);
    expect(hit[0]!.detail).toMatch(/sealed/);
  });

  it('a seal whose root was edited is reported', async () => {
    const r = await tampered(
      [{ table: 'trace_seals', trigger: 'trace_seals_append_only' }],
      async (tx) => {
        await handSeal(tx);
        await tx.exec(`UPDATE trace_seals SET root_hash = '${'1'.repeat(64)}'`);
      },
    );
    expect(r.findings.some((f) => f.check === 'seal' && /root/.test(f.detail))).toBe(true);
  });

  it('a sealed head whose row was rewritten later is reported at that row', async () => {
    const r = await tampered([EVENTS_GUARD], async (tx) => {
      await handSeal(tx);
      const n = (
        await tx.query<{ seq: number }>(
          "SELECT seq::int FROM trace_heads WHERE chain_key = 'mdt:man_1'",
        )
      ).rows[0]!.seq;
      await tx.exec(
        `UPDATE trace_events SET mfa = NOT mfa WHERE chain_key = 'mdt:man_1' AND seq = ${n}`,
      );
    });
    expect(
      named(r, 'seal', 'mdt:man_1').length + named(r, 'chain', 'mdt:man_1').length,
    ).toBeGreaterThanOrEqual(1);
  });

  it('documented limit: before any seal a cut tail with a rewound head is not detectable', async () => {
    const r = await tampered([EVENTS_GUARD], async (tx) => {
      const n = (
        await tx.query<{ seq: number }>(
          "SELECT seq::int FROM trace_heads WHERE chain_key = 'key:key_1'",
        )
      ).rows[0]!.seq;
      await tx.exec(`DELETE FROM trace_events WHERE chain_key = 'key:key_1' AND seq = ${n}`);
      await tx.exec(
        `UPDATE trace_heads h SET seq = e.seq, row_hash = e.row_hash FROM trace_events e
          WHERE h.chain_key = 'key:key_1' AND e.chain_key = h.chain_key AND e.seq = ${n - 1}`,
      );
    });
    expect(r.findings.filter((f) => f.chain_key === 'key:key_1' && f.check !== 'drift')).toEqual(
      [],
    );
  });
});

describe('check digest: append-only tables', () => {
  it('a ledger amount edited with the guard off is reported at the sale’s event', async () => {
    const seq = await seqOf('ledger_entries', 'led_1');
    const r = await tampered(
      [
        { table: 'ledger_entries', trigger: 'ledger_entries_append_only' },
        captureOf('ledger_entries'),
      ],
      async (tx) => {
        await tx.exec("UPDATE ledger_entries SET amount_minor = 999999 WHERE id = 'led_1'");
      },
    );
    const hit = named(r, 'digest', 'ord:ord_1', seq);
    expect(hit).toHaveLength(1);
    expect(hit[0]!.detail).toMatch(/ledger_entries led_1/);
  });

  it('an audit_log action edited with the guard off is reported at its event', async () => {
    const id = (await db.query<{ id: string }>('SELECT id FROM audit_log ORDER BY id LIMIT 1'))
      .rows[0]!.id;
    const seq = await seqOf('audit_log', id, 'plat');
    const r = await tampered(
      [{ table: 'audit_log', trigger: 'audit_log_append_only' }, captureOf('audit_log')],
      async (tx) => {
        await tx.query("UPDATE audit_log SET action = 'x.edited' WHERE id = $1", [id]);
      },
    );
    expect(named(r, 'digest', 'plat', seq)).toHaveLength(1);
  });

  it('a column added to the table later does not change the digest of the rows already there', async () => {
    const r = await tampered([], async (tx) => {
      await tx.exec('ALTER TABLE ledger_entries ADD COLUMN later_col text');
    });
    expect(r.findings).toEqual([]);
  });
});

describe('check drift: state edited with the capture trigger off', () => {
  it('orders.status is reported as drift orders ord_1 status', async () => {
    const r = await tampered([captureOf('orders')], async (tx) => {
      await tx.exec("UPDATE orders SET status = 'cancelled' WHERE id = 'ord_1'");
    });
    expect(
      r.findings.some((f) => f.check === 'drift' && /orders ord_1 status/.test(f.detail)),
    ).toBe(true);
  });

  it('mandates.spent_minor is reported as drift mandates man_1 spent_minor', async () => {
    const r = await tampered([captureOf('mandates')], async (tx) => {
      await tx.exec("UPDATE mandates SET spent_minor = 1 WHERE id = 'man_1'");
    });
    expect(
      r.findings.some((f) => f.check === 'drift' && /mandates man_1 spent_minor/.test(f.detail)),
    ).toBe(true);
  });

  it('a hashed column (orders.expected) edited with the trigger off is reported as drift', async () => {
    const r = await tampered([captureOf('orders')], async (tx) => {
      await tx.exec(`UPDATE orders SET expected = '{"edited":true}'::jsonb WHERE id = 'ord_1'`);
    });
    expect(
      r.findings.some((f) => f.check === 'drift' && /orders ord_1 expected/.test(f.detail)),
    ).toBe(true);
  });

  it('a tracked row inserted with the trigger off is reported as having no journal event', async () => {
    const r = await tampered([captureOf('alerts')], async (tx) => {
      await tx.exec(
        `INSERT INTO alerts (id, kind, detail, created_at, updated_at) VALUES ('alr_ghost', 'k', '{}', '2026-11-04T10:00:00Z', '2026-11-04T10:00:00Z')`,
      );
    });
    expect(r.findings.some((f) => f.check === 'drift' && /alerts alr_ghost/.test(f.detail))).toBe(
      true,
    );
  });

  it('an untracked column edited with triggers off is not drift', async () => {
    const r = await tampered([captureOf('orders')], async (tx) => {
      await tx.exec(
        "UPDATE orders SET updated_at = updated_at + interval '1 second' WHERE id = 'ord_1'",
      );
    });
    expect(r.findings).toEqual([]);
  });
});

describe('INV-T2', () => {
  it('a write with no context is listed with its table and id', async () => {
    let lines: string[] = [];
    await db
      .transaction(async (tx) => {
        await ins(tx, 'alerts', {
          id: 'alr_nocontext',
          kind: 'k',
          order_id: null,
          unit_id: null,
          detail: j({}),
        });
        lines = await traceInvariants(tx);
        throw new Rollback();
      })
      .catch((e: unknown) => {
        if (!(e instanceof Rollback)) throw e;
      });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/INV-T2.*alerts alr_nocontext/);
  });
});
