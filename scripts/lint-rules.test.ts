// Proves the ESLint layering rules (architecture 2.2 and 2.3) with real lint runs on virtual files.
import { ESLint } from 'eslint';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { REPO_ROOT, TOKENS } from './test-helpers';

let eslint: ESLint;
beforeAll(() => {
  eslint = new ESLint({ cwd: REPO_ROOT });
});

async function lint(file: string, code: string) {
  const [r] = await eslint.lintText(code, { filePath: join(REPO_ROOT, file) });
  return (r?.messages ?? []).filter((m) => m.severity === 2);
}
const ids = (m: { ruleId: string | null }[]) => m.map((x) => x.ruleId);

const SIM_REPO = TOKENS.SIM_REPO;
const SIM_SCOPE = TOKENS.SIM_SCOPE;
const PUB = TOKENS.PUB;

describe('isolation from the simulation (2.2)', () => {
  it("fails a file importing '../../AIC_Hackathon_UnitMarket/anything'", async () => {
    const m = await lint(
      'packages/db/src/x.ts',
      `import { a } from '../../${SIM_REPO}/anything';\nexport const b = a;\n`,
    );
    expect(m.length).toBeGreaterThan(0);
    expect(m.some((x) => /Isolation/.test(x.message))).toBe(true);
  });

  it('fails a deep relative path out of the repository', async () => {
    const m = await lint(
      'packages/db/src/x.ts',
      `import { a } from '../../../../${SIM_REPO}/anything';\nexport const b = a;\n`,
    );
    expect(ids(m)).toContain('sbx/no-package-escape');
    expect(ids(m)).toContain('no-restricted-imports');
  });

  it.each([
    [`${SIM_SCOPE}/paypal`],
    ['@unitmarket/contracts'],
    ['../../simulation/paypal/src/index'],
    ['simulation/harness'],
  ])('fails import of %s', async (spec) => {
    const m = await lint(
      'domain/payments/src/x.ts',
      `import { a } from '${spec}';\nexport const b = a;\n`,
    );
    expect(m.length).toBeGreaterThan(0);
  });

  it('allows @umsbx/contracts', async () => {
    const m = await lint(
      'domain/payments/src/x.ts',
      `import { a } from '@umsbx/contracts';\nexport const b = a;\n`,
    );
    expect(m).toEqual([]);
  });
});

describe('layering (2.3 S1, S2, S4)', () => {
  it('S1: domain may import a sibling domain root, not its internals nor infrastructure', async () => {
    expect(
      await lint(
        'domain/payments/src/x.ts',
        `import { a } from '@umsbx/ledger';\nexport const b = a;\n`,
      ),
    ).toEqual([]);
    for (const spec of [
      '@umsbx/ledger/internal',
      '@umsbx/paypal',
      '@umsbx/db',
      '@umsbx/config',
      'zod',
      'node:fs',
    ]) {
      const m = await lint(
        'domain/payments/src/x.ts',
        `import { a } from '${spec}';\nexport const b = a;\n`,
      );
      expect(m.length, spec).toBeGreaterThan(0);
    }
  });

  it('S1: a relative import into another package is barred', async () => {
    const m = await lint(
      'domain/payments/src/x.ts',
      `import { a } from '../../ledger/src/index';\nexport const b = a;\n`,
    );
    expect(ids(m)).toContain('sbx/no-package-escape');
  });

  it('S4: discovery and fit never import payments', async () => {
    for (const file of [
      'domain/discovery/src/x.ts',
      'domain/fit/src/x.ts',
      'packages/model/src/x.ts',
    ]) {
      const m = await lint(file, `import { a } from '@umsbx/payments';\nexport const b = a;\n`);
      expect(m.length, file).toBeGreaterThan(0);
    }
  });

  it('S2: network clients only in packages/transport', async () => {
    const code = `import https from 'node:https';\nexport const b = https;\n`;
    expect((await lint('packages/db/src/x.ts', code)).length).toBeGreaterThan(0);
    expect((await lint('domain/ledger/src/x.ts', code)).length).toBeGreaterThan(0);
    expect(await lint('packages/transport/src/x.ts', code)).toEqual([]);
  });

  it('S2: the fetch global only in packages/transport', async () => {
    const code = `export const go = () => fetch('x');\n`;
    expect((await lint('packages/paypal/src/x.ts', code)).length).toBeGreaterThan(0);
    expect(await lint('packages/transport/src/x.ts', code)).toEqual([]);
  });

  it('S2: paypal is imported only by packages/jobs and composition', async () => {
    const code = `import { a } from '@umsbx/paypal';\nexport const b = a;\n`;
    expect((await lint('domain/payments/src/x.ts', code)).length).toBeGreaterThan(0);
    expect((await lint('packages/db/src/x.ts', code)).length).toBeGreaterThan(0);
    expect(await lint('packages/jobs/src/x.ts', code)).toEqual([]);
    expect(await lint('apps/web/composition.server.ts', code)).toEqual([]);
    expect((await lint('apps/web/app/page.tsx', code)).length).toBeGreaterThan(0);
  });

  it('Z1: web routes do not import the database driver', async () => {
    const code = `import { a } from '@umsbx/db';\nexport const b = a;\n`;
    expect((await lint('apps/web/app/api/x/route.ts', code)).length).toBeGreaterThan(0);
  });
});

describe('runtime rules (2.3 S3, S6, no NEXT_PUBLIC secrets)', () => {
  const bad: [string, string][] = [
    ['Date.now()', 'export const t = Date.now();'],
    ['new Date()', 'export const t = new Date();'],
    ['Math.random()', 'export const t = Math.random();'],
    ['performance.now()', 'export const t = performance.now();'],
    ['crypto.randomUUID()', 'export const t = crypto.randomUUID();'],
    [
      'randomUUID import',
      "import { randomUUID } from 'node:crypto';\nexport const t = randomUUID;",
    ],
  ];
  it.each(bad)('S6: %s fails outside packages/runtime', async (_n, code) => {
    expect((await lint('domain/ledger/src/x.ts', `${code}\n`)).length).toBeGreaterThan(0);
    expect((await lint('packages/db/src/x.ts', `${code}\n`)).length).toBeGreaterThan(0);
  });
  it.each(bad)('S6: %s passes inside packages/runtime', async (_n, code) => {
    expect(await lint('packages/runtime/src/x.ts', `${code}\n`)).toEqual([]);
  });
  it('S6: new Date(arg) is allowed', async () => {
    expect(await lint('domain/ledger/src/x.ts', 'export const t = new Date(0);\n')).toEqual([]);
  });

  it('S3: process.env only in packages/config', async () => {
    const code = 'export const v = process.env.UMS_MODE;\n';
    expect((await lint('domain/ledger/src/x.ts', code)).length).toBeGreaterThan(0);
    expect((await lint('packages/paypal/src/x.ts', code)).length).toBeGreaterThan(0);
    expect(await lint('packages/config/src/x.ts', code)).toEqual([]);
  });

  it('no NEXT_PUBLIC_ secrets; only the env label is public', async () => {
    const secret = `export const k = '${PUB}_PAYPAL_CLIENT_SECRET';\n`;
    expect((await lint('apps/web/app/page.tsx', secret)).length).toBeGreaterThan(0);
    const label = `export const k = '${PUB}_UMS_ENV_LABEL';\n`;
    expect(await lint('apps/web/app/page.tsx', label)).toEqual([]);
  });
});

// Review H2: dynamic import() and global lookups used to bypass the import and global rules.
describe('bypass attempts (review H2)', () => {
  const inModel = 'packages/model/src/x.ts';
  const inDomain = 'domain/payments/src/x.ts';
  const cases: [string, string, string][] = [
    [
      'import() of a barred workspace package',
      inModel,
      "export const m = () => import('@umsbx/paypal');",
    ],
    [
      'import() of a package the model may not use',
      inModel,
      "export const m = () => import('@umsbx/payments');",
    ],
    ['import() of a network module', inModel, "export const m = () => import('node:https');"],
    [
      'new globalThis.WebSocket',
      inModel,
      "export const m = new globalThis.WebSocket('wss://x.test');",
    ],
    ['self.fetch', inModel, "export const m = () => self.fetch('x');"],
    ['window.XMLHttpRequest', inModel, 'export const m = new window.XMLHttpRequest();'],
    [
      'import() of a simulation package',
      inDomain,
      `export const m = () => import('${SIM_SCOPE}/harness');`,
    ],
    [
      'import() of a template literal',
      inDomain,
      'export const m = () => import(`@unitmarket/core`);',
    ],
    [
      'import() of a concatenated specifier',
      inDomain,
      "export const m = () => import('node:' + 'https');",
    ],
    ['import() of a variable', inDomain, 'export const m = (n: string) => import(n);'],
    ['computed globalThis lookup', inDomain, "export const m = globalThis['fe' + 'tch'];"],
    ['destructured fetch', inDomain, 'export const { fetch: f } = globalThis;'],
    ['Reflect.construct(Date)', inDomain, 'export const m = Reflect.construct(Date, []);'],
    ['new Date(undefined)', inDomain, 'export const m = new Date(undefined);'],
    ['new globalThis.Date()', inDomain, 'export const m = new globalThis.Date();'],
    ['globalThis.Date.now()', inDomain, 'export const m = globalThis.Date.now();'],
  ];
  it.each(cases)('fails: %s', async (_name, file, code) => {
    const m = await lint(file, `${code}\n`);
    expect(m.length).toBeGreaterThan(0);
  });

  it('allows a literal import() of an allowed package and new Date(arg)', async () => {
    expect(
      await lint(
        inDomain,
        "export const m = () => import('@umsbx/contracts');\nexport const d = new Date(0);\n",
      ),
    ).toEqual([]);
  });

  it('the transport package may still use the network globals', async () => {
    expect(
      await lint(
        'packages/transport/src/x.ts',
        "export const m = () => globalThis.fetch('x');\nexport const n = () => import('node:https');\n",
      ),
    ).toEqual([]);
  });

  it('runtime may read real time through the globals', async () => {
    expect(
      await lint('packages/runtime/src/x.ts', 'export const m = new globalThis.Date();\n'),
    ).toEqual([]);
  });
});
