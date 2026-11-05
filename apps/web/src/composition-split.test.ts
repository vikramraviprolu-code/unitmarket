// INT-UI0 / UI0.7: each tab has its own composition module under src/composition/, so Wave 2 lanes do not
// collide. A page under a tab imports only its tab's module; no module imports another; and
// composition.server.ts gains nothing but `export ... from './src/composition/...'` lines.
// Source read, as the other split tests do (no .tsx compile in the unit runner).
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const here = fileURLToPath(new URL('.', import.meta.url));
const root = join(here, '..');
const read = (abs: string) => readFileSync(abs, 'utf8');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const importsOf = (src: string): string[] =>
  [...strip(src).matchAll(/(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+'([^']+)'/g)].map(
    (m) => m[1]!,
  );

const MODULES = [
  'ops-home',
  'ops-money',
  'ops-buyers',
  'ops-sellers',
  'ops-agents',
  'ops-controls',
  'buyer',
  'seller',
  // BR-6: the reads of the Business rules pages.
  'ops-rules',
] as const;

/** Page file (under src/app) to the one module it may import. Pages another lane builds are listed too. */
const PAGES: Record<string, (typeof MODULES)[number]> = {
  'ops/page.tsx': 'ops-home',
  'ops/money/page.tsx': 'ops-money',
  'ops/sellers/page.tsx': 'ops-sellers',
  'ops/agents/page.tsx': 'ops-agents',
  // INT-OPS-C: the detail pages of the Buyers, Sellers and Money tabs.
  'ops/buyers/[id]/page.tsx': 'ops-buyers',
  'ops/sellers/[id]/page.tsx': 'ops-sellers',
  'ops/money/ledger/page.tsx': 'ops-money',
  'ops/controls/page.tsx': 'ops-controls',
};

describe('the nine modules exist', () => {
  it.each(MODULES)('src/composition/%s.ts', (m) => {
    expect(existsSync(join(here, 'composition', `${m}.ts`))).toBe(true);
  });
  it('and there is no other file in the folder', () => {
    const files = readdirSync(join(here, 'composition')).sort();
    expect(files).toEqual(MODULES.map((m) => `${m}.ts`).sort());
  });
  // INT-OPS-A built the Buyers reads and INT-CTL (CTL.7) gives ops-agents its first read, the API exposure rows,
  // so no module is empty any more: each one exports at least one read.
  it('no module is empty: each exports at least one read', () => {
    for (const m of MODULES) {
      const src = strip(read(join(here, 'composition', `${m}.ts`)));
      expect(src.replace(/\s+/g, ' ').trim(), m).not.toBe('export {};');
      expect(src, m).toMatch(/export (async )?(function|const)/);
    }
  });
});

describe('a page imports only its own tab module', () => {
  const existing = Object.entries(PAGES).filter(([f]) => existsSync(join(here, 'app', f)));
  it('covers the pages UI0 and OPS-C built', () => {
    expect(existing.map(([f]) => f).sort()).toEqual(
      [
        'ops/agents/page.tsx',
        'ops/buyers/[id]/page.tsx',
        'ops/controls/page.tsx',
        'ops/money/ledger/page.tsx',
        'ops/money/page.tsx',
        'ops/page.tsx',
        'ops/sellers/[id]/page.tsx',
        'ops/sellers/page.tsx',
      ].sort(),
    );
  });
  it.each(existing)('%s', (file, mod) => {
    const specs = importsOf(read(join(here, 'app', file)));
    const comp = specs.filter((s) => /composition/.test(s));
    expect(comp.length, `${file} must import its module`).toBeGreaterThanOrEqual(1);
    for (const s of comp) {
      expect(s, `${file} imports ${s}`).toMatch(new RegExp(`/composition/${mod}$`));
      expect(s).not.toMatch(/composition\.server/);
    }
    for (const other of MODULES.filter((m) => m !== mod))
      expect(
        specs.some((s) => s.endsWith(`/composition/${other}`)),
        `${file} imports ${other}`,
      ).toBe(false);
  });
  it('a page under a tab does not reach the engine by another door', () => {
    for (const [file] of existing) {
      const specs = importsOf(read(join(here, 'app', file)));
      expect(
        specs.filter((s) => /server\/access|composition\.server/.test(s)),
        file,
      ).toEqual([]);
    }
  });
});

describe('a module reads through the one door and nothing else', () => {
  // INT-TR1 gave buyer and seller their first read (the timeline), through the same door.
  it.each([
    'ops-home',
    'ops-money',
    'ops-sellers',
    'ops-agents',
    'ops-controls',
    'buyer',
    'seller',
  ])('%s', (m) => {
    const specs = importsOf(read(join(here, 'composition', `${m}.ts`)));
    expect(specs).toContain('../server/access');
    for (const s of specs) {
      expect(s).not.toMatch(/composition\.server/);
      expect(s, `${m} must not import another module`).not.toMatch(/(^|\/)composition\//);
      expect(s).not.toMatch(/^\.\/(ops|buyer|seller)/);
    }
  });
  it('the reads are the ones the page made before: the snapshot, the refund keys and the engine convert', () => {
    const money = strip(read(join(here, 'composition', 'ops-money.ts')));
    expect(money).toContain('opsSnapshot(');
    expect(money).toContain('newKey()');
    expect(money).toContain('engine.fx.convert');
    expect(money).toContain('getRates()');
    expect(strip(read(join(here, 'composition', 'ops-home.ts')))).toContain('opsSnapshot(');
  });
});

describe('composition.server.ts', () => {
  const lines = read(join(root, 'composition.server.ts')).split('\n');
  const touching = lines.filter((l) => l.includes('src/composition/'));
  it('mentions the folder only in export-from lines', () => {
    for (const l of touching)
      expect(l).toMatch(/^export (type )?\{[^}]*\} from '\.\/src\/composition\/[a-z-]+';$/);
  });
  it('does not import from a module, so there is no cycle', () => {
    for (const l of touching) expect(l).not.toMatch(/^import /);
  });
});

describe('the folder holds only .ts files', () => {
  it('no .tsx, no css', () => {
    for (const n of readdirSync(join(here, 'composition')))
      expect(statSync(join(here, 'composition', n)).isFile() && n.endsWith('.ts')).toBe(true);
  });
});
