// Owned by SBX (CO-9). The single-opener lock for a PGlite data directory (nfr REL-8, ASM-55).
//
// PGlite runs one transaction at a time inside one process, so the app is safe only while ONE process
// owns the directory. A CLI (safety:*, backup, restore) opened while the app runs would be a second
// writer on the same files. This lock turns that into a refusal.
//
// File: `<dir>/.ums-open.lock`, created with O_EXCL and mode 0600, holding one JSON object
//   {"pid":<int>,"host":"<os.hostname()>","started":"<ISO UTC from the injected clock>"}
// followed by a newline. Rules (fail closed):
//   - no lock: create it. A lock naming a live pid on this host: DbInUseError, nothing is changed.
//   - a lock naming a dead pid, or another host (a pid cannot be checked there; a restarted container
//     gets a new host name), is replaced, but only after a warning has been printed.
//   - a symbolic link, a directory or any other non-file, an unreadable file, a file over 4 KiB or one
//     that is not the JSON above: DbLockRefusedError. Nothing is deleted and nothing is followed.
//   - release removes the file only if it still holds OUR pid, host and start time. A lock someone
//     else wrote, replaced by a link or a directory, or already gone, is left alone.
//   - process exit releases every lock this module holds (a 'exit' listener, removed on release).
//     A process killed by a signal leaves the file; the next opener sees a dead pid and replaces it.
// Limit: replacing a stale lock is a check followed by an unlink. Two processes that both find the
// same stale lock in the same instant are narrowed by re-reading the file right before the unlink,
// not excluded; the consequence is a refused open, never two holders (the loser's O_EXCL fails).
//
// Other host, CO-10: openDatabase REPLACES a lock that names another host, after the warning (a
// restarted container gets a new host name, so the pid cannot be checked there). Backup and restore
// (scripts/backup.mjs, scripts/restore.mjs, CO-10) are stricter and REFUSE an other-host lock. Once
// CO-9 and CO-10 are both on main, CO-10 calls acquireLock for its whole run, so the two tools and
// the app exclude each other through this one file.
// The module has no dependency on the app. Time comes from the injected Clock, the process id, host
// name and liveness check can be injected for tests. backup and restore reuse acquireLock,
// inspectLock and releaseLock from the package root.
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import type { Clock } from '@umsbx/contracts';
import { systemClock } from '@umsbx/runtime';

export const LOCK_FILE = '.ums-open.lock';
const MAX_LOCK_BYTES = 4096;
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;

export interface LockInfo {
  readonly pid: number;
  readonly host: string;
  readonly started: string;
}

export type LockRefusalCode = 'symlink' | 'not_file' | 'unreadable' | 'malformed' | 'io';

/** A live process on this host holds the directory. The message is the one in the CO-9 spec. */
export class DbInUseError extends Error {
  readonly pid: number;
  constructor(pid: number) {
    super(
      `The UnitMarket app (pid ${pid}) holds this database. Stop it first, or use the ops page Stop button.`,
    );
    this.name = 'DbInUseError';
    this.pid = pid;
  }
}

/** The lock cannot be read or written safely: refuse, change nothing. */
export class DbLockRefusedError extends Error {
  readonly code: LockRefusalCode;
  constructor(code: LockRefusalCode, message: string) {
    super(message);
    this.name = 'DbLockRefusedError';
    this.code = code;
  }
}

export interface LockDeps {
  /** Source of `started`. Default: the system clock. */
  clock?: Clock;
  /** Receives the stale-lock warning. Default: one line on stderr. */
  warn?: (message: string) => void;
  /** Is this pid running on this host? Default: process.kill(pid, 0). */
  isAlive?: (pid: number) => boolean;
  /** Test seams: the pid and host name written to the lock. */
  pid?: number;
  host?: string;
}

export type LockInspection =
  | { state: 'absent' }
  | { state: 'live'; info: LockInfo }
  | { state: 'stale'; info: LockInfo; reason: 'dead_pid' | 'other_host' }
  | { state: 'refused'; code: LockRefusalCode; message: string };

export interface LockHandle {
  readonly path: string;
  readonly info: LockInfo;
  /** Removes the lock if it is still ours. True when a file was removed. Safe to call twice. */
  release(): boolean;
}

/** Default liveness check. ESRCH means no such process; EPERM means it exists; anything else counts as alive. */
export function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

const codeOf = (e: unknown): string => (e as NodeJS.ErrnoException | undefined)?.code ?? 'error';
const printable = (s: string): string =>
  [...s.slice(0, 80)]
    .map((c) => (c.charCodeAt(0) < 0x20 || c.charCodeAt(0) > 0x7e ? '?' : c))
    .join('');

const messageFor = (code: LockRefusalCode, dir: string, detail: string): string =>
  `The database lock file ${LOCK_FILE} in ${dir} ${detail}; refusing to open. ` +
  (code === 'io'
    ? 'Check the directory and its permissions.'
    : 'Check that no UnitMarket process runs, then remove the file by hand.');

// ---- reading -----------------------------------------------------------------------------------

type Read =
  | { kind: 'absent' }
  | { kind: 'info'; info: LockInfo; raw: string }
  | { kind: 'refused'; code: LockRefusalCode; message: string };

function parseLock(raw: string): LockInfo | null {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const { pid, host, started } = v as Record<string, unknown>;
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) return null;
  if (typeof host !== 'string' || host.length === 0 || host.length > 255) return null;
  if (typeof started !== 'string' || !ISO_UTC.test(started) || Number.isNaN(Date.parse(started))) {
    return null;
  }
  return { pid, host, started };
}

function readAt(dir: string, path: string): Read {
  const refuse = (code: LockRefusalCode, detail: string): Read => ({
    kind: 'refused',
    code,
    message: messageFor(code, dir, detail),
  });
  let st;
  try {
    st = lstatSync(path);
  } catch (e) {
    if (codeOf(e) === 'ENOENT') return { kind: 'absent' };
    return refuse('unreadable', `cannot be inspected (${codeOf(e)})`);
  }
  if (st.isSymbolicLink()) return refuse('symlink', 'is a symbolic link');
  if (!st.isFile()) return refuse('not_file', 'is not a plain file');
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | NO_FOLLOW | (constants.O_NONBLOCK ?? 0));
  } catch (e) {
    const c = codeOf(e);
    if (c === 'ENOENT') return { kind: 'absent' };
    if (c === 'ELOOP') return refuse('symlink', 'is a symbolic link');
    return refuse('unreadable', `cannot be read (${c})`);
  }
  try {
    const fst = fstatSync(fd);
    if (!fst.isFile()) return refuse('not_file', 'is not a plain file');
    if (fst.size > MAX_LOCK_BYTES) return refuse('malformed', 'is too large to be a lock');
    const raw = readFileSync(fd, 'utf8');
    const info = parseLock(raw);
    if (info === null) return refuse('malformed', 'is not a valid lock');
    return { kind: 'info', info, raw };
  } catch (e) {
    return refuse('unreadable', `cannot be read (${codeOf(e)})`);
  } finally {
    closeSync(fd);
  }
}

type Look = LockInspection & { raw?: string };

function look(
  dir: string,
  deps: Pick<LockDeps, 'isAlive' | 'host'>,
  path: string = join(dir, LOCK_FILE),
): Look {
  const r = readAt(dir, path);
  if (r.kind === 'absent') return { state: 'absent' };
  if (r.kind === 'refused') return { state: 'refused', code: r.code, message: r.message };
  if (r.info.host !== (deps.host ?? hostname())) {
    return { state: 'stale', info: r.info, reason: 'other_host', raw: r.raw };
  }
  const alive = deps.isAlive ?? processIsAlive;
  return alive(r.info.pid)
    ? { state: 'live', info: r.info, raw: r.raw }
    : { state: 'stale', info: r.info, reason: 'dead_pid', raw: r.raw };
}

/** Reads the lock in `dir` and says what it means. Creates, changes and removes nothing. */
export function inspectLock(
  dir: string,
  deps: Pick<LockDeps, 'isAlive' | 'host'> = {},
): LockInspection {
  const { raw: _raw, ...result } = look(dir, deps);
  void _raw;
  return result;
}

// ---- acquiring and releasing ---------------------------------------------------------------------

function sameLock(a: LockInfo, b: LockInfo): boolean {
  return a.pid === b.pid && a.host === b.host && a.started === b.started;
}

function removeIfOurs(dir: string, path: string, ours: LockInfo): boolean {
  const r = readAt(dir, path);
  if (r.kind !== 'info' || !sameLock(r.info, ours)) return false;
  try {
    unlinkSync(path);
    return true;
  } catch {
    return false;
  }
}

function create(dir: string, path: string, body: string): boolean {
  let fd: number;
  try {
    fd = openSync(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW,
      0o600,
    );
  } catch (e) {
    if (codeOf(e) === 'EEXIST') return false;
    throw new DbLockRefusedError('io', messageFor('io', dir, `cannot be created (${codeOf(e)})`));
  }
  try {
    writeSync(fd, body);
  } catch (e) {
    closeSync(fd);
    try {
      unlinkSync(path);
    } catch {
      // nothing more to do; the next opener refuses on a malformed file
    }
    throw new DbLockRefusedError('io', messageFor('io', dir, `cannot be written (${codeOf(e)})`));
  }
  closeSync(fd);
  return true;
}

/**
 * Takes the lock for `dir` (creating the directory if needed) or throws DbInUseError when a live
 * process on this host holds it, DbLockRefusedError when the lock cannot be trusted.
 */
export function acquireLock(dir: string, deps: LockDeps = {}): LockHandle {
  const host = deps.host ?? hostname();
  const pid = deps.pid ?? process.pid;
  const warn =
    deps.warn ??
    ((m: string): void => {
      process.stderr.write(`${m}\n`);
    });
  const path = join(dir, LOCK_FILE);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch (e) {
    throw new DbLockRefusedError(
      'io',
      messageFor('io', dir, `cannot be created, the directory is unusable (${codeOf(e)})`),
    );
  }
  const info: LockInfo = {
    pid,
    host,
    started: (deps.clock ?? systemClock()).now().toISOString(),
  };
  const body = `${JSON.stringify({ pid: info.pid, host: info.host, started: info.started })}\n`;

  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (create(dir, path, body)) return handleFor(dir, path, info);
    const seen = look(dir, deps.isAlive === undefined ? { host } : { host, isAlive: deps.isAlive });
    if (seen.state === 'absent') continue; // vanished between the two calls: try again
    if (seen.state === 'live') throw new DbInUseError(seen.info.pid);
    if (seen.state === 'refused') throw new DbLockRefusedError(seen.code, seen.message);
    warn(
      seen.reason === 'dead_pid'
        ? `warning: replacing a stale database lock in ${dir}: pid ${seen.info.pid} on host ${printable(seen.info.host)} is not running`
        : `warning: replacing a database lock in ${dir} that names another host (${printable(seen.info.host)}, this host is ${printable(host)}): cannot tell whether it runs`,
    );
    // Narrow the window: only remove the file if it still holds exactly what was judged stale.
    const again = readAt(dir, path);
    if (again.kind === 'info' && again.raw === seen.raw) {
      try {
        unlinkSync(path);
      } catch (e) {
        if (codeOf(e) !== 'ENOENT') {
          throw new DbLockRefusedError(
            'io',
            messageFor('io', dir, `cannot be replaced (${codeOf(e)})`),
          );
        }
      }
    }
  }
  throw new DbLockRefusedError('io', messageFor('io', dir, 'could not be taken after retries'));
}

function handleFor(dir: string, path: string, info: LockInfo): LockHandle {
  let released = false;
  const onExit = (): void => {
    handle.release();
  };
  const handle: LockHandle = {
    path,
    info,
    release(): boolean {
      if (released) return false;
      released = true;
      process.off('exit', onExit);
      return removeIfOurs(dir, path, info);
    },
  };
  process.on('exit', onExit);
  return handle;
}

/** Same as handle.release(); a function for callers that keep only the handle. */
export function releaseLock(handle: LockHandle): boolean {
  return handle.release();
}
