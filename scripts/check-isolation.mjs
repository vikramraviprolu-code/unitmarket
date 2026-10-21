// Fails when any file reaches the simulation repository or its package scopes, or imports a
// relative path that leaves the SBX repository. Architecture 2.2 rule 1.
//
//  - Code files (ts, tsx, mts, cts, js, mjs, cjs): import/export/require/dynamic-import specifiers.
//  - Config files (package.json, tsconfig*.json, pnpm-workspace.yaml): dependency names, link:,
//    file: and workspace: paths, extends and paths entries.
//  - Provenance comments ("Origin: <repo>@<sha>:<path>") are text, not imports, and are allowed.
//  - Markdown is documentation and is not scanned.
//
// Usage: node scripts/check-isolation.mjs [--root <dir>]
import { dirname, relative, resolve, sep } from 'node:path';
import { listFiles, read, report, resolveRoot } from './lib/walk.mjs';

const NAME = 'check-isolation';
const ROOT = resolveRoot(process.argv, import.meta.url);

// Built from parts so this file does not contain the repository name it forbids.
const SIM_REPO = 'AIC_Hackathon_' + 'UnitMarket';
const CODE = /\.(ts|tsx|mts|cts|js|mjs|cjs)$/;
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

const IMPORT_RE = [
  /\bimport\s+(?:[^'"()]*?\sfrom\s*)?['"]([^'"]+)['"]/g,
  /\bexport\s+[^'";]*?\sfrom\s*['"]([^'"]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
];

const violations = [];
const add = (file, line, why) => violations.push({ file, line, message: `isolation: ${why}` });

for (const file of listFiles(ROOT)) {
  if (SKIP.has(file.rel)) continue;
  const text = read(file);
  const lines = text.split('\n');

  if (CODE.test(file.rel)) {
    lines.forEach((line, i) => {
      const t = line.trim();
      if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return;
      for (const re of IMPORT_RE) {
        for (const m of line.matchAll(re)) {
          const spec = m[1];
          const bad = forbiddenSpecifier(spec);
          if (bad) add(file.rel, i + 1, `import of ${bad} ("${spec}")`);
          else if (spec.startsWith('.')) {
            const target = resolve(dirname(file.abs), spec);
            const rel = relative(ROOT, target);
            if (rel.startsWith('..' + sep) || rel === '..') {
              add(file.rel, i + 1, `relative import leaves the repository ("${spec}")`);
            }
          } else if (line.includes(SIM_REPO)) {
            add(file.rel, i + 1, 'simulation repository name in code');
          }
        }
      }
      if (t.includes(SIM_REPO) && !IMPORT_RE.some((re) => new RegExp(re.source).test(line))) {
        add(file.rel, i + 1, 'simulation repository name in code');
      }
    });
  } else if (CONFIG.test(file.rel)) {
    lines.forEach((line, i) => {
      if (line.includes(SIM_REPO)) add(file.rel, i + 1, 'simulation repository path in config');
      for (const m of line.matchAll(/["']((?:@unitmarket-sim|@unitmarket)\/[^"']*)["']/g)) {
        add(file.rel, i + 1, `package from a forbidden scope ("${m[1]}")`);
      }
      for (const m of line.matchAll(/["'](?:link|file|workspace):([^"']*)["']/g)) {
        const p = m[1];
        if (p.startsWith('..') || p.includes('simulation')) {
          add(file.rel, i + 1, `dependency path leaves the repository ("${m[0].slice(1, -1)}")`);
        }
      }
    });
  }
}
process.exit(report(NAME, violations));
