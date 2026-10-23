// CO-9 golden: the exact bytes of the lock file and the exact text of the messages. A change here is
// a change to what operators read and what CO-10 backup and restore parse; update on purpose only.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Clock } from '@umsbx/contracts';
import { DbInUseError, LOCK_FILE, acquireLock } from './lock';

const GOLDEN_LOCK_BYTES =
  '{"pid":4242,"host":"golden-host","started":"2026-03-04T05:06:07.089Z"}\n';
const GOLDEN_IN_USE =
  'The UnitMarket app (pid 4242) holds this database. Stop it first, or use the ops page Stop button.';
const GOLDEN_STALE_PID =
  'warning: replacing a stale database lock in DIR: pid 999999 on host golden-host is not running';
const GOLDEN_STALE_HOST =
  'warning: replacing a database lock in DIR that names another host (other-host, this host is golden-host): cannot tell whether it runs';

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
});
