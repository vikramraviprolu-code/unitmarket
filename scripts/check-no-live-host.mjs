// Fails when any file contains a live PayPal API hostname, or the sandbox hostname outside the one
// constant module. Architecture 2.3 rule S7 and section 7 (connection safety).
//
//  - Live hosts are forbidden everywhere except in markdown under docs/design/, and only when that
//    folder holds the marker file `.allow-live-hostnames`.
//  - The sandbox API host may appear only in packages/transport/src/endpoints.ts (the one constant
//    module) and in docs/design/. Other sandbox subdomains (for the approve link or certificate
//    host) are not API hosts and are not flagged here.
//
// Usage: node scripts/check-no-live-host.mjs [--root <dir>]
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { listFiles, read, report, resolveRoot } from './lib/walk.mjs';

const NAME = 'check-no-live-host';
const ROOT = resolveRoot(process.argv, import.meta.url);

const ALLOWED_DOCS_DIR = 'docs/design/';
const MARKER = '.allow-live-hostnames';
const SANDBOX_CONSTANT_MODULE = 'packages/transport/src/endpoints.ts';

// Built from parts so this file does not contain the strings it forbids.
const P = 'paypal' + '.com';
const LIVE = [
  new RegExp(
    `(?<![A-Za-z0-9.-])(?:api-m|api|api-3t|api-aa|api-aa-3t|ipnpb|www|svcs|payflowpro|pilot-payflowpro)\\.${P.replace('.', '\\.')}`,
    'i',
  ),
  // the bare host (no subdomain) directly after a URL scheme
  new RegExp(`//${P.replace('.', '\\.')}(?![A-Za-z0-9.-])`, 'i'),
];
const SANDBOX_API = new RegExp(`api-m\\.sandbox\\.${P.replace('.', '\\.')}`, 'i');

const docsAllowed =
  existsSync(join(ROOT, ALLOWED_DOCS_DIR, MARKER)) ||
  // the fixture and the real folder both ship the marker; without it nothing is allow-listed
  false;

const violations = [];
for (const file of listFiles(ROOT)) {
  const inDocsAllow =
    docsAllowed && file.rel.startsWith(ALLOWED_DOCS_DIR) && file.rel.endsWith('.md');
  const isConstant = file.rel === SANDBOX_CONSTANT_MODULE;
  const text = read(file);
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    if (inDocsAllow) return;
    if (LIVE.some((re) => re.test(line))) {
      violations.push({
        file: file.rel,
        line: i + 1,
        message: `live PayPal hostname (forbidden; only docs under ${ALLOWED_DOCS_DIR} may name one)`,
      });
    }
    if (SANDBOX_API.test(line) && !isConstant) {
      violations.push({
        file: file.rel,
        line: i + 1,
        message: `sandbox hostname outside the one constant module (${SANDBOX_CONSTANT_MODULE})`,
      });
    }
  });
}
process.exit(report(NAME, violations));
