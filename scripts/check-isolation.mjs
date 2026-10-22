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
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { findSymlinks, listFiles, read, report, resolveRoot } from './lib/walk.mjs';

const NAME = 'check-isolation';
const ROOT = resolveRoot(process.argv, import.meta.url);

// Built from parts so this file does not contain the repository name it forbids.
const SIM_REPO = 'AIC_Hackathon_' + 'UnitMarket';
const CODE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
// Other files that carry import statements or paths: scanned as text for every quoted string.
const TEXT_CODE = /\.(mdx|vue|svelte|astro|html?)$/;
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

// Remote and file URLs: an import of one leaves the repository whatever it names.
const urlEscape = (spec) => {
  if (/^(https?|wss?|ftp|data|blob):/i.test(spec)) return 'a remote or inline URL';
  if (/^file:/i.test(spec)) {
    try {
      return outsideRoot(fileURLToPath(spec)) ? 'a file URL outside the repository' : null;
    } catch {
      return 'a malformed file URL';
    }
  }
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

// Fold a string expression made of literals, `+`, substitution-free templates and module-level
// constants (`consts` maps a name to its folded value).
function fold(node, consts = new Map()) {
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node))
    return fold(node.expression, consts);
  if (ts.isIdentifier(node)) return consts.has(node.text) ? consts.get(node.text) : null;
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const l = fold(node.left, consts);
    const r = fold(node.right, consts);
    return l === null || r === null ? null : l + r;
  }
  if (ts.isTemplateExpression(node)) {
    let out = node.head.text;
    for (const span of node.templateSpans) {
      const v = fold(span.expression, consts);
      if (v === null) return null;
      out += v + span.literal.text;
    }
    return out;
  }
  return null;
}

// Path-building calls: join('..', 'x'), resolve(root, ...). Folded pieces are joined with '/', an
// unknown piece becomes '*', so a forbidden name split over arguments is still seen.
const PATH_FNS = new Set(['join', 'resolve', 'normalize', 'relative', 'pathToFileURL', 'URL']);

function checkCode(file, text) {
  const kind = /\.tsx$/.test(file.rel)
    ? ts.ScriptKind.TSX
    : /\.jsx$/.test(file.rel)
      ? ts.ScriptKind.JSX
      : undefined;
  const sf = ts.createSourceFile(file.rel, text, ts.ScriptTarget.Latest, true, kind);
  const lineOf = (node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  const spec = (node, value, how) => {
    const line = lineOf(node);
    const bad = forbiddenSpecifier(value) ?? urlEscape(value);
    if (bad) add(file.rel, line, `${how} of ${bad} ("${value}")`);
    else if (escapes(dirname(file.abs), value))
      add(file.rel, line, `${how} leaves the repository ("${value}")`);
  };
  // Review 4 M4: triple-slash references are imports in all but name.
  for (const ref of [
    ...sf.referencedFiles,
    ...sf.typeReferenceDirectives,
    ...sf.libReferenceDirectives,
  ]) {
    const line = sf.getLineAndCharacterOfPosition(ref.pos).line + 1;
    const bad = forbiddenSpecifier(ref.fileName) ?? urlEscape(ref.fileName);
    if (bad) add(file.rel, line, `reference of ${bad} ("${ref.fileName}")`);
    else if (escapes(dirname(file.abs), ref.fileName))
      add(file.rel, line, `reference leaves the repository ("${ref.fileName}")`);
  }
  // Module-level constants with a foldable value (two passes so one may build on another).
  const consts = new Map();
  for (let pass = 0; pass < 2; pass++) {
    const collect = (node) => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer &&
        !consts.has(node.name.text)
      ) {
        const v = fold(node.initializer, consts);
        if (v !== null) consts.set(node.name.text, v);
      }
      ts.forEachChild(node, collect);
    };
    collect(sf);
  }
  const calleeName = (e) =>
    ts.isIdentifier(e) ? e.text : ts.isPropertyAccessExpression(e) ? e.name.text : null;
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
    } else if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const args = node.arguments ?? [];
      const isImport =
        ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire =
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'require';
      if ((isImport || isRequire) && args.length > 0) {
        const value = fold(args[0], consts);
        if (value === null)
          add(
            file.rel,
            lineOf(node),
            `${isImport ? 'import()' : 'require()'} with a specifier that is not a constant string`,
          );
        else spec(node, value, isImport ? 'import()' : 'require()');
      } else if (args.length > 0) {
        // Any other call or construction (createRequire(...)(x), require.resolve(x), new Worker(x),
        // readFileSync(x), join(...)): a folded argument that names the simulation or climbs out of
        // the repository is a violation, whatever the callee is called.
        const name = calleeName(node.expression);
        const parts = args.map((a) => fold(a, consts));
        // A lone word (`.includes(name)`, a string compared in a test) is not a path.
        const candidates = parts.filter(
          (v) => v !== null && (v.includes('/') || v.startsWith('.')),
        );
        if (name !== null && PATH_FNS.has(name))
          candidates.push(parts.map((v) => (v === null ? '*' : v)).join('/'));
        for (const value of candidates) {
          const bad = forbiddenSpecifier(value);
          if (bad) add(file.rel, lineOf(node), `call argument names ${bad} ("${value}")`);
          else if (value.startsWith('.') && escapes(dirname(file.abs), value))
            add(file.rel, lineOf(node), `call argument leaves the repository ("${value}")`);
        }
      }
    } else if (ts.isStringLiteralLike(node) && node.text.includes(SIM_REPO)) {
      add(file.rel, lineOf(node), 'simulation repository name in code');
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

// Files with imports in a markup or MDX wrapper: every quoted string and every import line.
function checkTextCode(file, text) {
  text.split('\n').forEach((line, i) => {
    const strings = [...line.matchAll(/["'`]([^"'`]+)["'`]/g)].map((m) => m[1]);
    for (const value of strings) {
      const bad = forbiddenSpecifier(value) ?? urlEscape(value);
      if (bad) add(file.rel, i + 1, `reference to ${bad} ("${value}")`);
      else if (escapes(dirname(file.abs), value))
        add(file.rel, i + 1, `reference leaves the repository ("${value}")`);
    }
  });
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

// Review 4 M4: dependency values are parsed, not pattern-matched. A registry version or range,
// workspace:* and an npm: alias to an allowed package pass; git, github, tarball URLs, file: paths
// and owner/repo shorthands fail, as does an alias to a forbidden scope.
const DEP_SECTIONS = new Set([
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
  'overrides',
  'resolutions',
  'catalog',
  'catalogs',
]);
function checkDependencyValue(file, name, value) {
  if (typeof value !== 'string') return;
  const v = value.trim();
  const alias = /^npm:(@?[^@]+(?:\/[^@]+)?)(?:@.*)?$/.exec(v);
  const target = alias ? alias[1] : null;
  for (const n of [name, target]) {
    const bad = n ? forbiddenSpecifier(n + '/') : null;
    if (bad) add(file.rel, 1, `dependency "${name}" resolves to ${bad} ("${v}")`);
  }
  if (/^(git\+|git:|git@|github:|gitlab:|bitbucket:|gist:|ssh:|https?:|ftp:)/i.test(v))
    add(file.rel, 1, `dependency "${name}" is fetched from a URL or repository ("${v}")`);
  else if (/^[\w.-]+\/[\w.-]+(#.*)?$/.test(v) && !v.startsWith('.'))
    add(file.rel, 1, `dependency "${name}" is a repository shorthand ("${v}")`);
}
function walkDependencies(file, node, inSection) {
  if (node === null || typeof node !== 'object') return;
  for (const [k, v] of Object.entries(node)) {
    if (inSection && typeof v === 'string') checkDependencyValue(file, k, v);
    else walkDependencies(file, v, inSection || DEP_SECTIONS.has(k));
  }
}

function checkPackageJson(file, text) {
  const dir = dirname(file.abs);
  try {
    walkDependencies(file, JSON.parse(text), false);
  } catch {
    add(file.rel, 1, 'package.json could not be parsed');
  }
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
  else if (TEXT_CODE.test(file.rel)) checkTextCode(file, text);
  else if (CONFIG.test(file.rel)) {
    text.split('\n').forEach((line, i) => {
      if (line.includes(SIM_REPO)) add(file.rel, i + 1, 'simulation repository path in config');
      for (const m of line.matchAll(/(@unitmarket(?:-sim)?\/[^"'\s@,]*)/g)) {
        add(file.rel, i + 1, `package from a forbidden scope ("${m[1]}")`);
      }
    });
    if (TSCONFIG.test(file.rel)) checkTsconfig(file, text);
    else if (PACKAGE_JSON.test(file.rel)) checkPackageJson(file, text);
    else if (WORKSPACE.test(file.rel)) checkWorkspace(file, text);
  }
}
for (const link of findSymlinks(ROOT))
  add(link, 1, 'symbolic link inside the repository (a guard never follows one; remove it)');
process.exit(report(NAME, violations));
