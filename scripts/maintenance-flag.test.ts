import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from './test-helpers';

// CO-7b (D-037), lint-style: the maintenance flag is created and removed only from the host shell.
// Nothing the app runs may write that path, so this test pins (1) which production files may touch the
// file system at all, (2) which files may name the flag or its config field, (3) that the one reader
// imports read functions only, and (4) that the host tools only look at it.
const SKIP_DIRS = new Set(['node_modules', '.next', '.git', 'dist', '__fixtures__', '.turbo']);
const CODE = /\.(?:[cm]?[jt]sx?)$/;
const TEST_FILE =
  /(?:\.test\.[cm]?[jt]sx?$|\.spec\.[jt]s$|\/e2e\/|test-support\.ts$|-test-support\.ts$|\/testing\.ts$)/;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (CODE.test(name)) out.push(p);
  }
  return out;
}
const rel = (p: string): string => relative(REPO_ROOT, p).split(sep).join('/');
const read = (r: string): string => readFileSync(join(REPO_ROOT, r), 'utf8');

const prodFiles = ['apps', 'packages', 'domain', 'tools']
  .flatMap((d) => walk(join(REPO_ROOT, d)))
  .map(rel)
  .filter((f) => !TEST_FILE.test(`/${f}`));

const FS_IMPORT =
  /(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"](?:node:)?(?:fs|fs\/promises|child_process)['"]/;
// The only production files that import node:fs (or child_process) today, each for its own job.
const FS_ALLOWED = new Set([
  'packages/db/src/lock.ts', // the single-opener lock, inside the PGlite folder
  'packages/db/src/migrate.ts', // reads migration files
  'packages/transport/src/fixture-store.ts', // reads recorded fixtures
  'packages/transport/src/recorder.ts', // owner-run recorder
  'tools/spike-kit/src/git-head.ts', // owner-run spike kit
  'tools/spike-kit/src/spike.ts', // owner-run spike kit
  'packages/config/src/maintenance.ts', // the flag reader (CO-7b): lstat only
]);

const WRITE_API =
  /\b(?:writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream|unlink|unlinkSync|rm|rmSync|rmdir|rmdirSync|rename|renameSync|mkdir|mkdirSync|mkdtemp|symlink|symlinkSync|link|linkSync|copyFile|copyFileSync|cp|cpSync|truncate|truncateSync|open|openSync|chmod|chmodSync|chown|utimes|utimesSync|exec|execSync|spawn|spawnSync|fork)\b/;

describe('who may touch the file system or name the flag', () => {
  it('finds the production files (the scan is live)', () => {
    expect(prodFiles.length).toBeGreaterThan(100);
    expect(prodFiles).toContain('packages/db/src/lock.ts');
    expect(prodFiles).toContain('apps/web/composition.server.ts');
  });

  it('only the reviewed production files import node:fs or child_process', () => {
    const found = prodFiles.filter((f) => FS_IMPORT.test(read(f))).sort();
    expect(found).toEqual([...FS_ALLOWED].sort());
  });

  it('the flag file name appears in no production file but the config reader and its schema notes', () => {
    const named = prodFiles.filter((f) => /ums-maintenance/.test(read(f))).sort();
    expect(named.every((f) => f.startsWith('packages/config/src/'))).toBe(true);
  });

  it('the config field and the env name appear only where they are read, never to write', () => {
    const field = prodFiles
      .filter((f) => /maintenance_flag|UMS_MAINTENANCE_FLAG/.test(read(f)))
      .sort();
    expect(field).toEqual([
      'apps/web/composition.server.ts',
      'packages/config/src/load.ts',
      'packages/config/src/maintenance.ts',
      'packages/config/src/schema.ts',
    ]);
  });

  it('composition hands the path to the reader and does nothing else with it', () => {
    const text = read('apps/web/composition.server.ts');
    const uses = [...text.matchAll(/.*maintenance_flag.*/g)].map((m) => m[0].trim());
    expect(uses).toHaveLength(1);
    expect(uses[0]).toMatch(/readMaintenanceFlag\(config\.maintenance_flag\)/);
  });

  it('no other script names the flag; only the two host tools and the checker do', () => {
    const scripts = walk(join(REPO_ROOT, 'scripts'))
      .map(rel)
      .filter((f) => !TEST_FILE.test(`/${f}`) && !f.includes('__fixtures__'));
    const named = scripts.filter((f) => /ums-maintenance/.test(read(f))).sort();
    expect(named).toEqual([
      'scripts/backup.mjs',
      'scripts/check-hosting.mjs',
      'scripts/restore.mjs',
    ]);
  });
});

describe('the reader only looks', () => {
  const text = read('packages/config/src/maintenance.ts');

  it('imports lstatSync from node:fs and nothing else from it', () => {
    const imports = [...text.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"]node:fs['"]/g)];
    expect(imports).toHaveLength(1);
    const names = (imports[0]?.[1] ?? '')
      .split(',')
      .map((n) => n.trim().replace(/^type\s+/, ''))
      .filter(Boolean)
      .sort();
    expect(names).toEqual(['Stats', 'lstatSync']);
    expect(text).not.toMatch(/import\s+\*|import\s+\w+\s+from\s*['"]node:fs|require\(/);
  });

  it('names no write, delete, rename, link, open or process-spawning call', () => {
    const code = text.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(code).not.toMatch(WRITE_API);
  });
});

describe('the host tools only look at the flag', () => {
  const WRITES =
    /\b(?:writeFileSync|rmSync|unlinkSync|renameSync|mkdirSync|symlinkSync|copyFileSync|openSync|appendFileSync)\b/;

  it('backup.mjs: the flag check is one lstat and nothing else', () => {
    const text = read('scripts/backup.mjs');
    const start = text.indexOf('export function checkMaintenanceFlag');
    expect(start).toBeGreaterThan(-1);
    const body = text.slice(start, text.indexOf('\nfunction ', start));
    expect(body).toContain('lstatSync(flag)');
    expect(body.replace(/\/\/.*$/gm, '')).not.toMatch(WRITES);
  });

  it('restore.mjs: every line that deals with maintenance mode is free of writes', () => {
    const lines = read('scripts/restore.mjs')
      .split('\n')
      .filter((l) => /maintenance/i.test(l));
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) expect(l.replace(/\/\/.*$/, ''), l).not.toMatch(WRITES);
  });
});
