// Test data and builders for API-B (domain/mandates). Synthetic rows only. Imported by tests; not exported
// from index.ts. The layering lint lets this one helper file open a database and use the fake clock.
import { migrate, openDatabase } from '@umsbx/db';
import { fakeClock, seededIds } from '@umsbx/runtime';
import { EVENT_PAYLOAD_SCHEMAS } from '@umsbx/contracts';
import type {
  AuditEntry,
  Database,
  EventOutbox,
  Id,
  IsoUtc,
  OutboxEvent,
  SqlExecutor,
} from '@umsbx/contracts';
import type { MandateDeps } from './index';

export const T0: IsoUtc = '2026-11-04T10:00:00.000Z';
export const SEED_TIME = '2026-11-01T00:00:00Z';
const HASH = 'c'.repeat(64);

export type Db = Database & { close(): Promise<void> };
export type Clk = ReturnType<typeof fakeClock>;

export interface Harness {
  db: Db;
  clock: Clk;
  deps: MandateDeps;
  audits: AuditEntry[];
  /** Every event the outbox saw, in order; the row is in event_outbox only when the transaction commits. */
  appended: OutboxEvent[];
}

/** An outbox that validates like the real adapter and inserts into event_outbox in the caller's transaction. */
function outboxFor(clock: Clk, ids: ReturnType<typeof seededIds>, appended: OutboxEvent[]) {
  const outbox: EventOutbox = {
    async append(tx: SqlExecutor, event: OutboxEvent): Promise<Id> {
      const parsed = EVENT_PAYLOAD_SCHEMAS[event.type].parse(event.payload);
      const id = ids.next('evt');
      await tx.query(
        'INSERT INTO event_outbox (id, type, payload, occurred_at) VALUES ($1, $2, $3::jsonb, $4)',
        [id, event.type, JSON.stringify(parsed), clock.now().toISOString()],
      );
      appended.push(event);
      return id;
    },
  };
  return outbox;
}

export async function makeHarness(): Promise<Harness> {
  const db = await openDatabase({ kind: 'pglite-memory' });
  const clock = fakeClock(T0);
  await migrate(db, clock);
  const ids = seededIds('mandates-tests');
  const audits: AuditEntry[] = [];
  const appended: OutboxEvent[] = [];
  const deps: MandateDeps = {
    clock,
    ids,
    outbox: outboxFor(clock, ids, appended),
    audit: {
      record: (_tx, e) => {
        audits.push(e);
        return Promise.resolve();
      },
    },
  };
  for (const b of ['buy_A', 'buy_B']) await seedBuyer(db, b);
  await seedAgentKey(db, 'key_A1', 'buy_A');
  await seedAgentKey(db, 'key_A2', 'buy_A');
  await seedAgentKey(db, 'key_B1', 'buy_B');
  return { db, clock, deps, audits, appended };
}

export async function seedBuyer(db: SqlExecutor, id: string): Promise<void> {
  await db.query(
    `INSERT INTO buyers (id, display_name, auth_subject, country, created_at, updated_at)
     VALUES ($1, $2, $3, 'US', $4, $4)`,
    [id, `name-${id}`, `sub-${id}`, SEED_TIME],
  );
}

export async function seedAgentKey(db: SqlExecutor, id: string, buyer_id: string): Promise<void> {
  await db.query(
    `INSERT INTO api_keys (id, owner_kind, owner_id, key_kind, agent_buyer_id, scopes, secret_hash, created_at)
     VALUES ($1, 'buyer', $2, 'agent', $5, ARRAY['agent:buy','catalogue:read'], $3, $4)`,
    [id, buyer_id, HASH, SEED_TIME, buyer_id],
  );
}

/** A mandate with sensible defaults: 30 days, USD. */
export const CAPS = {
  currency: 'USD',
  max_total_minor: null as number | null,
  max_count: null as number | null,
  max_per_purchase_minor: null as number | null,
  expires_at: '2026-12-04T10:00:00.000Z' as IsoUtc,
};

export async function count(db: SqlExecutor, sql: string, p: unknown[] = []): Promise<number> {
  const r = await db.query<{ c: string | number }>(sql, p);
  return Number(r.rows[0]?.c ?? 0);
}
