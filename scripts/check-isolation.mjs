// Fails when any file reaches the simulation repository or its package scopes, or imports a
// relative path that leaves the SBX repository. Architecture 2.2 rule 1.
//
//  - Code files (ts, tsx, mts, cts, js, mjs, cjs): parsed whole with the TypeScript API, so
//    multi-line import/export, import(), require() and import types are all seen. A specifier that
//    cannot be folded to a constant (a variable) is itself a violation.
//  - Config files (package.json, tsconfig*.json, pnpm-workspace.yaml): dependency names, link:,
//    file:, link:, portal: and workspace: paths, extends, paths, references and workspace globs;
//    any path that resolves outside the root (relative or absolute) fails.
//  - Provenance comments ("Origin: <repo>@<sha>:<path>") are text, not imports, and are allowed.
//  - Markdown is documentation and is not scanned.
//
// Usage: node scripts/check-isolation.mjs [--root <dir>]
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import ts from 'typescript';
import { listFiles, read, report, resolveRoot } from './lib/walk.mjs';

const NAME = 'check-isolation';
const ROOT = resolveRoot(process.argv, import.meta.url);

// Built from parts so this file does not contain the repository name it forbids.
const SIM_REPO = 'AIC_Hackathon_' + 'UnitMarket';
const CODE = /\.(ts|tsx|mts|cts|js|mjs|cjs)$/;
const TSCONFIG = /(^|\/)tsconfig[^/]*\.json$/;
const PACKAGE_JSON = /(^|\/)package\.json$/;
const WORKSPACE = /(^|\/)pnpm-workspace\.yaml$/;
const CONFIG = /(^|\/)(package\.json|tsconfig[^/]*\.json|pnpm-workspace\.yaml|\.npmrc)$/;
// Files that name the forbidden patterns as data.
const SKIP = new Set([
  'eslint.config.mjs',
  'scripts/check-isolation.mjs',
  'scripts/check-isolation.test.ts',
  'scripts/lint-rules.test.ts',
]);

const forbiddenSpecifier = (spec) => {
  if (spec.startsWith('@unitmarket/') || spec === '@unitmarket') return 'product scope @unitmarket';
  if (spec.startsWith('@unitmarket-sim/')) return 'simulation scope @unitmarket-sim';
  if (spec.includes(SIM_REPO)) return 'simulation repository path';
  if (/(^|\/)simulation(\/|$)/.test(spec)) return 'simulation path';
  return null;
};

const outsideRoot = (target) => {
  const rel = relative(ROOT, target);
  return rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel);
};
// A path that is relative to `fromDir` or absolute and lands outside the repository.
const escapes = (fromDir, p) =>
  (p.startsWith('.') || isAbsolute(p)) && outsideRoot(resolve(fromDir, p));

const violations = [];
const add = (file, line, why) => violations.push({ file, line, message: `isolation: ${why}` });

// Fold a string expression made of literals, `+` and substitution-free templates.
function fold(node) {
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isParenthesizedExpression(node)) return fold(node.expression);
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const l = fold(node.left);
    const r = fold(node.right);
    return l === null || r === null ? null : l + r;
  }
  if (ts.isTemplateExpression(node)) {
    let out = node.head.text;
    for (const span of node.templateSpans) {
      const v = fold(span.expression);
      if (v === null) return null;
      out += v + span.literal.text;
    }
    return out;
  }
  return null;
}

function checkCode(file, text) {
  const kind = /\.tsx$/.test(file.rel) ? ts.ScriptKind.TSX : undefined;
  const sf = ts.createSourceFile(file.rel, text, ts.ScriptTarget.Latest, true, kind);
  const lineOf = (node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  const spec = (node, value, how) => {
    const line = lineOf(node);
    const bad = forbiddenSpecifier(value);
    if (bad) add(file.rel, line, `${how} of ${bad} ("${value}")`);
    else if (escapes(dirname(file.abs), value))
      add(file.rel, line, `${how} leaves the repository ("${value}")`);
  };
  const visit = (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      if (ts.isStringLiteralLike(node.moduleSpecifier))
        spec(node, node.moduleSpecifier.text, 'import');
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteralLike(node.moduleReference.expression)
    ) {
      spec(node, node.moduleReference.expression.text, 'import');
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      if (ts.isStringLiteralLike(node.argument.literal))
        spec(node, node.argument.literal.text, 'import type');
    } else if (ts.isCallExpression(node)) {
      const isImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require';
      if ((isImport || isRequire) && node.arguments.length > 0) {
        const value = fold(node.arguments[0]);
        if (value === null)
          add(
            file.rel,
            lineOf(node),
            `${isImport ? 'import()' : 'require()'} with a specifier that is not a constant string`,
          );
        else spec(node, value, isImport ? 'import()' : 'require()');
      }
    } else if (ts.isStringLiteralLike(node) && node.text.includes(SIM_REPO)) {
      add(file.rel, lineOf(node), 'simulation repository name in code');
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

function checkTsconfig(file, text) {
  const { config, error } = ts.parseConfigFileTextToJson(file.rel, text);
  if (error || config === undefined) {
    add(file.rel, 1, 'tsconfig could not be parsed');
    return;
  }
  const dir = dirname(file.abs);
  const line = 1;
  const pathLike = (what, p) => {
    if (typeof p !== 'string') return;
    if (escapes(dir, p)) add(file.rel, line, `${what} leaves the repository ("${p}")`);
    const bad = forbiddenSpecifier(p);
    if (bad) add(file.rel, line, `${what} names ${bad} ("${p}")`);
  };
  const ext = config.extends;
  for (const e of Array.isArray(ext) ? ext : ext === undefined ? [] : [ext]) pathLike('extends', e);
  const co = config.compilerOptions ?? {};
  pathLike('baseUrl', co.baseUrl);
  for (const key of ['rootDir', 'outDir']) pathLike(key, co[key]);
  for (const [alias, targets] of Object.entries(co.paths ?? {})) {
    pathLike('paths alias', alias);
    for (const t of Array.isArray(targets) ? targets : []) pathLike('paths target', t);
  }
  for (const key of ['include', 'files', 'exclude'])
    for (const p of Array.isArray(config[key]) ? config[key] : []) pathLike(key, p);
  for (const r of Array.isArray(config.references) ? config.references : [])
    pathLike('references', r?.path);
}

function checkPackageJson(file, text) {
  const dir = dirname(file.abs);
  text.split('\n').forEach((line, i) => {
    for (const m of line.matchAll(/["'](?:link|file|portal|workspace):([^"']*)["']/g)) {
      if (escapes(dir, m[1]) || m[1].includes('simulation')) {
        add(file.rel, i + 1, `dependency path leaves the repository ("${m[0].slice(1, -1)}")`);
      }
    }
  });
}

function checkWorkspace(file, text) {
  const dir = dirname(file.abs);
  text.split('\n').forEach((line, i) => {
    const m = /^\s*-\s*['"]?([^'"#]+?)['"]?\s*(?:#.*)?$/.exec(line);
    if (!m) return;
    const glob = m[1].replace(/^!/, '');
    if (isAbsolute(glob) || glob.split('/').includes('..') || glob.includes('simulation'))
      add(
        file.rel,
        i + 1,
        `workspace entry leaves the repository or names the simulation ("${glob}")`,
      );
    else if (escapes(dir, glob))
      add(file.rel, i + 1, `workspace entry leaves the repository ("${glob}")`);
  });
}

for (const file of listFiles(ROOT)) {
  if (SKIP.has(file.rel)) continue;
  const text = read(file);

  if (CODE.test(file.rel)) checkCode(file, text);
  else if (CONFIG.test(file.rel)) {
    text.split('\n').forEach((line, i) => {
      if (line.includes(SIM_REPO)) add(file.rel, i + 1, 'simulation repository path in config');
      for (const m of line.matchAll(/["']((?:@unitmarket-sim|@unitmarket)\/[^"']*)["']/g)) {
        add(file.rel, i + 1, `package from a forbidden scope ("${m[1]}")`);
      }
    });
    if (TSCONFIG.test(file.rel)) checkTsconfig(file, text);
    else if (PACKAGE_JSON.test(file.rel)) checkPackageJson(file, text);
    else if (WORKSPACE.test(file.rel)) checkWorkspace(file, text);
  }
}
process.exit(report(NAME, violations));
