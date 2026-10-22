// TEMP-until-lane-01: local copy of the F1 interface text from docs/design/lanes/01-contracts.md.
// Lane 01 owns @umsbx/contracts. Replace these imports with `from "@umsbx/contracts"` once F1 is on main, then delete this file.

export type IsoUtc = string;
export interface Clock {
  now(): Date;
}
export interface SqlExecutor {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  exec(sql: string): Promise<void>;
}
export interface Database extends SqlExecutor {
  readonly dialect: 'pglite' | 'pg';
  transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T>;
}
