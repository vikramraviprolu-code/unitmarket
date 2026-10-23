// Owned by SBX (CO-9). The single-opener lock for a PGlite data directory (nfr REL-8, ASM-55, ASM-72).
//
// PGlite runs one transaction at a time inside one process, so the app is safe only while ONE process
// owns the directory. A CLI (safety:*, backup, restore) opened while the app runs would be a second
// writer on the same files. This lock turns that into a refusal.
//
// File: `<dir>/.ums-open.lock`, created with O_EXCL and mode 0600, holding one JSON object
//   {"pid":<int>,"host":"<os.hostname()>","started":"<ISO UTC from the injected clock>"}
// followed by a newline. Rules (fail closed):
//   - no lock: create it. A lock naming a live pid on this host: DbInUseError, nothing is changed.
//   - a lock naming a dead pid is a previous run: replaced, but only after a warning has been printed.
//   - a lock naming ANOTHER HOST is replaced the same way (ASM-72): the deployment is one instance on
//     one disk (Render), so a lock with another host name can only be a previous incarnation.
//     A shared volume with several live instances is unsupported and unsafe: this lock cannot tell a
//     live instance on another host from a dead one.
//   - a lock naming THIS pid (and this host) that this process does not hold is a previous run too
//     (SIGKILL or OOM, then a restart that gets the same pid, pid 1 in a container). The in-process
//     registry `held` says what this process holds: a lock it holds is live and refuses a second open.
//   - a symbolic link, a directory or any other non-file, an unreadable file, an EMPTY file (a crash
//     between creating and writing it), a file over 4 KiB, a pid above 4194304 or a file that is not
//     the JSON above: DbLockRefusedError. Nothing is deleted and nothing is followed. The message says
//     to check that no UnitMarket process runs and then remove the file by hand.
//   - release removes the file only if it still holds OUR pid, host and start time. A lock someone
//     else wrote, replaced by a link or a directory, or already gone, is left alone.
//   - process exit releases every lock this module holds: one 'exit' listener for all of them, added
//     with the first lock and removed with the last. A process killed by a signal leaves the file; the
//     next opener replaces it after the warning.
//
// Replacing a stale lock is guarded. Check then unlink then create is not atomic, so two openers that
// both judge the same lock stale could end up with the second one deleting the first one's fresh lock.
// The replace therefore runs inside a second O_EXCL file, `<dir>/.ums-open.lock.break` (JSON of the
// breaker, mode 0600): take it, warn, re-read the lock and unlink it only if it still holds what was
// judged stale, create the new lock, give the guard back. An opener that finds the guard refuses
// (code 'guard'): either another process is replacing the lock right now, or one died in the few
// microseconds it held the guard, in which case the message says to remove the file by hand. The guard
// is never replaced automatically. A fresh create needs no guard: its O_EXCL fails while any lock file
// exists, and the breaker deletes only the exact stale content it re-read.
//
// CO-10 (backup and restore) calls acquireLock for its whole run once this lane is on main, so it
// replaces an other-host lock like openDatabase does; the 'another host: refuse' note in the CO-10
// work is superseded by ASM-72.
//
// The module has no dependency on the app. Time comes from the injected Clock; the process id, host
// name and liveness check can be injected for tests. Backup and restore reuse acquireLock, inspectLock
// and releaseLock from the package root.
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';
import type { Clock } from '@umsbx/contracts';
import { systemClock } from '@umsbx/runtime';

export const LOCK_FILE = '.ums-open.lock';
export const LOCK_BREAK_FILE = '.ums-open.lock.break';
const MAX_LOCK_BYTES = 4096;
/** The largest pid_max on Linux (2^22). A larger number is not a pid; process.kill would throw on it. */
const MAX_PID = 4_194_304;
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;

export interface LockInfo {
  readonly pid: number;
  readonly host: string;
  readonly started: string;
}

export type LockRefusalCode = 'symlink' | 'not_file' | 'unreadable' | 'malformed' | 'io' | 'guard';

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
  | { state: 'stale'; info: LockInfo; reason: 'dead_pid' | 'other_host' | 'previous_run' }
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

const messageFor = (
  code: LockRefusalCode,
  dir: string,
  detail: string,
  file: string = LOCK_FILE,
): string =>
  `The database lock file ${file} in ${dir} ${detail}; refusing to open. ` +
  (code === 'io'
    ? 'Check the directory and its permissions.'
    : 'Check that no UnitMarket process runs, then remove the file by hand.');

// ---- what this process holds -----------------------------------------------------------------------

/** Locks held by THIS process, by real path. A lock file naming our pid that is not in here is old. */
const held = new Map<string, LockHandle>();

function keyFor(dir: string): string {
  let real: string;
  try {
    real = realpathSync(dir);
  } catch {
    real = resolve(dir);
  }
  return join(real, LOCK_FILE);
}

function exitAll(): void {
  for (const handle of [...held.values()]) handle.release();
}

// ---- reading ---------------------------------------------------------------------------------------

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
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0 || pid > MAX_PID) {
    return null;
  }
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
    if (fst.size === 0) {
      return refuse('malformed', 'is empty (left by a crash while it was written)');
    }
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
  deps: Pick<LockDeps, 'isAlive' | 'host' | 'pid'>,
  path: string = join(dir, LOCK_FILE),
): Look {
  const r = readAt(dir, path);
  if (r.kind === 'absent') return { state: 'absent' };
  if (r.kind === 'refused') return { state: 'refused', code: r.code, message: r.message };
  if (r.info.host !== (deps.host ?? hostname())) {
    return { state: 'stale', info: r.info, reason: 'other_host', raw: r.raw };
  }
  if (r.info.pid === (deps.pid ?? process.pid)) {
    // Our own pid: live only if this process really holds the lock; otherwise a previous run that got
    // the same pid (a restarted container, pid 1) and never released it.
    return held.has(keyFor(dir))
      ? { state: 'live', info: r.info, raw: r.raw }
      : { state: 'stale', info: r.info, reason: 'previous_run', raw: r.raw };
  }
  const alive = deps.isAlive ?? processIsAlive;
  return alive(r.info.pid)
    ? { state: 'live', info: r.info, raw: r.raw }
    : { state: 'stale', info: r.info, reason: 'dead_pid', raw: r.raw };
}

/** Reads the lock in `dir` and says what it means. Creates, changes and removes nothing. */
export function inspectLock(
  dir: string,
  deps: Pick<LockDeps, 'isAlive' | 'host' | 'pid'> = {},
): LockInspection {
  const { raw: _raw, ...result } = look(dir, deps);
  void _raw;
  return result;
}

// ---- acquiring and releasing -----------------------------------------------------------------------

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

/** Creates `path` exclusively with `body`. False when it already exists. Throws on anything else. */
function createExclusive(
  dir: string,
  path: string,
  body: string,
  existsMeans: (() => never) | null = null,
): boolean {
  let fd: number;
  try {
    fd = openSync(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW,
      0o600,
    );
  } catch (e) {
    if (codeOf(e) === 'EEXIST') {
      if (existsMeans !== null) existsMeans();
      return false;
    }
    throw new DbLockRefusedError('io', messageFor('io', dir, `cannot be created (${codeOf(e)})`));
  }
  let written = -1;
  try {
    written = writeSync(fd, body);
  } catch {
    written = -1;
  }
  closeSync(fd);
  if (written !== Buffer.byteLength(body)) {
    try {
      unlinkSync(path); // never leave a short or empty file behind
    } catch {
      // nothing more to do; the next opener refuses on an empty or malformed file
    }
    throw new DbLockRefusedError('io', messageFor('io', dir, 'cannot be written completely'));
  }
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
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch (e) {
    throw new DbLockRefusedError(
      'io',
      messageFor('io', dir, `cannot be created, the directory is unusable (${codeOf(e)})`),
    );
  }
  const path = join(dir, LOCK_FILE);
  const guard = join(dir, LOCK_BREAK_FILE);
  const info: LockInfo = {
    pid,
    host,
    started: (deps.clock ?? systemClock()).now().toISOString(),
  };
  const body = `${JSON.stringify({ pid: info.pid, host: info.host, started: info.started })}\n`;
  const guardRefusal = (): never => {
    throw new DbLockRefusedError(
      'guard',
      messageFor(
        'guard',
        dir,
        'exists: another process is replacing a stale lock, or one was interrupted',
        LOCK_BREAK_FILE,
      ),
    );
  };

  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (createExclusive(dir, path, body)) return register(dir, path, info);
    const seen = look(
      dir,
      deps.isAlive === undefined ? { host, pid } : { host, pid, isAlive: deps.isAlive },
    );
    if (seen.state === 'absent') continue; // vanished between the two calls: try again
    if (seen.state === 'live') throw new DbInUseError(seen.info.pid);
    if (seen.state === 'refused') throw new DbLockRefusedError(seen.code, seen.message);

    // Stale: replace it inside the guard, so that no second breaker can delete the new lock.
    createExclusive(dir, guard, body, guardRefusal);
    let created = false;
    try {
      const who = printable(seen.info.host);
      warn(
        seen.reason === 'dead_pid'
          ? `warning: replacing a stale database lock in ${dir}: pid ${seen.info.pid} on host ${who} is not running`
          : seen.reason === 'previous_run'
            ? `warning: replacing a stale database lock in ${dir}: pid ${seen.info.pid} on host ${who} names this process, which does not hold it (left by a previous run)`
            : `warning: replacing a database lock in ${dir} that names another host (${who}, this host is ${printable(host)}): cannot tell whether it runs`,
      );
      // Only remove the file if it still holds exactly what was judged stale.
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
      created = createExclusive(dir, path, body);
    } finally {
      try {
        unlinkSync(guard);
      } catch {
        // already gone
      }
    }
    if (created) return register(dir, path, info);
  }
  throw new DbLockRefusedError('io', messageFor('io', dir, 'could not be taken after retries'));
}

function register(dir: string, path: string, info: LockInfo): LockHandle {
  const key = keyFor(dir);
  let released = false;
  const handle: LockHandle = {
    path,
    info,
    release(): boolean {
      if (released) return false;
      released = true;
      if (held.get(key) === handle) held.delete(key);
      if (held.size === 0) process.off('exit', exitAll);
      return removeIfOurs(dir, path, info);
    },
  };
  held.set(key, handle);
  if (held.size === 1) process.on('exit', exitAll);
  return handle;
}

/** Same as handle.release(); a function for callers that keep only the handle. */
export function releaseLock(handle: LockHandle): boolean {
  return handle.release();
}
