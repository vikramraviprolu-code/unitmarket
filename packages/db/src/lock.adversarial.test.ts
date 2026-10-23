// CO-9 adversarial tests: the single-opener lock fails closed on anything it cannot read, never
// deletes a lock held by a live process, and lets exactly one of several racing openers win.
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Clock } from '@umsbx/contracts';

// Unreadable-file simulation: root ignores file modes, so a flagged path makes reads fail with
// EACCES. Every other path reaches the real fs.
const flagged = vi.hoisted(() => ({ paths: new Set<string>() }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import('node:fs');
  const deny = (p: unknown): void => {
    if (typeof p === 'string' && flagged.paths.has(p)) {
      throw Object.assign(new Error(`EACCES: permission denied, open '${p}'`), { code: 'EACCES' });
    }
  };
  const patched = {
    ...actual,
    openSync: ((p: never, flags: never, ...rest: never[]) => {
      // Only a read-only open is denied: creating the lock (O_EXCL) must still work.
      if (flags === undefined || (Number(flags) & 3) === actual.constants.O_RDONLY) deny(p);
      return (actual.openSync as (...a: unknown[]) => number)(p, flags, ...rest);
    }) as typeof actual.openSync,
    readFileSync: ((p: never, ...rest: never[]) => {
      deny(p);
      return (actual.readFileSync as (...a: unknown[]) => unknown)(p, ...rest);
    }) as typeof actual.readFileSync,
  };
  return { ...patched, default: patched };
});

import { DbInUseError, DbLockRefusedError, LOCK_FILE, acquireLock, inspectLock } from './lock';
import { openDatabase } from './pglite';

const T0 = '2026-03-04T05:06:07.089Z';
const clock: Clock = { now: () => new Date(T0) };
const quiet = { clock, warn: () => undefined };

let dir: string;
let lock: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ums-lock-adv-'));
  lock = join(dir, LOCK_FILE);
  flagged.paths.clear();
});
afterEach(() => {
  flagged.paths.clear();
  rmSync(dir, { recursive: true, force: true });
});

const refusal = (fn: () => unknown): DbLockRefusedError => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(DbLockRefusedError);
    expect(e).not.toBeInstanceOf(DbInUseError);
    return e as DbLockRefusedError;
  }
  throw new Error('expected the lock to refuse, but it did not');
};

describe('a symlinked lock file refuses (fail closed)', () => {
  it.each([
    ['dangling target', (): string => join(dir, 'nowhere')],
    [
      'a file holding a perfectly valid stale lock',
      (): string => {
        const t = join(dir, 'real-lock');
        writeFileSync(t, JSON.stringify({ pid: 999_999, host: hostname(), started: T0 }));
        return t;
      },
    ],
    [
      'a directory',
      (): string => {
        const t = join(dir, 'a-dir');
        mkdirSync(t);
        return t;
      },
    ],
    ['a system file', (): string => '/etc/hostname'],
  ])('%s', (_name, makeTarget) => {
    const target = makeTarget();
    symlinkSync(target, lock);
    const e = refusal(() => acquireLock(dir, { ...quiet, isAlive: () => false }));
    expect(e.code).toBe('symlink');
    expect(lstatSync(lock).isSymbolicLink()).toBe(true);
    expect(readlinkSync(lock)).toBe(target);
    if (existsSync(join(dir, 'real-lock'))) {
      expect(JSON.parse(readFileSync(join(dir, 'real-lock'), 'utf8')).pid).toBe(999_999);
    }
    expect(inspectLock(dir)).toMatchObject({ state: 'refused', code: 'symlink' });
  });
});

describe('a lock file that is not a plain file refuses', () => {
  it('a directory', () => {
    mkdirSync(lock);
    writeFileSync(join(lock, 'keep'), 'x');
    expect(refusal(() => acquireLock(dir, quiet)).code).toBe('not_file');
    expect(readFileSync(join(lock, 'keep'), 'utf8')).toBe('x');
    expect(inspectLock(dir)).toMatchObject({ state: 'refused', code: 'not_file' });
  });
});

describe('an unreadable lock refuses', () => {
  it('EACCES while reading: refuse, keep the file', () => {
    writeFileSync(lock, JSON.stringify({ pid: 999_999, host: hostname(), started: T0 }));
    flagged.paths.add(lock);
    const e = refusal(() => acquireLock(dir, { ...quiet, isAlive: () => false }));
    expect(e.code).toBe('unreadable');
    flagged.paths.clear();
    expect(JSON.parse(readFileSync(lock, 'utf8')).pid).toBe(999_999);
    flagged.paths.add(lock);
    expect(inspectLock(dir)).toMatchObject({ state: 'refused', code: 'unreadable' });
  });

  it.skipIf(process.getuid?.() === 0)('a real chmod 000 file (non-root runs only)', () => {
    writeFileSync(lock, JSON.stringify({ pid: 999_999, host: hostname(), started: T0 }));
    chmodSync(lock, 0o000);
    expect(refusal(() => acquireLock(dir, { ...quiet, isAlive: () => false })).code).toBe(
      'unreadable',
    );
  });
});

describe('a malformed lock refuses and is left in place', () => {
  const good = { pid: 999_999, host: 'h', started: T0 };
  it.each([
    ['empty file', ''],
    ['garbage', 'not json at all'],
    ['truncated JSON', '{"pid":12'],
    ['a JSON array', '[]'],
    ['null', 'null'],
    ['a string', '"pid"'],
    ['pid zero (would signal the process group)', JSON.stringify({ ...good, pid: 0 })],
    ['pid negative (would signal a process group)', JSON.stringify({ ...good, pid: -1 })],
    ['pid fractional', JSON.stringify({ ...good, pid: 1.5 })],
    ['pid a string', JSON.stringify({ ...good, pid: '123' })],
    ['pid beyond a safe integer', '{"pid":1e400,"host":"h","started":"' + T0 + '"}'],
    ['host missing', JSON.stringify({ pid: 5, started: T0 })],
    ['host empty', JSON.stringify({ ...good, host: '' })],
    ['host a number', JSON.stringify({ ...good, host: 7 })],
    ['started missing', JSON.stringify({ pid: 5, host: 'h' })],
    ['started not a date', JSON.stringify({ ...good, started: 'yesterday' })],
    ['started without Z', JSON.stringify({ ...good, started: '2026-03-04T05:06:07' })],
    ['over 4 KiB', JSON.stringify({ ...good, host: 'h'.repeat(5000) })],
  ])('%s', (_name, content) => {
    writeFileSync(lock, content);
    const e = refusal(() => acquireLock(dir, { ...quiet, isAlive: () => false }));
    expect(e.code).toBe('malformed');
    expect(readFileSync(lock, 'utf8')).toBe(content);
    expect(inspectLock(dir)).toMatchObject({ state: 'refused', code: 'malformed' });
  });
});

describe('the printed warning cannot be used to inject text', () => {
  it('control characters in the lock host are not printed raw', () => {
    const host = 'evil\nSTOP\u001b[31m host';
    writeFileSync(lock, JSON.stringify({ pid: 5, host, started: T0 }));
    const warnings: string[] = [];
    const h = acquireLock(dir, { clock, warn: (m) => warnings.push(m) });
    expect(warnings).toHaveLength(1);
    const odd = [...(warnings[0] ?? '')].filter(
      (c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f,
    );
    expect(odd).toEqual([]);
    h.release();
  });
});

describe('a lock held by a live process is never deleted', () => {
  it('many refused attempts leave the live lock byte-identical', () => {
    const holder = acquireLock(dir, { ...quiet, pid: 4242, isAlive: () => true });
    const before = readFileSync(lock, 'utf8');
    for (let i = 0; i < 20; i += 1) {
      expect(() => acquireLock(dir, { ...quiet, pid: 5000 + i, isAlive: () => true })).toThrow(
        DbInUseError,
      );
    }
    expect(readFileSync(lock, 'utf8')).toBe(before);
    holder.release();
  });

  it('release does not follow a symlink swapped in for the lock', () => {
    const h = acquireLock(dir, quiet);
    const victim = join(dir, 'victim');
    writeFileSync(victim, 'keep me');
    rmSync(lock);
    symlinkSync(victim, lock);
    expect(h.release()).toBe(false);
    expect(readFileSync(victim, 'utf8')).toBe('keep me');
    expect(lstatSync(lock).isSymbolicLink()).toBe(true);
  });

  it('release leaves a directory that replaced the lock', () => {
    const h = acquireLock(dir, quiet);
    rmSync(lock);
    mkdirSync(lock);
    expect(h.release()).toBe(false);
    expect(lstatSync(lock).isDirectory()).toBe(true);
  });
});

describe('racing openers: exactly one wins', { timeout: 120_000 }, () => {
  const settle = async <T>(ps: Promise<T>[]): Promise<{ ok: T[]; err: unknown[] }> => {
    const r = await Promise.allSettled(ps);
    return {
      ok: r.flatMap((x) => (x.status === 'fulfilled' ? [x.value] : [])),
      err: r.flatMap((x) => (x.status === 'rejected' ? [x.reason as unknown] : [])),
    };
  };

  it('two openDatabase calls on the same fresh directory', async () => {
    const { ok, err } = await settle([
      openDatabase({ kind: 'pglite-disk', dir }, { clock }),
      openDatabase({ kind: 'pglite-disk', dir }, { clock }),
    ]);
    expect(ok).toHaveLength(1);
    expect(err).toHaveLength(1);
    expect(err[0]).toBeInstanceOf(DbInUseError);
    expect(existsSync(lock)).toBe(true);
    await ok[0]?.close();
    expect(existsSync(lock)).toBe(false);
  });

  it('eight acquirers with different live pids on a fresh directory', () => {
    const results = Array.from({ length: 8 }, (_v, i) => {
      try {
        return { h: acquireLock(dir, { ...quiet, pid: 7000 + i, isAlive: () => true }) };
      } catch (e) {
        return { e };
      }
    });
    const won = results.flatMap((r) => ('h' in r && r.h ? [r.h] : []));
    expect(won).toHaveLength(1);
    expect(results.filter((r) => 'e' in r && r.e instanceof DbInUseError)).toHaveLength(7);
    won[0]?.release();
  });

  it('eight acquirers racing for one stale lock: one replaces it, the rest are refused', () => {
    writeFileSync(lock, JSON.stringify({ pid: 999_999, host: hostname(), started: T0 }));
    const warnings: string[] = [];
    const alive = new Set<number>();
    const isAlive = (pid: number): boolean => alive.has(pid);
    const results = Array.from({ length: 8 }, (_v, i) => {
      const pid = 7000 + i;
      alive.add(pid);
      try {
        return { h: acquireLock(dir, { clock, pid, isAlive, warn: (m) => warnings.push(m) }) };
      } catch (e) {
        return { e };
      }
    });
    const won = results.flatMap((r) => ('h' in r && r.h ? [r.h] : []));
    expect(won).toHaveLength(1);
    expect(warnings).toHaveLength(1);
    expect(JSON.parse(readFileSync(lock, 'utf8')).pid).toBe(won[0]?.info.pid);
    won[0]?.release();
  });

  it('a failed database open gives the lock back', async () => {
    // A PG_VERSION that is not a PGlite data directory makes the open fail after the lock was taken.
    writeFileSync(join(dir, 'PG_VERSION'), '99\n');
    await expect(openDatabase({ kind: 'pglite-disk', dir }, { clock })).rejects.toThrow(
      /PGlite failed to initialize/,
    );
    expect(existsSync(lock)).toBe(false);
  });
});
