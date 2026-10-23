// The logical export and its import (architecture section 8, lane CO-10). The export lists the tables
// in foreign-key order, parents first, and renders each table as one single-line INSERT statement
// whose rows travel as a JSON array. The import runs those statements in one transaction on a
// fresh, migrated database; it switches the user triggers off for that transaction only (the
// append-only guards would refuse a bulk load) and on again before it commits. Nothing here reads
// the environment, the clock or the network; the caller passes the time.
import { PGlite } from '@electric-sql/pglite';
import type { Database, SqlExecutor } from '@umsbx/contracts';

export async function tablesInDependencyOrder(db: SqlExecutor): Promise<string[]> {
  const tables = await db.query<{ tablename: string }>(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'schema_migrations' ORDER BY tablename",
  );
  const fks = await db.query<{ child: string; parent: string }>(
    `SELECT c.conrelid::regclass::text AS child, c.confrelid::regclass::text AS parent
     FROM pg_constraint c
     WHERE c.contype = 'f' AND c.connamespace = 'public'::regnamespace AND c.conrelid <> c.confrelid`,
  );
  const names = tables.rows.map((t) => t.tablename);
  const unmet = new Map<string, Set<string>>(names.map((n) => [n, new Set<string>()]));
  for (const { child, parent } of fks.rows) {
    const c = child.replace(/^"|"$/g, '');
    const p = parent.replace(/^"|"$/g, '');
    unmet.get(c)?.add(p);
  }
  const out: string[] = [];
  const left = new Set(names);
  while (left.size > 0) {
    const ready = [...left].filter((n) => [...unmet.get(n)!].every((p) => !left.has(p))).sort();
    if (ready.length === 0) throw new Error(`foreign-key cycle among: ${[...left].join(', ')}`);
    for (const n of ready) {
      out.push(n);
      left.delete(n);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Counts and version

const quote = (name: string) => `"${name.replace(/"/g, '""')}"`;

/** Row count per application table (schema_migrations excluded). */
export async function rowCounts(db: SqlExecutor): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of await tablesInDependencyOrder(db)) {
    const r = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${quote(t)}`);
    out[t] = r.rows[0]!.n;
  }
  return out;
}

/** The newest common migration recorded in the database, for example `0009_active_entitlement_unique`. */
export async function latestMigrationVersion(db: SqlExecutor): Promise<string> {
  const r = await db.query<{ v: string | null }>(
    "SELECT max(version) AS v FROM schema_migrations WHERE version NOT LIKE 'supabase/%'",
  );
  const v = r.rows[0]?.v;
  if (!v) throw new Error('no migration is recorded: this is not a migrated UnitMarket database');
  return v;
}

// ---------------------------------------------------------------------------------------------
// Export

export const EXPORT_FORMAT = 1;

export interface ExportOptions {
  /** The time written in the header, an ISO 8601 UTC string from the caller's clock. */
  utc: string;
}

export async function exportSql(db: SqlExecutor, options: ExportOptions): Promise<string> {
  const tables = await tablesInDependencyOrder(db);
  const lines = [
    '-- UnitMarket sandbox logical export (CO-10). One INSERT per table, parents first.',
    `-- format: ${EXPORT_FORMAT}`,
    `-- schema-version: ${await latestMigrationVersion(db)}`,
    `-- utc: ${options.utc}`,
    `-- tables: ${tables.join(',')}`,
  ];
  for (const t of tables) {
    // jsonb text keeps numbers and timestamps exactly as the database prints them.
    const r = await db.query<{ rows: string }>(
      `SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.ctid), '[]'::jsonb)::text AS rows FROM ${quote(t)} x`,
    );
    const json = r.rows[0]!.rows;
    if (json === '[]') continue;
    lines.push(
      `INSERT INTO ${quote(t)} OVERRIDING SYSTEM VALUE SELECT * FROM jsonb_populate_recordset(NULL::${quote(t)}, '${json.replace(/'/g, "''")}'::jsonb);`,
    );
  }
  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------------------------------------
// Import

// Rows the migrations seed. A fresh database holds only these, all stamped with the epoch; the
// import replaces them with the exported rows.
const SEED_TABLES = ['corridors', 'access_policies', 'safety_switches'] as const;
const SEED_EPOCH = '1970-01-01T00:00:00Z';

const STATEMENT =
  /^INSERT INTO "([a-z_][a-z0-9_]*)" OVERRIDING SYSTEM VALUE SELECT \* FROM jsonb_populate_recordset\(NULL::"\1", '((?:[^']|'')*)'::jsonb\);$/;

interface ParsedExport {
  schemaVersion: string;
  tables: string[];
  statements: { table: string; json: string }[];
}

function parseExport(sql: string): ParsedExport {
  const header = new Map<string, string>();
  const statements: { table: string; json: string }[] = [];
  for (const line of sql.split('\n')) {
    if (line === '') continue;
    if (line.startsWith('-- ')) {
      const m = /^-- ([a-z-]+): (.*)$/.exec(line);
      if (m && !header.has(m[1]!)) header.set(m[1]!, m[2]!);
      continue;
    }
    const m = STATEMENT.exec(line);
    if (!m) throw new Error('import refused: a line is not an export statement');
    statements.push({ table: m[1]!, json: m[2]!.replace(/''/g, "'") });
  }
  const schemaVersion = header.get('schema-version');
  const tables = header.get('tables');
  if (header.get('format') !== String(EXPORT_FORMAT) || !schemaVersion || tables === undefined) {
    throw new Error('import refused: the export header is missing or has an unknown format');
  }
  return { schemaVersion, tables: tables.split(',').filter(Boolean), statements };
}

/**
 * Loads a logical export into a fresh, migrated database in one transaction and returns the row
 * count per table. Refuses a schema-version mismatch, a database that already holds application
 * rows, and any text that is not a statement this module wrote. The user triggers are switched off
 * inside the transaction only; a failure rolls everything back, triggers included.
 */
export async function importSql(db: Database, sql: string): Promise<Record<string, number>> {
  const parsed = parseExport(sql);
  const have = await latestMigrationVersion(db);
  if (parsed.schemaVersion !== have) {
    throw new Error(
      `import refused: schema version mismatch (export ${parsed.schemaVersion}, database ${have})`,
    );
  }
  const known = new Set(await tablesInDependencyOrder(db));
  for (const t of parsed.tables) {
    if (!known.has(t)) throw new Error(`import refused: unknown table ${t}`);
  }
  for (const s of parsed.statements) {
    if (!known.has(s.table) || !parsed.tables.includes(s.table)) {
      throw new Error(`import refused: statement for a table that is not listed: ${s.table}`);
    }
  }
  await db.transaction(async (tx) => {
    const order = await tablesInDependencyOrder(tx);
    for (const t of order) {
      const seeded = (SEED_TABLES as readonly string[]).includes(t);
      const r = await tx.query<{ n: number }>(
        seeded
          ? `SELECT count(*)::int AS n FROM ${quote(t)} WHERE created_at <> '${SEED_EPOCH}'`
          : `SELECT count(*)::int AS n FROM ${quote(t)}`,
      );
      if (r.rows[0]!.n > 0) {
        throw new Error(
          `import refused: the database is not empty (${t}); restore into a fresh one`,
        );
      }
    }
    const off = await tx.query(
      "SELECT 1 FROM pg_trigger WHERE NOT tgisinternal AND tgenabled <> 'O'",
    );
    if (off.rows.length > 0) throw new Error('import refused: a trigger is already switched off');
    // Inside this transaction only. Foreign keys, checks and unique indexes stay enforced.
    for (const t of order) await tx.exec(`ALTER TABLE ${quote(t)} DISABLE TRIGGER USER`);
    for (const t of [...order].reverse()) {
      if ((SEED_TABLES as readonly string[]).includes(t)) await tx.exec(`DELETE FROM ${quote(t)}`);
    }
    for (const s of parsed.statements) {
      await tx.query(
        `INSERT INTO ${quote(s.table)} OVERRIDING SYSTEM VALUE SELECT * FROM jsonb_populate_recordset(NULL::${quote(s.table)}, $1::jsonb)`,
        [s.json],
      );
    }
    // Identity columns carry on after the highest imported value.
    const ids = await tx.query<{ t: string; c: string }>(
      `SELECT c.relname AS t, a.attname AS c FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
       WHERE c.relnamespace = 'public'::regnamespace AND a.attidentity <> '' AND NOT a.attisdropped`,
    );
    for (const { t, c } of ids.rows) {
      await tx.query(
        `SELECT setval(pg_get_serial_sequence($1, $2), coalesce((SELECT max(${quote(c)}) FROM ${quote(t)}), 1), (SELECT count(*) > 0 FROM ${quote(t)}))`,
        [quote(t), c],
      );
    }
    for (const t of order) await tx.exec(`ALTER TABLE ${quote(t)} ENABLE TRIGGER USER`);
  });
  return rowCounts(db);
}

// ---------------------------------------------------------------------------------------------
// Data directory tarball (PGlite dumpDataDir / loadDataDir)

function executorOf(pg: PGlite): SqlExecutor {
  return {
    query: async <T = Record<string, unknown>>(text: string, params?: unknown[]) => {
      const r = await pg.query<T>(text, params);
      return { rows: r.rows };
    },
    exec: async (text: string) => {
      await pg.exec(text);
    },
  };
}

export interface BackupHandle {
  db: SqlExecutor;
  /** The gzip tarball of the data directory. */
  tarball(): Promise<Uint8Array>;
  close(): Promise<void>;
}

/** Opens an existing data directory for a backup. The caller has checked that the app is not running. */
export async function openForBackup(dir: string): Promise<BackupHandle> {
  const pg = new PGlite(dir);
  await pg.waitReady;
  return {
    db: executorOf(pg),
    tarball: async () => new Uint8Array(await (await pg.dumpDataDir('gzip')).arrayBuffer()),
    close: () => pg.close(),
  };
}

/** Writes a tarball made by openForBackup(...).tarball() into an empty data directory. */
export async function restoreDataDirTarball(dir: string, bytes: Uint8Array): Promise<void> {
  const pg = new PGlite({ dataDir: dir, loadDataDir: new Blob([bytes]) });
  await pg.waitReady;
  await pg.close();
}
