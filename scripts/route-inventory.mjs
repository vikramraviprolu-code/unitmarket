// SOP 5: every route handler file declares RouteMeta and builds each handler with
// withRoute(routeMeta, ...). Scans every app root (apps/web/src/app, apps/web/app) for route files
// of any extension and refuses any pages/api file (the pages router would bypass withRoute).
// `--check` exits 1 on any problem. `--root <dir>` points at another repository root.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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

const entries = [];
for (const rel of APP_ROOTS) {
  const appDir = join(root, rel);
  if (!existsSync(appDir)) continue;
  for (const f of walk(appDir, (n) => ROUTE_FILE.test(n)))
    entries.push(
      checkEntry(
        relative(root, f),
        relative(appDir, f).split('\\').join('/'),
        readFileSync(f, 'utf8'),
      ),
    );
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
