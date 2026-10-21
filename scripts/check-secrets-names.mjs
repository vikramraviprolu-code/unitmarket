// Fails when a client-exposed variable name could carry a secret, or when .env.example holds a value.
//
//  - Names starting with NEXT_PUBLIC_, VITE_, REACT_APP_, EXPO_PUBLIC_, GATSBY_, NUXT_PUBLIC_ or
//    PUBLIC_ are shipped to the browser. The only one allowed is NEXT_PUBLIC_UMS_ENV_LABEL.
//  - .env.example holds names only: every assignment must have an empty value.
// Values are never printed.
//
// Usage: node scripts/check-secrets-names.mjs [--root <dir>]
import { listFiles, read, report, resolveRoot } from './lib/walk.mjs';

const NAME = 'check-secrets-names';
const ROOT = resolveRoot(process.argv, import.meta.url);
const ALLOWED_PUBLIC = new Set(['NEXT_PUBLIC_UMS_ENV_LABEL']);
const CLIENT_NAME =
  /\b((?:NEXT_PUBLIC|VITE|REACT_APP|EXPO_PUBLIC|GATSBY|NUXT_PUBLIC|PUBLIC)_[A-Z0-9_]+)\b/g;
const TEXT_EXT = /\.(ts|tsx|mts|cts|js|mjs|cjs|json|ya?ml|md|toml|example|env)$|\.env\.example$/;
// Files that talk about the rule itself.
const SKIP = new Set([
  'scripts/check-secrets-names.mjs',
  'scripts/check-secrets-names.test.ts',
  'eslint.config.mjs',
]);
const isDesignDoc = (rel) => rel.startsWith('docs/design/');

const violations = [];
for (const file of listFiles(ROOT)) {
  if (SKIP.has(file.rel) || isDesignDoc(file.rel)) continue;
  const isEnvExample = file.rel === '.env.example' || file.rel.endsWith('/.env.example');
  if (!isEnvExample && !TEXT_EXT.test(file.rel)) continue;
  const lines = read(file).split('\n');
  lines.forEach((line, i) => {
    const code = line.trim();
    if (isEnvExample && code && !code.startsWith('#')) {
      const eq = code.indexOf('=');
      if (eq > 0 && code.slice(eq + 1).trim() !== '') {
        violations.push({
          file: file.rel,
          line: i + 1,
          message: `${code.slice(0, eq)} has a value; .env.example is names only`,
        });
      }
    }
    if (isEnvExample && code.startsWith('#')) return;
    for (const m of line.matchAll(CLIENT_NAME)) {
      if (!ALLOWED_PUBLIC.has(m[1])) {
        violations.push({
          file: file.rel,
          line: i + 1,
          message: `${m[1]} is a client-exposed name; only NEXT_PUBLIC_UMS_ENV_LABEL may be public`,
        });
      }
    }
  });
}
process.exit(report(NAME, violations));
