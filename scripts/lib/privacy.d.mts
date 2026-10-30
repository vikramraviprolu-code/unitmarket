export type Tty = { isTTY: boolean | undefined; env: Record<string, string | undefined> };
export type PrivacyResult<T> = { ok: true; value: T } | { ok: false; error: string };
export interface Queryable {
  query<R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: R[] }>;
}
export interface PrivacyDb extends Queryable {
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
}
export interface PrivacyAudit {
  record(tx: never, e: never): Promise<void>;
}
export interface ExportDocument {
  buyer_id: string;
  exported_at: string;
  tables: Record<string, Record<string, unknown>[]>;
}
export interface DeleteOutcome {
  changed: boolean;
  pseudonym: string;
  counts: { buyers: number; briefs: number; sessions_revoked: number };
}
export const REMOVED_TEXT: string;
export function pseudonymFor(buyerId: string): string;
export function refusal(tty: Tty): string | null;
export function runExport(d: {
  db: PrivacyDb;
  now: Date;
  tty: Tty;
  buyer_id: string;
}): Promise<PrivacyResult<ExportDocument>>;
export function runDelete(d: {
  db: PrivacyDb;
  clock: { now(): Date };
  audit: PrivacyAudit | { record(...a: never[]): Promise<void> };
  tty: Tty;
  ask: (prompt: string) => Promise<string>;
  write: (line: string) => void;
  buyer_id: string;
  operator_id: string;
  reason: string;
}): Promise<PrivacyResult<DeleteOutcome>>;
