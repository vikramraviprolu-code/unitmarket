// Adapted from AIC_Hackathon_UnitMarket packages/core/app/platform-invariants.ts (the idea: each
// invariant is SQL over the real rows, nothing is written) at a36ddc03fd0b962000f686291c145b50ee337f90.
// Owned by SBX lane 05b. Architecture 9.2:
//   INV1 ledger sale minus refunds equals the verified captured amount per unit;
//   INV2 every available item has a verified capture;
//   INV3 no captured unit without its items (and none left pending or denied);
//   INV4 the end of every access window equals the end the event log gives;
//   INV5 every order in capture_requested, capture_claimed or unresolved has an operation that is
//        `sent` or `unknown` (something is polling it), unless its create, capture or read-back
//        gave up at the end of the 24 h window and a human was told (failed, window_expired).
//        Per PayPal order (DP-2a): every per-publisher PayPal order in one of those states has such
//        an operation of its own, so a pack cannot hide an unpolled PayPal order behind a polled one;
//   INV6 every open refund request (sent, unknown, pending) has a refund or refund read-back
//        operation that is `sent` or `unknown`. A request nobody polls can stay open forever.
//   INV8 (POB-M1) per unit that has a parts row, the sale equals the fee plus the payable (and both equal the parts), and the
//        refunds equal the fee reversals plus the payable reversals. A unit sold before the fee existed has neither and is
//        not judged.
import { computeWindow } from '@umsbx/access-clock';
import { AccessPolicySchema } from '@umsbx/contracts';
import type { AccessEvent, AccessEventKind, Id, LedgerEntry, SqlExecutor } from '@umsbx/contracts';
import { publisherBalances } from '@umsbx/ledger';

/** INT-OPS-A / OPS-A.6: a row that breaks an invariant, by table and id. `detail` shows five of them; `rows` has all. */
export interface InvariantRow {
  table: string;
  id: string;
}
type Result = {
  id: 'INV1' | 'INV2' | 'INV3' | 'INV4' | 'INV5' | 'INV6' | 'INV7' | 'INV8';
  ok: boolean;
  detail: string;
  rows: InvariantRow[];
};
const SHOWN = 5;

/** One violation: the sentence of `detail` and the row it is about. */
interface Bad extends InvariantRow {
  text: string;
  /** Other rows the same violation is about (a capture on two units names both units). */
  also?: InvariantRow[];
}
const bad_ = (table: string, id: string, text: string): Bad => ({ table, id, text });
const describe = (title: string, bad: Bad[]): string =>
  bad.length === 0
    ? `${title}: holds`
    : `${title}: ${bad.length} violation${bad.length === 1 ? '' : 's'}: ${bad
        .slice(0, SHOWN)
        .map((b) => b.text)
        .join('; ')}${bad.length > SHOWN ? '; ...' : ''}`;
const rowsOf = (bad: Bad[]): InvariantRow[] =>
  bad.flatMap((b) => [{ table: b.table, id: b.id }, ...(b.also ?? [])]);

async function inv1(db: SqlExecutor): Promise<Result> {
  const rows = await db.query<Record<string, unknown>>(
    `SELECT u.id, u.amount_minor, u.refunded_minor, (u.captured_verified_at IS NOT NULL) AS verified,
            COALESCE(sum(l.amount_minor) FILTER (WHERE l.kind = 'sale'), 0) AS sale,
            count(*) FILTER (WHERE l.kind = 'sale') AS sales,
            COALESCE(sum(l.amount_minor) FILTER (WHERE l.kind = 'refund'), 0) AS refund
       FROM order_units u LEFT JOIN ledger_entries l ON l.unit_id = u.id
      GROUP BY u.id, u.amount_minor, u.refunded_minor, u.captured_verified_at
      ORDER BY u.id`,
  );
  const bad: Bad[] = [];
  for (const r of rows.rows) {
    const id = r['id'] as string;
    const sale = Number(r['sale']);
    const sales = Number(r['sales']);
    const refund = Number(r['refund']);
    const amount = Number(r['amount_minor']);
    const refunded = Number(r['refunded_minor']);
    if (r['verified'] === true) {
      if (sales !== 1 || sale !== amount) {
        bad.push(
          bad_(
            'order_units',
            id,
            `unit ${id}: ${sales} sale entries totalling ${sale}, captured amount ${amount}`,
          ),
        );
      } else if (refund !== refunded || sale - refund !== amount - refunded) {
        bad.push(
          bad_('order_units', id, `unit ${id}: ledger refunds ${refund}, unit says ${refunded}`),
        );
      }
    } else if (sales > 0 || refund > 0) {
      bad.push(
        bad_(
          'order_units',
          id,
          `unit ${id}: not verified but the ledger has sale ${sale} and refund ${refund}`,
        ),
      );
    }
  }
  return {
    id: 'INV1',
    ok: bad.length === 0,
    rows: rowsOf(bad),
    detail: describe('ledger sale minus refunds equals the verified amount per unit', bad),
  };
}

async function inv2(db: SqlExecutor): Promise<Result> {
  const rows = await db.query<{ id: string; unit_id: string }>(
    `SELECT e.id, e.unit_id FROM entitlements e JOIN order_units u ON u.id = e.unit_id
      WHERE e.access_state = 'available'
        AND NOT (e.money_state = 'captured' AND u.captured_verified_at IS NOT NULL AND u.capture_id IS NOT NULL
                 AND u.status IN ('captured_verified', 'partially_refunded', 'reversal_suspected'))
      ORDER BY e.id`,
  );
  const bad = rows.rows.map((r) => bad_('entitlements', r.id, `item ${r.id} of unit ${r.unit_id}`));
  return {
    id: 'INV2',
    ok: bad.length === 0,
    rows: rowsOf(bad),
    detail: describe('every available item has a verified capture', bad),
  };
}

async function inv3(db: SqlExecutor): Promise<Result> {
  const rows = await db.query<{ id: string; items: string | number; open: string | number }>(
    `SELECT u.id, count(e.id) AS items,
            count(e.id) FILTER (WHERE e.money_state IN ('pending', 'denied', 'unknown')) AS open
       FROM order_units u LEFT JOIN entitlements e ON e.unit_id = u.id
      WHERE u.captured_verified_at IS NOT NULL
      GROUP BY u.id
     HAVING count(e.id) = 0 OR count(e.id) FILTER (WHERE e.money_state IN ('pending', 'denied', 'unknown')) > 0
      ORDER BY u.id`,
  );
  const bad = rows.rows.map((r) =>
    bad_(
      'order_units',
      r.id,
      Number(r.items) === 0
        ? `unit ${r.id}: captured, no items`
        : `unit ${r.id}: captured, ${Number(r.open)} item(s) not paid`,
    ),
  );
  return {
    id: 'INV3',
    ok: bad.length === 0,
    rows: rowsOf(bad),
    detail: describe('no captured unit without its paid items', bad),
  };
}

async function inv4(db: SqlExecutor): Promise<Result> {
  const windows = await db.query<Record<string, unknown>>(
    `SELECT e.id, e.policy, w.started_at, w.base_ends_at, w.ends_at, w.credit_ms
       FROM access_windows w JOIN entitlements e ON e.id = w.entitlement_id ORDER BY e.id`,
  );
  const bad: Bad[] = [];
  const iso = (v: unknown): string | null =>
    v === null || v === undefined ? null : new Date(v as string | Date).toISOString();
  for (const w of windows.rows) {
    const id = w['id'] as Id;
    const policyRaw = w['policy'];
    const policy = AccessPolicySchema.parse(
      typeof policyRaw === 'string' ? JSON.parse(policyRaw) : policyRaw,
    );
    const events = await db.query<{
      kind: AccessEventKind;
      at: Date | string;
      source: AccessEvent['source'];
      evidence: AccessEvent['evidence'];
    }>(
      'SELECT kind, at, source, evidence FROM access_events WHERE entitlement_id = $1 ORDER BY at, seq',
      [id],
    );
    // The end does not depend on the moment of the check, so any instant will do.
    const expected = computeWindow(
      events.rows.map((r) => ({
        entitlement_id: id,
        kind: r.kind,
        at: new Date(r.at).toISOString(),
        source: r.source,
        evidence: r.evidence,
      })),
      policy,
      new Date(0),
    );
    if (
      expected.ends_at !== iso(w['ends_at']) ||
      expected.started_at !== iso(w['started_at']) ||
      expected.credit_ms !== Number(w['credit_ms'])
    ) {
      bad.push(
        bad_(
          'entitlements',
          id,
          `item ${id}: stored end ${iso(w['ends_at'])}, log gives ${expected.ends_at}`,
        ),
      );
    }
  }
  return {
    id: 'INV4',
    ok: bad.length === 0,
    rows: rowsOf(bad),
    detail: describe('every window end equals the end the event log gives', bad),
  };
}

async function inv5(db: SqlExecutor): Promise<Result> {
  const rows = await db.query<{ id: string; status: string }>(
    `SELECT o.id, o.status FROM orders o
      WHERE o.status IN ('capture_requested', 'capture_claimed', 'unresolved')
        AND NOT EXISTS (SELECT 1 FROM operations p WHERE p.order_id = o.id AND p.state IN ('sent', 'unknown'))
        AND NOT EXISTS (SELECT 1 FROM operations p WHERE p.order_id = o.id
                          AND p.kind IN ('create', 'capture', 'readback')
                          AND p.state = 'failed' AND p.failure_reason = 'window_expired')
      ORDER BY o.id`,
  );
  const bad = rows.rows.map((r) =>
    bad_('orders', r.id, `order ${r.id} is ${r.status} and nothing polls it`),
  );
  // Per PayPal order, for a pack (a single order has one, and the order check above covers it).
  const perPo = await db.query<{ id: string; order_id: string; state: string }>(
    `SELECT p.id, p.order_id, p.state FROM provider_orders p
      WHERE p.route = 'per_publisher' AND p.state IN ('capture_requested', 'capture_claimed', 'unresolved')
        AND NOT EXISTS (SELECT 1 FROM operations o WHERE o.provider_order_ref = p.id AND o.state IN ('sent', 'unknown'))
        AND NOT EXISTS (SELECT 1 FROM operations o WHERE o.provider_order_ref = p.id
                          AND o.kind IN ('create', 'capture', 'readback')
                          AND o.state = 'failed' AND o.failure_reason = 'window_expired')
      ORDER BY p.order_id, p.id`,
  );
  for (const r of perPo.rows) {
    bad.push(
      bad_(
        'provider_orders',
        r.id,
        `provider order ${r.id} of order ${r.order_id} is ${r.state} and nothing polls it`,
      ),
    );
  }
  return {
    id: 'INV5',
    ok: bad.length === 0,
    rows: rowsOf(bad),
    detail: describe('every order in flight has an operation that is polled', bad),
  };
}

async function inv6(db: SqlExecutor): Promise<Result> {
  const rows = await db.query<{ id: string; state: string }>(
    `SELECT r.id, r.state FROM refund_requests r
      WHERE r.state IN ('sent', 'unknown', 'pending')
        AND NOT EXISTS (SELECT 1 FROM operations p
                         WHERE p.request_id IN ('umsR-' || r.id, 'umsRB-' || r.id)
                           AND p.state IN ('sent', 'unknown'))
      ORDER BY r.id`,
  );
  const bad = rows.rows.map((r) =>
    bad_('refund_requests', r.id, `refund request ${r.id} is ${r.state} and nothing polls it`),
  );
  return {
    id: 'INV6',
    ok: bad.length === 0,
    rows: rowsOf(bad),
    detail: describe('every open refund request has an operation that is polled', bad),
  };
}

async function inv7(db: SqlExecutor): Promise<Result> {
  // What the units say each publisher is owed: verified captured amount minus refunded, by currency.
  const units = await db.query<{
    publisher_id: string;
    currency: string;
    expected: string | number;
  }>(
    `SELECT u.publisher_id, o.currency, sum(u.amount_minor - u.refunded_minor) AS expected
       FROM order_units u JOIN orders o ON o.id = u.order_id
      WHERE u.captured_verified_at IS NOT NULL
      GROUP BY u.publisher_id, o.currency`,
  );
  // What the ledger says, one row per entry with the publisher of its unit.
  const entries = await db.query<{
    id: string;
    unit_id: string;
    capture_id: string;
    kind: LedgerEntry['kind'];
    amount_minor: string | number;
    currency: string;
    refund_id: string | null;
    ref_entry_id: string | null;
    environment: LedgerEntry['environment'];
    created_at: string;
    publisher_id: string;
  }>(
    `SELECT l.id, l.unit_id, l.capture_id, l.kind, l.amount_minor, l.currency, l.refund_id,
            l.ref_entry_id, l.environment, u.publisher_id,
            to_char(l.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at
       FROM ledger_entries l JOIN order_units u ON u.id = l.unit_id`,
  );
  const net = new Map<string, number>();
  for (const b of publisherBalances(
    entries.rows.map((r) => ({
      publisher_id: r.publisher_id,
      entry: {
        id: r.id,
        unit_id: r.unit_id,
        capture_id: r.capture_id,
        kind: r.kind,
        amount: { currency: r.currency, minor: Number(r.amount_minor) },
        refund_id: r.refund_id,
        ref_entry_id: r.ref_entry_id,
        created_at: r.created_at,
        environment: r.environment,
      },
    })),
  )) {
    net.set(JSON.stringify([b.publisher_id, b.currency]), b.net_minor);
  }
  const expected = new Map<string, number>();
  for (const r of units.rows) {
    expected.set(JSON.stringify([r.publisher_id, r.currency]), Number(r.expected));
  }
  const bad: Bad[] = [];
  const keys = [...new Set([...net.keys(), ...expected.keys()])].sort();
  for (const key of keys) {
    const [publisher, currency] = JSON.parse(key) as [string, string];
    const ledger = net.get(key) ?? 0;
    const owed = expected.get(key) ?? 0;
    if (ledger !== owed) {
      bad.push(
        bad_(
          'publishers',
          publisher,
          `publisher ${publisher} (${currency}): ledger net ${ledger}, verified captured minus refunded ${owed}, difference ${ledger - owed}`,
        ),
      );
    }
  }
  // A capture id on two units would let one capture's money count for two publishers.
  const shared = await db.query<{ capture_id: string; units: string | number }>(
    `SELECT capture_id, count(*) AS units FROM order_units WHERE capture_id IS NOT NULL
      GROUP BY capture_id HAVING count(*) > 1 ORDER BY capture_id`,
  );
  for (const r of shared.rows) {
    const text = `capture ${r.capture_id} is on ${Number(r.units)} units`;
    const units = await db.query<{ id: string }>(
      'SELECT id FROM order_units WHERE capture_id = $1 ORDER BY id',
      [r.capture_id],
    );
    // One violation with one row per unit, so each unit resolves to its own order.
    const [first, ...rest] = units.rows;
    if (first !== undefined)
      bad.push({
        ...bad_('order_units', first.id, text),
        also: rest.map((u) => ({ table: 'order_units', id: u.id })),
      });
  }
  return {
    id: 'INV7',
    ok: bad.length === 0,
    rows: rowsOf(bad),
    detail: describe(
      'per publisher, ledger net equals verified captured minus refunded, and a capture belongs to one unit',
      bad,
    ),
  };
}

async function inv8(db: SqlExecutor): Promise<Result> {
  const rows = await db.query<Record<string, unknown>>(
    `SELECT u.id, up.seller_minor, up.fee_minor,
            (u.captured_verified_at IS NOT NULL) AS verified,
            COALESCE(sum(l.amount_minor) FILTER (WHERE l.kind = 'sale'), 0) AS sale,
            COALESCE(sum(l.amount_minor) FILTER (WHERE l.kind = 'fee'), 0) AS fee,
            COALESCE(sum(l.amount_minor) FILTER (WHERE l.kind = 'payable'), 0) AS payable,
            COALESCE(sum(l.amount_minor) FILTER (WHERE l.kind = 'refund'), 0) AS refund,
            COALESCE(sum(l.amount_minor) FILTER (WHERE l.kind = 'fee_reversal'), 0) AS fee_rev,
            COALESCE(sum(l.amount_minor) FILTER (WHERE l.kind = 'payable_reversal'), 0) AS payable_rev
       FROM order_units u
       JOIN order_unit_parts up ON up.unit_id = u.id
       LEFT JOIN ledger_entries l ON l.unit_id = u.id
      GROUP BY u.id, up.seller_minor, up.fee_minor, u.captured_verified_at
      ORDER BY u.id`,
  );
  const bad: Bad[] = [];
  const add = (id: string, text: string): void => {
    bad.push(bad_('order_units', id, text));
  };
  for (const r of rows.rows) {
    const id = r['id'] as string;
    const sale = Number(r['sale']);
    const fee = Number(r['fee']);
    const payable = Number(r['payable']);
    if (r['verified'] !== true) {
      if (fee > 0 || payable > 0)
        add(id, `unit ${id}: not verified but the ledger has fee ${fee} and payable ${payable}`);
      continue;
    }
    if (sale !== fee + payable) {
      add(id, `unit ${id}: sale ${sale}, fee ${fee} plus payable ${payable}`);
    } else if (fee !== Number(r['fee_minor']) || payable !== Number(r['seller_minor'])) {
      add(
        id,
        `unit ${id}: fee ${fee} and payable ${payable}, parts say ${String(r['fee_minor'])} and ${String(r['seller_minor'])}`,
      );
    } else if (Number(r['refund']) !== Number(r['fee_rev']) + Number(r['payable_rev'])) {
      add(
        id,
        `unit ${id}: refunds ${Number(r['refund'])}, fee reversals ${Number(r['fee_rev'])} plus payable reversals ${Number(r['payable_rev'])}`,
      );
    }
  }
  return {
    id: 'INV8',
    ok: bad.length === 0,
    rows: rowsOf(bad),
    detail: describe(
      'per unit, sale equals fee plus payable, and refunds equal their reversals',
      bad,
    ),
  };
}

export async function checkInvariants(db: SqlExecutor): Promise<Result[]> {
  return [
    await inv1(db),
    await inv2(db),
    await inv3(db),
    await inv4(db),
    await inv5(db),
    await inv6(db),
    await inv7(db),
    await inv8(db),
  ];
}
