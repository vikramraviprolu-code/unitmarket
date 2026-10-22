// SOP 5: every route handler file declares RouteMeta. Reads apps/web/src/app/**/route.ts, checks
// each `export const routeMeta` literal with packages/security/src/inventory.ts and prints the
// route table. `--check` exits 1 on any problem. `--root <dir>` points at another repository root.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const rootIdx = args.indexOf('--root');
const root = rootIdx >= 0 ? resolve(args[rootIdx + 1] ?? '.') : resolve(here, '..');
const check = args.includes('--check');

const { checkEntry, formatInventory } = await import(
  pathToFileURL(join(here, '..', 'packages/security/src/inventory.ts')).href
);

function walk(dir, out = []) {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name === 'route.ts' || name === 'route.tsx') out.push(p);
  }
  return out;
}

const appDir = join(root, 'apps/web/src/app');
const files = existsSync(appDir) ? walk(appDir) : [];
const entries = files.map((f) =>
  checkEntry(relative(root, f), relative(appDir, f).split('\\').join('/'), readFileSync(f, 'utf8')),
);

const table = formatInventory(entries);
if (table) console.log(table);
const bad = entries.filter((e) => e.problems.length > 0);
for (const e of bad) for (const p of e.problems) console.error(`route-inventory: ${e.file}: ${p}`);
if (check && bad.length > 0) {
  console.error(`route-inventory: FAILED (${bad.length} of ${entries.length} route files)`);
  process.exit(1);
}
console.log(`route-inventory: ok (${entries.length} route files)`);
