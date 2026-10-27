// Postgres driver for the Database port (PG-1, D-049, D-050). node-postgres behind the same port as
// PGlite: pooled queries, one pooled client per transaction (BEGIN, COMMIT, ROLLBACK on throw), the
// serialization/deadlock retry of retry.ts, and a session advisory lock for migrate().
//
// The URL, user and password are secrets. Nothing here logs. A bad URL raises PgConfigError with a fixed
// reason; a failed connection raises PgConnectionError with the error code only; any other error that
// leaves this module has the URL and the password scrubbed from its message and stack.
//
// `pg` is loaded on first use (dynamic import) so a PGlite-only process never loads it.
import type { Pool, PoolClient, Client, ClientConfig } from 'pg';
import type { SqlExecutor } from '@umsbx/contracts';
import type { DbTarget, PgOptions, SqlDriver } from './driver';
import { withSerializationRetry } from './retry';

export const DEFAULT_POOL_MAX = 5;
export const DEFAULT_STATEMENT_TIMEOUT_MS = 30_000;
export const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
/** How long a session advisory lock may be waited for (migrate() of a second booting process). */
export const ADVISORY_LOCK_WAIT_MS = 120_000;
const APPLICATION_NAME = 'umsbx';
const IDLE_TIMEOUT_MS = 10_000;

/** A DATABASE_URL that cannot be used. The message is a fixed reason; it never quotes the input. */
export class PgConfigError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`invalid database configuration: ${reason}`);
    this.name = 'PgConfigError';
    this.reason = reason;
  }
}

/** The server could not be reached or refused the login. Carries the error code only. */
export class PgConnectionError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(`database connection failed (${code})`);
    this.name = 'PgConnectionError';
    this.code = code;
  }
}

export interface ParsedPgUrl {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly database: string;
  /** false: no TLS. Otherwise the node `tls` options (rejectUnauthorized says whether the chain is checked). */
  readonly ssl: false | { rejectUnauthorized: boolean };
  /** true when `host` is a unix socket directory (Cloud SQL, local test server). */
  readonly socket: boolean;
  /** Not enumerable: JSON.stringify, spread and util.inspect do not show it. */
  readonly password: string;
}

const URL_RE =
  /^postgres(?:ql)?:\/\/(?:([^:@/?#]*)(?::([^@/?#]*))?@)?(\[[0-9a-fA-F:.]+\]|[^:/?#@]*)(?::([^/?#]*))?\/([^?#]*)(?:\?([^#]*))?$/;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
const TLS_NO_VERIFY = new Set(['allow', 'prefer', 'require', 'no-verify']);
const TLS_VERIFY = new Set(['verify-ca', 'verify-full']);

function decode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    throw new PgConfigError('bad percent-escape');
  }
}

/**
 * Parses postgres://u:p@host:5432/db?sslmode=require and the socket form
 * postgres://u:p@/db?host=/cloudsql/PROJECT:REGION:INSTANCE. Only `sslmode` and `host` are read from
 * the query; other parameters are ignored (the driver sets application_name and the timeouts itself).
 * TLS: sslmode 'disable' is off; 'allow', 'prefer', 'require' and 'no-verify' encrypt without checking the chain;
 * verify-ca and verify-full check it. With no sslmode a socket or local host is plain and every other
 * host is encrypted without a chain check (safer than plain, and Cloud SQL public addresses use a
 * private CA).
 */
export function parsePgUrl(url: string): ParsedPgUrl {
  const m = typeof url === 'string' ? URL_RE.exec(url) : null;
  if (m === null) throw new PgConfigError('not a postgres:// URL');
  const [, userRaw, passRaw, hostRaw = '', portRaw, dbRaw = '', queryRaw] = m;
  const user = decode(userRaw ?? '');
  if (user === '') throw new PgConfigError('missing user');
  const password = decode(passRaw ?? '');
  const database = decode(dbRaw);
  if (database === '') throw new PgConfigError('missing database name');
  let port = 5432;
  if (portRaw !== undefined && portRaw !== '') {
    if (!/^\d{1,5}$/.test(portRaw) || Number(portRaw) < 1 || Number(portRaw) > 65535) {
      throw new PgConfigError('bad port');
    }
    port = Number(portRaw);
  }
  const query = new Map<string, string>();
  for (const part of (queryRaw ?? '').split('&')) {
    if (part === '') continue;
    const eq = part.indexOf('=');
    const k = decode(eq < 0 ? part : part.slice(0, eq));
    const v = decode(eq < 0 ? '' : part.slice(eq + 1));
    query.set(k, v);
  }
  let host = decode(hostRaw);
  const hostParam = query.get('host');
  if (hostParam !== undefined && hostParam !== '') host = hostParam;
  if (host === '') host = 'localhost';
  const socket = host.startsWith('/');
  const mode = query.get('sslmode');
  let ssl: ParsedPgUrl['ssl'];
  if (socket) ssl = false;
  else if (mode === undefined) ssl = LOCAL_HOSTS.has(host) ? false : { rejectUnauthorized: false };
  else if (mode === 'disable') ssl = false;
  else if (TLS_NO_VERIFY.has(mode)) ssl = { rejectUnauthorized: false };
  else if (TLS_VERIFY.has(mode)) ssl = { rejectUnauthorized: true };
  else throw new PgConfigError('unsupported sslmode');
  const out = { host, port, user, database, ssl, socket } as ParsedPgUrl;
  Object.defineProperty(out, 'password', { value: password, enumerable: false });
  return out;
}

function checkWhole(name: string, v: number | undefined, def: number, min: number, max: number) {
  const n = v ?? def;
  if (!Number.isInteger(n) || n < min || n > max) throw new PgConfigError(`${name} out of range`);
  return n;
}

function scrubber(url: string, password: string): (e: unknown) => unknown {
  const needles = [url, ...(password.length >= 6 ? [password] : [])].filter((s) => s !== '');
  const clean = (s: string) => needles.reduce((acc, n) => acc.split(n).join('[redacted]'), s);
  return (e) => {
    if (typeof e !== 'object' || e === null) return e;
    const err = e as { message?: unknown; stack?: unknown };
    try {
      if (typeof err.message === 'string') err.message = clean(err.message);
      if (typeof err.stack === 'string') err.stack = clean(err.stack);
    } catch {
      /* frozen error: leave it */
    }
    return e;
  };
}

/** A fixed, safe reason for a connect-phase failure: the error code, never the message. */
function connectCode(e: unknown): string {
  const code = (e as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && /^[A-Za-z0-9_]{3,20}$/.test(code)) return code;
  const msg = (e as { message?: unknown } | null)?.message;
  if (typeof msg === 'string' && /timeout/i.test(msg)) return 'ETIMEDOUT';
  return 'UNKNOWN';
}

// PGlite parity: int8 is a number when it is a safe integer, a bigint otherwise (node-postgres
// returns a string).
const INT8 = 20;
function parseInt8(s: string): number | bigint {
  const n = BigInt(s);
  return n < BigInt(Number.MIN_SAFE_INTEGER) || n > BigInt(Number.MAX_SAFE_INTEGER) ? n : Number(n);
}

type Queryable = Pick<PoolClient, 'query'>;

function executor(q: Queryable, alive: () => boolean, scrub: (e: unknown) => unknown): SqlExecutor {
  return {
    query: async <T = Record<string, unknown>>(sql: string, params?: unknown[]) => {
      if (!alive()) throw new Error('transaction already finished');
      try {
        const r = await q.query(sql, params);
        const last = Array.isArray(r) ? r[r.length - 1] : r;
        return { rows: (last?.rows ?? []) as T[] };
      } catch (e) {
        throw scrub(e);
      }
    },
    exec: async (sql: string) => {
      if (!alive()) throw new Error('transaction already finished');
      try {
        await q.query(sql);
      } catch (e) {
        throw scrub(e);
      }
    },
  };
}

export async function openPg(t: Extract<DbTarget, { kind: 'postgres' }>): Promise<SqlDriver> {
  const parsed = parsePgUrl(t.url);
  const poolMax = checkWhole('pool_max', t.pool_max, DEFAULT_POOL_MAX, 1, 100);
  const statementMs = checkWhole(
    'statement_timeout_ms',
    t.statement_timeout_ms,
    DEFAULT_STATEMENT_TIMEOUT_MS,
    1,
    3_600_000,
  );
  const connectMs = checkWhole(
    'connect_timeout_ms',
    t.connect_timeout_ms,
    DEFAULT_CONNECT_TIMEOUT_MS,
    1,
    600_000,
  );
  const scrub = scrubber(t.url, parsed.password);

  const { Pool, Client, types } = (await import('pg')).default;
  const base: ClientConfig = {
    host: parsed.host,
    port: parsed.port,
    user: parsed.user,
    password: parsed.password,
    database: parsed.database,
    application_name: APPLICATION_NAME,
    types: {
      getTypeParser: ((oid: number, format?: 'text' | 'binary') =>
        oid === INT8 && format !== 'binary'
          ? parseInt8
          : types.getTypeParser(oid as never, format as never)) as never,
    },
    ...(parsed.ssl === false ? {} : { ssl: parsed.ssl }),
  };
  const pool: Pool = new Pool({
    ...base,
    max: poolMax,
    statement_timeout: statementMs,
    connectionTimeoutMillis: connectMs,
    idleTimeoutMillis: IDLE_TIMEOUT_MS,
  });
  // An idle client that loses its connection emits 'error'; without a listener node would exit.
  pool.on('error', () => undefined);
  // A checked-out client whose connection drops between two statements emits 'error' with no query to
  // fail; the next statement then rejects on its own. One listener per client, added when it is created.
  pool.on('connect', (c) => {
    c.on('error', () => undefined);
  });

  let closed = false;
  let closing: Promise<void> | null = null;
  const lockClients = new Set<Client>();
  const assertOpen = () => {
    if (closed) throw new Error('database is closed');
  };

  async function checkout(): Promise<PoolClient> {
    assertOpen();
    try {
      return await pool.connect();
    } catch (e) {
      throw new PgConnectionError(connectCode(e));
    }
  }

  // Fail fast like PGlite's waitReady: prove the login works now, with a fixed error if it does not.
  try {
    const probe = await checkout();
    probe.release();
  } catch (e) {
    closed = true;
    await pool.end().catch(() => undefined);
    throw e;
  }

  const pooled = <T>(fn: (c: PoolClient) => Promise<T>): Promise<T> => {
    return (async () => {
      const client = await checkout();
      let failed = false;
      try {
        return await fn(client);
      } catch (e) {
        failed = true;
        throw e;
      } finally {
        // A failed statement may have left a BEGIN open (multi-statement exec): drop the connection.
        client.release(failed);
      }
    })();
  };

  const always = () => true;
  const query = <T = Record<string, unknown>>(sql: string, params?: unknown[]) =>
    pooled((c) => executor(c, always, scrub).query<T>(sql, params));
  const exec = (sql: string) => pooled((c) => executor(c, always, scrub).exec(sql));

  const transaction = async <T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T> => {
    const client = await checkout();
    let destroy = false;
    let live = true;
    try {
      try {
        await client.query('BEGIN');
      } catch (e) {
        destroy = true;
        throw scrub(e);
      }
      let result: T;
      try {
        result = await fn(executor(client, () => live, scrub));
      } catch (e) {
        live = false;
        try {
          await client.query('ROLLBACK');
        } catch {
          destroy = true;
        }
        throw scrub(e);
      }
      live = false;
      try {
        await client.query('COMMIT');
      } catch (e) {
        try {
          await client.query('ROLLBACK');
        } catch {
          /* the connection is dropped below */
        }
        destroy = true;
        throw scrub(e);
      }
      return result;
    } finally {
      live = false;
      client.release(destroy);
    }
  };

  const withAdvisoryLock = async <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    assertOpen();
    const client = new Client({ ...base, statement_timeout: ADVISORY_LOCK_WAIT_MS });
    let lost = false;
    client.on('error', () => {
      lost = true;
    });
    lockClients.add(client);
    try {
      try {
        await client.connect();
      } catch (e) {
        throw new PgConnectionError(connectCode(e));
      }
      try {
        await client.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [key]);
      } catch (e) {
        throw scrub(e);
      }
      let out: T;
      try {
        out = await fn();
      } finally {
        try {
          await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [key]);
        } catch {
          /* ending the connection below releases every session lock anyway */
        }
      }
      if (lost) throw new PgConnectionError('LOCK_CONNECTION_LOST');
      return out;
    } finally {
      lockClients.delete(client);
      await client.end().catch(() => undefined);
    }
  };

  const close = (): Promise<void> => {
    closed = true;
    closing ??= (async () => {
      await Promise.all([...lockClients].map((c) => c.end().catch(() => undefined)));
      await pool.end();
    })();
    return closing;
  };

  return withSerializationRetry<SqlDriver>({
    dialect: 'pg',
    target: 'postgres',
    query,
    exec,
    transaction,
    close,
    withAdvisoryLock,
  });
}

export type { PgOptions };
