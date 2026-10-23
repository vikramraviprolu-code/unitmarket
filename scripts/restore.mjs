// Offline restore of a backup made by scripts/backup.mjs (CO-10, nfr.md REL-5, REL-7).
//
//   node scripts/restore.mjs --from <backup folder> --dir <empty dir> [--sql]
//
// Refuses a target that is not empty, checks the size and sha256 of both files against the manifest,
// then either loads the tarball into the target (default) or, with --sql, migrates a fresh PGlite
// there and imports the logical export in one transaction (the append-only triggers are off only
// inside that transaction). Either way it migrates, then compares the row count of every table with
// the manifest and removes what it wrote if anything differs. The backup folder is only read.
//
// After either mode: paypal_outbound is forced OFF (changed_by 'restore') and the outbound approval
// refs found are printed, because a restored approval must not come back live; any user trigger that is
// switched off or missing refuses the restore; the stale lock file is never restored.
//
// Exit 0 done, 1 refused or failed, 2 bad arguments. Opens no network connection and reads no
// environment variable.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { register } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  LOCK_FILE,
  MANIFEST_FORMAT,
  REPO_ROOT,
  Refused,
  USAGE as BACKUP_NOTES,
  isInside,
  realLoose,
  sha256Hex,
} from './backup.mjs';

const NOTES = BACKUP_NOTES.split('\n').slice(2).join('\n');
export const USAGE = `usage: restore.mjs --from <folder> --dir <empty dir> [--sql]\n${NOTES}`;
export const OUTBOUND_NOTE =
  'paypal_outbound is switched OFF after every restore, and outbound approvals are not carried live: re-approve with pnpm safety:approve before any sandbox call';

const TAR_NAME = /^pglite-\d{8}T\d{6}Z\.tar\.gz$/;
const SQL_NAME = /^export-\d{8}T\d{6}Z\.sql$/;

function readManifest(from) {
  const path = join(from, 'manifest.json');
  if (!existsSync(path)) throw new Refused(`no manifest.json in ${from}`);
  let m;
  try {
    m = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Refused('manifest.json is not valid JSON');
  }
  const file = (f, re) =>
    f &&
    typeof f.name === 'string' &&
    re.test(f.name) &&
    /^[a-f0-9]{64}$/.test(f.sha256) &&
    Number.isInteger(f.bytes) &&
    f.bytes >= 0;
  const counts = m?.tables;
  const countsOk =
    counts &&
    typeof counts === 'object' &&
    Object.values(counts).every((n) => Number.isInteger(n) && n >= 0);
  if (
    m?.format !== MANIFEST_FORMAT ||
    typeof m.migration_version !== 'string' ||
    !countsOk ||
    !file(m.files?.tarball, TAR_NAME) ||
    !file(m.files?.sql, SQL_NAME)
  ) {
    throw new Refused('the manifest is malformed or has an unknown format');
  }
  return m;
}

function readChecked(from, f) {
  const path = join(from, f.name);
  if (!existsSync(path)) throw new Refused(`${f.name} is missing from the backup folder`);
  const bytes = readFileSync(path);
  if (bytes.length !== f.bytes || sha256Hex(bytes) !== f.sha256) {
    throw new Refused(`${f.name} has changed: its size or sha256 does not match the manifest`);
  }
  return bytes;
}

function compareCounts(expected, actual) {
  const names = new Set([...Object.keys(expected), ...Object.keys(actual)]);
  for (const t of [...names].sort()) {
    if (expected[t] !== actual[t]) {
      throw new Error(
        `row count mismatch in ${t}: manifest ${expected[t] ?? 'none'}, restored ${actual[t] ?? 'none'}`,
      );
    }
  }
}

/** @param {{ from: string, dir: string, sql?: boolean, clock?: { now(): Date }, warn?: (message: string) => void }} options */
/** @param {{ from: string, dir: string, sql?: boolean, clock?: { now(): Date }, warn?: (message: string) => void }} options */
export async function runRestore({
  from,
  dir,
  sql = false,
  clock,
  warn = (message) => void message,
}) {
  if (!from || !dir) throw new Refused(USAGE);
  const source = resolve(from);
  const target = resolve(dir);
  if (!existsSync(source) || !statSync(source).isDirectory()) {
    throw new Refused(`${source} is not a folder`);
  }
  if (isInside(realLoose(target), realLoose(REPO_ROOT))) {
    throw new Refused('the target is inside the repository; choose a folder outside it');
  }
  if (existsSync(target)) {
    if (!statSync(target).isDirectory()) throw new Refused(`${target} is not a directory`);
    if (readdirSync(target).length > 0) throw new Refused(`the target ${target} is not empty`);
  }
  const manifest = readManifest(source);
  // Both files are checked whichever one is used, so a damaged backup is found at restore time.
  const tarball = readChecked(source, manifest.files.tarball);
  const sqlText = readChecked(source, manifest.files.sql).toString('utf8');

  const sqlLib = await import('../packages/db/src/export-sql.ts');
  const dbLib = await import('../packages/db/src/index.ts');
  const now = clock ?? (await import('../packages/runtime/src/index.ts')).systemClock();
  const expectedTriggers = sqlLib.expectedTriggerNames(
    dbLib.listMigrations(join(dbLib.MIGRATIONS_ROOT, 'common')).map((m) => m.sql),
  );

  const createdTarget = !existsSync(target);
  mkdirSync(target, { recursive: true, mode: 0o700 });
  try {
    if (!sql) {
      await sqlLib.restoreDataDirTarball(target, tarball);
      // A lock file inside an old tarball is stale by definition.
      rmSync(join(target, LOCK_FILE), { force: true });
    }
    const db = await dbLib.openDatabase({ kind: 'pglite-disk', dir: target });
    let tables;
    let outbound;
    try {
      if (!sql) {
        const have = await sqlLib.latestMigrationVersion(db);
        if (have !== manifest.migration_version) {
          throw new Refused(
            `the tarball holds migration version ${have}, the manifest says ${manifest.migration_version}`,
          );
        }
      }
      const applied = await dbLib.migrate(db, now);
      if (!sql && applied.length > 0) {
        warn(`note: applied ${applied.length} newer migration(s) after the restore`);
      }
      if (sql) await sqlLib.importSql(db, sqlText);
      const problems = await sqlLib.guardProblems(db, expectedTriggers);
      if (problems.length > 0) {
        throw new Refused(`the restored database has ${problems.join('; ')}`);
      }
      if (!sql) {
        for (const line of await sqlLib.checkInvariants(db)) warn(`warning: ${line}`);
      }
      outbound = await db.transaction((tx) => sqlLib.disarmOutbound(tx, now.now().toISOString()));
      tables = await sqlLib.rowCounts(db);
    } finally {
      await db.close();
    }
    compareCounts(manifest.tables, tables);
    warn(outboundNotice(outbound));
    return {
      mode: sql ? 'sql' : 'tarball',
      tables,
      migration_version: manifest.migration_version,
      outbound,
    };
  } catch (e) {
    // The target was empty (or absent) when we started, so everything in it is ours.
    for (const name of readdirSync(target))
      rmSync(join(target, name), { recursive: true, force: true });
    if (createdTarget) rmSync(target, { recursive: true, force: true });
    throw e;
  }
}

export function outboundNotice(outbound) {
  const list =
    outbound.approvals.length === 0
      ? 'no outbound approval rows'
      : `${outbound.approvals.length} outbound approval row(s), kept but inert: ${outbound.approvals
          .map(
            (a) =>
              `${a.ref} (scope ${a.scope}, valid until ${a.valid_until}, approved by ${a.approved_by})`,
          )
          .join('; ')}`;
  return `WARNING: paypal_outbound was ${outbound.switch_was_on ? 'ON' : 'off'} in the backup and is now switched OFF; ${list}. ${OUTBOUND_NOTE}`;
}

export function parseArgs(argv) {
  const args = { sql: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--sql') {
      args.sql = true;
      continue;
    }
    if (flag !== '--from' && flag !== '--dir') return null;
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) return null;
    args[flag.slice(2)] = value;
    i += 1;
  }
  return args.from && args.dir ? args : null;
}

export async function main(argv, io = { out: process.stdout, err: process.stderr }) {
  const args = parseArgs(argv);
  if (!args) {
    io.err.write(`${USAGE}\n`);
    return 2;
  }
  try {
    const res = await runRestore({
      from: args.from,
      dir: args.dir,
      sql: args.sql,
      warn: (m) => io.err.write(`${m}\n`),
    });
    const rows = Object.values(res.tables).reduce((a, b) => a + b, 0);
    io.out.write(
      `restore ok (${res.mode}): ${resolve(args.dir)}\n  ${Object.keys(res.tables).length} tables, ${rows} rows, row counts match the manifest\n  ${outboundNotice(res.outbound)}\n`,
    );
    return 0;
  } catch (e) {
    io.err.write(
      `restore ${e instanceof Refused ? 'refused' : 'failed'}: ${e?.message ?? String(e)}\n`,
    );
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  register('./lib/ts-hooks.mjs', import.meta.url);
  process.exitCode = await main(process.argv.slice(2));
}
