// BR-2: the rule settings store. Rows are appended, never changed or deleted (migration 0027). An operator
// with the second factor adds a setting for the platform, a category, a seller or a buyer; reading the rows
// that apply to one sale is one query. Nothing in the product reads the rows yet: BR-3 and BR-4 do.
// Design: docs/business-rules/configurable-rules-design.md sections 5 and 6. Decision: D-096.
//
// Scope ids: `seller` keys on publishers.id and `buyer` on buyers.id. A category has no table yet, so a
// category id is stored as given (an Id), and `agreement` is refused until the agreements lane (BR-7).
// Gate note N2-1: a buyer value for a `min` key (mandate.max_days) may not be above the platform value that
// is active at the row's start. Lowering the platform value later needs no rewrite: the resolver clamps.
import {
  ActorSchema,
  IdSchema,
  IsoUtcSchema,
  RULES_REGISTRY,
  RULE_KEYS,
  RuleKeySchema,
  err,
  isRuleValueInRange,
  ok,
} from '@umsbx/contracts';
import type {
  Actor,
  CoreDeps,
  Id,
  Result,
  RuleKey,
  RuleScopeKind,
  RuleSettingRow,
  SqlExecutor,
} from '@umsbx/contracts';
import type { RulesContext } from './resolve';

export type RuleStoreDeps = Pick<CoreDeps, 'db' | 'clock' | 'ids' | 'audit'>;

export type RuleStoreErrorCode =
  | 'not_operator'
  | 'mfa_required'
  | 'rule_invalid'
  | 'backdated'
  | 'scope_unknown'
  | 'above_platform_cap';
export interface RuleStoreError {
  code: RuleStoreErrorCode;
}

/** What a caller hands in. The route has parsed the shape; the domain checks it again (it may be bypassed). */
export interface RuleSettingInput {
  actor: Actor;
  rule_key: string;
  scope_kind: string;
  scope_id: string | null;
  value: unknown;
  effective_from: string;
  effective_until: string | null;
  reason: string;
}

/** A start may be this far before the server clock (clock skew between the screen and the server). */
export const BACKDATE_TOLERANCE_MS = 60_000;
export const HISTORY_DEFAULT_LIMIT = 200;
export const HISTORY_MAX_LIMIT = 5000;

const WRITABLE_SCOPES: readonly RuleScopeKind[] = ['platform', 'category', 'seller', 'buyer'];
const INPUT_KEYS = [
  'actor',
  'rule_key',
  'scope_kind',
  'scope_id',
  'value',
  'effective_from',
  'effective_until',
  'reason',
] as const;

const fail = (code: RuleStoreErrorCode): Result<never, RuleStoreError> => err({ code });

/** Thrown inside the transaction to roll it back; the caller turns it into an error value. */
class Refused extends Error {
  // Declared field, not a parameter property: the offline scripts run this file in strip-only mode.
  readonly code: RuleStoreErrorCode;
  constructor(code: RuleStoreErrorCode) {
    super(code);
    this.code = code;
  }
}

const iso = (v: unknown): string => new Date(v as string | number | Date).toISOString();

interface Checked {
  actor: Extract<Actor, { kind: 'operator' }>;
  rule_key: RuleKey;
  scope_kind: RuleScopeKind;
  scope_id: string | null;
  value: number;
  from: string;
  until: string | null;
  reason: string;
}

/** The shape and the registry. Returns the checked fields, or the one code the caller answers with. */
function check(input: RuleSettingInput): Result<Checked, RuleStoreError> {
  if (typeof input !== 'object' || input === null || Array.isArray(input))
    return fail('rule_invalid');
  const actor = ActorSchema.safeParse(input.actor);
  if (!actor.success || actor.data.kind !== 'operator') return fail('not_operator');
  if (actor.data.mfa !== true) return fail('mfa_required');
  // Strict: a field this function does not know (approved_by, a __proto__ key) is a refusal.
  const own = Object.keys(input);
  if (own.some((k) => !(INPUT_KEYS as readonly string[]).includes(k))) return fail('rule_invalid');
  if (INPUT_KEYS.some((k) => !(k in input))) return fail('rule_invalid');

  const key = RuleKeySchema.safeParse(input.rule_key);
  if (!key.success) return fail('rule_invalid');
  const def = RULES_REGISTRY[key.data];
  const kind = input.scope_kind as RuleScopeKind;
  if (!WRITABLE_SCOPES.includes(kind) || !def.scopes.includes(kind)) return fail('rule_invalid');

  let scopeId: string | null = null;
  if (kind === 'platform') {
    if (input.scope_id !== null) return fail('rule_invalid');
  } else {
    const id = IdSchema.safeParse(input.scope_id);
    if (!id.success) return fail('rule_invalid');
    scopeId = id.data;
  }

  const value = input.value;
  if (typeof value !== 'number' || !isRuleValueInRange(key.data, value))
    return fail('rule_invalid');

  const from = IsoUtcSchema.safeParse(input.effective_from);
  if (!from.success) return fail('rule_invalid');
  let until: string | null = null;
  if (input.effective_until !== null) {
    const u = IsoUtcSchema.safeParse(input.effective_until);
    if (!u.success || Date.parse(u.data) <= Date.parse(from.data)) return fail('rule_invalid');
    until = u.data;
  }

  if (typeof input.reason !== 'string') return fail('rule_invalid');
  const reason = input.reason.trim();
  if (reason.length < 3 || reason.length > 200) return fail('rule_invalid');

  return ok({
    actor: actor.data,
    rule_key: key.data,
    scope_kind: kind,
    scope_id: scopeId,
    value,
    from: from.data,
    until,
    reason,
  });
}

const COLUMNS =
  'id, rule_key, scope_kind, scope_id, value, effective_from, effective_until, set_by, reason, approved_by, created_at';
interface DbRow {
  id: string;
  rule_key: string;
  scope_kind: string;
  scope_id: string | null;
  value: number | string;
  effective_from: unknown;
  effective_until: unknown;
  set_by: string;
  reason: string;
  approved_by: string | null;
  created_at: unknown;
}
const toRow = (r: DbRow): RuleSettingRow => ({
  id: r.id,
  rule_key: r.rule_key as RuleKey,
  scope_kind: r.scope_kind as RuleScopeKind,
  scope_id: r.scope_id,
  value: Number(r.value),
  effective_from: iso(r.effective_from),
  effective_until: r.effective_until == null ? null : iso(r.effective_until),
  set_by: r.set_by,
  reason: r.reason,
  approved_by: r.approved_by,
  created_at: iso(r.created_at),
});

/**
 * Adds one setting. Refuses (a value, nothing written): `not_operator`, `mfa_required` (checked here as well
 * as at the route), `rule_invalid`, `backdated`, `scope_unknown`, `above_platform_cap`. Writes the row and
 * one audit event in one transaction; ids from d.ids and the time from d.clock.
 */
export async function addRuleSetting(
  d: RuleStoreDeps,
  input: RuleSettingInput,
): Promise<Result<{ id: Id }, RuleStoreError>> {
  const c = check(input);
  if (!c.ok) return c;
  const x = c.value;
  const now = d.clock.now();
  if (Date.parse(x.from) < now.getTime() - BACKDATE_TOLERANCE_MS) return fail('backdated');
  try {
    return await d.db.transaction(async (tx) => {
      if (x.scope_kind === 'seller' || x.scope_kind === 'buyer') {
        const table = x.scope_kind === 'seller' ? 'publishers' : 'buyers';
        const found = await tx.query(`SELECT 1 AS one FROM ${table} WHERE id = $1`, [x.scope_id]);
        if (found.rows.length === 0) throw new Refused('scope_unknown');
      }
      if (x.scope_kind === 'buyer' && RULES_REGISTRY[x.rule_key].merge === 'min') {
        const cap = await platformValueAt(tx, x.rule_key, x.from);
        if (cap !== null && x.value > cap) throw new Refused('above_platform_cap');
      }
      const id = d.ids.next('rls');
      await tx.query(
        `INSERT INTO rule_settings (${COLUMNS})
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NULL, $10)`,
        [
          id,
          x.rule_key,
          x.scope_kind,
          x.scope_id,
          x.value,
          x.from,
          x.until,
          x.actor.operator_id,
          x.reason,
          now.toISOString(),
        ],
      );
      await d.audit.record(tx, {
        actor: x.actor,
        action: 'rules.setting_added',
        target: id,
        reason: x.reason,
        detail: {
          rule_key: x.rule_key,
          scope_kind: x.scope_kind,
          scope_id: x.scope_id,
          value: x.value,
          effective_from: x.from,
          effective_until: x.until,
        },
      });
      return ok({ id });
    });
  } catch (e) {
    if (e instanceof Refused) return fail(e.code);
    throw e;
  }
}

/** The platform value of a key that is active at `at`, or null when there is no platform row. */
async function platformValueAt(tx: SqlExecutor, key: RuleKey, at: string): Promise<number | null> {
  const r = await tx.query<{ value: number | string }>(
    `SELECT value FROM rule_settings
      WHERE rule_key = $1 AND scope_kind = 'platform'
        AND effective_from <= $2 AND (effective_until IS NULL OR effective_until > $2)
      ORDER BY effective_from DESC, created_at DESC, id DESC
      LIMIT 1`,
    [key, at],
  );
  return r.rows[0] === undefined ? null : Number(r.rows[0].value);
}

/**
 * The rows that can apply to one sale at `at`: every platform row, the sale's seller, buyer and category rows,
 * live at `at` (start inclusive, end exclusive). Agreement rows are never returned. One query; the BR-1
 * resolver picks among them.
 */
export async function activeRows(
  db: SqlExecutor,
  ctx: RulesContext,
  at: string,
): Promise<RuleSettingRow[]> {
  const r = await db.query<DbRow>(
    `SELECT ${COLUMNS} FROM rule_settings
      WHERE rule_key = ANY($1::text[])
        AND effective_from <= $2 AND (effective_until IS NULL OR effective_until > $2)
        AND (   scope_kind = 'platform'
             OR (scope_kind = 'seller' AND scope_id = $3)
             OR (scope_kind = 'buyer' AND scope_id = $4)
             OR (scope_kind = 'category' AND scope_id = $5::text))
      ORDER BY effective_from DESC, created_at DESC, id DESC`,
    [[...RULE_KEYS], at, ctx.seller_id, ctx.buyer_id, ctx.category],
  );
  return r.rows.map(toRow);
}

export interface RuleHistoryFilter {
  rule_key?: string;
  scope_kind?: string;
  scope_id?: string;
}

/** Newest first (created_at, then id). `limit` defaults to 200, is at least 1 and at most 5000. */
export async function listRuleHistory(
  db: SqlExecutor,
  filter: RuleHistoryFilter = {},
  limit: number = HISTORY_DEFAULT_LIMIT,
): Promise<RuleSettingRow[]> {
  const n = Number.isFinite(limit)
    ? Math.min(Math.max(Math.trunc(limit), 1), HISTORY_MAX_LIMIT)
    : HISTORY_DEFAULT_LIMIT;
  const where: string[] = [];
  const params: unknown[] = [];
  for (const k of ['rule_key', 'scope_kind', 'scope_id'] as const) {
    const v = filter[k];
    if (v !== undefined) {
      params.push(v);
      where.push(`${k} = $${params.length}`);
    }
  }
  params.push(n);
  const r = await db.query<DbRow>(
    `SELECT ${COLUMNS} FROM rule_settings
      ${where.length === 0 ? '' : `WHERE ${where.join(' AND ')}`}
      ORDER BY created_at DESC, id DESC
      LIMIT $${params.length}`,
    params,
  );
  return r.rows.map(toRow);
}
