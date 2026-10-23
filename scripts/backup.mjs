// Offline backup of the PGlite data directory (CO-10, nfr.md REL-5, REL-7).
//
//   node scripts/backup.mjs --dir <pglite dir> --out <folder outside the repo> --i-stopped-the-app
//
// STOP THE APP FIRST. Opening a PGlite data directory writes to it (recovery, checkpoint), so this is
// not a read-only copy, and PGlite allows one process per directory. Until the single-opener lock
// (CO-9) is in the app, nothing can detect a running app, so the command refuses unless you pass
// --i-stopped-the-app to say you stopped it. The lock contract is in
// docs/specs/db-single-opener-and-pg-waiver.md (notes): this command takes the same lock file with an
// exclusive create for its whole run, and leaves it out of the tarball.
//
// Writes three files into the output folder: pglite-<utc>.tar.gz (PGlite dumpDataDir), export-<utc>.sql
// (the logical export, schema version header, foreign-key order) and manifest.json (sha256 and size of
// both, row count per table, migration version). The manifest is written last, so its presence means
// the backup is complete. Restore with scripts/restore.mjs.
//
// Exit 0 done, 1 refused or failed, 2 bad arguments. Opens no network connection and reads no
// environment variable: the time comes from the injected clock, the paths from the arguments.
// Refuses a running app (live lock), a directory that is not a PGlite data directory, an output
// folder inside the repository or the data directory, and an output folder that already holds a
// backup. The source directory is never deleted. A backup holds personal data and session data, so
// the folder and files are created private (0700 and 0600); copying them off the host is the owner's job.
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { register } from 'node:module';
import { hostname } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const MANIFEST_FORMAT = 1;
export const LOCK_FILE = '.ums-open.lock';
export const USAGE = [
  'usage: backup.mjs --dir <pglite dir> --out <folder outside the repo> --i-stopped-the-app',
  'note: stop the UnitMarket app first. Opening the data directory writes to it, and PGlite allows one process per directory.',
  'note: a backup holds personal data and session data (session ids, auth_subject, names, webhook payer data, idempotency responses). Keep it private, off shared storage.',
  'note: restoring an old backup brings back sessions that were revoked after it was taken.',
].join('\n');

/** A refusal the operator can act on: printed as one line, exit 1. */
export class Refused extends Error {}

export const sha256Hex = (bytes) => createHash('sha256').update(bytes).digest('hex');

// The real path of the nearest existing ancestor, plus the part that does not exist yet.
export function realLoose(p) {
  let head = resolve(p);
  const rest = [];
  while (!existsSync(head)) {
    rest.unshift(basename(head));
    const up = dirname(head);
    if (up === head) break;
    head = up;
  }
  return join(realpathSync(head), ...rest);
}
export const isInside = (child, parent) => child === parent || child.startsWith(parent + sep);

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e?.code !== 'ESRCH'; // EPERM means the process exists; anything unclear counts as alive
  }
}

// The single-opener lock written by openDatabase (CO-9): pid, host name and start time as JSON.
function checkLock(dir, warn) {
  const lock = join(dir, LOCK_FILE);
  let st;
  try {
    st = lstatSync(lock);
  } catch (e) {
    if (e?.code === 'ENOENT') return 'none';
    throw new Refused(
      `the lock file ${LOCK_FILE} cannot be read (${e?.code ?? 'error'}); refusing`,
    );
  }
  if (!st.isFile()) throw new Refused(`the lock file ${LOCK_FILE} is not a plain file; refusing`);
  let info;
  try {
    info = JSON.parse(readFileSync(lock, 'utf8'));
  } catch {
    throw new Refused(`the lock file ${LOCK_FILE} cannot be read; refusing`);
  }
  const pid = info?.pid;
  if (!Number.isInteger(pid) || pid <= 0 || typeof info?.host !== 'string') {
    throw new Refused(`the lock file ${LOCK_FILE} is malformed; refusing`);
  }
  if (info.host !== hostname()) {
    throw new Refused(
      `the lock file ${LOCK_FILE} names another host; cannot tell if the app runs; refusing`,
    );
  }
  if (isAlive(pid)) {
    throw new Refused(
      `The UnitMarket app (pid ${pid}) holds this database. Stop it first, or use the ops page Stop button.`,
    );
  }
  warn(`warning: the lock file names pid ${pid}, which is not running (stale lock); replacing it`);
  return 'stale';
}

export const stampOf = (iso) => iso.replace(/[-:]/g, '');
const isoOf = (clock) =>
  clock
    .now()
    .toISOString()
    .replace(/\.\d+Z$/, 'Z');

/** @param {{ dir: string, out: string, appStopped?: boolean, clock?: { now(): Date }, warn?: (message: string) => void, onLockHeld?: (lockPath: string) => void }} options */
export async function runBackup({
  dir,
  out,
  appStopped = false,
  clock,
  warn = (message) => void message,
  onLockHeld,
}) {
  if (!dir || !out) throw new Refused(USAGE);
  if (!appStopped) {
    throw new Refused(
      'the app must be stopped first: opening the data directory writes to it and nothing here can see a running app. Stop it, then run again with --i-stopped-the-app',
    );
  }
  const dataDir = resolve(dir);
  const outDir = resolve(out);
  if (!existsSync(join(dataDir, 'PG_VERSION'))) {
    throw new Refused(
      `${dataDir} is not a PGlite data directory (no PG_VERSION); refusing to create one`,
    );
  }
  const realOut = realLoose(outDir);
  if (isInside(realOut, realLoose(REPO_ROOT))) {
    throw new Refused('the output folder is inside the repository; choose a folder outside it');
  }
  if (isInside(realOut, realLoose(dataDir))) {
    throw new Refused('the output folder is the data directory or inside it');
  }
  if (existsSync(join(outDir, 'manifest.json'))) {
    throw new Refused(`${outDir} already holds a backup (manifest.json); use a new folder`);
  }

  // Dynamic imports: the CLI registers the TypeScript hooks first (see the bottom of this file).
  const sqlLib = await import('../packages/db/src/export-sql.ts');
  const dbLib = await import('../packages/db/src/index.ts');
  const now = clock ?? (await import('../packages/runtime/src/index.ts')).systemClock();
  const createdAt = isoOf(now);
  const stamp = stampOf(createdAt);

  // The lock: taken with an exclusive create for the whole run, so an opener that starts now is
  // refused and a second backup cannot run beside this one.
  const lock = join(dataDir, LOCK_FILE);
  if (checkLock(dataDir, warn) === 'stale') unlinkSync(lock);
  try {
    writeFileSync(
      lock,
      JSON.stringify({ pid: process.pid, host: hostname(), started: createdAt }),
      {
        flag: 'wx',
        mode: 0o600,
      },
    );
  } catch (e) {
    throw new Refused(
      `the lock file ${LOCK_FILE} could not be created (${e?.code ?? 'error'}); refusing`,
    );
  }
  let tables, version, sql, tarball;
  try {
    onLockHeld?.(lock);
    const handle = await sqlLib.openForBackup(dataDir);
    try {
      tables = await sqlLib.rowCounts(handle.db);
      version = await sqlLib.latestMigrationVersion(handle.db);
      const expected = sqlLib.expectedTriggerNames(
        dbLib.listMigrations(join(dbLib.MIGRATIONS_ROOT, 'common')).map((m) => m.sql),
      );
      for (const problem of await sqlLib.guardProblems(handle.db, expected)) {
        warn(`warning: ${problem}; the tarball restore will refuse this backup, use --sql`);
      }
      sql = await sqlLib.exportSql(handle.db, { utc: createdAt });
      // The lock file is ours (or stale): it never travels inside the backup.
      tarball = sqlLib.stripFromTarball(await handle.tarball(), [LOCK_FILE]);
    } finally {
      await handle.close();
    }
  } finally {
    rmSync(lock, { force: true });
  }

  const tarName = `pglite-${stamp}.tar.gz`;
  const sqlName = `export-${stamp}.sql`;
  const sqlBytes = Buffer.from(sql, 'utf8');
  const manifest = {
    format: MANIFEST_FORMAT,
    created_at: createdAt,
    migration_version: version,
    tables: Object.fromEntries(Object.entries(tables).sort(([a], [b]) => (a < b ? -1 : 1))),
    files: {
      tarball: { name: tarName, sha256: sha256Hex(tarball), bytes: tarball.length },
      sql: { name: sqlName, sha256: sha256Hex(sqlBytes), bytes: sqlBytes.length },
    },
  };

  const createdOut = !existsSync(outDir);
  mkdirSync(outDir, { recursive: true, mode: 0o700 });
  if (createdOut) chmodSync(outDir, 0o700);
  const written = [];
  try {
    for (const [name, bytes] of [
      [tarName, tarball],
      [sqlName, sqlBytes],
      ['manifest.json', Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8')],
    ]) {
      writeFileSync(join(outDir, name), bytes, { mode: 0o600, flag: 'wx' });
      written.push(name);
    }
  } catch (e) {
    for (const name of written) rmSync(join(outDir, name), { force: true });
    if (createdOut) rmSync(outDir, { recursive: true, force: true });
    throw e;
  }
  return { manifest, dir: outDir, files: [tarName, sqlName, 'manifest.json'] };
}

export function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--i-stopped-the-app') {
      args.appStopped = true;
      continue;
    }
    if (flag !== '--dir' && flag !== '--out') return null;
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) return null;
    args[flag.slice(2)] = value;
    i += 1;
  }
  return args.dir && args.out ? args : null;
}

export async function main(argv, io = { out: process.stdout, err: process.stderr }) {
  const args = parseArgs(argv);
  if (!args) {
    io.err.write(`${USAGE}\n`);
    return 2;
  }
  try {
    const res = await runBackup({
      dir: args.dir,
      out: args.out,
      appStopped: args.appStopped,
      warn: (m) => io.err.write(`${m}\n`),
    });
    const rows = Object.values(res.manifest.tables).reduce((a, b) => a + b, 0);
    io.out.write(
      `backup ok: ${res.dir}\n  files: ${res.files.join(', ')}\n  migration ${res.manifest.migration_version}, ${Object.keys(res.manifest.tables).length} tables, ${rows} rows\n`,
    );
    return 0;
  } catch (e) {
    io.err.write(
      `backup ${e instanceof Refused ? 'refused' : 'failed'}: ${e?.message ?? String(e)}\n`,
    );
    return 1;
  }
}

// Run as a command: register the TypeScript hooks, then do the work.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  register('./lib/ts-hooks.mjs', import.meta.url);
  process.exitCode = await main(process.argv.slice(2));
}
