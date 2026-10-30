// SOP 5: every route handler file declares RouteMeta and builds each handler with
// withRoute(routeMeta, ...). Scans every app root (apps/web/src/app, apps/web/app) for route files
// of any extension and refuses any pages/api file (the pages router would bypass withRoute).
// `--check` exits 1 on any problem. `--root <dir>` points at another repository root.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { checkEntry, formatInventory } from '../packages/security/src/inventory.ts';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const rootIdx = args.indexOf('--root');
const root = rootIdx >= 0 ? resolve(args[rootIdx + 1] ?? '.') : resolve(here, '..');
const check = args.includes('--check');

const APP_ROOTS = ['apps/web/src/app', 'apps/web/app'];
const PAGES_ROOTS = ['apps/web/src/pages', 'apps/web/pages'];
const ROUTE_FILE = /^route\.(?:[cm]?[jt]s|[jt]sx)$/;

function walk(dir, accept, out = []) {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, accept, out);
    else if (accept(name)) out.push(p);
  }
  return out;
}

// Review 4 M6. The text check in inventory.ts is a first filter; this parse is the rule: each
// exported HTTP verb is a const whose initializer is exactly withRoute(routeMeta, ...), seen
// through parentheses and type assertions only.
const STREAM_WRAPPER_FILES = new Set(['apps/web/src/app/c/[token]/route.ts']);
const VERBS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
const peel = (n) => {
  while (
    ts.isParenthesizedExpression(n) ||
    ts.isAsExpression(n) ||
    ts.isSatisfiesExpression(n) ||
    ts.isNonNullExpression(n) ||
    ts.isTypeAssertionExpression(n)
  )
    n = n.expression;
  return n;
};
function metaProblems(d) {
  const out = [];
  const init = d.initializer === undefined ? undefined : peel(d.initializer);
  if (init === undefined || !ts.isObjectLiteralExpression(init)) {
    out.push('routeMeta must be an object literal');
    return out;
  }
  for (const prop of init.properties) {
    if (ts.isSpreadAssignment(prop)) out.push('routeMeta must not contain a spread');
    else if (prop.name !== undefined && ts.isComputedPropertyName(prop.name))
      out.push('routeMeta must not contain a computed key');
  }
  return out;
}
function astProblems(file, source) {
  const out = [];
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  for (const st of sf.statements) {
    if (!ts.isVariableStatement(st)) continue;
    if (!st.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) continue;
    for (const d of st.declarationList.declarations) {
      // BU-2 review nit: routeMeta is a plain object literal with plain keys. A computed key or a
      // spread could carry fail_safe_without_mfa (or any field) past the text check above.
      if (ts.isIdentifier(d.name) && d.name.text === 'routeMeta') out.push(...metaProblems(d));
      if (!ts.isIdentifier(d.name) || !VERBS.has(d.name.text)) continue;
      // The deps binding `withRoute(routeMeta, ...)(securityDeps)` is the one call allowed around it.
      let init = d.initializer === undefined ? undefined : peel(d.initializer);
      // The delivery route streams the article body; withStream only attaches the stream to
      // withRoute's own 200 answer. One named wrapper in one named file (decision D-016).
      if (
        init !== undefined &&
        STREAM_WRAPPER_FILES.has(relative(root, file).split(sep).join('/')) &&
        ts.isCallExpression(init) &&
        ts.isIdentifier(init.expression) &&
        init.expression.text === 'withStream' &&
        init.arguments.length === 1
      )
        init = peel(init.arguments[0]);
      if (
        init !== undefined &&
        ts.isCallExpression(init) &&
        init.arguments.length === 1 &&
        ts.isIdentifier(init.arguments[0]) &&
        init.arguments[0].text === 'securityDeps' &&
        ts.isCallExpression(peel(init.expression))
      )
        init = peel(init.expression);
      const ok =
        init !== undefined &&
        ts.isCallExpression(init) &&
        ts.isIdentifier(init.expression) &&
        init.expression.text === 'withRoute' &&
        init.arguments.length >= 1 &&
        ts.isIdentifier(init.arguments[0]) &&
        init.arguments[0].text === 'routeMeta';
      if (!ok)
        out.push(
          `handler ${d.name.text} must be exactly withRoute(routeMeta, ...), nothing around it`,
        );
    }
  }
  return out;
}

// 'use server' actions are handlers that never pass through withRoute; none is allowed.
const USE_SERVER_ALLOW = new Set([]);
const CODE_FILE = /\.(?:[cm]?[jt]s|[jt]sx)$/;
function useServerProblems(dir, out = []) {
  for (const name of readdirSync(dir).sort()) {
    if (name === 'node_modules' || name === '.next') continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) useServerProblems(p, out);
    else if (CODE_FILE.test(name) && !USE_SERVER_ALLOW.has(relative(root, p))) {
      const text = readFileSync(p, 'utf8');
      if (!/use server/.test(text)) continue;
      const sf = ts.createSourceFile(p, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
      let found = false;
      const visit = (n) => {
        if (
          ts.isExpressionStatement(n) &&
          ts.isStringLiteral(n.expression) &&
          n.expression.text === 'use server'
        )
          found = true;
        ts.forEachChild(n, visit);
      };
      visit(sf);
      if (found)
        out.push({
          file: relative(root, p),
          meta: null,
          problems: ["'use server' actions bypass withRoute; use an app route handler"],
        });
    }
  }
  return out;
}

const entries = [];
if (existsSync(join(root, 'apps/web'))) entries.push(...useServerProblems(join(root, 'apps/web')));
for (const rel of APP_ROOTS) {
  const appDir = join(root, rel);
  if (!existsSync(appDir)) continue;
  for (const f of walk(appDir, (n) => ROUTE_FILE.test(n))) {
    const source = readFileSync(f, 'utf8');
    const entry = checkEntry(relative(root, f), relative(appDir, f).split('\\').join('/'), source);
    entry.problems.push(...astProblems(f, source));
    entries.push(entry);
  }
}
for (const rel of PAGES_ROOTS) {
  const apiDir = join(root, rel, 'api');
  if (!existsSync(apiDir)) continue;
  for (const f of walk(apiDir, () => true))
    entries.push({
      file: relative(root, f),
      meta: null,
      problems: ['pages/api is not allowed: it bypasses withRoute; use an app route handler'],
    });
}

const table = formatInventory(entries);
if (table) console.log(table);
const bad = entries.filter((e) => e.problems.length > 0);
for (const e of bad) for (const p of e.problems) console.error(`route-inventory: ${e.file}: ${p}`);
if (check && bad.length > 0) {
  console.error(`route-inventory: FAILED (${bad.length} of ${entries.length} route files)`);
  process.exit(1);
}
console.log(`route-inventory: ok (${entries.length} route files)`);
