// The logical export and its import (architecture section 8, lane CO-10). The export lists the tables
// in foreign-key order, parents first, and renders each table as one single-line INSERT statement
// whose rows travel as a JSON array. The import runs those statements in one transaction on a
// fresh, migrated database; it switches the user triggers off for that transaction only (the
// append-only guards would refuse a bulk load) and on again before it commits. Nothing here reads
// the environment, the clock or the network; the caller passes the time.
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { PGlite } from '@electric-sql/pglite';
import type { Clock, Database, SqlExecutor } from '@umsbx/contracts';
import { applyMigrations, MIGRATIONS_ROOT } from './migrate';
import { openDatabase } from './pglite';
import { traceInvariants } from './trace-verify';
import { traceSetting } from './trace-db';

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

// INT-TR0: trace_tracked is the allow-list of the journal. The migration writes it and a reset writes it
// again; an export neither needs nor carries it.
const NOT_EXPORTED: readonly string[] = ['trace_tracked'];
// INT-TR0 (restore): a freshly migrated database already holds the journal rows of the six seeded switches
// (channel backfill) and their heads. The import accepts them and replaces them with the exported journal.
const TRACE_EVENTS_GUARD = 'trace_events_append_only';

export async function exportSql(db: SqlExecutor, options: ExportOptions): Promise<string> {
  const tables = (await tablesInDependencyOrder(db)).filter((t) => !NOT_EXPORTED.includes(t));
  const lines = [
    '-- UnitMarket sandbox logical export (CO-10). One INSERT per table, parents first.',
    `-- format: ${EXPORT_FORMAT}`,
    `-- schema-version: ${await latestMigrationVersion(db)}`,
    `-- utc: ${options.utc}`,
    `-- tables: ${tables.join(',')}`,
  ];
  for (const t of tables) {
    // jsonb text keeps numbers and timestamps exactly as the database prints them.
    // Insertion order (ctid) except the one self-referencing table: the ledger goes by time, a sale
    // before its refunds, then id, so an updated row (a new tuple position) cannot reorder it.
    const order = t === 'ledger_entries' ? "x.created_at, (x.kind <> 'sale'), x.id" : 'x.ctid';
    const r = await db.query<{ rows: string }>(
      `SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY ${order}), '[]'::jsonb)::text AS rows FROM ${quote(t)} x`,
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
const SEED_TABLES = ['corridors', 'access_policies', 'safety_switches', 'fx_rates'] as const;
const SEED_EPOCH = '1970-01-01T00:00:00Z';
const SEED_DELETE_GUARD = 'safety_switches_no_delete';
// MC2-L4: fx_rates has no created_at; its migration rows are the ones marked source = 'seed', so any other row
// means the database is not fresh. The table is append-only, so its delete guard is lifted for the seed
// delete alone, like the safety switch guard.
const NOT_SEED_ROW: Record<string, string> = { fx_rates: "source <> 'seed'" };
const FX_DELETE_GUARD = 'fx_rates_append_only';

// One export statement is exactly: PREFIX(table) + the doubled-quote JSON literal + SUFFIX. It is
// checked with a fixed prefix and suffix and one linear scan for a lone quote, never with a pattern
// that backtracks over the literal (a table line can be tens of megabytes).
const PREFIX =
  /^INSERT INTO "([a-z_][a-z0-9_]*)" OVERRIDING SYSTEM VALUE SELECT \* FROM jsonb_populate_recordset\(NULL::"([a-z_][a-z0-9_]*)", '/;
const SUFFIX = "'::jsonb);";

function parseStatement(line: string): { table: string; json: string } | null {
  const m = PREFIX.exec(line);
  if (!m || m[1] !== m[2] || !line.endsWith(SUFFIX) || line.length < m[0].length + SUFFIX.length) {
    return null;
  }
  const literal = line.slice(m[0].length, line.length - SUFFIX.length);
  for (let i = literal.indexOf("'"); i >= 0; i = literal.indexOf("'", i + 2)) {
    if (literal[i + 1] !== "'") return null; // a lone quote would end the literal early
  }
  return { table: m[1]!, json: literal.replace(/''/g, "'") };
}

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
    const statement = parseStatement(line);
    if (!statement) throw new Error('import refused: a line is not an export statement');
    statements.push(statement);
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
      if (NOT_EXPORTED.includes(t) || t === 'trace_heads') continue;
      const seeded = (SEED_TABLES as readonly string[]).includes(t);
      const r = await tx.query<{ n: number }>(
        seeded
          ? `SELECT count(*)::int AS n FROM ${quote(t)} WHERE ${NOT_SEED_ROW[t] ?? `created_at <> '${SEED_EPOCH}'`}`
          : t === 'trace_events'
            ? `SELECT count(*)::int AS n FROM ${quote(t)} WHERE channel IS DISTINCT FROM 'backfill'`
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
    // Inside this transaction only, and only the one guard that refuses to delete the seed switch
    // rows. Every INSERT guard (ledger bounds, order currency and approval checks) stays on, so the
    // import re-checks what it loads; foreign keys, checks and unique indexes stay enforced too.
    // Restore mode: the capture triggers journal nothing while the rows load, and the exported events keep
    // their seqs. The setting is local to this transaction. The migration's own backfill events and heads
    // are removed with the journal guard lifted for these two deletes only (like the seed guards below).
    await tx.query('SELECT set_config(\'ums.trace\', \'{"mode":"restore"}\', true)');
    await tx.exec(`ALTER TABLE trace_events DISABLE TRIGGER ${quote(TRACE_EVENTS_GUARD)}`);
    await tx.exec("DELETE FROM trace_events WHERE channel = 'backfill'");
    await tx.exec('DELETE FROM trace_heads');
    await tx.exec(`ALTER TABLE trace_events ENABLE TRIGGER ${quote(TRACE_EVENTS_GUARD)}`);
    await tx.exec(`ALTER TABLE safety_switches DISABLE TRIGGER ${quote(SEED_DELETE_GUARD)}`);
    await tx.exec(`ALTER TABLE fx_rates DISABLE TRIGGER ${quote(FX_DELETE_GUARD)}`);
    for (const t of [...order].reverse()) {
      if ((SEED_TABLES as readonly string[]).includes(t)) await tx.exec(`DELETE FROM ${quote(t)}`);
    }
    // The fx_rates delete guard is back on as soon as its seed rows are gone, before anything is loaded.
    await tx.exec(`ALTER TABLE fx_rates ENABLE TRIGGER ${quote(FX_DELETE_GUARD)}`);
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
    await tx.exec(`ALTER TABLE safety_switches ENABLE TRIGGER ${quote(SEED_DELETE_GUARD)}`);
    // INV-T2 (a row written with no context) is reported after a restore, never a reason to refuse it: a
    // backup taken before the journal's callers all carried a context must still load.
    const broken = (await checkInvariants(tx)).filter((l) => !l.startsWith('INV-T2'));
    if (broken.length > 0) {
      throw new Error(`import refused: the loaded data breaks an invariant: ${broken.join('; ')}`);
    }
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
  // A copy backed by a plain ArrayBuffer: Blob parts do not accept a view over a shared buffer.
  const copy = new Uint8Array(new ArrayBuffer(bytes.length));
  copy.set(bytes);
  const pg = new PGlite({ dataDir: dir, loadDataDir: new Blob([copy]) });
  await pg.waitReady;
  await pg.close();
}

// ---------------------------------------------------------------------------------------------
// Invariants, guards and the outbound switch after a restore

const SHOWN = 5;
const describe = (title: string, bad: string[]) =>
  `${title}: ${bad.length} violation${bad.length === 1 ? '' : 's'}: ${bad.slice(0, SHOWN).join(', ')}${bad.length > SHOWN ? ', ...' : ''}`;

/**
 * Read-only checks over the loaded rows, the same ideas as the platform invariants (payments INV1
 * and INV2) plus one environment per order chain. Returns one line per broken invariant.
 */
export async function checkInvariants(db: SqlExecutor): Promise<string[]> {
  const out: string[] = [];
  const ids = async (sql: string) => (await db.query<{ id: string }>(sql)).rows.map((r) => r.id);

  const inv1 = await ids(
    `SELECT u.id FROM order_units u LEFT JOIN ledger_entries l ON l.unit_id = u.id
      GROUP BY u.id, u.amount_minor, u.refunded_minor, u.captured_verified_at
     HAVING CASE WHEN u.captured_verified_at IS NOT NULL THEN
              count(*) FILTER (WHERE l.kind = 'sale') <> 1
              OR coalesce(sum(l.amount_minor) FILTER (WHERE l.kind = 'sale'), 0) <> u.amount_minor
              OR coalesce(sum(l.amount_minor) FILTER (WHERE l.kind = 'refund'), 0) <> u.refunded_minor
            ELSE count(l.id) FILTER (WHERE l.kind IN ('sale', 'refund')) > 0 END
     ORDER BY u.id`,
  );
  if (inv1.length)
    out.push(describe('INV1 ledger sale and refunds against each verified unit', inv1));

  const inv2 = await ids(
    `SELECT e.id FROM entitlements e JOIN order_units u ON u.id = e.unit_id
      WHERE e.access_state = 'available'
        AND NOT (e.money_state = 'captured' AND u.captured_verified_at IS NOT NULL AND u.capture_id IS NOT NULL
                 AND u.status IN ('captured_verified', 'partially_refunded', 'reversal_suspected'))
      ORDER BY e.id`,
  );
  if (inv2.length) out.push(describe('INV2 available items without a verified capture', inv2));

  const env = await ids(
    `SELECT l.id FROM ledger_entries l JOIN order_units u ON u.id = l.unit_id JOIN orders o ON o.id = u.order_id
       WHERE l.environment <> o.environment
     UNION ALL
     SELECT e.id FROM entitlements e JOIN order_units u ON u.id = e.unit_id JOIN orders o ON o.id = u.order_id
       WHERE e.environment <> o.environment
     UNION ALL
     SELECT r.id FROM receipts r JOIN orders o ON o.id = r.order_id WHERE r.environment <> o.environment
     ORDER BY 1`,
  );
  if (env.length) out.push(describe('environment of a row differs from its order', env));
  // INT-TR0: INV-T1 (the journal's chains, heads, seals and digests) and INV-T2 (no unattributed write).
  out.push(...(await traceInvariants(db)));
  return out;
}

const triggerCache = new Map<string, Promise<string[]>>();

/**
 * The user triggers a correctly migrated schema has: apply the migrations to an empty in-memory
 * database and read pg_trigger, so renames and drops in later migrations are followed. Cached per
 * migration directory for the life of the process.
 */
export function expectedTriggers(
  clock: Clock,
  dir: string = join(MIGRATIONS_ROOT, 'common'),
): Promise<string[]> {
  let found = triggerCache.get(dir);
  if (!found) {
    found = (async () => {
      const db = await openDatabase({ kind: 'pglite-memory' });
      try {
        await applyMigrations(db, clock, dir);
        const r = await db.query<{ tgname: string }>(
          'SELECT tgname FROM pg_trigger WHERE NOT tgisinternal ORDER BY tgname',
        );
        return r.rows.map((t) => t.tgname);
      } finally {
        await db.close();
      }
    })();
    triggerCache.set(dir, found);
    found.catch(() => triggerCache.delete(dir));
  }
  return found;
}

/** Problems with the user triggers: any switched off, any expected one missing. Empty when sound. */
export async function guardProblems(db: SqlExecutor, expected: string[]): Promise<string[]> {
  const r = await db.query<{ tgname: string; tgenabled: string }>(
    'SELECT tgname, tgenabled FROM pg_trigger WHERE NOT tgisinternal',
  );
  const have = new Map(r.rows.map((t) => [t.tgname, t.tgenabled]));
  const problems: string[] = [];
  const off = [...have].filter(([, e]) => e !== 'O').map(([n]) => n);
  if (off.length) problems.push(`trigger(s) switched off: ${off.sort().join(', ')}`);
  const missing = expected.filter((n) => !have.has(n));
  if (missing.length) problems.push(`trigger(s) missing: ${missing.join(', ')}`);
  return problems;
}

export interface OutboundState {
  /** paypal_outbound was on in the data that was restored. */
  switch_was_on: boolean;
  /** Approval rows present. They are kept as they are (the table is append-only). */
  approvals: { id: string; ref: string; scope: string; valid_until: string; approved_by: string }[];
}

/** Approval rows whose valid_until is after the given time (ISO UTC), refs only. */
export async function liveApprovals(db: SqlExecutor, nowIso: string): Promise<string[]> {
  const r = await db.query<{ approval_ref: string }>(
    'SELECT approval_ref FROM outbound_approvals WHERE valid_until > $1 ORDER BY approval_ref',
    [nowIso],
  );
  return r.rows.map((a) => a.approval_ref);
}

/**
 * After a restore: force paypal_outbound off, write one audit row for that change (ids only), and
 * report what was found. Approval rows are kept: setSwitch turns the switch on with MFA and ANY
 * approval row whose valid_until is in the future, so a kept row re-activates when the switch is
 * turned on with its ref. Call inside a transaction, after the row counts were compared (this adds
 * one audit_log row).
 */
export async function disarmOutbound(
  db: SqlExecutor,
  atIso: string,
  auditId: string,
): Promise<OutboundState> {
  // INT-TR0: the restore's own writes (the switch and its audit row) are journaled as system on the cli channel,
  // not left unattributed. The caller runs this inside a transaction, so the setting covers all three writes.
  await db.query("SELECT set_config('ums.trace', $1, true)", [
    traceSetting(
      {
        id: `ctx_${auditId}`,
        at: atIso,
        channel: 'cli',
        actor_kind: 'system',
        actor_id: 'restore',
        on_behalf_of: null,
        mandate_id: null,
        mfa: false,
        req_id: null,
        ip_hash: null,
        ua_family: null,
        api_key_id: null,
        job: 'restore',
        tool: null,
      },
      { now: () => new Date(atIso) },
    ),
  ]);
  const was = await db.query<{ on: boolean }>(
    `SELECT "on" FROM safety_switches WHERE name = 'paypal_outbound'`,
  );
  const reason =
    'restore: outbound switched off; approval rows were kept and switching paypal_outbound on with one of these refs re-activates it';
  const upd = await db.query(
    `UPDATE safety_switches SET "on" = false, changed_by = 'restore', changed_at = $1, reason = $2, updated_at = $1
      WHERE name = 'paypal_outbound' RETURNING name`,
    [atIso, reason],
  );
  if (upd.rows.length === 0) {
    await db.query(
      `INSERT INTO safety_switches (name, "on", changed_by, changed_at, reason, created_at, updated_at)
       VALUES ('paypal_outbound', false, 'restore', $1, $2, $1, $1)`,
      [atIso, reason],
    );
  }
  const approvals = await db.query<{
    id: string;
    approval_ref: string;
    scope: string;
    valid_until: string;
    approved_by: string;
  }>(
    'SELECT id, approval_ref, scope, valid_until::text AS valid_until, approved_by FROM outbound_approvals ORDER BY created_at, approval_ref',
  );
  const state: OutboundState = {
    switch_was_on: was.rows[0]?.on === true,
    approvals: approvals.rows.map((a) => ({
      id: a.id,
      ref: a.approval_ref,
      scope: a.scope,
      valid_until: a.valid_until,
      approved_by: a.approved_by,
    })),
  };
  await db.query(
    `INSERT INTO audit_log (id, actor_kind, actor_id, action, target, reason, detail, created_at, updated_at)
     VALUES ($1, 'system', 'restore', 'restore.disarm_outbound', 'paypal_outbound', $2, $3::jsonb, $4, $4)`,
    [
      auditId,
      reason,
      JSON.stringify({
        switch_was_on: state.switch_was_on,
        approval_ids: state.approvals.map((a) => a.id),
      }),
      atIso,
    ],
  );
  return state;
}

// ---------------------------------------------------------------------------------------------
// Tarball: leave host files out

/** Returns the gzip tarball without the named files (matched on the last path segment). */
export function stripFromTarball(gz: Uint8Array, names: string[]): Uint8Array {
  const tar = gunzipSync(gz);
  const keep: Buffer[] = [];
  let removed = false;
  let off = 0;
  while (off + 512 <= tar.length) {
    const head = tar.subarray(off, off + 512);
    if (head.every((b) => b === 0)) break;
    const nul = head.indexOf(0);
    const name = head.toString('utf8', 0, nul < 0 || nul > 100 ? 100 : nul);
    const size = Number.parseInt(
      head.toString('ascii', 124, 136).replace(/\0/g, '').trim() || '0',
      8,
    );
    if (!Number.isFinite(size) || size < 0) throw new Error('tarball: unreadable entry size');
    const total = 512 + Math.ceil(size / 512) * 512;
    if (names.includes(name.split('/').filter(Boolean).pop() ?? '')) removed = true;
    else keep.push(tar.subarray(off, Math.min(off + total, tar.length)));
    off += total;
  }
  if (!removed) return gz;
  keep.push(tar.subarray(Math.min(off, tar.length))); // end-of-archive blocks
  return new Uint8Array(gzipSync(Buffer.concat(keep)));
}
