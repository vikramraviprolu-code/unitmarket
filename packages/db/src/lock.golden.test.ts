// CO-9 golden: the exact bytes of the lock file and the exact text of the messages. A change here is
// a change to what operators read and what CO-10 backup and restore parse; update on purpose only.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Clock } from '@umsbx/contracts';
import { DbInUseError, DbLockRefusedError, LOCK_BREAK_FILE, LOCK_FILE, acquireLock } from './lock';

const GOLDEN_LOCK_BYTES =
  '{"pid":4242,"host":"golden-host","started":"2026-03-04T05:06:07.089Z"}\n';
const GOLDEN_IN_USE =
  'The UnitMarket app (pid 4242) holds this database. Stop it first, or use the ops page Stop button.';
const GOLDEN_STALE_PID =
  'warning: replacing a stale database lock in DIR: pid 999999 on host golden-host is not running';
const GOLDEN_STALE_HOST =
  'warning: replacing a database lock in DIR that names another host (other-host, this host is golden-host): cannot tell whether it runs';

const GOLDEN_STALE_RUN =
  'warning: replacing a stale database lock in DIR: pid 4242 on host golden-host names this process, which does not hold it (left by a previous run)';
const GOLDEN_EMPTY =
  'The database lock file .ums-open.lock in DIR is empty (left by a crash while it was written); refusing to open. Check that no UnitMarket process runs, then remove the file by hand.';
const GOLDEN_GUARD =
  'The database lock file .ums-open.lock.break in DIR exists: another process is replacing a stale lock, or one was interrupted; refusing to open. Check that no UnitMarket process runs, then remove the file by hand.';

const clock: Clock = { now: () => new Date('2026-03-04T05:06:07.089Z') };

describe('lock golden', () => {
  it('the lock file bytes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ums-lock-golden-'));
    try {
      const h = acquireLock(dir, { clock, pid: 4242, host: 'golden-host', warn: () => undefined });
      expect(readFileSync(join(dir, LOCK_FILE), 'utf8')).toBe(GOLDEN_LOCK_BYTES);
      h.release();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the DbInUseError message', () => {
    expect(new DbInUseError(4242).message).toBe(GOLDEN_IN_USE);
  });

  it('the stale-lock warnings', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ums-lock-golden-'));
    try {
      const out: string[] = [];
      const warn = (m: string): void => void out.push(m.split(dir).join('DIR'));
      writeFileSync(
        join(dir, LOCK_FILE),
        JSON.stringify({ pid: 999999, host: 'golden-host', started: '2026-01-01T00:00:00.000Z' }),
      );
      acquireLock(dir, {
        clock,
        pid: 4242,
        host: 'golden-host',
        isAlive: () => false,
        warn,
      }).release();
      writeFileSync(
        join(dir, LOCK_FILE),
        JSON.stringify({ pid: 1, host: 'other-host', started: '2026-01-01T00:00:00.000Z' }),
      );
      acquireLock(dir, {
        clock,
        pid: 4242,
        host: 'golden-host',
        isAlive: () => true,
        warn,
      }).release();
      expect(out).toEqual([GOLDEN_STALE_PID, GOLDEN_STALE_HOST]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the previous-run warning, the empty-lock refusal and the guard refusal', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ums-lock-golden-'));
    try {
      const out: string[] = [];
      const warn = (m: string): void => void out.push(m.split(dir).join('DIR'));
      writeFileSync(
        join(dir, LOCK_FILE),
        JSON.stringify({ pid: 4242, host: 'golden-host', started: '2026-01-01T00:00:00.000Z' }),
      );
      acquireLock(dir, { clock, pid: 4242, host: 'golden-host', warn }).release();
      expect(out).toEqual([GOLDEN_STALE_RUN]);

      const message = (fn: () => unknown): string => {
        try {
          fn();
        } catch (e) {
          expect(e).toBeInstanceOf(DbLockRefusedError);
          return (e as Error).message.split(dir).join('DIR');
        }
        return 'no refusal';
      };
      writeFileSync(join(dir, LOCK_FILE), '');
      expect(message(() => acquireLock(dir, { clock, pid: 4242, host: 'golden-host', warn }))).toBe(
        GOLDEN_EMPTY,
      );
      writeFileSync(
        join(dir, LOCK_FILE),
        JSON.stringify({ pid: 1, host: 'other-host', started: '2026-01-01T00:00:00.000Z' }),
      );
      writeFileSync(join(dir, LOCK_BREAK_FILE), '{}');
      expect(
        message(() =>
          acquireLock(dir, { clock, pid: 4242, host: 'golden-host', isAlive: () => true, warn }),
        ),
      ).toBe(GOLDEN_GUARD);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
