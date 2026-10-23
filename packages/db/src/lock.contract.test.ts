// CO-9 contract tests: the lock file format and the DbInUseError message are an interface that
// other code reads (CO-10 backup and restore, scripts/safety-cli.mjs prints the message unchanged).
// The tests pin the file name, the JSON schema, the file mode, the error shapes and the public API.
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Clock } from '@umsbx/contracts';
import * as db from './index';
import { DbInUseError, DbLockRefusedError, LOCK_FILE, acquireLock, inspectLock } from './lock';

const T0 = '2026-03-04T05:06:07.089Z';
const clock: Clock = { now: () => new Date(T0) };

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ums-lock-contract-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('lock file format', () => {
  it('is <dir>/.ums-open.lock holding exactly {pid, host, started}, mode 0600', () => {
    const h = acquireLock(dir, { clock, warn: () => undefined });
    const path = join(dir, '.ums-open.lock');
    expect(LOCK_FILE).toBe('.ums-open.lock');
    expect(h.path).toBe(path);
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual(['pid', 'host', 'started']);
    expect(Number.isInteger(parsed.pid) && (parsed.pid as number) > 0).toBe(true);
    expect(parsed.pid).toBe(process.pid);
    expect(parsed.host).toBe(hostname());
    expect(parsed.started).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(new Date(parsed.started as string).toISOString()).toBe(parsed.started);
    expect(statSync(path).isFile()).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    h.release();
  });

  it('a reader that applies the CO-10 rule (integer pid > 0, string host) accepts what is written', () => {
    const h = acquireLock(dir, { clock, warn: () => undefined });
    const info = JSON.parse(readFileSync(h.path, 'utf8')) as { pid: unknown; host: unknown };
    expect(Number.isInteger(info.pid) && (info.pid as number) > 0).toBe(true);
    expect(typeof info.host).toBe('string');
    h.release();
  });

  it('a lock with extra keys is still read (forward compatible); the known keys decide', () => {
    writeFileSync(
      join(dir, LOCK_FILE),
      JSON.stringify({ pid: process.pid, host: hostname(), started: T0, note: 'future' }),
    );
    expect(inspectLock(dir)).toMatchObject({ state: 'live', info: { pid: process.pid } });
  });
});

describe('errors', () => {
  it('DbInUseError: name, pid and the exact spec message', () => {
    const e = new DbInUseError(4321);
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('DbInUseError');
    expect(e.pid).toBe(4321);
    expect(e.message).toBe(
      'The UnitMarket app (pid 4321) holds this database. Stop it first, or use the ops page Stop button.',
    );
  });

  it('DbLockRefusedError carries a code from the closed set and is not a DbInUseError', () => {
    writeFileSync(join(dir, LOCK_FILE), 'garbage');
    let caught: unknown;
    try {
      acquireLock(dir, { clock });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(DbLockRefusedError);
    expect(caught).not.toBeInstanceOf(DbInUseError);
    expect((caught as DbLockRefusedError).name).toBe('DbLockRefusedError');
    expect(['symlink', 'not_file', 'unreadable', 'malformed', 'io']).toContain(
      (caught as DbLockRefusedError).code,
    );
    expect((caught as Error).message).toContain(LOCK_FILE);
  });

  it('the message of a live lock written by another process matches what safety-cli prints', () => {
    writeFileSync(
      join(dir, LOCK_FILE),
      JSON.stringify({ pid: 777, host: hostname(), started: T0 }),
    );
    expect(() => acquireLock(dir, { clock, isAlive: () => true })).toThrowError(
      'The UnitMarket app (pid 777) holds this database. Stop it first, or use the ops page Stop button.',
    );
  });
});

describe('inspectLock result shapes', () => {
  it('has exactly four states', () => {
    expect(inspectLock(dir)).toEqual({ state: 'absent' });
    writeFileSync(join(dir, LOCK_FILE), JSON.stringify({ pid: 5, host: 'x', started: T0 }));
    expect(inspectLock(dir, { isAlive: () => true }).state).toBe('stale'); // other host
    writeFileSync(join(dir, LOCK_FILE), JSON.stringify({ pid: 5, host: hostname(), started: T0 }));
    expect(inspectLock(dir, { isAlive: () => true }).state).toBe('live');
    writeFileSync(join(dir, LOCK_FILE), '{');
    expect(inspectLock(dir).state).toBe('refused');
  });

  it('never creates, changes or removes a file', () => {
    inspectLock(dir);
    expect(existsSync(join(dir, LOCK_FILE))).toBe(false);
    writeFileSync(join(dir, LOCK_FILE), '{');
    inspectLock(dir);
    expect(readFileSync(join(dir, LOCK_FILE), 'utf8')).toBe('{');
  });
});

describe('public API of @umsbx/db for the lock', () => {
  it('the package root exports the helpers CO-10 reuses', () => {
    const exported = Object.keys(db).sort();
    for (const name of [
      'DbInUseError',
      'DbLockRefusedError',
      'LOCK_FILE',
      'acquireLock',
      'inspectLock',
      'releaseLock',
      'openDatabase',
    ]) {
      expect(exported, name).toContain(name);
    }
    expect(db.LOCK_FILE).toBe('.ums-open.lock');
  });

  it('openDatabase keeps its one-argument form for existing callers', () => {
    expect(db.openDatabase.length).toBeLessThanOrEqual(2);
  });
});
