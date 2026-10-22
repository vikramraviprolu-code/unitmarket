// Scans the Next.js build output (client and server chunks) for secrets (architecture A-25).
//
//   node scripts/check-bundle-secrets.mjs --print-env     canary NAME=value lines for the build step
//   node scripts/check-bundle-secrets.mjs [--root <app>]  scan <app>/.next (default apps/web)
//
// Flow: export the canary values as the build environment (--print-env), run `next build`, then run
// this scan. Fails (exit 1) when any canary value appears in any file under .next, or when a
// client-exposed variable name other than NEXT_PUBLIC_UMS_ENV_LABEL appears there. Exit 2 when there
// is no build output to scan. Canary values are synthetic and carry no meaning; they are still
// never printed by the scan, only the variable name.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// Every server-side name from .env.example that could carry a secret or an internal value.
export const CANARY_NAMES = [
  'PAYPAL_CLIENT_ID',
  'PAYPAL_CLIENT_SECRET',
  'PAYPAL_WEBHOOK_ID',
  'DATABASE_URL',
  'UMS_SESSION_SECRET',
  'UMS_APPROVAL_SECRET',
  'UMS_LINK_SECRET',
  'UMS_DEMO_PASSCODE_HASH',
  'UMS_OUTBOUND_APPROVAL_REF',
];
const canaryValue = (name) => `CANARY_SBX_${name}_c0ffee9a1b2d`;
const ALLOWED_PUBLIC = new Set(['NEXT_PUBLIC_UMS_ENV_LABEL']);
// Next.js ships this error-code string in every build; it is a framework constant, not a public name.
const FRAMEWORK_STRINGS = new Set([['PUBLIC', 'DIR_MIDDLEWARE_CONFLICT'].join('_')]);
const CLIENT_NAME =
  /\b((?:NEXT_PUBLIC|VITE|REACT_APP|EXPO_PUBLIC|GATSBY|NUXT_PUBLIC|PUBLIC)_[A-Z0-9_]+)\b/g;

function files(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) files(abs, out);
    else out.push(abs);
  }
  return out;
}

function main(argv) {
  if (argv.includes('--print-env')) {
    for (const n of CANARY_NAMES) console.log(`${n}=${canaryValue(n)}`);
    return 0;
  }
  const i = argv.indexOf('--root');
  const appDir = resolve(
    i >= 0 && argv[i + 1] ? argv[i + 1] : fileURLToPath(new URL('../apps/web', import.meta.url)),
  );
  const next = join(appDir, '.next');
  if (!existsSync(next)) {
    console.error(`check-bundle-secrets: no build output at ${next}; run next build first`);
    return 2;
  }
  const violations = [];
  for (const abs of files(next)) {
    const text = readFileSync(abs, 'latin1');
    const rel = relative(appDir, abs).split(sep).join('/');
    for (const n of CANARY_NAMES)
      if (text.includes(canaryValue(n)))
        violations.push(`${rel}: value of ${n} is present in the build output`);
    for (const m of new Set([...text.matchAll(CLIENT_NAME)].map((x) => x[1])))
      if (!ALLOWED_PUBLIC.has(m) && !FRAMEWORK_STRINGS.has(m))
        violations.push(
          `${rel}: client-exposed name ${m}; only NEXT_PUBLIC_UMS_ENV_LABEL may be public`,
        );
  }
  if (violations.length === 0) {
    console.log('check-bundle-secrets: ok');
    return 0;
  }
  for (const v of violations) console.error(`check-bundle-secrets: ${v}`);
  console.error(`check-bundle-secrets: FAILED with ${violations.length} violation(s)`);
  return 1;
}

process.exitCode = main(process.argv.slice(2));
