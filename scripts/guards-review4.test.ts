// Opus review 4 M4, M5, M6, L5: the guard scripts against the bypasses the review listed. Every
// tree is built in a temporary directory from parts, so no forbidden string sits in this file.
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TOKENS, runGuard } from './test-helpers';

const SIM = TOKENS.SIM_REPO!;
const SIM_SPLIT = `'${SIM.slice(0, 9)}' + '${SIM.slice(9)}'`;

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'sbx-guard-'));
  for (const [rel, text] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, text);
  }
  return root;
}

describe('check-isolation (review 4 M4)', () => {
  const bad: [string, Record<string, string>, string][] = [
    [
      'createRequire result called with a folded path',
      {
        'packages/db/src/a.ts': `import { createRequire } from 'node:module';\nconst r = createRequire(import.meta.url);\nexport const x = r('../../../' + ${SIM_SPLIT} + '/x');\n`,
      },
      'packages/db/src/a.ts',
    ],
    [
      'require.resolve',
      { 'packages/db/src/a.ts': `export const p = require.resolve('../../../${SIM}/x');\n` },
      'packages/db/src/a.ts',
    ],
    [
      'new Worker(new URL(...))',
      {
        'packages/db/src/a.ts': `import { Worker } from 'node:worker_threads';\nexport const w = new Worker(new URL('../../../${SIM}/w.js', import.meta.url));\n`,
      },
      'packages/db/src/a.ts',
    ],
    [
      '.jsx import',
      { 'packages/db/src/a.jsx': `import x from '../../../${SIM}/a';\nexport const y = x;\n` },
      'packages/db/src/a.jsx',
    ],
    [
      '.mdx import',
      { 'apps/web/src/a.mdx': `import X from '../../../../${SIM}/a'\n\n# hello\n` },
      'apps/web/src/a.mdx',
    ],
    [
      'triple-slash reference path',
      {
        'packages/db/src/a.ts': `/// <reference path="../../../${SIM}/types.d.ts" />\nexport const a = 1;\n`,
      },
      'packages/db/src/a.ts',
    ],
    [
      'triple-slash reference types of a forbidden scope',
      {
        'packages/db/src/a.ts': `/// <reference types="${TOKENS.SIM_SCOPE}/paypal" />\nexport const a = 1;\n`,
      },
      'packages/db/src/a.ts',
    ],
    [
      "import('file:///elsewhere')",
      { 'packages/db/src/a.ts': "export const m = () => import('file:///elsewhere/x.js');\n" },
      'packages/db/src/a.ts',
    ],
    [
      'import of an https URL',
      { 'packages/db/src/a.ts': "export const m = () => import('https://example.org/x.js');\n" },
      'packages/db/src/a.ts',
    ],
    [
      'package.json npm: alias to the product scope',
      {
        'packages/db/package.json':
          '{ "name": "x", "dependencies": { "core": "npm:@unitmarket/core@0" } }\n',
      },
      'packages/db/package.json',
    ],
    [
      'package.json git dependency',
      {
        'packages/db/package.json':
          '{ "name": "x", "dependencies": { "a": "git+https://example.org/a.git" } }\n',
      },
      'packages/db/package.json',
    ],
    [
      'package.json tarball dependency',
      {
        'packages/db/package.json':
          '{ "name": "x", "devDependencies": { "a": "https://example.org/a.tgz" } }\n',
      },
      'packages/db/package.json',
    ],
    [
      'package.json github shorthand',
      {
        'packages/db/package.json':
          '{ "name": "x", "dependencies": { "a": "github:owner/repo" } }\n',
      },
      'packages/db/package.json',
    ],
    [
      'package.json override to a tarball',
      {
        'package.json':
          '{ "name": "x", "pnpm": { "overrides": { "zod": "https://example.org/z.tgz" } } }\n',
      },
      'package.json',
    ],
    [
      'vitest alias built with join from split strings',
      {
        'vitest.config.ts': `import { join } from 'node:path';\nexport default { resolve: { alias: { x: join('..', '..', ${SIM_SPLIT}) } } };\n`,
      },
      'vitest.config.ts',
    ],
    [
      'specifier built from two constants',
      {
        'packages/db/src/a.ts': `const a = '../../../${SIM.slice(0, 9)}';\nconst b = '${SIM.slice(9)}/x';\nexport const m = () => import(a + b);\n`,
      },
      'packages/db/src/a.ts',
    ],
  ];
  it.each(bad)('fails on %s', (_n, files, file) => {
    const r = runGuard('check-isolation.mjs', tree(files));
    expect(r.status, r.out).toBe(1);
    expect(r.out).toContain(file);
  });

  it('fails on a symlinked directory inside the repository', () => {
    const outside = tree({ 'x.ts': 'export const a = 1;\n' });
    const root = tree({ 'packages/db/src/a.ts': 'export const a = 1;\n' });
    symlinkSync(outside, join(root, 'packages', 'linked'));
    const r = runGuard('check-isolation.mjs', root);
    expect(r.status, r.out).toBe(1);
    expect(r.out).toContain('packages/linked');
    expect(r.out).toMatch(/symlink/i);
  });

  it('fails on a symlinked file inside the repository', () => {
    const outside = tree({ 'x.ts': 'export const a = 1;\n' });
    const root = tree({ 'packages/db/src/a.ts': 'export const a = 1;\n' });
    symlinkSync(join(outside, 'x.ts'), join(root, 'packages', 'db', 'src', 'b.ts'));
    const r = runGuard('check-isolation.mjs', root);
    expect(r.status, r.out).toBe(1);
  });

  it('passes on ordinary path arithmetic and registry dependencies', () => {
    const r = runGuard(
      'check-isolation.mjs',
      tree({
        'packages/db/src/a.ts': `import { join, dirname } from 'node:path';\nexport const p = join(dirname('x/y'), '..', 'z');\nexport const q = () => import('@umsbx/contracts');\n`,
        'packages/db/package.json':
          '{ "name": "x", "dependencies": { "zod": "4.6.7", "@umsbx/contracts": "workspace:*", "a": "npm:zod@4.6.7" } }\n',
        'apps/web/src/a.jsx': "import x from './b';\nexport const y = x;\n",
      }),
    );
    expect(r.status, r.out).toBe(0);
  });
});
