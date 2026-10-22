// Adapted from AIC_Hackathon_UnitMarket packages/core/entitlements/entitlements.ts at
// a36ddc03fd0b962000f686291c145b50ee337f90. Owned by SBX.
// Entitlement rows: create, apply a money event (compare-and-set), read for the owning buyer.
import { revokeWindow } from '@umsbx/access-clock';
import { AccessPolicySchema, IdSchema, err, ok } from '@umsbx/contracts';
import type {
  AccessOption,
  AccessPolicy,
  AccessState,
  CoreDeps,
  Id,
  LicenceState,
  MoneyEvent,
  MoneyState,
  Result,
  SqlExecutor,
  WindowState,
} from '@umsbx/contracts';
import { nextStates, transitionsBetween } from './table';
import type { EntitlementStates } from './table';

export interface EntitlementView {
  entitlement_id: Id;
  buyer_id: Id;
  article_id: Id;
  unit_id: Id;
  option: AccessOption;
  money: MoneyState;
  access: AccessState;
  licence: LicenceState | null;
  window: WindowState;
}

// A malformed id (NUL, control or zero-width characters, blanks, over 200 characters) names no
// row, and a NUL would make PostgreSQL throw.
const isId = (value: string): boolean => IdSchema.safeParse(value).success;

export async function createPendingEntitlements(
  tx: SqlExecutor,
  d: CoreDeps,
  i: {
    buyer_id: Id;
    unit_id: Id;
    items: { article_id: Id; option: AccessOption; policy: AccessPolicy }[];
  },
): Promise<Id[]> {
  const now = d.clock.now().toISOString();
  const ids: Id[] = [];
  // In input order, so the ids follow the order of the items.
  for (const item of i.items) {
    const policy = AccessPolicySchema.parse(item.policy);
    if (policy.option !== item.option) {
      throw new Error(`policy ${policy.id} is for ${policy.option}, not ${item.option}`);
    }
    const id = d.ids.next('ent');
    await tx.query(
      `INSERT INTO entitlements (id, buyer_id, article_id, unit_id, option, policy, money_state, access_state,
         licence_state, transition_log, environment, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'pending', 'locked', NULL, '[]'::jsonb, $7, $8, $8)`,
      [
        id,
        i.buyer_id,
        item.article_id,
        i.unit_id,
        item.option,
        JSON.stringify(policy),
        d.environment,
        now,
      ],
    );
    await tx.query(
      `INSERT INTO access_windows (entitlement_id, state, started_at, base_ends_at, ends_at, paused_at, credit_ms, created_at, updated_at)
       VALUES ($1, 'not_started', NULL, NULL, NULL, NULL, 0, $2, $2)`,
      [id, now],
    );
    ids.push(id);
  }
  return ids;
}

interface HeadRow {
  money_state: MoneyState;
  access_state: AccessState;
  licence_state: LicenceState | null;
}

export async function applyMoneyEvent(
  tx: SqlExecutor,
  d: CoreDeps,
  i: { entitlement_id: Id; event: MoneyEvent },
): Promise<
  Result<
    { changed: boolean; money: MoneyState; access: AccessState },
    { code: 'forbidden_transition' | 'unknown_entitlement' }
  >
> {
  if (!isId(i.entitlement_id)) return err({ code: 'unknown_entitlement' });
  const now = d.clock.now().toISOString();
  // Compare-and-set on the money and access state read. Zero rows updated means somebody else
  // moved the row first: read again and decide again (the second reading may be a no-op or a refusal).
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const found = await tx.query<HeadRow>(
      'SELECT money_state, access_state, licence_state FROM entitlements WHERE id = $1',
      [i.entitlement_id],
    );
    const row = found.rows[0];
    if (row === undefined) return err({ code: 'unknown_entitlement' });
    const before: EntitlementStates = {
      money: row.money_state,
      access: row.access_state,
      licence: row.licence_state,
    };
    const next = nextStates(before, i.event);
    if (!next.ok) return err({ code: 'forbidden_transition' });
    const { states: after, changed } = next.value;
    if (!changed) return ok({ changed: false, money: after.money, access: after.access });
    const updated = await tx.query(
      `UPDATE entitlements SET money_state = $2, access_state = $3, licence_state = $4, updated_at = $5,
         transition_log = transition_log || $6::jsonb
       WHERE id = $1 AND money_state = $7 AND access_state = $8 RETURNING id`,
      [
        i.entitlement_id,
        after.money,
        after.access,
        after.licence,
        now,
        JSON.stringify(transitionsBetween(before, after, now)),
        before.money,
        before.access,
      ],
    );
    if (updated.rows.length === 1) {
      if (i.event === 'refund_verified' || i.event === 'reversal_verified') {
        await revokeWindow(tx, d, {
          entitlement_id: i.entitlement_id,
          reason: i.event === 'refund_verified' ? 'refund' : 'reversal',
        });
      }
      return ok({ changed: true, money: after.money, access: after.access });
    }
  }
  throw new Error(`entitlement ${i.entitlement_id} kept changing under compare-and-set`);
}

interface ViewRow {
  id: string;
  buyer_id: string;
  article_id: string;
  unit_id: string;
  option: AccessOption;
  money_state: MoneyState;
  access_state: AccessState;
  licence_state: LicenceState | null;
  w_state: WindowState['state'] | null;
  started_at: Date | string | null;
  base_ends_at: Date | string | null;
  ends_at: Date | string | null;
  paused_at: Date | string | null;
  credit_ms: number | null;
}
const iso = (v: Date | string | null): string | null =>
  v === null ? null : new Date(v).toISOString();

/** The buyer's own entitlement, or null: another buyer's id answers exactly like a missing one (P13). */
export async function getEntitlementForBuyer(
  db: SqlExecutor,
  i: { entitlement_id: Id; buyer_id: Id },
): Promise<EntitlementView | null> {
  if (!isId(i.entitlement_id) || !isId(i.buyer_id)) return null;
  const found = await db.query<ViewRow>(
    `SELECT e.id, e.buyer_id, e.article_id, e.unit_id, e.option, e.money_state, e.access_state, e.licence_state,
            w.state AS w_state, w.started_at, w.base_ends_at, w.ends_at, w.paused_at, w.credit_ms
     FROM entitlements e LEFT JOIN access_windows w ON w.entitlement_id = e.id
     WHERE e.id = $1 AND e.buyer_id = $2`,
    [i.entitlement_id, i.buyer_id],
  );
  const r = found.rows[0];
  if (r === undefined) return null;
  return {
    entitlement_id: r.id,
    buyer_id: r.buyer_id,
    article_id: r.article_id,
    unit_id: r.unit_id,
    option: r.option,
    money: r.money_state,
    access: r.access_state,
    licence: r.licence_state,
    window: {
      state: r.w_state ?? 'not_started',
      started_at: iso(r.started_at),
      base_ends_at: iso(r.base_ends_at),
      ends_at: iso(r.ends_at),
      paused_at: iso(r.paused_at),
      credit_ms: r.credit_ms ?? 0,
    },
  };
}
