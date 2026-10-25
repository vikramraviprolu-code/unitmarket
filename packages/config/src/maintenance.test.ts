import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import type { Stats } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { loadConfig, readMaintenanceFlag } from './index';
import { ENV_NAMES } from './schema';

// CO-7b (D-037): the maintenance flag. The app reads it once at boot; this file pins the reader
// (what counts as "on") and the config rule for the path. The reader only looks, it never writes.
const S1 = 'Qm7vK2pLx9RbT4zWc8NdYh3JfG6sAe1U';
const S2 = 'Zr5tB8nKd2VwXq7LmC4yHj9PgF3sEa6U';
const S3 = 'Jd4wN7xQk2ZcR9vTb5LmY8hGp3FsAe6U';
const NAME = 'UMS_MAINTENANCE_FLAG';

const made: string[] = [];
const fresh = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'co7b-cfg-'));
  made.push(d);
  return d;
};
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

const env = (over: Record<string, string | undefined> = {}) => ({
  UMS_SESSION_SECRET: S1,
  UMS_APPROVAL_SECRET: S2,
  UMS_LINK_SECRET: S3,
  ...over,
});
const disk = (dir: string, over: Record<string, string | undefined> = {}) =>
  env({ UMS_DB: 'pglite-disk', UMS_PGLITE_DIR: join(dir, 'pglite'), ...over });

describe('readMaintenanceFlag', () => {
  it('null path (no flag configured): off', () => {
    expect(readMaintenanceFlag(null)).toEqual({ on: false });
  });

  it('the parent folder exists and the flag does not: off', () => {
    expect(readMaintenanceFlag(join(fresh(), 'ums-maintenance'))).toEqual({ on: false });
  });

  it('a plain file: on', () => {
    const d = fresh();
    writeFileSync(join(d, 'ums-maintenance'), '');
    expect(readMaintenanceFlag(join(d, 'ums-maintenance'))).toEqual({
      on: true,
      why: 'flag_present',
    });
  });

  it('anything at the path counts: a folder, a link, a dangling link', () => {
    const d = fresh();
    mkdirSync(join(d, 'a'));
    mkdirSync(join(d, 'a', 'ums-maintenance'));
    symlinkSync('/nonexistent-target-for-co7b', join(d, 'ums-maintenance'));
    expect(readMaintenanceFlag(join(d, 'a', 'ums-maintenance')).on).toBe(true);
    expect(readMaintenanceFlag(join(d, 'ums-maintenance')).on).toBe(true);
  });

  it('the parent folder is missing (disk not mounted): on, never silently off', () => {
    expect(readMaintenanceFlag(join(fresh(), 'not-mounted', 'ums-maintenance'))).toEqual({
      on: true,
      why: 'flag_dir_missing',
    });
  });

  it('the parent is a file, not a folder: on', () => {
    const d = fresh();
    writeFileSync(join(d, 'file'), 'x');
    expect(readMaintenanceFlag(join(d, 'file', 'ums-maintenance')).on).toBe(true);
  });

  it('an error other than "no such file" (permission, I/O): on', () => {
    const d = fresh();
    const denied = (): Stats => {
      throw Object.assign(new Error('denied'), { code: 'EACCES' });
    };
    const dirStat = { isDirectory: () => true } as Stats;
    let calls = 0;
    const lstat = (): Stats => (calls++ === 0 ? dirStat : denied());
    expect(readMaintenanceFlag(join(d, 'ums-maintenance'), { lstat })).toEqual({
      on: true,
      why: 'flag_unreadable',
    });
  });

  it('creates, changes and removes nothing', () => {
    const d = fresh();
    const before = readdirSync(d);
    readMaintenanceFlag(join(d, 'ums-maintenance'));
    readMaintenanceFlag(join(d, 'missing', 'ums-maintenance'));
    expect(readdirSync(d)).toEqual(before);
  });
});

describe('UMS_MAINTENANCE_FLAG in the config', () => {
  it('is a name the config reads, and unset means no flag', () => {
    expect(ENV_NAMES).toContain(NAME);
    const r = loadConfig(env());
    expect(r.ok && r.value.maintenance_flag).toBeNull();
  });

  it('accepts a flag beside the PGlite folder', () => {
    const d = fresh();
    const r = loadConfig(disk(d, { [NAME]: join(d, 'ums-maintenance') }));
    expect(r.ok && r.value.maintenance_flag).toBe(join(d, 'ums-maintenance'));
  });

  it('accepts a flag with an in-memory database (tests, dry run)', () => {
    const r = loadConfig(env({ [NAME]: '/tmp/ums-maintenance' }));
    expect(r.ok && r.value.maintenance_flag).toBe('/tmp/ums-maintenance');
  });

  it.each([
    ['a relative path', 'ums-maintenance'],
    ['a dot segment', '/var/data/./ums-maintenance'],
    ['a parent segment', '/var/data/../data/ums-maintenance'],
    ['a double slash', '/var/data//ums-maintenance'],
    ['a trailing slash', '/var/data/ums-maintenance/'],
    ['another name', '/var/data/maintenance'],
    ['a name with a suffix', '/var/data/ums-maintenance.bak'],
    ['the root', '/'],
    ['a NUL byte', '/var/data/ums-maintenance\u0000x'],
    ['a line break', '/var/data/ums-maintenance\n'],
  ])('refuses %s with invalid_value naming the variable, never the value', (_n, v) => {
    const r = loadConfig(env({ [NAME]: v }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('invalid_value');
    expect(r.error.name).toBe(NAME);
    expect(JSON.stringify(r.error)).not.toContain('ums-maintenance');
  });

  it('with a PGlite folder on disk the flag must be its sibling, never inside it', () => {
    const d = fresh();
    for (const v of [
      join(d, 'pglite', 'ums-maintenance'),
      join(d, 'other', 'ums-maintenance'),
      '/tmp/ums-maintenance',
    ]) {
      const r = loadConfig(disk(d, { [NAME]: v }));
      expect(r.ok, v).toBe(false);
      if (!r.ok) expect(r.error).toMatchObject({ code: 'invalid_value', name: NAME });
    }
  });

  it('is not a secret and not a PayPal or live-looking name', () => {
    const r = loadConfig(env({ [NAME]: '/tmp/ums-maintenance' }));
    expect(r.ok && typeof r.value.maintenance_flag).toBe('string');
  });
});
