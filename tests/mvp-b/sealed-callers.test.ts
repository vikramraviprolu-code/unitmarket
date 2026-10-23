// FIX-BPREP M3 structural seal. The approved sandbox transport is reachable only through a
// capability minted by @umsbx/safety, and no non-test code builds it today. This reads source
// text (no import, no network) so a new caller, a new minter, or a test that omits the fake wire
// fails here and is reviewed by a person before the transport is unsealed.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(new URL('../..', import.meta.url).pathname);
const SKIP = new Set(['node_modules', '.next', 'dist', '.git', 'coverage', '.data', '.pglite']);
// FIX-MVPB-SEAL2 L: every JavaScript and TypeScript spelling, and the repository root as well as
// the source folders (eslint.config.mjs, vitest.config.ts and any other root file).
const SOURCE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (SOURCE.test(name)) out.push(p);
  }
  return out;
}
// Built at run time so this file does not itself name the production wire module.
const FETCH_WIRE_FN = ['create', 'Https', 'Wire'].join('');
const FETCH_WIRE_FILE = ['wire', 'https'].join('-');
const files = walk(ROOT);
const rel = (p: string) => relative(ROOT, p);
// Files that name the sealed identifiers as data and are reviewed as such: the lint configuration
// and its test, and this file. Everything else, root files included, is scanned.
const DATA = new Set(['eslint.config.mjs', 'scripts/lint-rules.test.ts']);
const text = new Map(
  files.filter((f) => !DATA.has(rel(f))).map((f) => [rel(f), readFileSync(f, 'utf8')]),
);
const isTest = (f: string) => /\.test\.[cm]?[jt]sx?$/.test(f) || /\/test-support\.ts$/.test(f);
const withText = (re: RegExp, pred: (f: string) => boolean = () => true) =>
  [...text.entries()]
    .filter(([f, t]) => pred(f) && re.test(t))
    .map(([f]) => f)
    .sort();

/** The argument text of every `name(` call in a file, by parenthesis matching. */
function callArgs(src: string, name: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`\\b${name}\\s*\\(`, 'g');
  for (let m = re.exec(src); m !== null; m = re.exec(src)) {
    let depth = 1;
    let i = re.lastIndex;
    for (; i < src.length && depth > 0; i += 1) {
      if (src[i] === '(') depth += 1;
      else if (src[i] === ')') depth -= 1;
    }
    out.push(src.slice(re.lastIndex, i - 1));
  }
  return out;
}

// Names built at run time so this file does not itself carry them as a bare identifier match.
const FACTORY = ['create', 'Approved', 'Sandbox', 'Transport'].join('');
const CLAIM = ['claim', 'Approval', 'Minter'].join('');
const MAKE_MINTER = ['create', 'Approval', 'Minter'].join('');
const OLD_MINTER = ['mint', 'Approval', 'Capability'].join('');
const TRANSPORT_PKG = '@umsbx/transport';
const isTransportSrc = (f: string) => f.startsWith('packages/transport/src/');

describe('who may build the approved sandbox transport', () => {
  it('non-test code calls the approved factory only in the factory itself, the package index and the one unseal file (BU-2)', () => {
    const callers = withText(new RegExp(`\\b${FACTORY}\\b`), (f) => !isTest(f));
    expect(callers).toEqual([
      'apps/web/src/server/outbound.server.ts',
      'packages/transport/src/index.ts',
      'packages/transport/src/sandbox.ts',
    ]);
  });
  it('composition builds the outbound only through buildOutbound and names none of the sealed identifiers (BU-2)', () => {
    const composition = text.get('apps/web/composition.server.ts') ?? '';
    expect(composition).toContain("from './src/server/outbound.server'");
    expect(composition).toMatch(/\bbuildOutbound\(/);
    // one call with one object argument: composition never passes the test-only seam
    expect(callArgs(composition, 'buildOutbound')).toHaveLength(1);
    expect(callArgs(composition, 'buildOutbound')[0]).not.toMatch(/\},\s*\{/);
    for (const banned of [
      FACTORY,
      CLAIM,
      OLD_MINTER,
      MAKE_MINTER,
      'createScopedGate',
      'PRODUCTION_WIRE',
      FETCH_WIRE_FN,
      FETCH_WIRE_FILE,
    ])
      expect(composition, banned).not.toContain(banned);
  });
  it('outbound.server.ts is the one apps file that names the factory, the production Wire token and the scoped-gate factory (BU-2)', () => {
    const users = (re: RegExp) => withText(re, (f) => f.startsWith('apps/'));
    expect(users(new RegExp(`\\b${FACTORY}\\b`))).toEqual([
      'apps/web/src/server/outbound.server.ts',
    ]);
    expect(users(/\bPRODUCTION_WIRE\b/)).toEqual(['apps/web/src/server/outbound.server.ts']);
    expect(users(/\bcreateScopedGate\b/)).toEqual(['apps/web/src/server/outbound.server.ts']);
    // never the minter, its claim, the old minter name, or the production Wire module
    expect(
      users(
        new RegExp(
          `\\b(${CLAIM}|${MAKE_MINTER}|${OLD_MINTER}|${FETCH_WIRE_FN})\\b|${FETCH_WIRE_FILE}`,
        ),
      ),
    ).toEqual([]);
  });
  it('outbound.server.ts passes its wire to the factory and selects the production Wire only for an explicit null (BU-2)', () => {
    const src = text.get('apps/web/src/server/outbound.server.ts') ?? '';
    const calls = callArgs(src, FACTORY);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatch(/\bwire\b/);
    expect(src).toMatch(/PRODUCTION_WIRE/);
    expect(src).not.toMatch(/\bwire\s*\?\?/);
    expect(src).toMatch(/wire === null/);
    // no namespace, default, dynamic or require spelling of the sealed packages
    expect(src).not.toMatch(/import\s+\*\s+as/);
    expect(src).not.toMatch(/import\s*\(/);
    expect(src).not.toMatch(/require\s*\(/);
  });
  it('every test call passes an explicit wire: a fake, never absent and never undefined', () => {
    const missing: string[] = [];
    let calls = 0;
    for (const [f, t] of text) {
      if (!isTest(f) || f.endsWith('sealed-callers.test.ts')) continue;
      for (const args of callArgs(t, FACTORY)) {
        calls += 1;
        if (!/\bwire\b/.test(args) || /\bwire\s*:\s*(undefined|null)\b/.test(args)) missing.push(f);
      }
    }
    expect(calls).toBeGreaterThan(5);
    expect(missing).toEqual([]);
  });
  it('the testkit sandbox subject takes a transport that its caller built, and does not import the factory', () => {
    const stack = text.get('packages/testkit/src/stack.ts') ?? '';
    expect(stack).toMatch(/approved\?: \{ transport: Transport \}/);
    expect(stack).not.toContain(FACTORY);
    expect(stack).not.toMatch(/wire\?:/);
  });
});

describe('the Wire is required (FIX-MVPB-SEAL2 H2)', () => {
  const sandbox = text.get('packages/transport/src/sandbox.ts') ?? '';
  it('sandbox.ts has no optional wire and no fallback to the production Wire', () => {
    expect(sandbox).not.toMatch(/\bwire\?:/);
    expect(sandbox).not.toMatch(/\bwire\s*\?\?/);
    expect(sandbox).not.toMatch(/o\.wire\s*\?\?/);
    expect(sandbox).toMatch(/wire: Wire \| typeof PRODUCTION_WIRE/);
    // The old string sentinel is gone from the factory.
    expect(sandbox).not.toMatch(/=== 'production'|\| 'production'/);
  });
  it('the PRODUCTION_WIRE token is named only in the transport package (sandbox.ts, the index) and its sandbox test', () => {
    const users = withText(/\bPRODUCTION_WIRE\b/, (f) => !f.endsWith('sealed-callers.test.ts'));
    // Composition has no standing exemption. BU-2 (the unseal) adds exactly one pinned file.
    expect(users).toEqual([
      'apps/web/src/server/outbound.server.ts',
      'packages/transport/src/index.ts',
      'packages/transport/src/sandbox.test.ts',
      'packages/transport/src/sandbox.ts',
    ]);
  });
  it('no source passes a string where the production Wire token goes', () => {
    const asString = /\bwire\s*:\s*['"`]production['"`]/;
    const hits = withText(asString, (f) => !f.endsWith('sealed-callers.test.ts'));
    // Only the test that proves a string is refused spells one.
    expect(hits).toEqual(['packages/transport/src/sandbox.test.ts']);
  });
});

describe('who may mint an approval capability', () => {
  it('the old exported minter name no longer exists in non-test code', () => {
    expect(withText(new RegExp(`\\b${OLD_MINTER}\\b`), (f) => !isTest(f))).toEqual([]);
  });
  it('non-test code names the claim function only in the scoped gate and the transport package', () => {
    expect(withText(new RegExp(`\\b${CLAIM}\\b`), (f) => !isTest(f))).toEqual([
      'packages/safety/src/scoped-gate.ts',
      'packages/transport/src/approval.ts',
      'packages/transport/src/index.ts',
    ]);
  });
  it('no minter factory exists: the old name is in no source file, and approval.ts exports only the claim and the check (SEAL4)', () => {
    expect(withText(new RegExp(`\\b${MAKE_MINTER}\\b`))).toEqual([]);
    const src = text.get('packages/transport/src/approval.ts') ?? '';
    const exported = [
      ...src.matchAll(/^export (?:async )?(?:function|const|class|let|var) (\w+)/gm),
    ].map((m) => m[1]);
    expect(exported.sort()).toEqual([CLAIM, 'isApprovalCapability']);
    expect(src).not.toMatch(/^export (?:\{|\*|default)/m);
    expect(src).toMatch(/^function makeMinter\(/m);
  });
  it('the only tests outside safety and transport that claim the minter are the pinned ones', () => {
    expect(
      withText(
        new RegExp(`\\b${CLAIM}\\b`),
        (f) =>
          isTest(f) &&
          !isTransportSrc(f) &&
          !f.startsWith('packages/safety/') &&
          !f.endsWith('sealed-callers.test.ts'),
      ),
    ).toEqual([
      'packages/paypal/src/sandbox-wire.integration.test.ts',
      // SEAL4: the runtime path-import probe calls the spent claim and expects it to throw.
      'tests/mvp-b/no-mint-by-path.test.ts',
    ]);
  });
  it('the transport factory requires a minted capability, not a structurally typed gate', () => {
    const sandbox = text.get('packages/transport/src/sandbox.ts') ?? '';
    expect(sandbox).toContain('isApprovalCapability(o.approval)');
    expect(sandbox).not.toMatch(/activeApproval/);
  });
  it('the sandbox sources never reach a Wire constructor from a parameter named gate', () => {
    const sandbox = text.get('packages/transport/src/sandbox.ts') ?? '';
    expect(sandbox).not.toMatch(/gate:\s*ScopedGate/);
  });
  it('safety hands the minter only gates its own factory built', () => {
    const scoped = text.get('packages/safety/src/scoped-gate.ts') ?? '';
    expect(scoped).toMatch(new RegExp(`${CLAIM}\\(isIssuedGate\\)`));
    const gate = text.get('packages/safety/src/gate.ts') ?? '';
    expect(gate).toContain('new WeakSet');
    expect(gate).toMatch(/apply\(wsAdd, issued, \[gate\]\)/);
    // The brand checks use the WeakSet methods captured at load, never a live property lookup.
    expect(gate).toContain('const wsHas = WeakSet.prototype.has');
    expect(gate).not.toMatch(/issued\.(has|add)\(/);
    const approval = text.get('packages/transport/src/approval.ts') ?? '';
    expect(approval).toContain('const wsHas = WeakSet.prototype.has');
    expect(approval).not.toMatch(/minted\.(has|add)\(/);
  });
});

// The text scan is the second fence behind lint (sbx/sealed-transport): a namespace import, a
// re-export, a dynamic import or a require of the transport package reaches every export, the
// claim function included, so none is allowed outside the pinned files.
describe('no spelling of the package import hides the sealed names', () => {
  const q = '[\'"`]';
  const pkg = TRANSPORT_PKG.replace('/', '\\/');
  const SPELLINGS: [string, RegExp][] = [
    [
      'namespace import',
      new RegExp(`import\\s+(type\\s+)?\\*\\s*as\\s+\\w+\\s+from\\s*${q}${pkg}`),
    ],
    [
      'default import',
      new RegExp(`import\\s+\\w+\\s*(,\\s*\\{[^}]*\\})?\\s+from\\s*${q}${pkg}${q}`),
    ],
    ['export star', new RegExp(`export\\s*\\*\\s*(as\\s+\\w+\\s*)?from\\s*${q}${pkg}`)],
    ['dynamic import', new RegExp(`import\\s*\\(\\s*${q}${pkg}`)],
    ['require', new RegExp(`require\\s*\\(\\s*${q}${pkg}`)],
    ['import equals', new RegExp(`import\\s+\\w+\\s*=\\s*require\\s*\\(\\s*${q}${pkg}`)],
  ];
  // One pinned file may use the namespace form: safety's adversarial probe (lint-exempt package).
  const PINNED = new Set(['packages/safety/src/seal.adversarial.test.ts']);
  it.each(SPELLINGS)('no source file uses a %s of the transport package', (_n, re) => {
    const hits = [...text.entries()]
      .filter(([f, t]) => !f.endsWith('sealed-callers.test.ts') && re.test(t))
      .map(([f]) => f)
      .filter((f) => !PINNED.has(f));
    expect(hits).toEqual([]);
  });
});

// FIX-MVPB-SEAL3 H-A. A relative path into the two sealed packages bypassed the package-name checks.
// The text scan below is the second fence behind lint (sbx/sealed-transport).
describe('paths into the sealed packages (SEAL3 H-A)', () => {
  const PKG = /packages\/(transport|safety)\//;
  // The runtime probe that spells these paths on purpose (a pinned lint exemption).
  const PATH_PROBES = new Set(['tests/mvp-b/no-mint-by-path.test.ts']);
  const insideSealed = (f: string) => PKG.test(f);
  // Every quoted path in an import/export/require/import() that names a sealed package's files.
  const reachOf = (t: string): string[] => {
    const out: string[] = [];
    const re =
      /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)['"`]([^'"`\n]*(?:packages\/(?:transport|safety)\/|node_modules\/@umsbx\/(?:transport|safety)\/)[^'"`\n]*)['"`]/g;
    for (let m = re.exec(t); m !== null; m = re.exec(t)) out.push(m[1] as string);
    return out;
  };
  it('outside the two packages, only the package entry file is named by path; one test names the recorder corpus', () => {
    const hits = [...text.entries()]
      .filter(
        ([f]) => !insideSealed(f) && !PATH_PROBES.has(f) && !f.endsWith('sealed-callers.test.ts'),
      )
      .flatMap(([f, t]) => reachOf(t).map((p) => `${f} -> ${p.replace(/^(\.\.\/)+/, '')}`))
      .sort();
    expect(hits).toEqual(
      [
        'scripts/record-fixtures.mjs -> packages/transport/src/index.ts',
        'scripts/record-fixtures.test.ts -> packages/transport/src/recorder-corpus',
        'scripts/safety-cli.mjs -> packages/safety/src/index.ts',
      ].sort(),
    );
  });
  it('no non-test file of the transport package imports test-support', () => {
    const offenders = [...text.entries()]
      .filter(([f]) => isTransportSrc(f) && !isTest(f))
      .filter(([, t]) => /from\s*['"]\.\/test-support['"]|import\(\s*['"]\.\/test-support/.test(t))
      .map(([f]) => f);
    expect(offenders).toEqual([]);
  });
  it('in the safety package only scoped-gate.ts names the claimed minter and the issued-gate predicate', () => {
    const named = (name: string) =>
      [...text.entries()]
        .filter(
          ([f, t]) =>
            f.startsWith('packages/safety/src/') &&
            !isTest(f) &&
            new RegExp(`\\b${name}\\b`).test(t),
        )
        .map(([f]) => f);
    expect(named('mintCapability')).toEqual(['packages/safety/src/scoped-gate.ts']);
    expect(named('isIssuedGate')).toEqual([
      'packages/safety/src/gate.ts',
      'packages/safety/src/scoped-gate.ts',
    ]);
  });
  it('the scoped-gate factory is named only inside safety, the unseal file (BU-2) and the pinned b09 test', () => {
    const fn = ['create', 'Scoped', 'Gate'].join('');
    // An actual import or re-export of the name; a comment that mentions it does not count.
    const users = withText(
      new RegExp(`(?:import|export)\\s*(?:type\\s*)?\\{[^}]*\\b${fn}\\b[^}]*\\}\\s*from`),
      (f) => !f.endsWith('sealed-callers.test.ts'),
    );
    expect(users.filter((f) => !f.startsWith('packages/safety/'))).toEqual([
      'apps/web/src/server/outbound.server.ts',
      'tests/mvp-b/b09-logs-clean.integration.test.ts',
    ]);
  });
  it('require is only ever called directly in tracked source (no alias, no comma call)', () => {
    const alias = /(?:=|,|\()\s*require\s*(?:[,)\];]|$)|\(\s*0\s*,\s*require\s*\)/m;
    const hits = [...text.entries()]
      .filter(
        ([f, t]) => !f.endsWith('sealed-callers.test.ts') && alias.test(t.replace(/\/\/.*$/gm, '')),
      )
      .map(([f]) => f);
    expect(hits).toEqual([]);
  });
});
