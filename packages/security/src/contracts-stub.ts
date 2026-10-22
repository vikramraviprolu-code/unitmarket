// TEMP-until-lane-01: local copy of the F1 interface text from docs/design/lanes/01-contracts.md
// (primitives, result, ports, actor). Lane 01 owns @umsbx/contracts. When F1 merges, delete this
// file and import from '@umsbx/contracts'. Do not extend it.
export type Id = string;
export type Ok<T> = { ok: true; value: T };
export type Err<E> = { ok: false; error: E };
export type Result<T, E> = Ok<T> | Err<E>;
export const ok = <T>(value: T): Ok<T> => ({ ok: true, value });
export const err = <E>(error: E): Err<E> => ({ ok: false, error });

export interface SqlExecutor {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  exec(sql: string): Promise<void>;
}
export interface Database extends SqlExecutor {
  readonly dialect: 'pglite' | 'pg';
  transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T>;
}
export interface Clock {
  now(): Date;
}
export type IdPrefix =
  | 'ord'
  | 'unt'
  | 'pvo'
  | 'opr'
  | 'ent'
  | 'apr'
  | 'quo'
  | 'lnk'
  | 'aev'
  | 'led'
  | 'rct'
  | 'cas'
  | 'cac'
  | 'rfr'
  | 'brf'
  | 'prp'
  | 'pub'
  | 'art'
  | 'ofr'
  | 'buy'
  | 'ses'
  | 'alr'
  | 'pcl'
  | 'whk'
  | 'aud'
  | 'oap';
export interface Ids {
  next(prefix: IdPrefix): Id;
  nonce(): string;
}
export interface Secret {
  reveal(): string;
  toString(): '[redacted]';
  toJSON(): '[redacted]';
}
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export interface LogEvent {
  msg: string;
  level: LogLevel;
  fields: Record<string, string | number | boolean | null>;
}
export interface Logger {
  log(e: LogEvent): void;
  child(fields: LogEvent['fields']): Logger;
}
export type Actor =
  | { kind: 'buyer'; buyer_id: Id }
  | { kind: 'publisher'; publisher_id: Id }
  | { kind: 'operator'; operator_id: Id; mfa: boolean }
  | { kind: 'system' };
export interface AuditEntry {
  actor: Actor;
  action: string;
  target: Id | null;
  reason: string | null;
  detail: Record<string, string | number | boolean | null>;
}
export interface AuditSink {
  record(tx: SqlExecutor, e: AuditEntry): Promise<void>;
}
