// CO-7b (D-037): on the host the app is up (in maintenance mode) while backup.mjs and restore.mjs run.
// `--maintenance` takes the maintenance flag, a plain file named ums-maintenance beside the data folder,
// as the proof that a restart would not open the database. Backup still refuses a live lock; the old
// --i-stopped-the-app path is unchanged; neither tool ever creates, changes or removes the flag.
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate, openDatabase } from '../packages/db/src/index';
import { runBackup, parseArgs as parseBackupArgs, USAGE } from './backup.mjs';
import { runRestore, parseArgs as parseRestoreArgs } from './restore.mjs';

const ROOT = join(__dirname, '..');
const T = '2026-10-25T10:00:00Z';
const clock = { now: () => new Date(T) };
const made: string[] = [];
const fresh = (p: string): string => {
  const d = mkdtempSync(join(tmpdir(), `co7b-${p}-`));
  made.push(d);
  return d;
};
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

let template: string;
beforeAll(async () => {
  template = fresh('tpl');
  const db = await openDatabase({ kind: 'pglite-disk', dir: join(template, 'pglite') });
  await migrate(db, clock);
  await db.close();
}, 120_000);

/** A host-shaped layout: <root>/pglite (data), <root>/ums-maintenance (flag, optional), <root>/out. */
function host(flag: 'file' | 'none' | 'symlink' | 'dir' | 'lock-live' | 'lock-stale' = 'file') {
  const root = fresh('host');
  cpSync(join(template, 'pglite'), join(root, 'pglite'), { recursive: true });
  const flagPath = join(root, 'ums-maintenance');
  if (flag === 'file' || flag === 'lock-live' || flag === 'lock-stale')
    writeFileSync(flagPath, 'x\n');
  if (flag === 'symlink') symlinkSync('/etc/hostname', flagPath);
  if (flag === 'dir') mkdirSync(flagPath);
  if (flag === 'lock-live')
    writeFileSync(
      join(root, 'pglite', '.ums-open.lock'),
      JSON.stringify({ pid: process.pid, host: hostname(), started: T }),
    );
  if (flag === 'lock-stale')
    writeFileSync(
      join(root, 'pglite', '.ums-open.lock'),
      JSON.stringify({ pid: 2 ** 22 + 4321, host: hostname(), started: T }),
    );
  return { root, data: join(root, 'pglite'), flagPath, out: join(root, 'out', 'bk') };
}
const stamp = (p: string) => ({ text: readFileSync(p, 'utf8'), mtime: statSync(p).mtimeMs });

describe('backup --maintenance', () => {
  it('accepts the flag beside the data folder as proof, backs up, leaves the flag untouched', async () => {
    const h = host('file');
    const before = stamp(h.flagPath);
    const res = await runBackup({ dir: h.data, out: h.out, maintenance: true, clock });
    expect(existsSync(join(res.dir, 'manifest.json'))).toBe(true);
    expect(stamp(h.flagPath)).toEqual(before);
    expect(existsSync(join(h.data, '.ums-open.lock'))).toBe(false);
  }, 120_000);

  it('still refuses while the app holds the lock (live pid on this host), even with the flag', async () => {
    const h = host('lock-live');
    await expect(runBackup({ dir: h.data, out: h.out, maintenance: true, clock })).rejects.toThrow(
      /holds this database|Stop it first/i,
    );
    expect(existsSync(h.out)).toBe(false);
  });

  it('goes ahead past a stale lock with the flag, with a printed warning', async () => {
    const h = host('lock-stale');
    const warnings: string[] = [];
    await runBackup({
      dir: h.data,
      out: h.out,
      maintenance: true,
      clock,
      warn: (m: string) => warnings.push(m),
    });
    expect(warnings.join('\n')).toMatch(/stale|not running/i);
  }, 120_000);

  it.each([
    ['no flag', 'none'],
    ['a symbolic link', 'symlink'],
    ['a folder', 'dir'],
  ] as const)('refuses with %s, says how to set it, and writes nothing', async (_n, kind) => {
    const h = host(kind);
    const err = await runBackup({ dir: h.data, out: h.out, maintenance: true, clock }).then(
      () => null,
      (e: Error) => e,
    );
    expect(err?.message).toMatch(/maintenance/i);
    expect(err?.message).toMatch(/ums-maintenance/);
    expect(existsSync(h.out)).toBe(false);
    expect(existsSync(join(h.data, '.ums-open.lock'))).toBe(false);
  });

  it('a flag elsewhere does not count: it must sit beside the data folder', async () => {
    const h = host('none');
    const other = fresh('other');
    writeFileSync(join(other, 'ums-maintenance'), '');
    await expect(runBackup({ dir: h.data, out: h.out, maintenance: true, clock })).rejects.toThrow(
      /maintenance/i,
    );
  });

  it('the old way is unchanged: neither option refuses, --i-stopped-the-app alone works with no flag', async () => {
    const h = host('none');
    await expect(runBackup({ dir: h.data, out: h.out, clock })).rejects.toThrow(
      /--i-stopped-the-app/,
    );
    const res = await runBackup({ dir: h.data, out: h.out, appStopped: true, clock });
    expect(existsSync(join(res.dir, 'manifest.json'))).toBe(true);
    expect(existsSync(h.flagPath)).toBe(false); // not created for it
  }, 120_000);

  it('the refusal without either option names --maintenance as well', async () => {
    const h = host('file');
    await expect(runBackup({ dir: h.data, out: h.out, clock })).rejects.toThrow(/--maintenance/);
  });

  it('parses --maintenance; unknown flags are still a usage error; usage names it', () => {
    expect(parseBackupArgs(['--dir', 'a', '--out', 'b', '--maintenance'])).toMatchObject({
      maintenance: true,
    });
    expect(parseBackupArgs(['--dir', 'a', '--out', 'b', '--maintenance=1'])).toBeNull();
    expect(parseBackupArgs(['--dir', 'a', '--out', 'b', '--force'])).toBeNull();
    expect(USAGE).toMatch(/--maintenance/);
    expect(USAGE).toMatch(/--i-stopped-the-app/);
  });

  it('command line: exit 0 with the flag, exit 1 without, nothing printed but names and counts', () => {
    const run = (args: string[]) =>
      spawnSync(process.execPath, ['scripts/backup.mjs', ...args], {
        cwd: ROOT,
        encoding: 'utf8',
        env: {},
      });
    const ok = host('file');
    const a = run(['--dir', ok.data, '--out', ok.out, '--maintenance']);
    expect(a.status, a.stderr).toBe(0);
    expect(a.stdout).toMatch(/backup ok/);
    const no = host('none');
    const b = run(['--dir', no.data, '--out', no.out, '--maintenance']);
    expect(b.status).toBe(1);
    expect(b.stderr).toMatch(/maintenance/i);
    expect(existsSync(no.out)).toBe(false);
  }, 120_000);
});

describe('restore --maintenance', () => {
  let backup: string;
  beforeAll(async () => {
    const h = host('file');
    backup = (await runBackup({ dir: h.data, out: h.out, maintenance: true, clock })).dir;
  }, 120_000);

  /** A host layout whose live data folder was moved aside: <root>/ums-maintenance beside a free target. */
  function target(flag: 'file' | 'none' | 'symlink' | 'dir') {
    const root = fresh('rt');
    const flagPath = join(root, 'ums-maintenance');
    if (flag === 'file') writeFileSync(flagPath, 'x\n');
    if (flag === 'symlink') symlinkSync('/etc/hostname', flagPath);
    if (flag === 'dir') mkdirSync(flagPath);
    return { root, dir: join(root, 'pglite'), flagPath };
  }

  it('restores into the free target beside the flag and leaves the flag untouched', async () => {
    const t = target('file');
    const before = stamp(t.flagPath);
    await runRestore({
      from: backup,
      dir: t.dir,
      maintenance: true,
      allowLiveApprovals: true,
      clock,
    });
    expect(existsSync(join(t.dir, 'PG_VERSION'))).toBe(true);
    expect(stamp(t.flagPath)).toEqual(before);
  }, 120_000);

  it.each([
    ['no flag', 'none'],
    ['a symbolic link', 'symlink'],
    ['a folder', 'dir'],
  ] as const)('refuses with %s and creates nothing', async (_n, kind) => {
    const t = target(kind);
    await expect(
      runRestore({ from: backup, dir: t.dir, maintenance: true, allowLiveApprovals: true, clock }),
    ).rejects.toThrow(/maintenance/i);
    expect(existsSync(t.dir)).toBe(false);
    expect(readdirSync(t.root).filter((n) => n !== 'ums-maintenance')).toEqual([]);
  });

  it('without --maintenance nothing about the flag is checked (the laptop drill is unchanged)', async () => {
    const t = target('none');
    await runRestore({ from: backup, dir: t.dir, allowLiveApprovals: true, clock });
    expect(existsSync(join(t.dir, 'PG_VERSION'))).toBe(true);
    expect(existsSync(t.flagPath)).toBe(false);
  }, 120_000);

  it('still refuses a target that is not empty, flag or not', async () => {
    const t = target('file');
    mkdirSync(t.dir);
    writeFileSync(join(t.dir, 'x'), '');
    await expect(
      runRestore({ from: backup, dir: t.dir, maintenance: true, allowLiveApprovals: true, clock }),
    ).rejects.toThrow(/not empty/i);
  });

  it('parses --maintenance and still refuses unknown flags', () => {
    expect(parseRestoreArgs(['--from', 'a', '--dir', 'b', '--maintenance'])).toMatchObject({
      maintenance: true,
    });
    expect(parseRestoreArgs(['--from', 'a', '--dir', 'b', '--maintenance=1'])).toBeNull();
  });
});
