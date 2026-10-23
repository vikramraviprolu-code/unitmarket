// CO-4 adversarial tests: hostile input and races around refunds. Twenty callers for one unit give
// one request and at most one provider call; a refund list that does not add up (another currency,
// a status nobody knows, a sum above the capture, one id with two amounts) books nothing and
// freezes the unit with an alert; the booking is idempotent under concurrent reads; the lock-order
// spy shows the documented order (D-020) in every refund transaction, recovery cases included.
// Real PGlite, scripted PayPal. Synthetic rows only, no network.
import { afterEach, describe, expect, it } from 'vitest';
import type { OrderRead, PaymentsDeps, SqlExecutor } from '@umsbx/contracts';
import {
  checkInvariants,
  executeRefund,
  reconcileOrder,
  recoverOnStartup,
  requestRefund,
  runDue,
  suspectReversal,
} from './index';
import { OPERATOR, paid } from './ops/support';
import { makeRemainingWorld } from './remaining-world';
import type { RemainingWorld } from './remaining-world';

let w: RemainingWorld;
afterEach(async () => {
  expect(w.paypal.violations).toEqual([]);
  await w.close();
});
const usd = (minor: number) => ({ currency: 'USD', minor });
const SEC = 1_000;
const H = 3_600_000;

async function setup(price = 500) {
  w = await makeRemainingWorld({ price });
  const a = await paid(w);
  w.markReads();
  const unit = (
    await w.rows<{ id: string; capture_id: string }>(
      'SELECT id, capture_id FROM order_units WHERE order_id = $1',
      [a.order_id],
    )
  )[0]!;
  return { a, unit };
}
const provider = async () =>
  (await w.rows<{ provider_order_id: string }>('SELECT provider_order_id FROM provider_orders'))[0]!
    .provider_order_id;
const reread = (order_id: string) => reconcileOrder(w.deps, { order_id, trigger: 'poll' });
type Listed = { refund_id: string; status: string; amount: { currency: string; minor: number } };
/** The next read lists exactly these refunds (whatever they say), beside a capture that reads refunded. */
async function listOnly(list: Listed[]): Promise<void> {
  await w.editNextRead(await provider(), (r) => ({
    ...r,
    units: r.units.map((u) => ({ ...u, refunds: list })),
  }));
}
const ledgerCount = async () =>
  (await w.rows("SELECT 1 FROM ledger_entries WHERE kind = 'refund'")).length;
const receiptCount = async (order_id: string) =>
  (await w.rows('SELECT 1 FROM receipts WHERE order_id = $1', [order_id])).length;
const unitRow = async (id: string) =>
  (
    await w.rows<{ status: string; refunded_minor: number }>(
      'SELECT status, refunded_minor FROM order_units WHERE id = $1',
      [id],
    )
  )[0]!;
const alerts = (order_id: string) =>
  w.rows<{ kind: string; unit_id: string | null; detail: { reason: string } }>(
    'SELECT kind, unit_id, detail FROM alerts WHERE order_id = $1 ORDER BY kind, id',
    [order_id],
  );
const mismatch = async (order_id: string) =>
  (
    await w.rows<{ mismatch: boolean; status: string }>(
      'SELECT mismatch, status FROM orders WHERE id = $1',
      [order_id],
    )
  )[0]!;
const entStates = (unit_id: string) =>
  w.rows<{ money_state: string; access_state: string }>(
    'SELECT money_state, access_state FROM entitlements WHERE unit_id = $1',
    [unit_id],
  );
async function invariantsHold(): Promise<void> {
  const r = await checkInvariants(w.db);
  expect(r.slice(0, 4).map((x) => x.ok)).toEqual([true, true, true, true]);
}

describe('concurrency', () => {
  it('20 concurrent requests for one unit give one request and at most one provider call', async () => {
    const { unit } = await setup();
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, k) =>
        requestRefund(w.deps, {
          unit_id: unit.id,
          amount: usd(100 + k),
          reason: `r${k}`,
          actor: OPERATOR,
        }),
      ),
    );
    const won = results.filter((r) => r.ok);
    expect(won).toHaveLength(1);
    expect(results.filter((r) => !r.ok).map((r) => (r.ok ? '' : r.error.code))).toEqual(
      Array(19).fill('refund_in_flight'),
    );
    expect(await w.rows('SELECT 1 FROM refund_requests')).toHaveLength(1);
    const first = won[0]!;
    const id = first.ok ? first.value.refund_request_id : '';
    // Twenty executions of the one request.
    await Promise.all(
      Array.from({ length: 20 }, () => executeRefund(w.deps, { refund_request_id: id })),
    );
    expect(w.sends().length).toBeLessThanOrEqual(1);
    expect(w.sends()).toHaveLength(1);
    expect(await w.rows("SELECT 1 FROM ledger_entries WHERE kind = 'refund'")).toHaveLength(1);
    await invariantsHold();
  });

  it('20 concurrent null "refund the rest" requests give one request, sized by what PayPal holds', async () => {
    const { unit } = await setup();
    w.dashboard(unit.capture_id, 300);
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        requestRefund(w.deps, { unit_id: unit.id, amount: null, reason: 'rest', actor: OPERATOR }),
      ),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const rows = await w.rows<{ amount_minor: number }>('SELECT amount_minor FROM refund_requests');
    expect(rows.map((r) => Number(r.amount_minor))).toEqual([200]);
  });

  it('five concurrent re-reads book one dashboard refund once', async () => {
    const { a, unit } = await setup();
    const id = w.dashboard(unit.capture_id, 150);
    await Promise.all(Array.from({ length: 5 }, () => reread(a.order_id)));
    expect(
      await w.rows<{ refund_id: string }>(
        "SELECT refund_id FROM ledger_entries WHERE kind = 'refund'",
      ),
    ).toEqual([{ refund_id: id }]);
    expect(await receiptCount(a.order_id)).toBe(2);
    expect(await unitRow(unit.id)).toEqual({ status: 'partially_refunded', refunded_minor: 150 });
    await invariantsHold();
  });

  it('a re-read racing the read-back of our own refund books each refund once', async () => {
    const { a, unit } = await setup();
    const rq = await requestRefund(w.deps, {
      unit_id: unit.id,
      amount: usd(200),
      reason: 'x',
      actor: OPERATOR,
    });
    if (!rq.ok) throw new Error('refused');
    w.dashboard(unit.capture_id, 300);
    await Promise.all([
      executeRefund(w.deps, { refund_request_id: rq.value.refund_request_id }),
      reread(a.order_id),
      reread(a.order_id),
    ]);
    await reread(a.order_id);
    const rows = await w.rows<{ amount_minor: number }>(
      "SELECT amount_minor FROM ledger_entries WHERE kind = 'refund'",
    );
    expect(rows.map((r) => Number(r.amount_minor)).sort()).toEqual([200, 300]);
    expect(await unitRow(unit.id)).toEqual({ status: 'refunded', refunded_minor: 500 });
    await invariantsHold();
  });
});

describe('MFA is a strict true', () => {
  it.each([
    ['false', false],
    ['undefined', undefined],
    ['null', null],
    ['the string "true"', 'true'],
    ['the number 1', 1],
    ['an object', {}],
  ])('mfa %s is refused', async (_n, mfa) => {
    const { unit } = await setup();
    const r = await requestRefund(w.deps, {
      unit_id: unit.id,
      amount: usd(100),
      reason: 'x',
      actor: { kind: 'operator', operator_id: 'opr_1', mfa } as never,
    });
    expect(r).toEqual({ ok: false, error: { code: 'mfa_required' } });
    expect(await w.rows('SELECT 1 FROM refund_requests')).toEqual([]);
  });

  it('a publisher actor is not an operator', async () => {
    const { unit } = await setup();
    const r = await requestRefund(w.deps, {
      unit_id: unit.id,
      amount: usd(100),
      reason: 'x',
      actor: { kind: 'publisher', publisher_id: 'pub_1' } as never,
    });
    expect(r).toEqual({ ok: false, error: { code: 'not_operator' } });
  });
});

describe('a refund list that does not add up books nothing and freezes with an alert', () => {
  async function expectFrozen(order_id: string, unit_id: string, reason: RegExp): Promise<void> {
    expect(await ledgerCount()).toBe(0);
    expect(await receiptCount(order_id)).toBe(1);
    expect(await unitRow(unit_id)).toEqual({ status: 'captured_verified', refunded_minor: 0 });
    expect(await entStates(unit_id)).toEqual([
      { money_state: 'captured', access_state: 'available' },
    ]);
    expect((await mismatch(order_id)).mismatch).toBe(true);
    const found = await alerts(order_id);
    expect(found.map((x) => x.kind)).toEqual(['frozen_order']);
    expect(found[0]?.unit_id).toBe(unit_id);
    expect(found[0]?.detail.reason).toMatch(reason);
    await invariantsHold();
  }

  it('a listed refund in another currency', async () => {
    const { a, unit } = await setup();
    await listOnly([
      { refund_id: 'RFOK1', status: 'COMPLETED', amount: usd(100) },
      { refund_id: 'RFEUR', status: 'COMPLETED', amount: { currency: 'EUR', minor: 100 } },
    ]);
    await reread(a.order_id);
    await expectFrozen(a.order_id, unit.id, /^refund_list_currency_RFEUR$/);
  });

  it('a listed refund with a status nobody knows', async () => {
    const { a, unit } = await setup();
    await listOnly([
      { refund_id: 'RFOK1', status: 'COMPLETED', amount: usd(100) },
      { refund_id: 'RFODD', status: 'REVERSED', amount: usd(100) },
    ]);
    await reread(a.order_id);
    await expectFrozen(a.order_id, unit.id, /^refund_list_status_RFODD$/);
  });

  it('a status in lower case is not COMPLETED', async () => {
    const { a, unit } = await setup();
    await listOnly([{ refund_id: 'RFLOW', status: 'completed', amount: usd(100) }]);
    await reread(a.order_id);
    await expectFrozen(a.order_id, unit.id, /^refund_list_status_RFLOW$/);
  });

  it('completed refunds that add up to more than the capture', async () => {
    const { a, unit } = await setup();
    await listOnly([
      { refund_id: 'RFA', status: 'COMPLETED', amount: usd(300) },
      { refund_id: 'RFB', status: 'COMPLETED', amount: usd(300) },
    ]);
    await reread(a.order_id);
    await expectFrozen(a.order_id, unit.id, /^refund_list_exceeds_capture$/);
  });

  it('one completed refund above the capture', async () => {
    const { a, unit } = await setup();
    await listOnly([{ refund_id: 'RFBIG', status: 'COMPLETED', amount: usd(501) }]);
    await reread(a.order_id);
    await expectFrozen(a.order_id, unit.id, /^refund_list_exceeds_capture$/);
  });

  it('a new refund on top of what is booked that adds up to more than the capture', async () => {
    const { a, unit } = await setup();
    const first = w.dashboard(unit.capture_id, 400);
    await reread(a.order_id);
    expect(await ledgerCount()).toBe(1);
    await listOnly([
      { refund_id: first, status: 'COMPLETED', amount: usd(400) },
      { refund_id: 'RFMORE', status: 'COMPLETED', amount: usd(200) },
    ]);
    await reread(a.order_id);
    expect(await ledgerCount()).toBe(1); // RFMORE is not booked
    expect(await unitRow(unit.id)).toEqual({ status: 'partially_refunded', refunded_minor: 400 });
    expect((await mismatch(a.order_id)).mismatch).toBe(true);
    expect((await alerts(a.order_id)).map((x) => x.kind)).toEqual(['frozen_order']);
    await invariantsHold();
  });

  it('one refund id listed twice with two amounts', async () => {
    const { a, unit } = await setup();
    await listOnly([
      { refund_id: 'RFTWICE', status: 'COMPLETED', amount: usd(100) },
      { refund_id: 'RFTWICE', status: 'COMPLETED', amount: usd(200) },
    ]);
    await reread(a.order_id);
    await expectFrozen(a.order_id, unit.id, /^refund_list_conflict_RFTWICE$/);
  });

  it('one refund id listed twice with one status and amount is one refund', async () => {
    const { a, unit } = await setup();
    await listOnly([
      { refund_id: 'RFSAME', status: 'COMPLETED', amount: usd(100) },
      { refund_id: 'RFSAME', status: 'COMPLETED', amount: usd(100) },
    ]);
    await reread(a.order_id);
    expect(
      await w.rows<{ amount_minor: number }>(
        "SELECT amount_minor FROM ledger_entries WHERE kind = 'refund'",
      ),
    ).toEqual([{ amount_minor: 100 }]);
    expect(await unitRow(unit.id)).toEqual({ status: 'partially_refunded', refunded_minor: 100 });
    expect((await mismatch(a.order_id)).mismatch).toBe(false);
  });

  it('a completed refund of zero is not a money fact', async () => {
    const { a, unit } = await setup();
    await listOnly([{ refund_id: 'RFZERO', status: 'COMPLETED', amount: usd(0) }]);
    await reread(a.order_id);
    await expectFrozen(a.order_id, unit.id, /^refund_list_amount_RFZERO$/);
  });

  it('a negative or fractional amount is refused the same way', async () => {
    for (const minor of [-5, 1.5]) {
      const { a, unit } = await setup();
      await listOnly([{ refund_id: 'RFODDAMT', status: 'COMPLETED', amount: usd(minor) }]);
      await reread(a.order_id);
      await expectFrozen(a.order_id, unit.id, /^refund_list_amount_RFODDAMT$/);
      await w.close();
    }
    w = await makeRemainingWorld({ price: 500 }); // afterEach closes one world
  });

  it('the frozen unit raises its alert once, however often it is read', async () => {
    const { a, unit } = await setup();
    for (let k = 0; k < 3; k += 1) {
      await listOnly([
        { refund_id: 'RFEUR', status: 'COMPLETED', amount: { currency: 'EUR', minor: 100 } },
      ]);
      await reread(a.order_id);
    }
    await expectFrozen(a.order_id, unit.id, /^refund_list_currency_RFEUR$/);
  });

  it('a later clean list books normally (the freeze is an alert and a flag, not a lock-out)', async () => {
    const { a, unit } = await setup();
    await listOnly([
      { refund_id: 'RFEUR', status: 'COMPLETED', amount: { currency: 'EUR', minor: 100 } },
    ]);
    await reread(a.order_id);
    const good = w.dashboard(unit.capture_id, 150);
    await reread(a.order_id);
    expect(
      await w.rows<{ refund_id: string }>(
        "SELECT refund_id FROM ledger_entries WHERE kind = 'refund'",
      ),
    ).toEqual([{ refund_id: good }]);
  });

  it('a listed refund on a unit that is already refunded in full is above the capture: frozen, nothing booked', async () => {
    const { a, unit } = await setup();
    w.dashboard(unit.capture_id, 500);
    await reread(a.order_id);
    expect(await unitRow(unit.id)).toEqual({ status: 'refunded', refunded_minor: 500 });
    w.dashboard(unit.capture_id, 100);
    await reread(a.order_id);
    expect(await ledgerCount()).toBe(1);
    expect(await receiptCount(a.order_id)).toBe(2);
    expect((await alerts(a.order_id)).map((x) => x.kind)).toEqual(['frozen_order']);
    await invariantsHold();
  });

  it('a listed refund on a unit suspected of a reversal is not booked silently: a human is told', async () => {
    const { a, unit } = await setup();
    await suspectReversal(w.deps, { capture_id: unit.capture_id, source: 'manual' });
    w.dashboard(unit.capture_id, 100);
    await reread(a.order_id);
    expect(await ledgerCount()).toBe(0);
    expect(await unitRow(unit.id)).toMatchObject({ status: 'reversal_suspected' });
    const kinds = (await alerts(a.order_id)).map((x) => x.kind);
    expect(kinds).toContain('reversal');
    expect(kinds).toContain('refund_unresolved');
  });

  it('a refund id that looks like SQL is data', async () => {
    const { a, unit } = await setup();
    const evil = "RF'; DROP TABLE ledger_entries; --";
    await listOnly([{ refund_id: evil, status: 'COMPLETED', amount: usd(100) }]);
    await reread(a.order_id);
    expect(
      await w.rows<{ refund_id: string }>(
        "SELECT refund_id FROM ledger_entries WHERE kind = 'refund'",
      ),
    ).toEqual([{ refund_id: evil }]);
    expect(await unitRow(unit.id)).toEqual({ status: 'partially_refunded', refunded_minor: 100 });
  });

  it('many small refunds in one read are booked in one go with one new receipt version', async () => {
    const { a, unit } = await setup();
    const list: Listed[] = Array.from({ length: 50 }, (_, k) => ({
      refund_id: `RFMANY${String(k).padStart(3, '0')}`,
      status: 'COMPLETED',
      amount: usd(10),
    }));
    await listOnly(list);
    await reread(a.order_id);
    expect(await ledgerCount()).toBe(50);
    expect(await unitRow(unit.id)).toEqual({ status: 'refunded', refunded_minor: 500 });
    expect(await receiptCount(a.order_id)).toBe(2);
    await invariantsHold();
  });
});

describe('a read that is not an order read books nothing', () => {
  it.each([
    ['not_found', { kind: 'not_found', debug_id: null }],
    ['timeout', { kind: 'timeout' }],
    ['unavailable', { kind: 'unavailable', retry_after_ms: null }],
  ])('%s', async (_n, read) => {
    const { a, unit } = await setup();
    w.dashboard(unit.capture_id, 100);
    w.script(read as unknown as OrderRead);
    await reread(a.order_id);
    expect(await ledgerCount()).toBe(0);
    expect(await receiptCount(a.order_id)).toBe(1);
  });
});

// -------------------------------------------------------------------------------------------
// D-020 lock order, every refund transaction. The ranks are those of lockorder.state.test.ts plus
// recovery cases between refund requests and entitlements: a recovery case locks the case, then the
// entitlement (credit), so a case sits above the request and below the entitlement.
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
function lockTarget(sql: string): string | null {
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
function violations(log: Tx[]): string[] {
  const bad: string[] = [];
  for (const tx of log) {
    const held = new Map<number, string>();
    for (const l of tx.locks) {
      const r = RANK[l.table];
      if (r === undefined) continue;
      if (held.has(r)) continue;
      const above = [...held.entries()].filter(([k]) => k > r);
      if (above.length > 0)
        bad.push(`${l.table}(${r}) after rank ${above[0]![0]} [${above[0]![1]}] by [${l.sql}]`);
      held.set(r, l.sql);
    }
  }
  return [...new Set(bad)];
}

describe('D-020: every refund transaction follows the lock order', () => {
  it('the spy sees the rank of a recovery case between refund requests and entitlements', () => {
    expect(lockTarget('SELECT id FROM recovery_cases WHERE id = $1 FOR UPDATE')).toBe(
      'recovery_cases',
    );
    expect(RANK['refund_requests']).toBeLessThan(RANK['recovery_cases']!);
    expect(RANK['recovery_cases']).toBeLessThan(RANK['entitlements']!);
    // And the spy catches a violation: an entitlement lock followed by a unit lock.
    const log: Tx[] = [
      {
        locks: [
          { table: 'entitlements', sql: 'UPDATE entitlements' },
          { table: 'order_units', sql: 'UPDATE order_units' },
        ],
      },
    ];
    expect(violations(log)).toHaveLength(1);
  });

  it('request, send, read-back, close, dashboard booking, full refund, resend and reversal', async () => {
    w = await makeRemainingWorld({ price: 500 });
    const log: Tx[] = [];
    const d = spy(w.deps, log);
    const a = await paid(w);
    const b = await paid(w, { buyer_id: 'buy_B', offers: ['ofr_3'] });
    const cap = async (order_id: string) =>
      (
        await w.rows<{ id: string; capture_id: string }>(
          'SELECT id, capture_id FROM order_units WHERE order_id = $1',
          [order_id],
        )
      )[0]!;
    const ua = await cap(a.order_id);
    const ub = await cap(b.order_id);
    const ask = async (unit_id: string, minor: number | null) => {
      const r = await requestRefund(d, {
        unit_id,
        amount: minor === null ? null : usd(minor),
        reason: 'x',
        actor: OPERATOR,
      });
      if (!r.ok) throw new Error(`refused ${r.error.code}`);
      return r.value.refund_request_id;
    };
    // 1. A partial refund, completed at once; the rest asked after a dashboard refund.
    await executeRefund(d, { refund_request_id: await ask(ua.id, 200) });
    w.dashboard(ua.capture_id, 100);
    await reconcileOrder(d, { order_id: a.order_id, trigger: 'poll' });
    await executeRefund(d, { refund_request_id: await ask(ua.id, null) });
    // 2. A request closed because PayPal holds less (the dashboard refunded the lot).
    w.dashboard(ub.capture_id, 500);
    const closed = await ask(ub.id, 200);
    await executeRefund(d, { refund_request_id: closed });
    await reconcileOrder(d, { order_id: b.order_id, trigger: 'poll' });
    // 3. A pending refund read back later, and a lost answer resent.
    w.refundNext.status = 'PENDING';
    const c = await paid(w, { offers: ['ofr_2'] });
    const uc = await cap(c.order_id);
    const pend = await ask(uc.id, 100);
    await executeRefund(d, { refund_request_id: pend });
    for (const f of w.refunds.values()) f.status = 'COMPLETED';
    for (let k = 0; k < 3; k += 1) {
      w.tick(H);
      await runDue(d, { max_items: 10 });
    }
    // 4. A reversal on a booked unit, startup recovery.
    await suspectReversal(d, { capture_id: uc.capture_id, source: 'manual' });
    w.tick(61 * SEC);
    await recoverOnStartup(d);
    expect(log.length).toBeGreaterThan(15);
    expect(violations(log)).toEqual([]);
  });
});
