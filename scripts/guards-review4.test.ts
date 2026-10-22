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
    expect(r.out).toMatch(/symbolic link/i);
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

describe('check-no-live-host (review 4 M5)', () => {
  const PAY = ['pay', 'pal'].join('');
  const COM = 'com';
  const host = (sub: string) => `${sub}.${PAY}.${COM}`;
  const b64 = (t: string) => Buffer.from(t).toString('base64');
  const bad: [string, string, string][] = [
    ['literal soft hyphen', 'src/a.ts', `export const u = 'https://api-m.pay­pal.${COM}';\n`],
    [
      'literal zero-width space',
      'src/a.ts',
      `export const u = 'https://api-m.pay\u200Bpal.${COM}';\n`,
    ],
    ['literal U+034F', 'src/a.ts', `export const u = 'https://api-m.pay͏pal.${COM}';\n`],
    [
      'concatenated strings',
      'src/a.ts',
      `export const u = 'https://api-m.' + '${PAY}' + '.${COM}';\n`,
    ],
    [
      'concatenation inside one argument split in the middle of the name',
      'src/a.ts',
      `export const u = 'api-m.pay' + 'pal.${COM}';\n`,
    ],
    [
      'template pieces',
      'src/a.ts',
      "export const u = `https://${'api-m'}.${'pay' + 'pal'}.${'com'}`;\n",
    ],
    ['array join', 'src/a.ts', `export const u = ['api-m', '${PAY}', '${COM}'].join('.');\n`],
    [
      'constants joined',
      'src/a.ts',
      `const a = 'api-m.';\nconst b = '${PAY}.${COM}';\nexport const u = a + b;\n`,
    ],
    ['bare host object', 'src/a.ts', `export const c = { host: '${PAY}.${COM}' };\n`],
    ['notify host', 'src/a.ts', `export const u = '${host('notify')}';\n`],
    [
      'paypalobjects host',
      'src/a.ts',
      `export const u = 'https://www.${PAY}objects.${COM}/x.js';\n`,
    ],
    ['upper case', 'src/a.ts', `export const u = '${host('API-M').toUpperCase()}';\n`],
    [
      'base64 token',
      'src/a.ts',
      `export const u = Buffer.from('${b64(host('api-m'))}', 'base64').toString();\n`,
    ],
    [
      'backslash line continuation',
      'src/a.ts',
      `export const u = 'https://api-m.pay\\\npal.${COM}';\n`,
    ],
    [
      'SANDBOX_API.replace',
      'src/other.ts',
      "import { SANDBOX_API } from '@umsbx/transport';\nexport const u = SANDBOX_API.replace('.sandbox', '');\n",
    ],
    [
      'lower-case alias and slice',
      'src/other.ts',
      "import { SANDBOX_API as sandbox_api } from '@umsbx/transport';\nexport const u = sandbox_api.slice(0, 5);\n",
    ],
    [
      'SANDBOX_API.split',
      'src/other.ts',
      "import { SANDBOX_API } from '@umsbx/transport';\nexport const u = SANDBOX_API.split('.');\n",
    ],
    ['mjs file', 'scripts/a.mjs', `export const u = ['api-m', '${PAY}', '${COM}'].join('.');\n`],
    ['markdown outside docs/design', 'docs/notes.md', `see ${host('api-m')}\n`],
    ['yaml', 'ci/a.yml', `url: https://${host('api-m')}/v1\n`],
  ];
  it.each(bad)('fails on %s', (_n, rel, text) => {
    const r = runGuard('check-no-live-host.mjs', tree({ [rel]: text }));
    expect(r.status, r.out).toBe(1);
    expect(r.out).toContain(rel);
  });

  it('passes on sandbox pages that are not API hosts, and on the one constant module', () => {
    const r = runGuard(
      'check-no-live-host.mjs',
      tree({
        'src/a.ts': `export const approve = 'https://www.sandbox.${PAY}.${COM}/checkoutnow?token=T';\n`,
        'packages/transport/src/endpoints.ts': `export const SANDBOX_API = 'https://api-m.sandbox.${PAY}.${COM}' as const;\nexport const CERT_HOST_SUFFIX = '.sandbox.${PAY}.${COM}' as const;\n`,
        'src/b.ts':
          "import { SANDBOX_API } from '@umsbx/transport';\nexport const u = new URL('/v1/x', SANDBOX_API);\n",
      }),
    );
    expect(r.status, r.out).toBe(0);
  });
});

describe('check-fixtures scope (review 4 L5)', () => {
  const GOOD_META = { meta: { source: 'synthetic' } };
  const leak = JSON.stringify({
    ...GOOD_META,
    headers: { authorization: 'Bearer abcdef123456789' },
  });
  const withIndex = (files: Record<string, string>) => {
    const root = tree(files);
    runGuard('check-fixtures.mjs', root); // no-op on the first pass; index written below
    return root;
  };
  it('an index.json that is not the generated index is scanned', () => {
    const root = tree({
      'fixtures/synthetic/index.json': leak,
      'fixtures/synthetic/ok.json': JSON.stringify(GOOD_META),
    });
    const r = runGuard('check-fixtures.mjs', root);
    expect(r.status, r.out).toBe(1);
    expect(r.out).toContain('synthetic/index.json');
  });
  it('files under domain/*/test-data are scanned', () => {
    const r = runGuard('check-fixtures.mjs', tree({ 'domain/fit/test-data/a.json': leak }));
    expect(r.status, r.out).toBe(1);
    expect(r.out).toContain('domain/fit/test-data/a.json');
  });
  it('files under scripts/__fixtures__ without the .fixture suffix are scanned', () => {
    const r = runGuard('check-fixtures.mjs', tree({ 'scripts/__fixtures__/x/a.json': leak }));
    expect(r.status, r.out).toBe(1);
    expect(r.out).toContain('scripts/__fixtures__/x/a.json');
  });
  it('inert .fixture files are not scanned, and clean data passes', () => {
    const r = runGuard(
      'check-fixtures.mjs',
      tree({
        'scripts/__fixtures__/x/a.json.fixture': leak,
        'domain/fit/test-data/b.json': JSON.stringify({ ...GOOD_META, n: 1 }),
      }),
    );
    expect(r.status, r.out).toBe(0);
    expect(withIndex).toBeTypeOf('function');
  });
});
