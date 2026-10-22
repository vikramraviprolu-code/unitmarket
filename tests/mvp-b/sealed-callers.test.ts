// FIX-BPREP M3 structural seal. The approved sandbox transport is reachable only through a
// capability minted by @umsbx/safety, and no non-test code builds it today. This reads source
// text (no import, no network) so a new caller, a new minter, or a test that omits the fake wire
// fails here and is reviewed by a person before the transport is unsealed.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(new URL('../..', import.meta.url).pathname);
const SKIP = new Set(['node_modules', '.next', 'dist', '.git', 'coverage']);
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|mjs|js)$/.test(name)) out.push(p);
  }
  return out;
}
// Built at run time so this file does not itself name the production wire module.
const FETCH_WIRE_FN = ['create', 'Fetch', 'Wire'].join('');
const FETCH_WIRE_FILE = ['wire', 'fetch'].join('-');
const files = ['apps', 'domain', 'packages', 'tools', 'tests', 'scripts'].flatMap((d) =>
  walk(join(ROOT, d)),
);
const rel = (p: string) => relative(ROOT, p);
const text = new Map(files.map((f) => [rel(f), readFileSync(f, 'utf8')]));
const isTest = (f: string) => /\.test\.tsx?$/.test(f) || /\/test-support\.ts$/.test(f);
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

describe('who may build the approved sandbox transport', () => {
  it('non-test code calls createApprovedSandboxTransport only in the factory itself and the testkit subject', () => {
    const callers = withText(/\bcreateApprovedSandboxTransport\b/, (f) => !isTest(f));
    expect(callers).toEqual([
      'packages/testkit/src/stack.ts',
      'packages/transport/src/index.ts',
      'packages/transport/src/sandbox.ts',
    ]);
  });
  it('composition builds only the sealed zero-argument stub and never touches the approval pieces', () => {
    const composition = text.get('apps/web/composition.server.ts') ?? '';
    expect(composition).toContain('createSandboxTransport()');
    for (const banned of [
      'createApprovedSandboxTransport',
      'mintApprovalCapability',
      'createScopedGate',
      FETCH_WIRE_FN,
      FETCH_WIRE_FILE,
    ])
      expect(composition, banned).not.toContain(banned);
  });
  it('apps/web contains no reference to the approved transport at all', () => {
    expect(
      withText(
        new RegExp(
          `createApprovedSandboxTransport|mintApprovalCapability|createScopedGate|${FETCH_WIRE_FN}`,
        ),
        (f) => f.startsWith('apps/'),
      ),
    ).toEqual([]);
  });
  it('every test call passes a fake wire, so no test can fall back to the production Wire', () => {
    const missing: string[] = [];
    let calls = 0;
    for (const [f, t] of text) {
      if (!isTest(f) || f.endsWith('sealed-callers.test.ts')) continue;
      for (const args of callArgs(t, 'createApprovedSandboxTransport')) {
        calls += 1;
        if (!/\bwire\b/.test(args)) missing.push(f);
      }
    }
    expect(calls).toBeGreaterThan(5);
    expect(missing).toEqual([]);
  });
  it('the testkit sandbox subject requires a wire', () => {
    const stack = text.get('packages/testkit/src/stack.ts') ?? '';
    expect(stack).toMatch(
      /approved\?: \{ approval: ApprovalCapability; scope: string; wire: Wire \}/,
    );
    expect(stack).not.toMatch(/wire\?:/);
    for (const args of callArgs(stack, 'createApprovedSandboxTransport'))
      expect(args).toMatch(/\bwire:\s*approved\.wire\b/);
  });
});

describe('who may mint an approval capability', () => {
  it('non-test code mints only in the scoped gate (and the transport package that defines it)', () => {
    expect(withText(/\bmintApprovalCapability\b/, (f) => !isTest(f))).toEqual([
      'packages/safety/src/scoped-gate.ts',
      'packages/transport/src/approval.ts',
      'packages/transport/src/index.ts',
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
});
