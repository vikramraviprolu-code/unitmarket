// Adversarial tests of webhook intake (lane CO-2): replay, duplicates, concurrent delivery, hostile
// ids, rejected verdicts, the lock order and the race with the poller. Whatever arrives, at most one
// event row and at most one read-back change per order, and no money state from a webhook.
import { afterEach, describe, expect, it } from 'vitest';
import type { PaymentsDeps, ProviderEvent, SqlExecutor, WebhookVerdict } from '@umsbx/contracts';
import {
  checkInvariants,
  executeRefund,
  handleWebhook,
  onBuyerReturn,
  reconcileOrder,
  requestRefund,
  runDue,
} from './index';
import { BUYER_A, OPERATOR, approved, count, makeWorld, ops, paid } from './ops/support';
import type { OpsWorld } from './ops/support';

let w: OpsWorld;
afterEach(async () => {
  expect(w.paypal.violations).toEqual([]);
  await w.close();
});
const H = 3_600_000;
const iso = (ms = 0): string => new Date(w.clock.now().getTime() + ms).toISOString();

async function world(): Promise<void> {
  w = await makeWorld();
  let n = 0;
  w.deps = {
    ...w.deps,
    audit: {
      record: async (tx: SqlExecutor, e) => {
        n += 1;
        await tx.query(
          `INSERT INTO audit_log (id, actor_kind, actor_id, action, target, reason, detail, created_at, updated_at)
           VALUES ($1, $2, NULL, $3, $4, $5, $6::jsonb, $7, $7)`,
          [
            `aud_a${n}`,
            e.actor.kind,
            e.action,
            e.target,
            e.reason,
            JSON.stringify(e.detail),
            iso(),
          ],
        );
      },
    },
  };
}

let seq = 0;
const ev = (o: Partial<ProviderEvent> = {}): ProviderEvent => {
  seq += 1;
  return {
    event_id: `WH-ADV-${seq}`,
    transmission_id: `tx-adv-${seq}`,
    type: 'PAYMENT.CAPTURE.COMPLETED',
    provider_order_id: null,
    capture_id: null,
    refund_id: null,
    occurred_at: iso(),
    ...o,
  };
};
const deliverWith = (d: PaymentsDeps, e: ProviderEvent) =>
  handleWebhook(d, {
    verdict: { kind: 'verified', event: e },
    transmission_id: e.transmission_id,
    received_at: iso(),
  });
const deliver = (e: ProviderEvent) => deliverWith(w.deps, e);
const verdict = (v: WebhookVerdict, transmission_id: string) =>
  handleWebhook(w.deps, { verdict: v, transmission_id, received_at: iso() });

const captureOf = async (order_id: string): Promise<string> =>
  (
    await w.rows<{ capture_id: string }>('SELECT capture_id FROM order_units WHERE order_id = $1', [
      order_id,
    ])
  )[0]!.capture_id;
const statusOf = async (order_id: string) =>
  (await w.rows<{ status: string }>('SELECT status FROM orders WHERE id = $1', [order_id]))[0]!
    .status;
const readbacks = async (order_id: string) =>
  (await ops(w, order_id)).filter((o) => o.kind === 'readback');

async function tableCounts(): Promise<Record<string, number>> {
  const tables = await w.rows<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`,
  );
  const out: Record<string, number> = {};
  for (const t of tables) out[t.table_name] = await count(w, t.table_name);
  return out;
}

/** deps whose transactions report every statement to `seen`; `fail` may throw to simulate a fault. */
function spied(
  d: PaymentsDeps,
  seen: (sql: string) => void,
  fail?: (sql: string) => boolean,
): PaymentsDeps {
  const wrap = (tx: SqlExecutor): SqlExecutor => ({
    query: (sql, params) => {
      seen(sql);
      if (fail?.(sql) === true) return Promise.reject(new Error('injected fault'));
      return tx.query(sql, params);
    },
    exec: (sql) => tx.exec(sql),
  });
  return { ...d, db: { ...d.db, transaction: (fn) => d.db.transaction((tx) => fn(wrap(tx))) } };
}
const writesOperations = (sql: string): boolean =>
  /^\s*(UPDATE|INSERT INTO)\s+operations\b/i.test(sql);

async function claimStored() {
  const a = await approved(w);
  w.paypal.queue.get.push('real', { kind: 'timeout' } as never);
  const r = await onBuyerReturn(w.deps, { order_ref: a.order_ref, actor: BUYER_A });
  if (!r.ok || r.value.status !== 'unresolved') throw new Error('expected an unresolved order');
  return { ...a, capture_id: await captureOf(a.order_id) };
}

describe('replay and concurrency', () => {
  it('50 concurrent deliveries of one event: one row, one enqueue', async () => {
    await world();
    const a = await paid(w);
    const capture_id = await captureOf(a.order_id);
    const calls = w.paypal.calls.length;
    let writes = 0;
    const d = spied(w.deps, (sql) => {
      if (writesOperations(sql)) writes += 1;
    });
    const e = ev({ capture_id });
    const results = await Promise.all(Array.from({ length: 50 }, () => deliverWith(d, e)));

    expect(results.every((r) => r.http === 200)).toBe(true);
    expect(results.filter((r) => r.outcome === 'enqueued')).toHaveLength(1);
    expect(results.filter((r) => r.outcome === 'duplicate')).toHaveLength(49);
    expect(await count(w, 'webhook_events')).toBe(1);
    expect(writes).toBe(1);
    expect(await readbacks(a.order_id)).toHaveLength(1);
    expect(w.paypal.calls.length).toBe(calls);
  });

  it('50 concurrent deliveries of one event for an order with no read-back: one operation row', async () => {
    await world();
    const a = await approved(w);
    const e = ev({ type: 'CHECKOUT.ORDER.APPROVED', provider_order_id: a.provider_order_id });
    const results = await Promise.all(Array.from({ length: 50 }, () => deliver(e)));
    expect(results.filter((r) => r.outcome === 'enqueued')).toHaveLength(1);
    expect(results.filter((r) => r.outcome === 'duplicate')).toHaveLength(49);
    expect(await readbacks(a.order_id)).toHaveLength(1);
    expect(await count(w, 'webhook_events')).toBe(1);
  });

  it('50 different events for one order at once: 50 rows, still one read-back change', async () => {
    await world();
    const a = await paid(w);
    const capture_id = await captureOf(a.order_id);
    let writes = 0;
    const d = spied(w.deps, (sql) => {
      if (writesOperations(sql)) writes += 1;
    });
    const results = await Promise.all(
      Array.from({ length: 50 }, () => deliverWith(d, ev({ capture_id }))),
    );
    expect(results.every((r) => r.http === 200 && r.outcome === 'enqueued')).toBe(true);
    expect(await count(w, 'webhook_events')).toBe(50);
    expect(writes).toBe(1);
    expect(await readbacks(a.order_id)).toHaveLength(1);
  });

  it('same event id with a new transmission id: duplicate, nothing changes', async () => {
    await world();
    const a = await paid(w);
    const capture_id = await captureOf(a.order_id);
    const first = ev({ capture_id });
    expect(await deliver(first)).toEqual({ http: 200, outcome: 'enqueued' });
    await runDue(w.deps, { max_items: 10 });
    w.tick(2 * H);
    const counts = await tableCounts();
    const rows = await readbacks(a.order_id);
    expect(await deliver({ ...first, transmission_id: 'tx-brand-new' })).toEqual({
      http: 200,
      outcome: 'duplicate',
    });
    expect(await tableCounts()).toEqual(counts);
    expect(await readbacks(a.order_id)).toEqual(rows);
  });

  it('a new event id on an old transmission id is a duplicate as well', async () => {
    await world();
    const a = await paid(w);
    const capture_id = await captureOf(a.order_id);
    const first = ev({ capture_id });
    await deliver(first);
    await runDue(w.deps, { max_items: 10 });
    w.tick(2 * H);
    const counts = await tableCounts();
    expect(await deliver({ ...first, event_id: 'WH-OTHER-ID' })).toEqual({
      http: 200,
      outcome: 'duplicate',
    });
    expect(await tableCounts()).toEqual(counts);
  });

  it('a fault after the event is stored rolls everything back, so the retry is processed', async () => {
    await world();
    const a = await paid(w);
    const capture_id = await captureOf(a.order_id);
    const counts = await tableCounts();
    const rows = await readbacks(a.order_id);
    const e = ev({ capture_id });
    const broken = spied(
      w.deps,
      () => undefined,
      (sql) => writesOperations(sql),
    );
    await expect(deliverWith(broken, e)).rejects.toThrow('injected fault');
    expect(await tableCounts()).toEqual(counts);
    expect(await readbacks(a.order_id)).toEqual(rows);
    // PayPal retries the same delivery.
    expect(await deliver(e)).toEqual({ http: 200, outcome: 'enqueued' });
  });
});

describe('rejected verdicts touch the audit log and nothing else', () => {
  const HASH_BAD = '450a7e5ec5e8a6a2d854f01b44b0f278a3d1305ae02ce24d5b545c7d19129e69'; // sha256("tx-bad-1")
  const HASH_MAL = '7af259d02e39cafa6584fdfd6f81a774019b52442ee7bf7063bf293ad4966867'; // sha256("tx-malformed-1")
  const HASH_UNV = 'a15a4cb6c0106e922ee1917e911f10691803f3bd7e4de95399f9bf22d18b7f7b'; // sha256("tx-unverifiable-1")
  const audits = () =>
    w.rows<{
      actor_kind: string;
      action: string;
      target: string | null;
      reason: string | null;
      detail: Record<string, unknown>;
    }>(
      "SELECT actor_kind, action, target, reason, detail FROM audit_log WHERE action LIKE 'webhook.%' ORDER BY length(id), id",
    );

  it('bad_signature and malformed change no table except audit_log', async () => {
    await world();
    await paid(w);
    const before = await tableCounts();
    expect(await verdict({ kind: 'bad_signature', why: 'crc_mismatch' }, 'tx-bad-1')).toEqual({
      http: 400,
      outcome: 'rejected',
    });
    expect(await verdict({ kind: 'malformed' }, 'tx-malformed-1')).toEqual({
      http: 400,
      outcome: 'rejected',
    });
    expect(await tableCounts()).toEqual({ ...before, audit_log: before['audit_log']! + 2 });
    expect(await audits()).toEqual([
      {
        actor_kind: 'system',
        action: 'webhook.rejected',
        target: null,
        reason: 'crc_mismatch',
        detail: { verdict: 'bad_signature', transmission_sha256: HASH_BAD },
      },
      {
        actor_kind: 'system',
        action: 'webhook.rejected',
        target: null,
        reason: 'malformed',
        detail: { verdict: 'malformed', transmission_sha256: HASH_MAL },
      },
    ]);
  });

  it('unverifiable: 503, one audit row, nothing else', async () => {
    await world();
    await paid(w);
    const before = await tableCounts();
    expect(await verdict({ kind: 'unverifiable' }, 'tx-unverifiable-1')).toEqual({
      http: 503,
      outcome: 'unverifiable',
    });
    expect(await tableCounts()).toEqual({ ...before, audit_log: before['audit_log']! + 1 });
    expect(await audits()).toEqual([
      {
        actor_kind: 'system',
        action: 'webhook.unverifiable',
        target: null,
        reason: 'unverifiable',
        detail: { verdict: 'unverifiable', transmission_sha256: HASH_UNV },
      },
    ]);
  });

  it('a hostile reason and transmission id never reach the log whole', async () => {
    await world();
    const body = '{"resource":{"payer":"secret@example.test"}}'.repeat(200);
    await verdict({ kind: 'bad_signature', why: body }, body);
    const [row] = await audits();
    expect(row!.reason!.length).toBeLessThanOrEqual(200);
    expect(JSON.stringify(row!.detail)).not.toContain('secret@example.test');
    expect(row!.detail['transmission_sha256']).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('hostile identifiers', () => {
  it('SQL, unicode and very long ids are data: stored, no_op, no table dropped', async () => {
    await world();
    await paid(w);
    const before = await tableCounts();
    const nasty = ["'; DROP TABLE orders; --", '‮​' + 'x'.repeat(10_000), 'CAP%\\_', ''];
    for (const s of nasty) {
      const r = await deliver(
        ev({
          event_id: `EV-${s.slice(0, 50)}-${seq}`,
          capture_id: s,
          refund_id: s,
          provider_order_id: null,
        }),
      );
      expect(r).toEqual({ http: 200, outcome: 'no_op' });
    }
    expect(await tableCounts()).toEqual({ ...before, webhook_events: nasty.length });
  });

  it('a foreign capture id can only wake that order read, never change it', async () => {
    await world();
    const a = await paid(w);
    const b = await paid(w, { offers: ['ofr_2'] });
    const snapshot = async (id: string) => ({
      status: await statusOf(id),
      ledger: await w.rows(
        'SELECT l.kind, l.amount_minor FROM ledger_entries l JOIN order_units u ON u.id = l.unit_id WHERE u.order_id = $1 ORDER BY l.kind',
        [id],
      ),
      ent: await w.rows(
        'SELECT money_state, access_state FROM entitlements e JOIN order_units u ON u.id = e.unit_id WHERE u.order_id = $1',
        [id],
      ),
    });
    const sa = await snapshot(a.order_id);
    const sb = await snapshot(b.order_id);
    await deliver(
      ev({ type: 'PAYMENT.CAPTURE.DECLINED', capture_id: await captureOf(b.order_id) }),
    );
    await deliver(ev({ type: 'PAYMENT.CAPTURE.DENIED', capture_id: await captureOf(b.order_id) }));
    expect(await snapshot(a.order_id)).toEqual(sa);
    expect(await snapshot(b.order_id)).toEqual(sb);
  });
});

// ---------------------------------------------------------------------------------------------
// Lock order (D-020, docs/READINESS.md "Lock order"): orders -> operations -> order_units.
const RANK: Record<string, number> = {
  orders: 1,
  provider_orders: 1,
  operations: 2,
  order_units: 3,
  refund_requests: 4,
  entitlements: 5,
  access_windows: 5,
  access_events: 5,
  access_links: 5,
  ledger_entries: 6,
  receipts: 6,
  receipt_versions: 6,
};
function lockTarget(sql: string): string | null {
  const s = sql.replace(/\s+/g, ' ').trim();
  const write = /^(?:UPDATE|INSERT INTO|DELETE FROM) (\w+)/i.exec(s);
  if (write !== null) return write[1]!.toLowerCase();
  if (!/ FOR UPDATE\b/i.test(s)) return null;
  const of = / FOR UPDATE OF (\w+)/i.exec(s);
  if (of !== null) {
    const hit = new RegExp(`(?:FROM|JOIN) (\\w+)(?: AS)? ${of[1]!}\\b`, 'i').exec(s);
    return (hit?.[1] ?? of[1]!).toLowerCase();
  }
  return /FROM (\w+)/i.exec(s)?.[1]?.toLowerCase() ?? null;
}

describe('lock order', () => {
  it('lock order spy: orders, operations, order_units only, in D-020 order', async () => {
    await world();
    const pa = await paid(w);
    const pb = await paid(w, { offers: ['ofr_2'] });
    const aw = await approved(w, { offers: ['ofr_3'] });
    const ref = await (async () => {
      const unit = (
        await w.rows<{ id: string }>('SELECT id FROM order_units WHERE order_id = $1', [
          pb.order_id,
        ])
      )[0]!;
      const r = await requestRefund(w.deps, {
        unit_id: unit.id,
        amount: { currency: 'USD', minor: 100 },
        reason: 'x',
        actor: OPERATOR,
      });
      if (!r.ok) throw new Error('refund refused');
      await executeRefund(w.deps, { refund_request_id: r.value.refund_request_id });
      return (
        await w.rows<{ refund_id: string }>(
          'SELECT refund_id FROM refund_requests WHERE unit_id = $1',
          [unit.id],
        )
      )[0]!.refund_id;
    })();

    const log: { table: string; sql: string }[][] = [];
    const d = (() => {
      const base = w.deps;
      return {
        ...base,
        db: {
          ...base.db,
          transaction: <T>(fn: (tx: SqlExecutor) => Promise<T>) => {
            const rec: { table: string; sql: string }[] = [];
            log.push(rec);
            return base.db.transaction((tx) =>
              fn({
                query: (sql, params) => {
                  const t = lockTarget(sql);
                  if (t !== null)
                    rec.push({ table: t, sql: sql.replace(/\s+/g, ' ').slice(0, 100) });
                  return tx.query(sql, params);
                },
                exec: (sql) => tx.exec(sql),
              }),
            );
          },
        },
      } as PaymentsDeps;
    })();

    const capA = await captureOf(pa.order_id);
    const sent = [
      ev({ capture_id: capA }), // settled read-back reopened
      ev({ capture_id: capA }), // coalesced
      ev({ type: 'PAYMENT.CAPTURE.REVERSED', capture_id: capA }), // reversal suspected
      ev({ type: 'CHECKOUT.ORDER.APPROVED', provider_order_id: aw.provider_order_id }), // created
      ev({ type: 'PAYMENT.CAPTURE.REFUNDED', refund_id: ref }), // by refund id
      ev({ capture_id: 'NOTOURS1' }), // no_op
      ev({ type: 'OTHER' }), // no_op
    ];
    for (const e of sent) await deliverWith(d, e);
    await deliverWith(d, sent[0]!); // duplicate

    expect(log.length).toBeGreaterThanOrEqual(8);
    const touched = new Set<string>();
    const bad: string[] = [];
    for (const tx of log) {
      const held = new Map<number, string>();
      for (const l of tx) {
        const r = RANK[l.table];
        if (r === undefined) continue; // leaf inserts: webhook_events, alerts, audit_log
        touched.add(l.table);
        if (held.has(r)) continue;
        const above = [...held.keys()].filter((k) => k > r);
        if (above.length > 0) bad.push(`${l.table}(${r}) after rank ${above[0]!}: ${l.sql}`);
        held.set(r, l.sql);
      }
    }
    expect(bad).toEqual([]);
    expect([...touched].sort()).toEqual(['operations', 'order_units', 'orders']);
  });
});

// ---------------------------------------------------------------------------------------------
describe('webhook and poller at once (C-12 offline twin)', () => {
  async function expectOneSale(order_id: string): Promise<void> {
    expect(await statusOf(order_id)).toBe('paid');
    expect(await count(w, 'ledger_entries', "kind = 'sale'")).toBe(1);
    expect(await count(w, 'entitlements', "access_state = 'available'")).toBe(1);
    expect((await checkInvariants(w.deps.db)).filter((i) => !i.ok)).toEqual([]);
  }

  it('webhook lands while the poller waits for PayPal: one transition, one sale', async () => {
    await world();
    const a = await claimStored();
    w.tick(31_000);
    let results: unknown[] = [];
    w.paypal.beforeGet = async () => {
      w.paypal.beforeGet = null;
      results = [
        await deliver(ev({ capture_id: a.capture_id })),
        await deliver(ev({ capture_id: a.capture_id })),
      ];
    };
    await runDue(w.deps, { max_items: 10 });
    expect(results).toHaveLength(2);
    await expectOneSale(a.order_id);
  });

  it('webhook lands between the poller read and its apply: one transition, one sale', async () => {
    await world();
    const a = await claimStored();
    w.tick(31_000);
    let fired = false;
    const head = w.content.head.bind(w.content);
    w.content.head = async (key) => {
      if (!fired) {
        fired = true;
        await deliver(ev({ capture_id: a.capture_id }));
      }
      return head(key);
    };
    await reconcileOrder(w.deps, { order_id: a.order_id, trigger: 'poll' });
    expect(fired).toBe(true);
    await expectOneSale(a.order_id);
    // A later pass has nothing left to book.
    w.tick(H);
    await runDue(w.deps, { max_items: 10 });
    await expectOneSale(a.order_id);
  });

  it('webhooks, due runs and reconciles all at once: one sale however they interleave', async () => {
    await world();
    const a = await claimStored();
    w.tick(31_000);
    await Promise.all([
      deliver(ev({ capture_id: a.capture_id })),
      runDue(w.deps, { max_items: 10 }),
      deliver(ev({ type: 'CHECKOUT.ORDER.APPROVED', provider_order_id: a.provider_order_id })),
      reconcileOrder(w.deps, { order_id: a.order_id, trigger: 'webhook' }),
      deliver(ev({ capture_id: a.capture_id })),
      runDue(w.deps, { max_items: 10 }),
    ]);
    await expectOneSale(a.order_id);
  });
});
