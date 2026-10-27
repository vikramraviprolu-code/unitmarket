// PG-2 (PG-1 LOW): the throwaway-Postgres helper is for tests. No production file may import it, in
// packages/db or anywhere else; only the three test-support files next to it and test files may.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SUPPORT = new Set([
  'packages/db/src/pg-testing.ts',
  'packages/db/src/pg-global-setup.ts',
  'packages/db/src/pg-test-setup.ts',
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.next' || name === 'dist') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|mts|mjs|js)$/.test(name)) out.push(p);
  }
  return out;
}

describe('pg-testing is test-only', () => {
  it('no production file imports or names the throwaway-Postgres helper', () => {
    const offenders: string[] = [];
    for (const top of ['apps', 'domain', 'packages', 'tools', 'scripts']) {
      for (const file of walk(join(ROOT, top))) {
        const rel = relative(ROOT, file).split('\\').join('/');
        const testFile = /\.test\.(ts|tsx)$/.test(rel) || rel.includes('/__fixtures__/');
        if (testFile || SUPPORT.has(rel)) continue;
        if (readFileSync(file, 'utf8').includes('pg-testing')) offenders.push(rel);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the Postgres driver itself does not import it', () => {
    const src = readFileSync(join(ROOT, 'packages/db/src/pg.ts'), 'utf8');
    expect(src).not.toMatch(/from\s+['"]\.\/pg-testing['"]/);
  });
});
