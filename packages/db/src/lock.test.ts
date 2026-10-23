// CO-9 unit tests: the single-opener lock `<dir>/.ums-open.lock` (spec db-single-opener-and-pg-waiver).
// Offline. Time comes from an injected clock; liveness from an injected isAlive unless a test says
// it uses the real process table.
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Clock } from '@umsbx/contracts';
import { DbInUseError, LOCK_FILE, acquireLock, inspectLock, releaseLock } from './lock';
import { openDatabase } from './pglite';

const T0 = '2026-03-04T05:06:07.089Z';
const clockAt = (iso: string): Clock => ({ now: () => new Date(iso) });
const IN_USE = (pid: number): string =>
  `The UnitMarket app (pid ${pid}) holds this database. Stop it first, or use the ops page Stop button.`;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ums-lock-unit-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const lockPath = (): string => join(dir, LOCK_FILE);
const readLock = (): { pid: number; host: string; started: string } =>
  JSON.parse(readFileSync(lockPath(), 'utf8')) as { pid: number; host: string; started: string };
const plant = (info: Record<string, unknown>): void =>
  writeFileSync(lockPath(), `${JSON.stringify(info)}\n`, { mode: 0o600 });

describe('acquireLock creates the lock', () => {
  it('writes <dir>/.ums-open.lock with this pid, this host and the injected start time', () => {
    const h = acquireLock(dir, { clock: clockAt(T0), warn: () => undefined });
    expect(LOCK_FILE).toBe('.ums-open.lock');
    expect(h.path).toBe(lockPath());
    expect(readLock()).toEqual({ pid: process.pid, host: hostname(), started: T0 });
    expect(h.info).toEqual({ pid: process.pid, host: hostname(), started: T0 });
    h.release();
  });

  it('creates the file private (0600)', () => {
    const h = acquireLock(dir, { clock: clockAt(T0), warn: () => undefined });
    expect(statSync(lockPath()).mode & 0o777).toBe(0o600);
    h.release();
  });

  it('creates the directory when it does not exist yet', () => {
    const fresh = join(dir, 'a', 'b');
    const h = acquireLock(fresh, { clock: clockAt(T0), warn: () => undefined });
    expect(existsSync(join(fresh, LOCK_FILE))).toBe(true);
    h.release();
  });

  it('inspectLock reports absent, then live while held, then absent after release', () => {
    expect(inspectLock(dir)).toEqual({ state: 'absent' });
    const h = acquireLock(dir, { clock: clockAt(T0), warn: () => undefined });
    expect(inspectLock(dir)).toEqual({
      state: 'live',
      info: { pid: process.pid, host: hostname(), started: T0 },
    });
    h.release();
    expect(inspectLock(dir)).toEqual({ state: 'absent' });
  });
});

describe('acquireLock refuses while a live pid on this host holds the directory', () => {
  it('throws DbInUseError with the spec message and leaves the lock byte-identical', () => {
    const first = acquireLock(dir, {
      clock: clockAt(T0),
      pid: 4242,
      isAlive: () => true,
      warn: () => undefined,
    });
    const before = readFileSync(lockPath(), 'utf8');
    let caught: unknown;
    try {
      acquireLock(dir, {
        clock: clockAt('2026-03-04T06:00:00.000Z'),
        pid: 5151,
        isAlive: () => true,
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(DbInUseError);
    expect((caught as DbInUseError).message).toBe(IN_USE(4242));
    expect((caught as DbInUseError).pid).toBe(4242);
    expect(readFileSync(lockPath(), 'utf8')).toBe(before);
    first.release();
  });

  it('uses the real process table by default: this process holds it, a second open is refused', () => {
    const first = acquireLock(dir, { clock: clockAt(T0), warn: () => undefined });
    expect(() => acquireLock(dir, { clock: clockAt(T0) })).toThrowError(IN_USE(process.pid));
    first.release();
  });
});

describe('a stale lock is replaced only after a printed warning', () => {
  it('replaces a lock naming a dead pid on this host and warns first', () => {
    plant({ pid: 999_999, host: hostname(), started: '2026-01-01T00:00:00.000Z' });
    const warnings: string[] = [];
    const seenAtWarn: string[] = [];
    const h = acquireLock(dir, {
      clock: clockAt(T0),
      isAlive: () => false,
      warn: (m) => {
        warnings.push(m);
        seenAtWarn.push(readFileSync(lockPath(), 'utf8')); // the old lock is still there
      },
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('999999');
    expect(warnings[0]).toMatch(/stale/i);
    expect(JSON.parse(seenAtWarn[0] as string).pid).toBe(999_999);
    expect(readLock()).toEqual({ pid: process.pid, host: hostname(), started: T0 });
    h.release();
  });

  it('replaces a lock naming another host and warns first, without asking about the pid', () => {
    plant({ pid: process.pid, host: 'some-other-host', started: '2026-01-01T00:00:00.000Z' });
    const warnings: string[] = [];
    let asked = 0;
    const h = acquireLock(dir, {
      clock: clockAt(T0),
      isAlive: () => {
        asked += 1;
        return true;
      },
      warn: (m) => warnings.push(m),
    });
    expect(asked).toBe(0);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('some-other-host');
    expect(readLock().started).toBe(T0);
    h.release();
  });

  it('inspectLock names the reason', () => {
    plant({ pid: 999_999, host: hostname(), started: T0 });
    expect(inspectLock(dir, { isAlive: () => false })).toEqual({
      state: 'stale',
      reason: 'dead_pid',
      info: { pid: 999_999, host: hostname(), started: T0 },
    });
    plant({ pid: 1, host: 'elsewhere', started: T0 });
    expect(inspectLock(dir, { isAlive: () => true })).toEqual({
      state: 'stale',
      reason: 'other_host',
      info: { pid: 1, host: 'elsewhere', started: T0 },
    });
  });

  it('the default liveness check sees a pid that does not exist as dead', () => {
    const gone = 4_194_300;
    let exists = true;
    try {
      process.kill(gone, 0);
    } catch (e) {
      exists = (e as NodeJS.ErrnoException).code !== 'ESRCH';
    }
    if (exists) return; // pid happens to be in use on this machine; nothing to prove
    plant({ pid: gone, host: hostname(), started: T0 });
    const warnings: string[] = [];
    const h = acquireLock(dir, { clock: clockAt(T0), warn: (m) => warnings.push(m) });
    expect(warnings).toHaveLength(1);
    h.release();
  });
});

describe('release', () => {
  it('removes the lock', () => {
    const h = acquireLock(dir, { clock: clockAt(T0), warn: () => undefined });
    expect(releaseLock(h)).toBe(true);
    expect(existsSync(lockPath())).toBe(false);
  });

  it('is idempotent: the second call is a no-op even after someone else took the lock', () => {
    const h = acquireLock(dir, { clock: clockAt(T0), pid: 4242, warn: () => undefined });
    expect(h.release()).toBe(true);
    plant({ pid: 4242, host: hostname(), started: T0 }); // same pid and start, a "new" lock
    expect(h.release()).toBe(false);
    expect(existsSync(lockPath())).toBe(true);
  });

  it('does not remove a lock that is no longer ours', () => {
    const h = acquireLock(dir, { clock: clockAt(T0), warn: () => undefined });
    plant({ pid: process.pid + 1, host: hostname(), started: T0 });
    expect(h.release()).toBe(false);
    expect(readLock().pid).toBe(process.pid + 1);
    plant({ pid: process.pid, host: hostname(), started: '2026-12-31T00:00:00.000Z' });
    expect(releaseLock(h)).toBe(false);
    expect(existsSync(lockPath())).toBe(true);
  });

  it('does nothing when the lock is already gone', () => {
    const h = acquireLock(dir, { clock: clockAt(T0), warn: () => undefined });
    rmSync(lockPath());
    expect(h.release()).toBe(false);
  });

  it('process exit removes the lock: the exit listener is added on acquire and removed on release', () => {
    const before = process.listeners('exit');
    const h = acquireLock(dir, { clock: clockAt(T0), warn: () => undefined });
    const added = process.listeners('exit').filter((l) => !before.includes(l));
    expect(added).toHaveLength(1);
    added[0]?.call(process, 0); // what node does at exit
    expect(existsSync(lockPath())).toBe(false);
    h.release();
    expect(process.listeners('exit').filter((l) => !before.includes(l))).toHaveLength(0);
  });
});

describe('openDatabase and the lock', () => {
  it('a disk target holds the lock while open and removes it on close', async () => {
    const db = await openDatabase({ kind: 'pglite-disk', dir }, { clock: clockAt(T0) });
    expect(readLock()).toEqual({ pid: process.pid, host: hostname(), started: T0 });
    await db.close();
    expect(existsSync(lockPath())).toBe(false);
  });

  it('a second open of the same directory is refused while the first is open, and works after close', async () => {
    const first = await openDatabase({ kind: 'pglite-disk', dir }, { clock: clockAt(T0) });
    await expect(
      openDatabase({ kind: 'pglite-disk', dir }, { clock: clockAt(T0) }),
    ).rejects.toThrowError(IN_USE(process.pid));
    await first.close();
    const again = await openDatabase({ kind: 'pglite-disk', dir }, { clock: clockAt(T0) });
    await again.close();
  });

  it('a memory target takes no lock and adds no exit listener', async () => {
    const before = process.listenerCount('exit');
    const a = await openDatabase({ kind: 'pglite-memory' });
    const b = await openDatabase({ kind: 'pglite-memory' }); // two memory databases never conflict
    expect(process.listenerCount('exit')).toBe(before);
    expect(existsSync(lockPath())).toBe(false);
    await a.close();
    await b.close();
  });
});
