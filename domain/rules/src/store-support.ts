// Test helper only (never exported from index.ts): a migrated in-memory database with two publishers and
// two buyers, a recording audit sink and the dependency bundle the BR-2 store takes.
import { migrate, openDatabase } from '@umsbx/db';
import { fakeClock, seededIds } from '@umsbx/runtime';
import type {
  Actor,
  AuditEntry,
  AuditSink,
  Database,
  Id,
  RuleKey,
  RuleScopeKind,
  SqlExecutor,
} from '@umsbx/contracts';
import type { RuleStoreDeps } from './store';

export const T0 = '2026-11-05T10:00:00.000Z';

export interface RulesWorld {
  db: Database & { close(): Promise<void> };
  clock: ReturnType<typeof fakeClock>;
  deps: RuleStoreDeps;
  pubA: Id;
  pubB: Id;
  buyA: Id;
  buyB: Id;
  opMfa: Actor;
  opNoMfa: Actor;
  buyer: Actor;
  publisher: Actor;
  system: Actor;
}

export async function rulesWorld(): Promise<RulesWorld> {
  const db = await openDatabase({ kind: 'pglite-memory' });
  const clock = fakeClock(T0);
  await migrate(db, clock);
  const ids = seededIds('rules-br2');
  const audit: AuditSink = {
    async record(tx: SqlExecutor, e: AuditEntry): Promise<void> {
      const actorId =
        e.actor.kind === 'operator'
          ? e.actor.operator_id
          : e.actor.kind === 'buyer'
            ? e.actor.buyer_id
            : e.actor.kind === 'publisher'
              ? e.actor.publisher_id
              : null;
      await tx.query(
        `INSERT INTO audit_log (id, actor_kind, actor_id, action, target, reason, detail, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $8)`,
        [
          ids.next('aud'),
          e.actor.kind,
          actorId,
          e.action,
          e.target,
          e.reason,
          JSON.stringify(e.detail),
          clock.now().toISOString(),
        ],
      );
    },
  };
  const at = T0;
  const pub = async (slug: string): Promise<Id> => {
    const id = ids.next('pub');
    await db.query(
      `INSERT INTO publishers (id, slug, display_name, country, created_at, updated_at)
       VALUES ($1, $2, $3, 'US', $4, $4)`,
      [id, slug, `Publisher ${slug}`, at],
    );
    return id;
  };
  const buy = async (n: string): Promise<Id> => {
    const id = ids.next('buy');
    await db.query(
      `INSERT INTO buyers (id, display_name, auth_subject, country, created_at, updated_at)
       VALUES ($1, $2, $3, 'US', $4, $4)`,
      [id, `Buyer ${n}`, `sub:${n}`, at],
    );
    return id;
  };
  const pubA = await pub('pub-a');
  const pubB = await pub('pub-b');
  const buyA = await buy('a');
  const buyB = await buy('b');
  return {
    db,
    clock,
    deps: { db, clock, ids, audit },
    pubA,
    pubB,
    buyA,
    buyB,
    opMfa: { kind: 'operator', operator_id: 'opr_vikram', mfa: true },
    opNoMfa: { kind: 'operator', operator_id: 'opr_vikram', mfa: false },
    buyer: { kind: 'buyer', buyer_id: buyA },
    publisher: { kind: 'publisher', publisher_id: pubA },
    system: { kind: 'system' },
  };
}

/** A valid platform input for `refund.request_window`, effective now. Override any field. */
export function input(
  w: RulesWorld,
  over: Partial<{
    actor: Actor;
    rule_key: RuleKey | string;
    scope_kind: RuleScopeKind | string;
    scope_id: string | null;
    value: unknown;
    effective_from: string;
    effective_until: string | null;
    reason: string;
  }> = {},
) {
  return {
    actor: w.opMfa,
    rule_key: 'refund.request_window',
    scope_kind: 'platform',
    scope_id: null,
    value: 14,
    effective_from: T0,
    effective_until: null,
    reason: 'Longer window for the pilot',
    ...over,
  };
}

export async function countRows(db: SqlExecutor, table: string, where = 'true'): Promise<number> {
  const r = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`);
  return r.rows[0]?.n ?? 0;
}
