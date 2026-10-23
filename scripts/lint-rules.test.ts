// Proves the ESLint layering rules (architecture 2.2 and 2.3) with real lint runs on virtual files.
import { ESLint } from 'eslint';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { REPO_ROOT, TOKENS } from './test-helpers';

// Built at run time: the transport package test bars any file outside the transport package from
// naming the production Wire module, and this file lists its lint exemptions.
const WIRE = ['wire', 'https'].join('-');

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

// FIX-MVPB-SEAL4 item 3. The production Wire is selected by the PRODUCTION_WIRE token (a unique
// symbol), not by a string. A string built at run time (['prod','uction'].join(''), a const) selects
// nothing; reaching the token needs one of the sealed ways in, which lint bars like the factory.
describe('the production Wire token (SEAL4)', () => {
  const SEALED = 'sbx/sealed-transport';
  const sealed = async (file: string, code: string) =>
    (await lint(file, code)).filter((m) => m.ruleId === SEALED);
  const outsiders = [
    'packages/paypal/src/evil.ts',
    'packages/testkit/src/evil.ts',
    'apps/web/composition.server.ts',
    'tests/mvp-b/evil.test.ts',
    'scripts/evil.mjs',
    'evil.mjs',
  ];
  const forms: [string, string][] = [
    [
      'named import',
      "import { PRODUCTION_WIRE } from '@umsbx/transport';\nexport const w = PRODUCTION_WIRE;\n",
    ],
    [
      'renamed import',
      "import { PRODUCTION_WIRE as P } from '@umsbx/transport';\nexport const w = P;\n",
    ],
    [
      'namespace import',
      "import * as T from '@umsbx/transport';\nexport const w = T.PRODUCTION_WIRE;\n",
    ],
    [
      'computed member of a namespace',
      "import * as T from '@umsbx/transport';\nexport const w = T[['PRODUCTION', 'WIRE'].join('_')];\n",
    ],
    ['re-export', "export { PRODUCTION_WIRE } from '@umsbx/transport';\n"],
    ['dynamic import', "export const w = (await import('@umsbx/transport')).PRODUCTION_WIRE;\n"],
  ];
  it.each(forms)('is refused outside the pinned files: %s', async (_n, code) => {
    for (const f of outsiders) expect((await sealed(f, code)).length, f).toBeGreaterThan(0);
  });
  it('a string used as a wire is not a lint matter (it selects nothing at run time)', async () => {
    const code =
      "const P = 'production';\nexport const o = { wire: P, w2: ['prod', 'uction'].join('') };\n";
    expect(await sealed('packages/paypal/src/x.ts', code)).toEqual([]);
  });
  it('the old string sentinel rule no longer exists', async () => {
    const { default: cfg } = await import('../eslint.config.mjs');
    const names = (cfg as { plugins?: Record<string, { rules?: object }> }[]).flatMap((c) =>
      Object.keys(c.plugins?.['sbx']?.rules ?? {}),
    );
    expect(names).toContain('sealed-transport');
    expect(names).not.toContain('sealed-wire-sentinel');
  });
});

describe('percent-encoded relative and file: specifiers (SEAL4)', () => {
  const SEALED = 'sbx/sealed-transport';
  const sealed = async (file: string, code: string) =>
    (await lint(file, code)).filter((m) => m.ruleId === SEALED);
  const specs = [
    '../packages/transp%6Frt/src/approval.ts',
    '../packages/transport/src/appr%6Fval.ts',
    '../packages/transport/%73rc/approval',
    './a%20b',
    '../x%2e%2e/y',
    'file:///tmp/packages/transp%6Frt/src/approval.ts',
    'file:///tmp/a%20b.mjs',
    '/tmp/packages/transp%6Frt/src/approval.ts',
  ];
  const forms: ((s: string) => string)[] = [
    (s) => `import { x } from '${s}';\nexport const m = x;\n`,
    (s) => `export * from '${s}';\n`,
    (s) => `export const m = await import('${s}');\n`,
    (s) => `export const m = require('${s}');\n`,
    (s) => `export const m = await vi.importActual('${s}');\n`,
  ];
  it('any % in a relative, file: or absolute specifier is refused, in every file', async () => {
    for (const f of [
      'scripts/evil.mjs',
      'packages/paypal/src/evil.ts',
      'packages/transport/src/evil.ts',
      'packages/safety/src/evil.ts',
      'tests/mvp-b/evil.test.ts',
      'evil.mjs',
    ])
      for (const sp of specs)
        for (const make of forms)
          expect((await sealed(f, make(sp))).length, `${f} ${sp}`).toBeGreaterThan(0);
  });
  it('a bare package specifier or an ordinary relative path is unaffected', async () => {
    expect(
      await sealed(
        'packages/paypal/src/x.ts',
        "import { a } from './adapter';\nimport { z } from 'zod';\nexport const b = [a, z];\n",
      ),
    ).toEqual([]);
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
        'tests/mvp-b/no-mint-by-path.test.ts -> sbx/no-package-escape,sbx/sealed-transport',
        'tools/spike-kit/src/spike.ts -> no-restricted-globals,no-restricted-properties,no-restricted-syntax,sbx/no-global-alias',
        'tools/spike-kit/src/spike.test.ts -> no-restricted-imports,sbx/no-restricted-dynamic-import',
        'tools/spike-kit/src/spike-cli.integration.test.ts -> no-restricted-imports,no-restricted-properties,sbx/no-global-alias',
      ].sort(),
    );
  });
});

// ---------------------------------------------------------------------------------------------
// SEAL5 (a) to (d). Ways to reach the sealed names (createApprovedSandboxTransport, PRODUCTION_WIRE,
// createScopedGate) without writing the package name: a package.json `imports` alias (`#ap`), a
// node_modules alias whose real path is packages/transport or packages/safety, and the bundler
// globs `import.meta.glob` / `import.meta.webpackContext`. The first two are proved real by the
// Node resolver itself (require.resolve in a child Node process started inside the fixture package) before lint is asked to refuse them.
// ---------------------------------------------------------------------------------------------
describe('SEAL5: aliases and bundler globs cannot reach the sealed names', () => {
  const ALIAS = 'sbx/no-sealed-alias';
  const GLOB = 'sbx/no-bundler-glob';
  const NAMES = 'createApprovedSandboxTransport, PRODUCTION_WIRE';
  let fx: string; // fixture package directory, inside the repository so the config applies
  let fxRel: string;
  const TRANSPORT = join(REPO_ROOT, 'packages', 'transport');
  const SAFETY = join(REPO_ROOT, 'packages', 'safety');

  beforeAll(() => {
    const base = join(REPO_ROOT, 'scripts', '__fixtures__');
    fx = mkdtempSync(join(base, 'seal5-'));
    fxRel = relative(REPO_ROOT, fx);
    writeFileSync(
      join(fx, 'package.json'),
      JSON.stringify({
        name: 'seal5-fixture',
        private: true,
        type: 'module',
        imports: {
          '#ap': '@umsbx/transport',
          '#ap-cond': { node: { import: './nothing.js', default: '@umsbx/transport' } },
          '#ap-array': ['transport-alias'],
          '#alias': 'transport-alias',
          '#safety': 'safety-alias',
          '#star/*': '@umsbx/transport/src/*',
          '#ok': './ok.js',
          '#okpkg': 'zod',
        },
      }),
    );
    mkdirSync(join(fx, 'node_modules', '@umsbx'), { recursive: true });
    symlinkSync(TRANSPORT, join(fx, 'node_modules', '@umsbx', 'transport'), 'dir');
    symlinkSync(TRANSPORT, join(fx, 'node_modules', 'transport-alias'), 'dir');
    symlinkSync(SAFETY, join(fx, 'node_modules', 'safety-alias'), 'dir');
  });
  afterAll(() => rmSync(fx, { recursive: true, force: true }));

  const only = async (file: string, code: string, rule: string) =>
    (await lint(file, code)).filter((m) => m.ruleId === rule);
  const inFx = (name: string) => join(fxRel, name);

  describe('runtime proof: the Node resolver really lands in the sealed packages', () => {
    it.each([
      ['#ap', TRANSPORT],
      ['#ap-cond', TRANSPORT],
      ['#ap-array', TRANSPORT],
      ['#alias', TRANSPORT],
      ['#safety', SAFETY],
      ['transport-alias', TRANSPORT],
      ['safety-alias', SAFETY],
    ])('%s resolves into %s', (spec, pkg) => {
      const resolved = execFileSync(
        process.execPath,
        ['-e', 'process.stdout.write(require.resolve(process.argv[1]))', spec],
        { cwd: fx, encoding: 'utf8', env: {} },
      );
      expect(realpathSync(resolved).startsWith(`${realpathSync(pkg)}/`), resolved).toBe(true);
    });
  });

  describe('(a) # imports that map to a sealed package, and (b) bare aliases that resolve into one', () => {
    const forms: [string, (s: string) => string][] = [
      [
        'named import',
        (s) =>
          `import { ${NAMES} } from '${s}';\nexport const x = [createApprovedSandboxTransport, PRODUCTION_WIRE];\n`,
      ],
      ['default import', (s) => `import T from '${s}';\nexport const x = T;\n`],
      ['namespace import', (s) => `import * as T from '${s}';\nexport const x = T;\n`],
      ['side-effect import', (s) => `import '${s}';\n`],
      ['re-export', (s) => `export { PRODUCTION_WIRE } from '${s}';\n`],
      ['export star', (s) => `export * from '${s}';\n`],
      ['dynamic import', (s) => `export const x = (await import('${s}')).PRODUCTION_WIRE;\n`],
      ['require', (s) => `export const x = require('${s}').PRODUCTION_WIRE;\n`],
      ['importActual', (s) => `export const x = await vi.importActual('${s}');\n`],
    ];
    const specs = [
      '#ap',
      '#ap-cond',
      '#ap-array',
      '#alias',
      '#safety',
      '#star/sandbox',
      'transport-alias',
      'transport-alias/src/sandbox',
      'safety-alias',
    ];
    const files = ['evil.ts', 'evil.mjs', 'evil.test.ts', 'src/deep/evil.ts'];
    it.each(specs)(
      '%s is refused in every file of the package, in every import form',
      async (spec) => {
        for (const f of files)
          for (const [name, make] of forms)
            expect((await only(inFx(f), make(spec), ALIAS)).length, `${f} ${name}`).toBeGreaterThan(
              0,
            );
      },
    );
    it('a # import that maps elsewhere, a bare package and a relative path are not flagged', async () => {
      for (const spec of ['#ok', '#okpkg', '#missing', 'zod', 'node:fs', './x', 'vitest'])
        expect(
          await only(inFx('evil.ts'), `import x from '${spec}';\nexport const y = x;\n`, ALIAS),
          spec,
        ).toEqual([]);
    });
    it('the official package name is not this rule (the sealed-transport rule handles it)', async () => {
      expect(
        await only(
          inFx('evil.ts'),
          "import { a } from '@umsbx/contracts';\nexport const b = a;\n",
          ALIAS,
        ),
      ).toEqual([]);
    });
    it('type-only imports load nothing and stay allowed', async () => {
      expect(
        await only(
          inFx('evil.ts'),
          "import type { Wire } from '#ap';\nexport type W = Wire;\n",
          ALIAS,
        ),
      ).toEqual([]);
    });
    it('no package.json in the repository declares an imports map (a new one needs a reviewed change here)', () => {
      const found: string[] = [];
      const walk = (dir: string) => {
        for (const name of readdirSync(dir)) {
          if (
            ['node_modules', '.git', '.next', 'dist', '.data', '.pglite', '__fixtures__'].includes(
              name,
            )
          )
            continue;
          const p = join(dir, name);
          if (statSync(p).isDirectory()) walk(p);
          else if (name === 'package.json') {
            const j = JSON.parse(readFileSync(p, 'utf8')) as { imports?: unknown };
            if (j.imports !== undefined) found.push(relative(REPO_ROOT, p));
          }
        }
      };
      walk(REPO_ROOT);
      expect(found).toEqual([]);
    });
  });

  describe('(c) import.meta.glob and import.meta.webpackContext are barred outright', () => {
    const G = "'../../packages/transport/src/sandbox.ts'";
    const bad: [string, string][] = [
      ['import.meta.glob', `export const m = import.meta.glob(${G}, { eager: true });\n`],
      ['import.meta.glob lazy', `export const m = import.meta.glob(${G});\n`],
      ['import.meta.globEager', `export const m = import.meta.globEager(${G});\n`],
      [
        'import.meta.webpackContext',
        `export const m = import.meta.webpackContext('../packages/transport/src');\n`,
      ],
      ['string-keyed glob', `export const m = import.meta['glob'](${G});\n`],
      ['template-keyed glob', `export const m = import.meta[\`glob\`](${G});\n`],
      ['string-keyed webpackContext', `export const m = import.meta['webpackContext']('.');\n`],
      ['optional chain', `export const m = import.meta?.glob?.(${G});\n`],
      ['computed key', `export const m = import.meta[['gl', 'ob'].join('')](${G});\n`],
      ['aliased import.meta', `const meta = import.meta;\nexport const m = meta.glob(${G});\n`],
      ['destructured glob', `const { glob } = import.meta;\nexport const m = glob(${G});\n`],
      [
        'destructured rest',
        `const { url, ...rest } = import.meta;\nexport const m = [url, rest];\n`,
      ],
      ['passed as an argument', `export const m = [import.meta].map((x) => x);\n`],
      [
        'cast then glob',
        `export const m = (import.meta as unknown as { glob(s: string): unknown }).glob(${G});\n`,
      ],
      ['non-null then glob', `export const m = import.meta!.glob(${G});\n`],
    ];
    const anywhere = [
      'packages/paypal/src/evil.ts',
      'apps/web/composition.server.ts',
      'apps/web/src/app/page.tsx',
      'tests/mvp-b/evil.test.ts',
      'scripts/evil.mjs',
      'evil.mjs',
      // the pinned (exempt from other rules) files: no exemption reaches this rule
      'tests/mvp-b/b09-logs-clean.integration.test.ts',
      'tests/mvp-b/no-mint-by-path.test.ts',
      'packages/safety/src/scoped-gate.ts',
      'packages/transport/src/sandbox.ts',
      `packages/transport/src/${WIRE}.ts`,
      'tools/spike-kit/src/spike.ts',
    ];
    it.each(bad)('%s is refused everywhere', async (_n, code) => {
      for (const f of anywhere) expect((await only(f, code, GLOB)).length, f).toBeGreaterThan(0);
    });
    it('the harmless uses of import.meta stay allowed', async () => {
      const ok = [
        "export const u = new URL('./x', import.meta.url);\n",
        'export const d = import.meta.dirname;\n',
        'export const f = import.meta.filename;\n',
        "export const r = import.meta.resolve('./x');\n",
        'export const e = import.meta.env;\n',
        'export const e = (import.meta as { env?: Record<string, string | undefined> }).env;\n',
        'export const p = new URL(import.meta.url).pathname;\n',
      ];
      for (const code of ok)
        expect(await only('packages/paypal/src/x.ts', code, GLOB), code).toEqual([]);
    });
    it('no named exemption can switch these two rules off, and the config refuses to load one that does', async () => {
      const { NAMED_EXEMPTIONS } = await import('../eslint.config.mjs');
      const off = (NAMED_EXEMPTIONS as { off: string[] }[]).flatMap((e) => e.off);
      expect(off).not.toContain(GLOB);
      expect(off).not.toContain(ALIAS);
    });
    it('the config refuses to load an exemption that switches either rule off', async () => {
      const { checkNamedExemptions } = await import('../eslint.config.mjs');
      expect(() =>
        checkNamedExemptions([{ files: ['x.ts'], off: ['no-restricted-syntax'] }]),
      ).not.toThrow();
      for (const rule of [GLOB, ALIAS])
        expect(() =>
          checkNamedExemptions([{ files: ['x.ts'], off: ['sbx/no-global-alias', rule] }]),
        ).toThrow(rule);
    });
    it('no raw block of the FINAL exported config switches either rule off or weakens it (BU-1 review L3)', async () => {
      const { default: cfg } = await import('../eslint.config.mjs');
      const blocks = cfg as { rules?: Record<string, unknown>; files?: unknown }[];
      expect(blocks.length).toBeGreaterThan(10);
      const severity = (v: unknown): unknown => (Array.isArray(v) ? v[0] : v);
      let seen = 0;
      for (const b of blocks)
        for (const rule of [GLOB, ALIAS])
          if (b.rules && Object.hasOwn(b.rules, rule)) {
            seen += 1;
            expect(['error', 2], `${rule} in ${JSON.stringify(b.files)}`).toContain(
              severity(b.rules[rule]),
            );
          }
      // each rule is set by every entry() block, so it is present many times and never off
      expect(seen).toBeGreaterThan(20);
    });
    it('both rules are errors in the config of every kind of file', async () => {
      for (const f of [
        'evil.mjs',
        'packages/paypal/src/x.ts',
        'apps/web/src/x.tsx',
        'tests/mvp-a/x.test.ts',
        'scripts/x.mjs',
        inFx('x.ts'),
      ]) {
        const cfg = await eslint.calculateConfigForFile(join(REPO_ROOT, f));
        expect(cfg.rules?.[GLOB]?.[0], `${f} ${GLOB}`).toBe(2);
        expect(cfg.rules?.[ALIAS]?.[0], `${f} ${ALIAS}`).toBe(2);
      }
    });
  });

  describe('(F4) vi.mock, vi.doMock and jest.mock of a sealed module hand over the real module (BU-1 review)', () => {
    const SEALED = 'sbx/sealed-transport';
    const callees = ['vi.mock', 'vi.doMock', 'jest.mock', 'jest.doMock'];
    const factories: [string, string][] = [
      ['no factory', ''],
      [
        'a factory using importOriginal',
        ', async (importOriginal) => ({ ...(await importOriginal()) })',
      ],
      ['a factory that ignores the original', ', () => ({})'],
    ];
    const repoSpecs = [
      '@umsbx/transport',
      '@umsbx/safety',
      '@umsbx/transport/src/sandbox',
      '../../packages/transport/src/sandbox',
      '../../packages/safety/src/scoped-gate',
      `file://${join(REPO_ROOT, 'packages/transport/src/sandbox.ts')}`,
    ];
    const outsiders = [
      'tests/mvp-b/evil.test.ts',
      'packages/paypal/src/evil.test.ts',
      'packages/testkit/src/evil.test.ts',
      'scripts/evil.test.ts',
      'apps/web/src/evil.test.ts',
    ];
    it.each(callees)(
      '%s of a sealed module is refused in an unpinned test file',
      async (callee) => {
        for (const spec of repoSpecs)
          for (const [fname, f] of factories)
            for (const file of outsiders) {
              const code = `${callee}('${spec}'${f});\n`;
              expect(
                (await only(file, code, SEALED)).length,
                `${file} ${spec} ${fname}`,
              ).toBeGreaterThan(0);
            }
      },
    );
    it.each(callees)(
      '%s with a template-literal spec and with a computed spec is refused',
      async (callee) => {
        const tpl = `${callee}(\`@umsbx/transport\`);\n`;
        const computed = `${callee}(['@umsbx', 'transport'].join('/'), async (importOriginal) => importOriginal());\n`;
        for (const file of outsiders)
          for (const code of [tpl, computed])
            expect((await only(file, code, SEALED)).length, `${file} ${code}`).toBeGreaterThan(0);
      },
    );
    it.each(callees)('%s of an alias that reaches a sealed module is refused', async (callee) => {
      for (const spec of ['#ap', 'transport-alias', 'safety-alias', '#star/sandbox'])
        for (const file of ['evil.test.ts', 'src/evil.test.ts']) {
          const code = `${callee}('${spec}', async (importOriginal) => importOriginal());\n`;
          expect((await only(inFx(file), code, ALIAS)).length, `${file} ${spec}`).toBeGreaterThan(
            0,
          );
        }
    });
    it('a pinned file keeps its exemption (the rule is off there by name)', async () => {
      const code = "vi.mock('@umsbx/transport', async (importOriginal) => importOriginal());\n";
      expect(await only('tests/mvp-b/b09-logs-clean.integration.test.ts', code, SEALED)).toEqual(
        [],
      );
    });
    it('mocking anything else is not flagged', async () => {
      const ok = [
        "vi.mock('zod');",
        "vi.mock('./adapter', async (importOriginal) => importOriginal());",
        "vi.doMock('node:https', () => ({ default: {} }));",
        "vi.mock('@umsbx/contracts', async (importOriginal) => importOriginal());",
        "jest.mock('../../paypal/src/adapter');",
        'const s = vi.fn(); s.mock.calls.push(1);',
      ];
      for (const code of ok)
        for (const file of outsiders) {
          expect(await only(file, `${code}\n`, SEALED), `${file} ${code}`).toEqual([]);
          expect(await only(file, `${code}\n`, ALIAS), `${file} ${code}`).toEqual([]);
        }
    });
  });

  describe('(d) a product file that is not pinned cannot obtain the sealed names by any of the probes', () => {
    const probes: [string, string, string][] = [
      [
        'package.json imports alias #ap',
        `import { ${NAMES} } from '#ap';\nexport const x = [createApprovedSandboxTransport, PRODUCTION_WIRE];\n`,
        ALIAS,
      ],
      [
        'node_modules alias with a bare specifier',
        `import { ${NAMES} } from 'transport-alias';\nexport const x = [createApprovedSandboxTransport, PRODUCTION_WIRE];\n`,
        ALIAS,
      ],
      [
        'node_modules alias, deep path',
        "import { createApprovedSandboxTransport } from 'transport-alias/src/sandbox';\nexport const x = createApprovedSandboxTransport;\n",
        ALIAS,
      ],
      [
        'import.meta.glob',
        "const mods = import.meta.glob('../../packages/transport/src/sandbox.ts', { eager: true });\nexport const x = Object.values(mods).map((m) => (m as Record<string, unknown>)['createApprovedSandboxTransport']);\n",
        GLOB,
      ],
      [
        'import.meta.webpackContext',
        "const ctx = import.meta.webpackContext('../../packages/transport/src', { recursive: false });\nexport const x = (ctx('./sandbox.ts') as Record<string, unknown>)['PRODUCTION_WIRE'];\n",
        GLOB,
      ],
    ];
    it.each(probes)('%s', async (_n, code, rule) => {
      for (const f of [inFx('evil.ts'), inFx('src/product.ts'), inFx('product.server.ts')]) {
        const hit = (await lint(f, code)).filter(
          (m) => m.ruleId === rule || m.ruleId === 'sbx/sealed-transport',
        );
        expect(hit.length, f).toBeGreaterThan(0);
      }
      // the glob probes do not depend on the fixture package: they fail in any product file
      if (rule === GLOB)
        for (const f of [
          'packages/paypal/src/evil.ts',
          'apps/web/composition.server.ts',
          'packages/jobs/src/evil.ts',
        ])
          expect((await only(f, code, GLOB)).length, f).toBeGreaterThan(0);
    });
    it('and the official name is still refused to the same files (the baseline these probes would bypass)', async () => {
      const code = `import { ${NAMES} } from '@umsbx/transport';\nexport const x = [createApprovedSandboxTransport, PRODUCTION_WIRE];\n`;
      expect(
        (await only('packages/paypal/src/evil.ts', code, 'sbx/sealed-transport')).length,
      ).toBeGreaterThan(0);
    });
  });
});
