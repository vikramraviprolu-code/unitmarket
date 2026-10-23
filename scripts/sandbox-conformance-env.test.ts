// BU-6 condition on the lint exemption of scripts/sandbox-conformance.mjs: the file may read
// process.env ONLY for the flag UMS_SANDBOX_TESTS and the CI and AI marker names, one static
// member access each. Credentials, secrets and approval names are read by packages/config alone.
// This parses the file and fails on any other form: computed key, spread, destructuring, an alias of
// process or of env, Object.keys/entries/values/assign of env, `in`, delete, a bare `process.env`,
// a dynamic import of node:process, globalThis.process, or a call through a string.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from './test-helpers';

const FILE = 'scripts/sandbox-conformance.mjs';
/** The names the entry may read. Pinned: a change here is a reviewed change. */
export const ALLOWED_ENV_NAMES = [
  'UMS_SANDBOX_TESTS',
  'CI',
  'GITHUB_ACTIONS',
  'GITLAB_CI',
  'BUILDKITE',
  'CIRCLECI',
  'TRAVIS',
  'JENKINS_URL',
  'TF_BUILD',
  'TEAMCITY_VERSION',
  'APPVEYOR',
  'DRONE',
  'CODEBUILD_BUILD_ID',
  'BITBUCKET_BUILD_NUMBER',
  'RENDER',
  'CLAUDECODE',
  'CLAUDE_CODE_REMOTE',
] as const;
const FORBIDDEN_FRAGMENT = /paypal|secret|credential|password|passcode|token|approval|client|merchant|webhook|database|pglite|salt|link|session/i;

/** Every way the source touches process.env, as strings; empty means clean. */
export function envProblems(src: string, allowed: readonly string[]): string[] {
  const sf = ts.createSourceFile('x.mjs', src, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const bad: string[] = [];
  const where = (n: ts.Node) => `line ${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`;
  const isProcessEnv = (n: ts.Node): n is ts.PropertyAccessExpression | ts.ElementAccessExpression =>
    (ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n)) &&
    ts.isIdentifier(n.expression) &&
    n.expression.text === 'process' &&
    (ts.isPropertyAccessExpression(n)
      ? n.name.text === 'env'
      : ts.isStringLiteralLike(n.argumentExpression) && n.argumentExpression.text === 'env');
  const visit = (n: ts.Node): void => {
    // process used as a value anywhere except as `process.<member>` is an alias, a spread or a call
    if (ts.isIdentifier(n) && n.text === 'process') {
      const p = n.parent;
      const member =
        (ts.isPropertyAccessExpression(p) && p.expression === n) ||
        (ts.isElementAccessExpression(p) && p.expression === n);
      if (!member && !ts.isImportSpecifier(p) && !ts.isImportClause(p))
        bad.push(`${where(n)}: process used as a value`);
      if (ts.isElementAccessExpression(p) && p.expression === n) {
        const a = p.argumentExpression;
        if (!(ts.isStringLiteralLike(a) && a.text !== 'env'))
          bad.push(`${where(n)}: computed access on process`);
      }
    }
    if (ts.isIdentifier(n) && n.text === 'env') {
      const p = n.parent;
      const okMember = ts.isPropertyAccessExpression(p) && p.name === n && isProcessEnv(p);
      const isOtherProp = ts.isPropertyAccessExpression(p) && p.name === n && !isProcessEnv(p);
      const isKey = ts.isPropertyAssignment(p) && p.name === n;
      const isShorthand = ts.isShorthandPropertyAssignment(p);
      const isParamName = ts.isBindingElement(p) || ts.isParameter(p) || ts.isVariableDeclaration(p);
      if (!okMember && !isOtherProp && !isKey && !isShorthand && !isParamName)
        bad.push(`${where(n)}: env used outside process.env.NAME`);
      if (isParamName && ts.isBindingElement(p)) bad.push(`${where(n)}: env destructured`);
    }
    if (isProcessEnv(n)) {
      const p = n.parent;
      const named =
        ts.isPropertyAccessExpression(p) && p.expression === n && !ts.isCallExpression(p.parent);
      if (!named) bad.push(`${where(n)}: process.env used other than process.env.NAME`);
      else if (!allowed.includes((p as ts.PropertyAccessExpression).name.text))
        bad.push(`${where(n)}: process.env.${(p as ts.PropertyAccessExpression).name.text} not allowed`);
      if (ts.isElementAccessExpression(n)) bad.push(`${where(n)}: process['env']`);
    }
    if (
      ts.isStringLiteralLike(n) &&
      (n.text === 'node:process' || n.text === 'process') &&
      (ts.isImportDeclaration(n.parent) || ts.isCallExpression(n.parent))
    )
      bad.push(`${where(n)}: process imported`);
    if (ts.isIdentifier(n) && n.text === 'globalThis') bad.push(`${where(n)}: globalThis`);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return bad;
}

describe(`${FILE} reads the environment only for the flag and the CI and AI markers`, () => {
  const src = readFileSync(join(REPO_ROOT, FILE), 'utf8');
  it('uses no process.env form other than process.env.NAME with an allowed name', () => {
    expect(envProblems(src, ALLOWED_ENV_NAMES)).toEqual([]);
  });
  it('the allowed list names nothing credential, secret or approval related', () => {
    for (const n of ALLOWED_ENV_NAMES) expect(n).not.toMatch(FORBIDDEN_FRAGMENT);
  });
  it('reads the flag and every name of its marker lists', () => {
    const read = [...src.matchAll(/process\.env\.([A-Z_]+)/g)].map((m) => m[1]);
    expect(read).toContain('UMS_SANDBOX_TESTS');
    for (const n of ['CI', 'GITHUB_ACTIONS', 'CLAUDECODE', 'CLAUDE_CODE_REMOTE'])
      expect(read).toContain(n);
  });
});

describe('the pin catches every other form (mutation checks on the pin itself)', () => {
  const bad = (code: string) => envProblems(code, ALLOWED_ENV_NAMES);
  it.each([
    ['a credential name', 'const a = process.env.PAYPAL_CLIENT_SECRET;'],
    ['a secret name', 'const a = process.env.UMS_SESSION_SECRET;'],
    ['an approval name', 'const a = process.env.UMS_OUTBOUND_APPROVAL_REF;'],
    ['a computed key', 'const k = "CI"; const a = process.env[k];'],
    ['a string key', 'const a = process.env["PAYPAL_CLIENT_ID"];'],
    ['a spread', 'const a = { ...process.env };'],
    ['a destructure', 'const { CI } = process.env;'],
    ['an alias of env', 'const e = process.env; const a = e.CI;'],
    ['an alias of process', 'const p = process; const a = p.env.CI;'],
    ['Object.keys', 'const a = Object.keys(process.env);'],
    ['Object.entries', 'const a = Object.entries(process.env);'],
    ['Object.assign', 'const a = Object.assign({}, process.env);'],
    ['a bare process.env', 'foo(process.env);'],
    ['an in test', 'const a = "CI" in process.env;'],
    ['a delete', 'delete process.env.CI;'],
    ['globalThis.process', 'const a = globalThis.process.env.CI;'],
    ['import of node:process', 'import { env } from "node:process";'],
    ['default import of node:process', 'import p from "node:process";'],
    ['dynamic import of process', 'const p = await import("node:process");'],
    ['a computed member of process', 'const a = process["en" + "v"].CI;'],
  ])('flags %s', (_n, code) => {
    expect(bad(code).length).toBeGreaterThan(0);
  });
  it.each([
    ['an allowed name', 'const a = process.env.CI;'],
    ['the flag', 'const a = process.env.UMS_SANDBOX_TESTS === "1";'],
    ['other process members', 'const a = process.argv.slice(2); const b = process.stdin.isTTY; process.exit(1);'],
    ['an env key in an object literal', 'const o = { env: { CI: process.env.CI } };'],
  ])('accepts %s', (_n, code) => {
    expect(bad(code)).toEqual([]);
  });
});
