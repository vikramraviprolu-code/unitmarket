// Adapted from AIC_Hackathon_UnitMarket packages/core/app/platform-invariants.ts (the idea: each
// invariant is SQL over the real rows, nothing is written) at a36ddc03fd0b962000f686291c145b50ee337f90.
// Owned by SBX lane 05b. Architecture 9.2:
//   INV1 ledger sale minus refunds equals the verified captured amount per unit;
//   INV2 every available item has a verified capture;
//   INV3 no captured unit without its items (and none left pending or denied);
//   INV4 the end of every access window equals the end the event log gives.
import { computeWindow } from '@umsbx/access-clock';
import { AccessPolicySchema } from '@umsbx/contracts';
import type { AccessEvent, AccessEventKind, Id, SqlExecutor } from '@umsbx/contracts';

type Result = { id: 'INV1' | 'INV2' | 'INV3' | 'INV4'; ok: boolean; detail: string };
const SHOWN = 5;

const describe = (title: string, bad: string[]): string =>
  bad.length === 0
    ? `${title}: holds`
    : `${title}: ${bad.length} violation${bad.length === 1 ? '' : 's'}: ${bad.slice(0, SHOWN).join('; ')}${
        bad.length > SHOWN ? '; ...' : ''
      }`;

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
  const bad: string[] = [];
  for (const r of rows.rows) {
    const id = r['id'] as string;
    const sale = Number(r['sale']);
    const sales = Number(r['sales']);
    const refund = Number(r['refund']);
    const amount = Number(r['amount_minor']);
    const refunded = Number(r['refunded_minor']);
    if (r['verified'] === true) {
      if (sales !== 1 || sale !== amount) {
        bad.push(`unit ${id}: ${sales} sale entries totalling ${sale}, captured amount ${amount}`);
      } else if (refund !== refunded || sale - refund !== amount - refunded) {
        bad.push(`unit ${id}: ledger refunds ${refund}, unit says ${refunded}`);
      }
    } else if (sales > 0 || refund > 0) {
      bad.push(`unit ${id}: not verified but the ledger has sale ${sale} and refund ${refund}`);
    }
  }
  return {
    id: 'INV1',
    ok: bad.length === 0,
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
  const bad = rows.rows.map((r) => `item ${r.id} of unit ${r.unit_id}`);
  return {
    id: 'INV2',
    ok: bad.length === 0,
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
    Number(r.items) === 0
      ? `unit ${r.id}: captured, no items`
      : `unit ${r.id}: captured, ${Number(r.open)} item(s) not paid`,
  );
  return {
    id: 'INV3',
    ok: bad.length === 0,
    detail: describe('no captured unit without its paid items', bad),
  };
}

async function inv4(db: SqlExecutor): Promise<Result> {
  const windows = await db.query<Record<string, unknown>>(
    `SELECT e.id, e.policy, w.started_at, w.base_ends_at, w.ends_at, w.credit_ms
       FROM access_windows w JOIN entitlements e ON e.id = w.entitlement_id ORDER BY e.id`,
  );
  const bad: string[] = [];
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
      'SELECT kind, at, source, evidence FROM access_events WHERE entitlement_id = $1 ORDER BY at, ctid',
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
      bad.push(`item ${id}: stored end ${iso(w['ends_at'])}, log gives ${expected.ends_at}`);
    }
  }
  return {
    id: 'INV4',
    ok: bad.length === 0,
    detail: describe('every window end equals the end the event log gives', bad),
  };
}

export async function checkInvariants(db: SqlExecutor): Promise<Result[]> {
  return [await inv1(db), await inv2(db), await inv3(db), await inv4(db)];
}
