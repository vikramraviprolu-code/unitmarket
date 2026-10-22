// The driver abstraction. PGlite now; a node-postgres adapter (dialect 'pg') arrives later and
// needs its own owner approval for the `pg` dependency. Plain Database port from lane 01 F1.
import type { Database } from '@umsbx/contracts';

export type DbTarget = { kind: 'pglite-memory' } | { kind: 'pglite-disk'; dir: string };

// `target` says where the driver runs; resetDatabase (tests only) reads it.
export type SqlDriver = Database & { close(): Promise<void>; readonly target: DbTarget['kind'] };
