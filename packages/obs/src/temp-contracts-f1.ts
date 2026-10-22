// TEMP-until-lane-01: local copy of the F1 interface text from docs/design/lanes/01-contracts.md.
// Lane 01 owns @umsbx/contracts. Replace these imports with `from "@umsbx/contracts"` once F1 is on main, then delete this file.

export type Id = string;
export type IsoUtc = string;
export interface Clock {
  now(): Date;
}
export type IdPrefix =
  | 'ord' | 'unt' | 'pvo' | 'opr' | 'ent' | 'apr' | 'quo' | 'lnk' | 'aev' | 'led' | 'rct' | 'cas'
  | 'cac' | 'rfr' | 'brf' | 'prp' | 'pub' | 'art' | 'ofr' | 'buy' | 'ses' | 'alr' | 'pcl' | 'whk'
  | 'aud' | 'oap';
export interface Ids {
  next(prefix: IdPrefix): Id;
  nonce(): string;
}
export interface SqlExecutor {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  exec(sql: string): Promise<void>;
}
export type Actor =
  | { kind: 'buyer'; buyer_id: Id }
  | { kind: 'publisher'; publisher_id: Id }
  | { kind: 'operator'; operator_id: Id; mfa: boolean }
  | { kind: 'system' };
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
