// Test support for @umsbx/security (lane 11). Not exported from index. Deterministic stand-ins for
// the lane 01 ports (fake clock, seeded ids, memory logger and audit sink) over a real PGlite
// database migrated with the lane 12 schema (review H1: no fake database).
import { createHash } from 'node:crypto';
import { afterAll } from 'vitest';
import type {
  AuditEntry,
  Clock,
  IdPrefix,
  Ids,
  LogEvent,
  Logger,
  Secret,
} from '@umsbx/contracts';
import { migrate, openDatabase, type SqlDriver } from '@umsbx/db';
import type { SecurityDeps } from './route';

export const ORIGIN = 'https://sandbox.example.test';

export function fakeClock(startIso: string): Clock & { advance(ms: number): void } {
  let t = Date.parse(startIso);
  return {
    now: () => new Date(t),
    advance(ms: number) {
      t += ms;
    },
  };
}

const B32 = '0123456789abcdefghjkmnpqrstvwxyz';

export function seededIds(seed = 'seed'): Ids {
  let n = 0;
  const digest = (): Buffer => createHash('sha256').update(`${seed}:${n++}`).digest();
  return {
    next(prefix: IdPrefix) {
      const d = digest();
      let s = '';
      for (let i = 0; i < 26; i++) s += B32[(d[i] ?? 0) % 32];
      return `${prefix}_${s}`;
    },
    nonce() {
      return digest().subarray(0, 16).toString('hex');
    },
  };
}

export function secret(value: string): Secret {
  return { reveal: () => value, toString: () => '[redacted]', toJSON: () => '[redacted]' };
}

export function memoryLogger(): Logger & { events: LogEvent[] } {
  const events: LogEvent[] = [];
  const make = (base: LogEvent['fields']): Logger => ({
    log: (e) => {
      events.push({ ...e, fields: { ...base, ...e.fields } });
    },
    child: (f) => make({ ...base, ...f }),
  });
  return Object.assign(make({}), { events });
}

let shared: SqlDriver | null = null;
afterAll(async () => {
  await shared?.close();
  shared = null;
});

// The real schema: PGlite plus the common migrations from @umsbx/db (review H1: no fake database
// that accepts any column). One database per test file, emptied for each rig, keeps this fast.
export async function realDb(clock: Clock): Promise<SqlDriver> {
  if (shared === null) {
    shared = await openDatabase({ kind: 'pglite-memory' });
    await migrate(shared, clock);
  }
  await shared.exec('TRUNCATE sessions, rate_buckets, api_idempotency');
  return shared;
}

export interface TestRig {
  deps: SecurityDeps;
  clock: ReturnType<typeof fakeClock>;
  log: ReturnType<typeof memoryLogger>;
  audit: AuditEntry[];
  db: SqlDriver;
}

export async function makeRig(over: Partial<SecurityDeps> = {}): Promise<TestRig> {
  const clock = fakeClock('2026-10-22T09:00:00.000Z');
  const log = memoryLogger();
  const audit: AuditEntry[] = [];
  const db = over.db === undefined ? await realDb(clock) : (over.db as SqlDriver);
  const deps: SecurityDeps = {
    db,
    clock,
    ids: seededIds('rig'),
    log,
    audit: {
      async record(_tx, e) {
        audit.push(e);
      },
    },
    session_secret: secret('test-only-session-secret-not-a-credential'),
    passcode_hash: null,
    public_origin: ORIGIN,
    ...over,
  };
  return { deps, clock, log, audit, db };
}

export function cookiePair(setCookie: string): string {
  return setCookie.split(';')[0] ?? '';
}
