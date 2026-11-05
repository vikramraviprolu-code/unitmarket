// INT-TR0 / TR0.2: withTraceDb. While a context is open, every write that goes through the database it
// wraps carries that context as the transaction-local setting ums.trace; the capture trigger of the journal
// reads it. A transaction sets it first. A bare query that may write, or a bare exec, runs in a one
// statement transaction that does the same. A plain SELECT passes straight through (no extra round trip).
// With no context open every call passes through unchanged, and the trigger records an unattributed row.
// Only these fields are ever sent: anything else on the context object is dropped here.
import type { Clock, Database, SqlExecutor, TraceContext } from '@umsbx/contracts';

const READ = /^\s*(?:\/\*[\s\S]*?\*\/\s*|--[^\n]*\n\s*)*(?:select|show|values|explain)\b/i;

/** The ums.trace value: the context, plus the time of this write (from the injected clock). */
export function traceSetting(ctx: TraceContext, clock: Clock): string {
  return JSON.stringify({
    ctx_id: ctx.id,
    ctx_at: ctx.at,
    at: clock.now().toISOString(),
    channel: ctx.channel,
    actor_kind: ctx.actor_kind,
    actor_id: ctx.actor_id,
    on_behalf_of: ctx.on_behalf_of,
    mandate_id: ctx.mandate_id,
    mfa: ctx.mfa,
    req_id: ctx.req_id,
    ip_hash: ctx.ip_hash,
    ua_family: ctx.ua_family,
    api_key_id: ctx.api_key_id,
    job: ctx.job,
    tool: ctx.tool,
  });
}

const SET = "SELECT set_config('ums.trace', $1, true)";

export function withTraceDb<D extends Database>(
  db: D,
  get: () => TraceContext | undefined,
  clock: Clock,
): D {
  const traced = {
    query: <R = Record<string, unknown>>(
      sql: string,
      params?: unknown[],
    ): Promise<{ rows: R[] }> => {
      const ctx = get();
      if (ctx === undefined || READ.test(sql)) return db.query<R>(sql, params);
      const setting = traceSetting(ctx, clock);
      return db.transaction(async (tx: SqlExecutor) => {
        await tx.query(SET, [setting]);
        return tx.query<R>(sql, params);
      });
    },
    exec: (sql: string): Promise<void> => {
      const ctx = get();
      if (ctx === undefined) return db.exec(sql);
      const setting = traceSetting(ctx, clock);
      return db.transaction(async (tx: SqlExecutor) => {
        await tx.query(SET, [setting]);
        await tx.exec(sql);
      });
    },
    transaction: <T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T> => {
      const ctx = get();
      if (ctx === undefined) return db.transaction(fn);
      // The context is read when the transaction starts and stays for the whole of it, retries included.
      const setting = traceSetting(ctx, clock);
      return db.transaction(async (tx) => {
        await tx.query(SET, [setting]);
        return fn(tx);
      });
    },
  };
  return new Proxy(db, {
    get(target, prop) {
      if (prop === 'query' || prop === 'exec' || prop === 'transaction') return traced[prop];
      const v: unknown = Reflect.get(target, prop, target);
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
}
