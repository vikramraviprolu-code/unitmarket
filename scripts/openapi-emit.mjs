// API-W0 (F1): writes the OpenAPI 3.1 document of /api/v1 from the zod contracts to
// docs/api/openapi-v1.json, or with --check compares the committed file to a fresh build.
//   node --import ./scripts/lib/ts-register.mjs scripts/openapi-emit.mjs [--check] [--out <file>]
// The build is pure: no network, no clock, no environment. Two runs give the same bytes.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildOpenApiV1 } from '../packages/contracts/src/v1.ts';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const args = process.argv.slice(2);
const outIdx = args.indexOf('--out');
const out =
  outIdx >= 0 ? resolve(args[outIdx + 1] ?? '') : resolve(root, 'docs', 'api', 'openapi-v1.json');
const check = args.includes('--check');

const fresh = `${JSON.stringify(buildOpenApiV1(), null, 2)}\n`;
const shown = relative(process.cwd(), out) || out;

if (check) {
  let committed = null;
  try {
    committed = readFileSync(out, 'utf8');
  } catch {
    committed = null;
  }
  if (committed !== fresh) {
    console.error(
      `openapi: ${shown} is stale or missing; run \`pnpm openapi:emit\` and commit the result`,
    );
    process.exit(1);
  }
  console.log(`openapi: ok (${shown})`);
} else {
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, fresh);
  console.log(`openapi: wrote ${shown}`);
}
