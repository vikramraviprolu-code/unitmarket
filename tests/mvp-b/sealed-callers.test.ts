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
const FETCH_WIRE_FN = ['create', 'Fetch', 'Wire'].join('');
const FETCH_WIRE_FILE = ['wire', 'fetch'].join('-');
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
  it('non-test code calls the approved factory only in the factory itself and the package index', () => {
    const callers = withText(new RegExp(`\\b${FACTORY}\\b`), (f) => !isTest(f));
    expect(callers).toEqual([
      'packages/transport/src/index.ts',
      'packages/transport/src/sandbox.ts',
    ]);
  });
  it('composition builds only the sealed zero-argument stub and never touches the approval pieces', () => {
    const composition = text.get('apps/web/composition.server.ts') ?? '';
    expect(composition).toContain('createSandboxTransport()');
    for (const banned of [
      FACTORY,
      CLAIM,
      OLD_MINTER,
      'createScopedGate',
      FETCH_WIRE_FN,
      FETCH_WIRE_FILE,
    ])
      expect(composition, banned).not.toContain(banned);
  });
  it('apps/web contains no reference to the approved transport at all', () => {
    expect(
      withText(
        new RegExp(`${FACTORY}|${CLAIM}|${OLD_MINTER}|createScopedGate|${FETCH_WIRE_FN}`),
        (f) => f.startsWith('apps/'),
      ),
    ).toEqual([]);
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
    expect(sandbox).toMatch(/wire: Wire \| 'production'/);
  });
  it("the 'production' sentinel is written only by composition and the transport package's own tests", () => {
    const sentinel = /\bwire\s*:\s*['"`]production['"`]/;
    const users = withText(sentinel, (f) => !f.endsWith('sealed-callers.test.ts'));
    for (const f of users)
      expect(f === 'apps/web/composition.server.ts' || (isTransportSrc(f) && isTest(f)), f).toBe(
        true,
      );
    // Today composition builds only the sealed stub, so nobody but the transport tests uses it.
    expect(users.filter((f) => !isTransportSrc(f))).toEqual([]);
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
  it('non-test code builds a minter only inside approval.ts; test code only in the transport package', () => {
    expect(withText(new RegExp(`\\b${MAKE_MINTER}\\b`), (f) => !isTest(f))).toEqual([
      'packages/transport/src/approval.ts',
    ]);
    expect(
      withText(
        new RegExp(`\\b${MAKE_MINTER}\\b`),
        (f) => isTest(f) && !f.endsWith('sealed-callers.test.ts'),
      ).filter((f) => !isTransportSrc(f)),
    ).toEqual([]);
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
    ).toEqual(['packages/paypal/src/sandbox-wire.integration.test.ts']);
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
    expect(gate).toMatch(/issued\.add\(gate\)/);
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
