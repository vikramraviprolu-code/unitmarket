// Test support for @umsbx/security (lane 11). Not exported from index. Deterministic stand-ins for
// the lane 01 / 12 ports: fake clock, seeded ids, memory logger and audit sink, and an in-memory
// Database that understands only the statements packages/security issues against `sessions`,
// `rate_buckets` and `api_idempotency` (column lists from lane 12, 0002 and 0006).
// TEMP-until-lane-12: replace the fake database with PGlite when lane 12 merges.
import { createHash } from 'node:crypto';
import type {
  AuditEntry,
  Clock,
  Database,
  IdPrefix,
  Ids,
  LogEvent,
  Logger,
  Secret,
  SqlExecutor,
} from './contracts-stub';
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

type Row = Record<string, unknown>;

export function fakeDb(): Database & {
  tables: { sessions: Map<string, Row>; rate_buckets: Map<string, Row>; api_idempotency: Map<string, Row> };
} {
  const tables = {
    sessions: new Map<string, Row>(),
    rate_buckets: new Map<string, Row>(),
    api_idempotency: new Map<string, Row>(),
  };
  const idemKey = (kind: unknown, id: unknown, key: unknown): string => `${kind}|${id}|${key}`;
  const exec: SqlExecutor = {
    async query<T>(raw: string, p: unknown[] = []) {
      const sql = raw.replace(/\s+/g, ' ').trim();
      const rows = ((): Row[] => {
        if (sql.startsWith('INSERT INTO sessions')) {
          tables.sessions.set(String(p[0]), {
            id: p[0],
            actor_kind: p[1],
            actor_id: p[2],
            csrf_token_hash: p[3],
            created_at: p[4],
            last_seen_at: p[4],
            expires_at: p[5],
            revoked_at: null,
          });
          return [];
        }
        if (sql.startsWith('SELECT id, actor_kind, actor_id, csrf_token_hash')) {
          const r = tables.sessions.get(String(p[0]));
          return r ? [{ ...r }] : [];
        }
        if (sql.startsWith('UPDATE sessions SET last_seen_at')) {
          const r = tables.sessions.get(String(p[0]));
          if (r) r.last_seen_at = p[1];
          return [];
        }
        if (sql.startsWith('UPDATE sessions SET revoked_at')) {
          const hit: Row[] = [];
          for (const r of tables.sessions.values()) {
            if (r.actor_kind === p[0] && r.actor_id === p[1] && r.revoked_at === null) {
              r.revoked_at = p[2];
              hit.push({ id: r.id });
            }
          }
          return hit;
        }
        if (sql.startsWith('SELECT tokens, refilled_at FROM rate_buckets')) {
          const r = tables.rate_buckets.get(String(p[0]));
          return r ? [{ tokens: r.tokens, refilled_at: r.refilled_at }] : [];
        }
        if (sql.startsWith('INSERT INTO rate_buckets')) {
          tables.rate_buckets.set(String(p[0]), { tokens: p[1], refilled_at: p[2] });
          return [];
        }
        if (sql.startsWith('INSERT INTO api_idempotency')) {
          const k = idemKey(p[2], p[3], p[1]);
          if (tables.api_idempotency.has(k)) return [];
          tables.api_idempotency.set(k, {
            route: p[4],
            request_sha256: p[5],
            response: JSON.parse(String(p[6])),
          });
          return [{ id: p[0] }];
        }
        if (sql.startsWith('SELECT route, request_sha256, response FROM api_idempotency')) {
          const r = tables.api_idempotency.get(idemKey(p[0], p[1], p[2]));
          return r ? [{ ...r }] : [];
        }
        if (sql.startsWith('UPDATE api_idempotency SET response')) {
          const r = tables.api_idempotency.get(idemKey(p[0], p[1], p[2]));
          if (r) r.response = JSON.parse(String(p[3]));
          return [];
        }
        if (sql.startsWith('DELETE FROM api_idempotency')) {
          tables.api_idempotency.delete(idemKey(p[0], p[1], p[2]));
          return [];
        }
        throw new Error(`fakeDb: unsupported statement: ${sql.slice(0, 60)}`);
      })();
      return { rows: rows as T[] };
    },
    async exec() {
      /* no DDL in the fake */
    },
  };
  return Object.assign(
    {
      dialect: 'pglite' as const,
      query: exec.query,
      exec: exec.exec,
      transaction: <T>(fn: (tx: SqlExecutor) => Promise<T>) => fn(exec),
    },
    { tables },
  );
}

export interface TestRig {
  deps: SecurityDeps;
  clock: ReturnType<typeof fakeClock>;
  log: ReturnType<typeof memoryLogger>;
  audit: AuditEntry[];
  db: ReturnType<typeof fakeDb>;
}

export function makeRig(over: Partial<SecurityDeps> = {}): TestRig {
  const clock = fakeClock('2026-10-22T09:00:00.000Z');
  const log = memoryLogger();
  const audit: AuditEntry[] = [];
  const db = fakeDb();
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
