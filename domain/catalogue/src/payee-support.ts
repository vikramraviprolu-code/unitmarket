// Test helper only (never exported from index.ts): a migrated in-memory database with three
// publishers, a recording audit sink and the dependency bundle the payee module takes (PUB-A2).
import type {
  Actor,
  AuditEntry,
  AuditSink,
  Database,
  EnvironmentLabel,
  Id,
  SqlExecutor,
} from '@umsbx/contracts';
import { fakeClock, seededIds, T0, testDb } from './support';
import type { PayeeDeps } from './payee';

/** Fictional merchant ids: 13 characters of capital letters and digits. Not credentials. */
export const MERCH_OLD = 'OLDMERCHANT01';
export const MERCH_NEW = 'NEWMERCHANT42';
export const MERCH_OTHER = 'OTHERMERCH777';
/** Canary: its last 4 ("9XYZ") may appear in audit and logs; the rest of it must not. */
export const MERCH_CANARY = 'CANARYMER9XYZ'.padStart(13, 'C');

export interface PayeeWorld {
  db: Database & { close(): Promise<void> };
  clock: ReturnType<typeof fakeClock>;
  logs: string[];
  /** Dependency bundle for one environment label. */
  deps(environment: EnvironmentLabel): PayeeDeps;
  pubA: Id;
  pubB: Id;
  pubC: Id;
  actorA: Actor;
  actorB: Actor;
  actorC: Actor;
  buyer: Actor;
  opMfa: Actor;
  opNoMfa: Actor;
}

export async function payeeWorld(): Promise<PayeeWorld> {
  const db = await testDb();
  const clock = fakeClock(T0);
  const ids = seededIds('payee');
  const logs: string[] = [];
  const audit: AuditSink = {
    async record(tx: SqlExecutor, e: AuditEntry): Promise<void> {
      const id =
        e.actor.kind === 'buyer'
          ? e.actor.buyer_id
          : e.actor.kind === 'publisher'
            ? e.actor.publisher_id
            : e.actor.kind === 'operator'
              ? e.actor.operator_id
              : null;
      await tx.query(
        `INSERT INTO audit_log (id, actor_kind, actor_id, action, target, reason, detail, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $8)`,
        [
          ids.next('aud'),
          e.actor.kind,
          id,
          e.action,
          e.target,
          e.reason,
          JSON.stringify(e.detail),
          clock.now().toISOString(),
        ],
      );
    },
  };
  const at = clock.now().toISOString();
  const make = async (slug: string, merchant: string | null, verified: boolean): Promise<Id> => {
    const id = ids.next('pub');
    await db.query(
      `INSERT INTO publishers (id, slug, display_name, country, paypal_merchant_id, payee_verified_at, created_at, updated_at)
       VALUES ($1, $2, $3, 'US', $4, $5, $6, $6)`,
      [id, slug, `Publisher ${slug}`, merchant, verified ? at : null, at],
    );
    return id;
  };
  const pubA = await make('pub-a', MERCH_OLD, true);
  const pubB = await make('pub-b', null, false);
  const pubC = await make('pub-c', MERCH_OTHER, true);
  return {
    db,
    clock,
    logs,
    deps: (environment) => ({ db, clock, ids, audit, environment }),
    pubA,
    pubB,
    pubC,
    actorA: { kind: 'publisher', publisher_id: pubA },
    actorB: { kind: 'publisher', publisher_id: pubB },
    actorC: { kind: 'publisher', publisher_id: pubC },
    buyer: { kind: 'buyer', buyer_id: 'buy_someone' },
    opMfa: { kind: 'operator', operator_id: 'opr_vikram', mfa: true },
    opNoMfa: { kind: 'operator', operator_id: 'opr_demo', mfa: false },
  };
}

export const count = async (db: Database, sql: string, params: unknown[] = []): Promise<number> =>
  Number((await db.query<{ c: string | number }>(sql, params)).rows[0]?.c ?? 0);

export async function publisherRow(
  db: Database,
  id: Id,
): Promise<{
  paypal_merchant_id: string | null;
  payee_verified_at: unknown;
  payee_shared: boolean;
}> {
  return (
    await db.query<{
      paypal_merchant_id: string | null;
      payee_verified_at: unknown;
      payee_shared: boolean;
    }>('SELECT paypal_merchant_id, payee_verified_at, payee_shared FROM publishers WHERE id = $1', [
      id,
    ])
  ).rows[0]!;
}
