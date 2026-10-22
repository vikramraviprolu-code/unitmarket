// Shared by the three guard scripts. No dependencies. Walks a directory tree, skipping
// dependency, build and local-data directories and local env files (which may hold secrets and are
// never read by a guard).
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.next',
  'dist',
  'coverage',
  '.data',
  '.pglite',
  '.recordings',
  '.sbx-local',
]);
const SKIP_FILES = new Set(['pnpm-lock.yaml']);
const BINARY = /\.(png|jpe?g|gif|ico|webp|woff2?|ttf|otf|pdf|zip|gz|wasm)$/i;

/** Parse `--root <dir>`; default is the repository root (parent of scripts/). */
export function resolveRoot(argv, scriptUrl) {
  const i = argv.indexOf('--root');
  if (i >= 0 && argv[i + 1]) return resolve(argv[i + 1]);
  return resolve(new URL('..', scriptUrl).pathname);
}

/** Every readable text file under root: { rel, abs }. Local env files are never returned,
 * except `.env.example`. */
export function listFiles(root) {
  const out = [];
  const visit = (dir) => {
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name);
      // Review 4 M4: a symlink is never followed (it can lead out of the repository); the
      // isolation guard reports every one through findSymlinks.
      const st = lstatSync(abs);
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) {
        if (!SKIP_DIRS.has(name)) visit(abs);
        continue;
      }
      if (SKIP_FILES.has(name) || BINARY.test(name)) continue;
      if ((name === '.env' || name.startsWith('.env.')) && name !== '.env.example') continue;
      out.push({ rel: relative(root, abs).split(sep).join('/'), abs });
    }
  };
  visit(root);
  return out.sort((a, b) => (a.rel < b.rel ? -1 : 1));
}

/** Every symbolic link under root (outside the skipped directories), as repository paths. */
export function findSymlinks(root) {
  const out = [];
  const visit = (dir) => {
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name);
      const st = lstatSync(abs);
      if (st.isSymbolicLink()) out.push(relative(root, abs).split(sep).join('/'));
      else if (st.isDirectory() && !SKIP_DIRS.has(name)) visit(abs);
    }
  };
  visit(root);
  return out.sort();
}

export function read(file) {
  return readFileSync(file.abs, 'utf8');
}

export function report(name, violations) {
  if (violations.length === 0) {
    console.log(`${name}: ok`);
    return 0;
  }
  for (const v of violations) console.error(`${name}: ${v.file}:${v.line}: ${v.message}`);
  console.error(`${name}: FAILED with ${violations.length} violation(s)`);
  return 1;
}
