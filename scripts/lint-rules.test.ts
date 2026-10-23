// Proves the ESLint layering rules (architecture 2.2 and 2.3) with real lint runs on virtual files.
import { ESLint } from 'eslint';
import { dirname, join, relative } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { REPO_ROOT, TOKENS } from './test-helpers';

// Built at run time: the transport package test bars any file outside the transport package from
// naming the production Wire module, and this file lists its lint exemptions.
const WIRE = ['wire', 'fetch'].join('-');

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

// Wave 2 exemptions (coordinator request) and the lane 02 follow-up.
describe('narrow test and crypto exemptions', () => {
  const hash = "import { createHash } from 'node:crypto';\nexport const h = createHash;\n";
  it('approval canonical.ts and token.ts may import node:crypto, but not its random functions', async () => {
    for (const f of ['canonical.ts', 'token.ts']) {
      expect(await lint(`domain/approval/src/${f}`, hash), f).toEqual([]);
      for (const name of [
        'randomBytes',
        'randomUUID',
        'randomInt',
        'getRandomValues',
        'randomFillSync',
        'randomFill',
      ]) {
        const m = await lint(
          `domain/approval/src/${f}`,
          `import { ${name} } from 'node:crypto';\nexport const r = ${name};\n`,
        );
        expect(m.length, `${f} ${name}`).toBeGreaterThan(0);
      }
      const ns = await lint(
        `domain/approval/src/${f}`,
        "import crypto from 'node:crypto';\nexport const r = crypto.randomBytes(4);\n",
      );
      expect(ns.length, `${f} namespace`).toBeGreaterThan(0);
      const fs = await lint(
        `domain/approval/src/${f}`,
        "import { readFileSync } from 'node:fs';\nexport const r = readFileSync;\n",
      );
      expect(fs.length, `${f} fs`).toBeGreaterThan(0);
    }
  });
  it('other domain production files still cannot import node:crypto', async () => {
    expect((await lint('domain/approval/src/other.ts', hash)).length).toBeGreaterThan(0);
    expect((await lint('domain/ledger/src/canonical.ts', hash)).length).toBeGreaterThan(0);
  });

  const dbImport =
    "import { openDatabase } from '@umsbx/db';\nimport { fakeClock } from '@umsbx/runtime';\nexport const x = [openDatabase, fakeClock];\n";
  it('domain tests and test helpers may import @umsbx/db and @umsbx/runtime', async () => {
    for (const f of [
      'domain/ledger/src/a.test.ts',
      'domain/ledger/src/a.state.test.ts',
      'domain/ledger/src/test-fixtures.ts',
      'domain/ledger/src/world.ts',
      'domain/ledger/src/support.ts',
      'domain/discovery/src/support.ts',
    ])
      expect(await lint(f, dbImport), f).toEqual([]);
  });
  it('only domain tests and helpers may import @umsbx/db/testing', async () => {
    const t =
      "import { resetDatabase } from '@umsbx/db/testing';\nexport const x = resetDatabase;\n";
    for (const f of ['domain/ledger/src/a.state.test.ts', 'domain/ledger/src/world.ts'])
      expect(await lint(f, t), f).toEqual([]);
    for (const f of [
      'domain/ledger/src/service.ts',
      'packages/paypal/src/x.ts',
      'apps/web/src/x.ts',
    ])
      expect((await lint(f, t)).length, f).toBeGreaterThan(0);
  });
  it('domain production files still cannot import @umsbx/db or @umsbx/runtime', async () => {
    expect((await lint('domain/ledger/src/service.ts', dbImport)).length).toBeGreaterThan(0);
  });
  it('tests and helpers stay barred from providers, and discovery from payments', async () => {
    for (const f of ['domain/ledger/src/a.test.ts', 'domain/ledger/src/world.ts']) {
      for (const spec of ['@umsbx/paypal', '@umsbx/transport', '@umsbx/safety'])
        expect(
          (await lint(f, `import { a } from '${spec}';\nexport const b = a;\n`)).length,
          `${f} ${spec}`,
        ).toBeGreaterThan(0);
    }
    expect(
      (
        await lint(
          'domain/discovery/src/support.ts',
          "import { a } from '@umsbx/payments';\nexport const b = a;\n",
        )
      ).length,
    ).toBeGreaterThan(0);
  });
  it('node:fs and node:crypto are for *.test.ts only, and random functions stay banned', async () => {
    const fs = "import { readFileSync } from 'node:fs';\nexport const r = readFileSync;\n";
    expect(await lint('domain/ledger/src/a.test.ts', fs)).toEqual([]);
    expect(await lint('domain/ledger/src/a.test.ts', hash)).toEqual([]);
    expect((await lint('domain/ledger/src/world.ts', fs)).length).toBeGreaterThan(0);
    expect((await lint('domain/ledger/src/support.ts', hash)).length).toBeGreaterThan(0);
    expect(
      (
        await lint(
          'domain/ledger/src/a.test.ts',
          "import { randomBytes } from 'node:crypto';\nexport const r = randomBytes;\n",
        )
      ).length,
    ).toBeGreaterThan(0);
  });
  it('lane 02 follow-up: safety and security tests may import db, obs and runtime; production may not', async () => {
    const code =
      "import { openDatabase } from '@umsbx/db';\nimport { createLogger } from '@umsbx/obs';\nimport { fakeClock } from '@umsbx/runtime';\nexport const x = [openDatabase, createLogger, fakeClock];\n";
    expect(await lint('packages/safety/src/a.state.test.ts', code)).toEqual([]);
    expect(await lint('packages/security/src/a.test.ts', code)).toEqual([]);
    expect((await lint('packages/safety/src/a.ts', code)).length).toBeGreaterThan(0);
    expect(
      (
        await lint(
          'packages/safety/src/a.test.ts',
          "import { a } from '@umsbx/paypal';\nexport const b = a;\n",
        )
      ).length,
    ).toBeGreaterThan(0);
  });
});

describe('@umsbx/model is for domain/discovery only (S4, 14b CR-1)', () => {
  const model =
    "import { createScriptedModel } from '@umsbx/model';\nexport const m = createScriptedModel;\n";
  const fs = "import { readFileSync } from 'node:fs';\nexport const r = readFileSync;\n";
  it('discovery production, tests and helpers may import the model', async () => {
    for (const f of ['discover.ts', 'discover.state.test.ts', 'support.ts'])
      expect(await lint(`domain/discovery/src/${f}`, model), f).toEqual([]);
  });
  it('no other domain package may, in production, tests or helpers', async () => {
    // domain/payments/src/support.ts is a named exemption (D-015) and is checked by its own pin test.
    for (const d of ['fit', 'payments', 'ledger', 'approval', 'catalogue'])
      for (const f of d === 'payments'
        ? ['x.ts', 'x.test.ts']
        : ['x.ts', 'x.test.ts', 'support.ts'])
        expect((await lint(`domain/${d}/src/${f}`, model)).length, `${d}/${f}`).toBeGreaterThan(0);
  });
  it('discovery may still not import payments, and uses node:fs in tests only', async () => {
    expect(
      (
        await lint(
          'domain/discovery/src/discover.ts',
          "import { a } from '@umsbx/payments';\nexport const b = a;\n",
        )
      ).length,
    ).toBeGreaterThan(0);
    expect(await lint('domain/discovery/src/discover.state.test.ts', fs)).toEqual([]);
    expect((await lint('domain/discovery/src/discover.ts', fs)).length).toBeGreaterThan(0);
  });
});

// Opus review 4 H1: spellings that used to slip past the network, clock, randomness and env bans.
describe('bypass attempts (review 4 H1)', () => {
  const fit = 'domain/fit/src/x.ts';
  const obs = 'packages/obs/src/x.ts';
  const cases: [string, string, string][] = [
    [
      'process.getBuiltinModule(https)',
      fit,
      "export const m = process.getBuiltinModule('node:https');",
    ],
    [
      'process.getBuiltinModule(process).env',
      fit,
      "export const m = process.getBuiltinModule('node:process').env;",
    ],
    ['aliasing globalThis', fit, 'const g = globalThis;\nexport const m = g.fetch;'],
    ['Reflect.get(globalThis)', fit, "export const m = Reflect.get(globalThis, 'fetch');"],
    ['(0, globalThis).fetch', fit, 'export const m = (0, globalThis).fetch;'],
    ['globalThis.process.env', fit, 'export const m = globalThis.process.env;'],
    ['aliasing Date', fit, 'const D = Date;\nexport const m = new D();'],
    ['new (Date as any)()', fit, 'export const m = new (Date as any)();'],
    ['Date.prototype.constructor.now', fit, 'export const m = Date.prototype.constructor.now();'],
    ["Date['no'+'w']", fit, "export const m = Date['no' + 'w']();"],
    ['Date() call', fit, 'export const m = Date();'],
    ['process.hrtime.bigint()', fit, 'export const m = process.hrtime.bigint();'],
    ['aliasing process', fit, 'const p = process;\nexport const m = p.env;'],
    ['aliasing Math', fit, 'const M = Math;\nexport const m = M.random();'],
    ['aliasing crypto', fit, 'const c = crypto;\nexport const m = c.randomUUID();'],
    ["require('node:' + 'https')", fit, "export const m = require('node:' + 'https');"],
    ['require(variable)', fit, 'export const m = (n: string) => require(n);'],
    ["module.require('https')", fit, "export const m = module.require('https');"],
    ["require('_http_client')", fit, "export const m = require('_http_client');"],
    ["require('node:child_process')", fit, "export const m = require('node:child_process');"],
    ["new Function('return fetch')()", fit, "export const m = new Function('return fetch')();"],
    ["Function('return fetch')()", fit, "export const m = Function('return fetch')();"],
    ["eval('1')", fit, "export const m = eval('1');"],
    ['.constructor() call', fit, "export const m = (() => 1).constructor('return fetch')();"],
    ['globalThis.crypto.randomUUID()', fit, 'export const m = globalThis.crypto.randomUUID();'],
    [
      'import node:module',
      obs,
      "import { createRequire } from 'node:module';\nexport const m = createRequire;",
    ],
    [
      'createRequire call',
      obs,
      "import { createRequire } from 'node:module';\nexport const m = createRequire(import.meta.url)('node:https');",
    ],
    [
      'node:process default import',
      obs,
      "import proc from 'node:process';\nexport const m = proc.env;",
    ],
    [
      'node:process namespace import',
      obs,
      "import * as proc from 'node:process';\nexport const m = proc.env;",
    ],
    [
      'node:crypto default import',
      obs,
      "import cr from 'node:crypto';\nexport const m = cr.randomUUID();",
    ],
    [
      'node:crypto namespace import',
      obs,
      "import * as cr from 'node:crypto';\nexport const m = cr.randomUUID();",
    ],
    [
      'dynamic import of node:crypto',
      obs,
      "export const m = async () => (await import('node:crypto')).randomUUID();",
    ],
    [
      'node:child_process',
      obs,
      "import { execSync } from 'node:child_process';\nexport const m = () => execSync('true');",
    ],
    [
      'node:worker_threads',
      obs,
      "import { Worker } from 'node:worker_threads';\nexport const m = Worker;",
    ],
    ['node:vm', obs, "import vm from 'node:vm';\nexport const m = vm;"],
    ['_tls_wrap', obs, "import t from '_tls_wrap';\nexport const m = t;"],
    [
      'node:perf_hooks performance',
      obs,
      "import { performance } from 'node:perf_hooks';\nexport const m = performance.now();",
    ],
    [
      'eslint-disable-next-line',
      fit,
      '// eslint-disable-next-line no-restricted-globals\nexport const m = fetch;',
    ],
    ['blanket eslint-disable', fit, '/* eslint-disable */\nexport const m = fetch;'],
    [
      'eslint-disable of an import rule',
      fit,
      "/* eslint-disable no-restricted-imports */\nimport h from 'node:https';\nexport const m = h;",
    ],
  ];
  it.each(cases)('fails: %s', async (_name, file, code) => {
    expect((await lint(file, `${code}\n`)).length).toBeGreaterThan(0);
  });

  it('keeps allowed spellings working', async () => {
    const ok = [
      'export const a = Date.UTC(2020, 0, 1);\nexport const b = (x: unknown) => x instanceof Date;\nexport const c: Date = new Date(0);',
      'export const a = Math.floor(1.5);\nexport const b = process.argv.length + (process.exitCode ?? 0);',
      'export const process = (n: number) => n;\nexport const x = process(1);',
    ];
    for (const code of ok) expect(await lint(fit, `${code}\n`)).toEqual([]);
    expect(
      await lint(
        'domain/approval/src/token.ts',
        "import { createHash } from 'node:crypto';\nexport const h = createHash;\n",
      ),
    ).toEqual([]);
  });

  it('packages/transport keeps its network and module access', async () => {
    expect(
      await lint(
        'packages/transport/src/x.ts',
        "import https from 'node:https';\nimport { createRequire } from 'node:module';\nexport const m = [https, createRequire, globalThis.fetch];\n",
      ),
    ).toEqual([]);
  });

  it('scripts keep node:child_process', async () => {
    expect(
      await lint(
        'scripts/x.mjs',
        "import { spawnSync } from 'node:child_process';\nexport const m = spawnSync;\n",
      ),
    ).toEqual([]);
  });
});

describe('delivery hash-only files (replace the former eslint-disable comments)', () => {
  const hash = "import { createHash } from 'node:crypto';\nexport const h = createHash;\n";
  it('link-token.ts, store-pg.ts and world.ts may hash, nothing else in node:*', async () => {
    for (const f of ['link-token.ts', 'store-pg.ts', 'world.ts'])
      expect(await lint(`domain/delivery/src/${f}`, hash), f).toEqual([]);
    expect((await lint('domain/delivery/src/serve.ts', hash)).length).toBeGreaterThan(0);
    for (const f of ['link-token.ts', 'store-pg.ts', 'world.ts']) {
      expect(
        (
          await lint(
            `domain/delivery/src/${f}`,
            "import { randomBytes } from 'node:crypto';\nexport const r = randomBytes;\n",
          )
        ).length,
        f,
      ).toBeGreaterThan(0);
      expect(
        (
          await lint(
            `domain/delivery/src/${f}`,
            "import { readFileSync } from 'node:fs';\nexport const r = readFileSync;\n",
          )
        ).length,
        f,
      ).toBeGreaterThan(0);
    }
  });
});

// FIX-MVPB-SEAL2 H1/H2: the approved transport factory and the minter claim are reachable only
// from packages/safety (and the pinned test files); a namespace import, a re-export, a dynamic
// import or a require of the transport package is the same reach and is barred with them.
describe('sealed transport imports (SEAL2 H1)', () => {
  const SEALED = 'sbx/sealed-transport';
  const factory = ['create', 'Approved', 'Sandbox', 'Transport'].join('');
  const claim = ['claim', 'Approval', 'Minter'].join('');
  const sealed = async (file: string, code: string) =>
    (await lint(file, code)).filter((m) => m.ruleId === SEALED);
  const outsiders = [
    'packages/paypal/src/evil.ts',
    'packages/jobs/src/evil.ts',
    'packages/db/src/evil.ts',
    'packages/testkit/src/evil.ts',
    'packages/config/src/evil.ts',
    'apps/web/composition.server.ts',
    'apps/web/src/evil.ts',
    'domain/payments/src/evil.ts',
    'domain/payments/src/evil.test.ts',
    'tests/mvp-b/evil.test.ts',
    'tools/spike-kit/src/evil.ts',
    'scripts/evil.mjs',
    'evil.mjs',
  ];

  it('the review evasion: import * as T plus computed property names is refused everywhere outside safety', async () => {
    const evil = [
      "import * as T from '@umsbx/transport';",
      'const lib = T as unknown as Record<string, (i: unknown) => unknown>;',
      "const mint = lib[['mint', 'Approval', 'Capability'].join('')];",
      "export const cap = mint?.({ scope: 'mvp_b_polling', approval_ref: 'X', gate: { check: async () => ({ allowed: true, approval_ref: 'X' }) } });",
      '',
    ].join('\n');
    for (const f of outsiders) expect((await sealed(f, evil)).length, f).toBeGreaterThan(0);
  });

  const spellings: [string, string][] = [
    [
      'named import of the factory',
      `import { ${factory} } from '@umsbx/transport';\nexport const f = ${factory};\n`,
    ],
    [
      'named import of the claim',
      `import { ${claim} } from '@umsbx/transport';\nexport const f = ${claim};\n`,
    ],
    ['renamed import', `import { ${claim} as c } from '@umsbx/transport';\nexport const f = c;\n`],
    [
      'string-named import',
      `import { '${claim}' as c } from '@umsbx/transport';\nexport const f = c;\n`,
    ],
    ['namespace import', "import * as T from '@umsbx/transport';\nexport const f = T;\n"],
    ['default import', "import T from '@umsbx/transport';\nexport const f = T;\n"],
    [
      'default plus named',
      "import T, { guard } from '@umsbx/transport';\nexport const f = [T, guard];\n",
    ],
    ['export star', "export * from '@umsbx/transport';\n"],
    ['export star as', "export * as T from '@umsbx/transport';\n"],
    ['re-export of the factory', `export { ${factory} } from '@umsbx/transport';\n`],
    ['re-export renamed', `export { ${claim} as c } from '@umsbx/transport';\n`],
    ['dynamic import', "export const m = import('@umsbx/transport');\n"],
    ['dynamic import (template)', 'export const m = import(`@umsbx/transport`);\n'],
    [
      'awaited dynamic import',
      `export async function f() {\n  return (await import('@umsbx/transport')).${claim};\n}\n`,
    ],
    ['require', "export const m = require('@umsbx/transport');\n"],
    ['import equals require', "import T = require('@umsbx/transport');\nexport const f = T;\n"],
  ];
  it.each(spellings)('refuses %s', async (_n, code) => {
    for (const f of outsiders) expect((await sealed(f, code)).length, f).toBeGreaterThan(0);
  });

  it.each([
    ['evil.ts', "import * as T from '@umsbx/transport';\nexport const f = T;\n"],
    ['evil.tsx', "import * as T from '@umsbx/transport';\nexport const f = <b>{String(T)}</b>;\n"],
    ['evil.mts', "import * as T from '@umsbx/transport';\nexport const f = T;\n"],
    ['evil.cts', "import T = require('@umsbx/transport');\nexport const f = T;\n"],
    ['evil.js', "import * as T from '@umsbx/transport';\nexport const f = T;\n"],
    ['evil.mjs', "import * as T from '@umsbx/transport';\nexport const f = T;\n"],
    ['evil.cjs', "module.exports = require('@umsbx/transport');\n"],
    ['evil.jsx', "import * as T from '@umsbx/transport';\nexport const f = <b>{String(T)}</b>;\n"],
  ])('lints every source extension, not only .ts: %s', async (name, code) => {
    for (const dir of ['packages/paypal/src', 'apps/web/src', 'scripts', '.']) {
      const file = dir === '.' ? name : `${dir}/${name}`;
      const m = await lint(file, code);
      expect(
        m.map((x) => x.ruleId),
        file,
      ).toContain(SEALED);
    }
  });

  it('allows the ordinary imports the other packages need, type imports included', async () => {
    const ok = [
      "import { guard, PATHS, SANDBOX_API, createSandboxTransport, createDryRunTransport } from '@umsbx/transport';",
      "import type { Wire, SandboxTransport, ApprovalCapability } from '@umsbx/transport';",
      `import type { ${factory} } from '@umsbx/transport';`,
      'export const x = [guard, PATHS, SANDBOX_API, createSandboxTransport, createDryRunTransport];',
      '',
    ].join('\n');
    for (const f of [
      'packages/paypal/src/x.ts',
      'apps/web/composition.server.ts',
      'packages/testkit/src/x.ts',
    ])
      expect(await sealed(f, ok), f).toEqual([]);
  });

  it('only the three pinned safety files may use the claim, the factory and the namespace', async () => {
    const all = `import * as T from '@umsbx/transport';\nimport { ${claim}, ${factory} } from '@umsbx/transport';\nexport const x = [T, ${claim}, ${factory}];\n`;
    for (const f of [
      'packages/safety/src/scoped-gate.ts',
      'packages/safety/src/scoped-gate.state.test.ts',
      'packages/safety/src/seal.adversarial.test.ts',
    ])
      expect(await sealed(f, all), f).toEqual([]);
    // Any other safety file, production or test, is an outsider like the rest.
    for (const f of [
      'packages/safety/src/gate.ts',
      'packages/safety/src/status.ts',
      'packages/safety/src/new.state.test.ts',
    ])
      expect((await sealed(f, all)).length, f).toBeGreaterThan(0);
  });

  it('an inline disable comment does not switch the rule off', async () => {
    const code = `/* eslint-disable sbx/sealed-transport */\nimport * as T from '@umsbx/transport';\nexport const f = T;\n`;
    expect((await sealed('packages/paypal/src/evil.ts', code)).length).toBeGreaterThan(0);
  });
});

// FIX-MVPB-SEAL3 H-A. The sealed rule matched only the '@umsbx/transport' specifier, so a relative or
// absolute path into the package sources reached the unexported minter, test-support and the
// approved factory. Any import of any file under packages/transport or packages/safety from outside
// that package is barred (the public way in is the package name); inside the package, the test-only
// minters and test-support are for test files.
describe('relative, absolute and indirect reach into the sealed packages (SEAL3 H-A)', () => {
  const SEALED = 'sbx/sealed-transport';
  const sealed = async (file: string, code: string) =>
    (await lint(file, code)).filter((m) => m.ruleId === SEALED);
  const maker = ['create', 'Approval', 'Minter'].join('');
  const outsiders = [
    'packages/paypal/src/evil.ts',
    'packages/testkit/src/evil.ts',
    'packages/db/src/evil.ts',
    'apps/web/composition.server.ts',
    'domain/payments/src/evil.test.ts',
    'tests/mvp-b/evil.test.ts',
    'tools/spike-kit/src/evil.ts',
    'scripts/evil.mjs',
    'scripts/lib/evil.mjs',
    'evil.mjs',
  ];
  const rel = (from: string, target: string) => {
    const r = relative(dirname(join(REPO_ROOT, from)), join(REPO_ROOT, target));
    return r.startsWith('.') ? r : `./${r}`;
  };
  const targets = [
    'packages/transport/src/approval.ts',
    'packages/transport/src/approval',
    'packages/transport/src/sandbox.ts',
    'packages/transport/src/test-support.ts',
    'packages/transport/src/recorder-corpus.ts',
    'packages/transport/package.json',
    'packages/safety/src/scoped-gate.ts',
    'packages/safety/src/gate',
  ];
  // The package entry file spelled as a path is the package name in disguise: public names pass,
  // everything the name check bars is barred here too.
  const entries = [
    'packages/transport/src/index.ts',
    'packages/transport/src/index',
    'packages/transport/src',
    'packages/safety/src/index.ts',
    'packages/safety/src',
  ];
  const forms: [string, (spec: string) => string][] = [
    ['static import', (s) => `import * as M from '${s}';\nexport const m = M;\n`],
    ['named import', (s) => `import { x } from '${s}';\nexport const m = x;\n`],
    ['export star', (s) => `export * from '${s}';\n`],
    ['named re-export', (s) => `export { x } from '${s}';\n`],
    ['dynamic import', (s) => `export const m = await import('${s}');\n`],
    ['require', (s) => `export const m = require('${s}');\n`],
    ['importActual', (s) => `export const m = await vi.importActual('${s}');\n`],
  ];
  it('every form of every relative path into either package is refused from outside', async () => {
    for (const f of outsiders)
      for (const t of targets)
        for (const [name, make] of forms)
          expect((await sealed(f, make(rel(f, t)))).length, `${f} ${name} ${t}`).toBeGreaterThan(0);
  });
  it('the entry file by path is checked like the package name', async () => {
    for (const f of outsiders) {
      for (const t of entries) {
        const sp = rel(f, t);
        const sealedName = t.includes('transport') ? 'claimApprovalMinter' : 'createScopedGate';
        const bad = [
          `import * as M from '${sp}';\nexport const m = M;\n`,
          `import { ${sealedName} } from '${sp}';\nexport const m = ${sealedName};\n`,
          `export * from '${sp}';\n`,
          `export { ${sealedName} } from '${sp}';\n`,
          `export const m = await import('${sp}');\n`,
          `export const m = require('${sp}');\n`,
        ];
        for (const code of bad)
          expect((await sealed(f, code)).length, `${f} ${sp} ${code}`).toBeGreaterThan(0);
        // Plain public names are fine, as they are through the package name.
        const ok = `import { guard, createSwitchReader } from '${sp}';\nexport const m = [guard, createSwitchReader];\n`;
        expect(await sealed(f, ok), `${f} ${sp}`).toEqual([]);
      }
    }
  });
  it('an absolute path, a file: URL and a node_modules symlink path are refused too', async () => {
    const abs = join(REPO_ROOT, 'packages/transport/src/approval.ts');
    const specs = [
      abs,
      `file://${abs}`,
      '../node_modules/@umsbx/transport/src/approval.ts',
      '../../node_modules/@umsbx/safety/src/scoped-gate.ts',
    ];
    for (const spec of specs)
      for (const [name, make] of forms)
        expect(
          (await sealed('scripts/evil.mjs', make(spec))).length,
          `${name} ${spec}`,
        ).toBeGreaterThan(0);
  });
  it('reproduces the Opus probe: runtime-registered loader, dynamic import of approval.ts and sandbox.ts, computed names, permissive minter, fake gate, computed production sentinel', async () => {
    const probe = [
      "import { register } from 'node:module';",
      "register('./lib/ts-hooks.mjs', import.meta.url);",
      "const approval = await import('../packages/transport/src/approval.ts');",
      "const sandbox = await import('../packages/transport/src/sandbox.ts');",
      `const mint = approval[['create', 'Approval', 'Minter'].join('')](() => true);`,
      "const fakeGate = { check: async () => ({ allowed: true, approval_ref: 'X' }) };",
      "const cap = mint({ scope: 'mvp_b_polling', approval_ref: 'X', gate: fakeGate });",
      "const make = sandbox[['create', 'Approved', 'Sandbox', 'Transport'].join('')];",
      "export const t = await make({ approval: cap, scope: 'mvp_b_polling', wire: ['produc', 'tion'].join(''), clock: { now: () => new Date(0) }, log: { log() {}, child() { return this; } } });",
      '',
    ].join('\n');
    const m = await sealed('scripts/probe-attack.mjs', probe);
    expect(m.length).toBeGreaterThanOrEqual(2); // both dynamic imports
    // Nothing else in the probe is a lint-clean way in.
    const all = await lint('scripts/probe-attack.mjs', probe);
    expect(all.length).toBeGreaterThan(0);
  });
  it('a file inside the package may import its own siblings; outside paths into other packages stay ordinary', async () => {
    expect(
      await sealed(
        'packages/transport/src/sandbox.ts',
        "import { a } from './guard';\nexport const b = a;\n",
      ),
    ).toEqual([]);
    expect(
      await sealed(
        'packages/paypal/src/x.ts',
        "import { a } from './adapter';\nexport const b = a;\n",
      ),
    ).toEqual([]);
    expect(
      await sealed('scripts/x.mjs', "import { a } from './lib/walk.mjs';\nexport const b = a;\n"),
    ).toEqual([]);
  });

  describe('inside the packages: test-only minters and test-support are for test files', () => {
    it(`${maker} and test-support are barred from non-test transport files`, async () => {
      for (const f of [
        'packages/transport/src/recorder-corpus.ts',
        'packages/transport/src/sandbox.ts',
        'packages/transport/src/new-file.ts',
      ]) {
        expect(
          (await sealed(f, `import { ${maker} } from './approval';\nexport const m = ${maker};\n`))
            .length,
          f,
        ).toBeGreaterThan(0);
        expect(
          (
            await sealed(
              f,
              "import { fakeWire } from './test-support';\nexport const w = fakeWire;\n",
            )
          ).length,
          f,
        ).toBeGreaterThan(0);
        expect(
          (await sealed(f, "import * as A from './approval';\nexport const a = A;\n")).length,
          f,
        ).toBeGreaterThan(0);
        expect((await sealed(f, "export * from './test-support';\n")).length, f).toBeGreaterThan(0);
        expect(
          (await sealed(f, "export const m = await import('./test-support');\n")).length,
          f,
        ).toBeGreaterThan(0);
      }
    });
    it('approval.ts is claimed through the index only: the index re-exports the claim function and nothing else sealed', async () => {
      expect(
        await sealed(
          'packages/transport/src/index.ts',
          "export { claimApprovalMinter } from './approval';\n",
        ),
      ).toEqual([]);
    });
    it('test files and test-support.ts itself may use them', async () => {
      const mk = `import { ${maker} } from './approval';\nexport const m = ${maker};\n`;
      for (const f of [
        'packages/transport/src/approval.test.ts',
        'packages/transport/src/sandbox.test.ts',
        'packages/transport/src/test-support.ts',
      ])
        expect(await sealed(f, mk), f).toEqual([]);
      expect(
        await sealed(
          'packages/transport/src/sandbox.test.ts',
          "import { fakeWire } from './test-support';\nexport const w = fakeWire;\n",
        ),
      ).toEqual([]);
    });
    it('the safety minter and issued-gate predicate are for scoped-gate.ts and tests', async () => {
      const mint =
        "import { mintCapability } from './scoped-gate';\nexport const m = mintCapability;\n";
      const issued = "import { isIssuedGate } from './gate';\nexport const m = isIssuedGate;\n";
      expect((await sealed('packages/safety/src/status.ts', mint)).length).toBeGreaterThan(0);
      expect((await sealed('packages/safety/src/status.ts', issued)).length).toBeGreaterThan(0);
      expect(
        (
          await sealed(
            'packages/safety/src/status.ts',
            "import * as G from './scoped-gate';\nexport const g = G;\n",
          )
        ).length,
      ).toBeGreaterThan(0);
      expect(await sealed('packages/safety/src/seal.adversarial.test.ts', mint)).toEqual([]);
      expect(await sealed('packages/safety/src/scoped-gate.ts', issued)).toEqual([]);
    });
  });

  describe('indirect loaders', () => {
    const spellings: [string, string][] = [
      [
        'require aliased to a variable',
        "const q = require;\nexport const m = q('@umsbx/transport');\n",
      ],
      ['comma-expression require', "export const m = (0, require)('@umsbx/transport');\n"],
      ['require passed as an argument', 'export const m = [1].map(require);\n'],
      ['require.call', "export const m = require.call(null, '@umsbx/transport');\n"],
      ['require in an object', 'export const o = { load: require };\n'],
      [
        'vi.importActual of the package',
        "export const m = await vi.importActual('@umsbx/transport');\n",
      ],
      [
        'vi.importActual with a type argument',
        "export const m = await vi.importActual<typeof import('@umsbx/transport')>('@umsbx/transport');\n",
      ],
      ['vi.importMock', "export const m = await vi.importMock('@umsbx/transport');\n"],
      ['requireActual', "export const m = jest.requireActual('@umsbx/transport');\n"],
      [
        'importActual with a computed specifier',
        "export const m = await vi.importActual(['@umsbx', 'transport'].join('/'));\n",
      ],
    ];
    it.each(spellings)('is refused outside the allowed files: %s', async (_n, code) => {
      for (const f of [
        'packages/paypal/src/evil.ts',
        'tests/mvp-b/evil.test.ts',
        'scripts/evil.mjs',
        'evil.cjs',
      ])
        expect((await sealed(f, code)).length, f).toBeGreaterThan(0);
    });
    it('an ordinary use of a local method named require or importActual elsewhere is not flagged', async () => {
      expect(
        await sealed(
          'packages/paypal/src/x.ts',
          'export const m = { require: 1 }.require;\nexport const n = typeof process;\n',
        ),
      ).toEqual([]);
    });
  });

  describe('the createScopedGate factory bar (SEAL3 M-A control)', () => {
    const fn = ['create', 'Scoped', 'Gate'].join('');
    it('named, namespace and re-exported use of the safety scoped-gate factory is refused outside the pinned files', async () => {
      for (const f of [
        'packages/paypal/src/evil.ts',
        'packages/testkit/src/probe-db.ts',
        'apps/web/composition.server.ts',
        'tests/mvp-b/evil.test.ts',
        'scripts/evil.mjs',
      ]) {
        expect(
          (await sealed(f, `import { ${fn} } from '@umsbx/safety';\nexport const g = ${fn};\n`))
            .length,
          f,
        ).toBeGreaterThan(0);
        expect(
          (await sealed(f, "import * as S from '@umsbx/safety';\nexport const g = S;\n")).length,
          f,
        ).toBeGreaterThan(0);
        expect(
          (await sealed(f, `export { ${fn} } from '@umsbx/safety';\n`)).length,
          f,
        ).toBeGreaterThan(0);
        expect(
          (await sealed(f, "export const g = await import('@umsbx/safety');\n")).length,
          f,
        ).toBeGreaterThan(0);
      }
    });
    it('the other safety exports stay importable', async () => {
      const ok =
        "import { createOutboundGate, createSwitchReader, readSafetyStatus, setSwitch } from '@umsbx/safety';\nimport type { ScopedGateHandle } from '@umsbx/safety';\nexport const g = [createOutboundGate, createSwitchReader, readSafetyStatus, setSwitch];\n";
      for (const f of [
        'apps/web/composition.server.ts',
        'packages/testkit/src/x.ts',
        'tests/mvp-a/x.test.ts',
      ])
        expect(await sealed(f, ok), f).toEqual([]);
    });
  });
});

describe('the production Wire sentinel (SEAL2 H2)', () => {
  const SENT = 'sbx/sealed-wire-sentinel';
  const sentinel = async (file: string, code: string) =>
    (await lint(file, code)).filter((m) => m.ruleId === SENT);
  const cases: [string, string][] = [
    ['plain property', "export const o = { wire: 'production' };\n"],
    ['quoted key', "export const o = { 'wire': 'production' };\n"],
    ['template value', 'export const o = { wire: `production` };\n'],
    [
      'nested in a call',
      "export const f = (g: (x: unknown) => void) => g({ a: 1, wire: 'production' });\n",
    ],
  ];
  it.each(cases)(
    'is barred everywhere except the one transport sandbox test: %s',
    async (_n, code) => {
      for (const f of [
        'packages/paypal/src/x.ts',
        'packages/safety/src/x.ts',
        'packages/testkit/src/x.ts',
        'packages/jobs/src/x.ts',
        'apps/web/src/x.ts',
        'tests/mvp-b/x.test.ts',
        'tools/spike-kit/src/x.ts',
        'scripts/x.mjs',
      ])
        expect((await sentinel(f, code)).length, f).toBeGreaterThan(0);
    },
  );
  it('only the transport sandbox test may write it (SEAL3: composition and other transport files may not)', async () => {
    const code = "export const o = { wire: 'production' };\n";
    expect(await sentinel('packages/transport/src/sandbox.test.ts', code)).toEqual([]);
    for (const f of [
      'apps/web/composition.server.ts',
      'packages/transport/src/sandbox.ts',
      'packages/transport/src/x.ts',
      `packages/transport/src/${WIRE}.env.test.ts`,
      'packages/transport/src/sandbox.binding.test.ts',
    ])
      expect((await sentinel(f, code)).length, f).toBeGreaterThan(0);
  });
  it('an ordinary use of the word production elsewhere is not flagged', async () => {
    const code = "export const o = { env: 'production', wire: 'fake' };\n";
    expect(await sentinel('packages/paypal/src/x.ts', code)).toEqual([]);
  });
});

describe('spike-kit git-head.ts lifts only the process-module restriction (SEAL3 LOW)', () => {
  const GH = 'tools/spike-kit/src/git-head.ts';
  const proc =
    "import { execFileSync } from 'node:child_process';\nexport const x = execFileSync;\n";
  it('may import node:child_process, statically and dynamically', async () => {
    expect(await lint(GH, proc)).toEqual([]);
    expect(await lint(GH, "export const x = await import('node:child_process');\n")).toEqual([]);
  });
  it('still may not import any network client, process-adjacent module or workspace package', async () => {
    for (const spec of [
      'node:net',
      'node:tls',
      'node:https',
      'node:http',
      'node:dns',
      'undici',
      'node:vm',
      'node:worker_threads',
      'node:module',
      '@umsbx/transport',
      '@umsbx/config',
      '@unitmarket/contracts',
    ])
      expect(
        (await lint(GH, `import x from '${spec}';\nexport const y = x;\n`)).length,
        spec,
      ).toBeGreaterThan(0);
    expect((await lint(GH, 'export const f = () => fetch("x");\n')).length).toBeGreaterThan(0);
  });
  it('no other spike-kit file, production or test helper, may import node:child_process', async () => {
    for (const f of [
      'tools/spike-kit/src/spike.ts',
      'tools/spike-kit/src/other.ts',
      'tools/spike-kit/src/index.ts',
    ])
      expect((await lint(f, proc)).length, f).toBeGreaterThan(0);
  });
});

describe('named exemptions (D-015)', () => {
  it('the exemption list is pinned: adding a file or a rule needs a reviewed change here', async () => {
    const { NAMED_EXEMPTIONS } = await import('../eslint.config.mjs');
    const flat = NAMED_EXEMPTIONS.flatMap((e: { files: string[]; off: string[] }) =>
      e.files.map((f) => `${f} -> ${[...e.off].sort().join(',')}`),
    ).sort();
    expect(flat).toEqual(
      [
        'apps/web/src/server/singleton.ts -> no-restricted-syntax,sbx/no-global-alias',
        'apps/web/src/instrumentation.ts -> no-restricted-properties,sbx/no-global-alias',
        'apps/web/src/lib/client-api.ts -> no-restricted-globals',
        'packages/paypal/src/paypal.sandbox.contract.test.ts -> no-restricted-syntax,sbx/no-global-alias',
        'domain/library/src/world.ts -> no-restricted-imports,sbx/no-restricted-dynamic-import',
        'domain/recovery/src/world.ts -> no-restricted-imports,sbx/no-restricted-dynamic-import',
        'domain/payments/src/support.ts -> no-restricted-imports,sbx/no-restricted-dynamic-import',
        'domain/payments/src/payments.integration.test.ts -> no-restricted-imports,sbx/no-restricted-dynamic-import',
        'tests/mvp-a/app-a20-a22-perf.integration.test.ts -> sbx/no-package-escape',
        'tests/mvp-a/dryrun-kill-switch.integration.test.ts -> sbx/no-package-escape',
        'tests/mvp-a/safety-a01-a04.integration.test.ts -> sbx/no-package-escape',
        'tests/mvp-b/b06-b08.integration.test.ts -> sbx/no-package-escape',
        'tests/mvp-b/b09-logs-clean.integration.test.ts -> sbx/no-package-escape,sbx/sealed-transport',
        'packages/paypal/src/sandbox-wire.integration.test.ts -> sbx/sealed-transport',
        `packages/transport/src/${WIRE}.ts -> no-restricted-properties,sbx/no-global-alias`,
        `packages/transport/src/${WIRE}.env.test.ts -> sbx/no-global-alias`,
        'scripts/record-fixtures.test.ts -> sbx/sealed-transport',
        'packages/safety/src/scoped-gate.ts -> sbx/sealed-transport',
        'packages/safety/src/scoped-gate.state.test.ts -> sbx/sealed-transport',
        'packages/safety/src/seal.adversarial.test.ts -> sbx/sealed-transport',
        'packages/transport/src/sandbox.test.ts -> sbx/sealed-wire-sentinel',
        'tools/spike-kit/src/spike.ts -> no-restricted-globals,no-restricted-properties,no-restricted-syntax,sbx/no-global-alias',
        'tools/spike-kit/src/spike.test.ts -> no-restricted-imports,sbx/no-restricted-dynamic-import',
        'tools/spike-kit/src/spike-cli.integration.test.ts -> no-restricted-imports,no-restricted-properties,sbx/no-global-alias',
      ].sort(),
    );
  });
});
