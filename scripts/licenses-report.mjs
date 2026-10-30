// Dependency licence audit (decision item 8, lane L2).
//
// Reads `pnpm licenses list --json --prod` (offline: it reads the installed tree), writes
// THIRD-PARTY-NOTICES.md (package, version, licence) and exits 1 when a production dependency has a
// copyleft or unknown licence, unless the package is in ALLOW below with a written reason and the
// recorded licence still matches. Weak file level copyleft (MPL-2.0 and similar) is listed, not failed.
//
// Usage:
//   node scripts/licenses-report.mjs            write THIRD-PARTY-NOTICES.md, then judge
//   node scripts/licenses-report.mjs --check    write nothing; fail when the file is missing or stale
//   --input <file>   read the pnpm JSON from a file instead of running pnpm (tests)
//   --out <file>     notices path (default: THIRD-PARTY-NOTICES.md at the repository root)
//
// It reads declared licences from package metadata. It is an audit aid, not legal advice.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

// Explicit exceptions. A key is a package name, or a family name ending in `-*` (platform builds of
// one binary are matched as one family). `license` must equal the licence pnpm reports today, so a
// licence change on an upgrade fails again. `reason` is required.
/** @type {Record<string, { license: string, reason: string }>} */
export const ALLOW = {
  '@img/sharp-libvips-*': {
    license: 'LGPL-3.0-or-later',
    reason:
      'Prebuilt libvips shared library (a separate .so file) that sharp loads. sharp is an optional ' +
      'dependency of next. It is installed from npm, is not modified and is not copied into this ' +
      'repository, and a user can replace the file. The licence text ships inside the package.',
  },
};

const PERMISSIVE = new Set([
  'MIT',
  'MIT-0',
  'ISC',
  'BSD-2-CLAUSE',
  'BSD-3-CLAUSE',
  '0BSD',
  'APACHE-2.0',
  'BLUEOAK-1.0.0',
  'CC0-1.0',
  'UNLICENSE',
  'ZLIB',
  'PYTHON-2.0',
  'CC-BY-4.0',
]);
const WEAK = /^(MPL-|EPL-|CDDL-)/;
const COPYLEFT = /^(GPL|AGPL|LGPL|SSPL|EUPL|OSL-|CC-BY-SA|CC-BY-NC)/;

// Badness order: an AND takes the worst side, an OR takes the best side.
const RANK = { permissive: 0, weak: 1, unknown: 2, copyleft: 3 };
const worst = (a, b) => (RANK[a] >= RANK[b] ? a : b);
const best = (a, b) => (RANK[a] <= RANK[b] ? a : b);

function classifyId(raw) {
  const id = raw.replace(/\+$/, '').toUpperCase();
  if (PERMISSIVE.has(id)) return 'permissive';
  if (COPYLEFT.test(id)) return 'copyleft';
  if (WEAK.test(id)) return 'weak';
  return 'unknown';
}

/** Classify an SPDX style expression: 'permissive' | 'weak' | 'copyleft' | 'unknown'. */
export function classify(expression) {
  const text = String(expression ?? '').trim();
  if (!text) return 'unknown';
  const tokens = text.match(/\(|\)|[^\s()]+/g) ?? [];
  let pos = 0;
  const fail = Symbol('parse');
  const orExpr = () => {
    let v = andExpr();
    while (tokens[pos] === 'OR') {
      pos += 1;
      v = best(v, andExpr());
    }
    return v;
  };
  const andExpr = () => {
    let v = atom();
    while (tokens[pos] === 'AND') {
      pos += 1;
      v = worst(v, atom());
    }
    return v;
  };
  const atom = () => {
    const t = tokens[pos];
    if (t === undefined || t === ')' || t === 'AND' || t === 'OR') throw fail;
    pos += 1;
    if (t === '(') {
      const v = orExpr();
      if (tokens[pos] !== ')') throw fail;
      pos += 1;
      return v;
    }
    if (tokens[pos] === 'WITH') {
      pos += 2; // an exception clause does not make a copyleft licence permissive
    }
    return classifyId(t);
  };
  try {
    const v = orExpr();
    return pos === tokens.length ? v : 'unknown';
  } catch (e) {
    if (e === fail) return 'unknown';
    throw e;
  }
}

// Platform builds of one binary (for example @next/swc-linux-x64-gnu) are reported as one family,
// so the notices file reads the same on every machine.
const PLATFORM = /^(.+?)-(?:darwin|linux|linuxmusl|win32|freebsd|android)-[a-z0-9]+(?:-[a-z]+)?$/;
const family = (name) => {
  const m = PLATFORM.exec(name);
  return m ? `${m[1]}-*` : name;
};

function checkAllow(allow) {
  for (const [key, entry] of Object.entries(allow)) {
    if (!entry || typeof entry.reason !== 'string' || entry.reason.trim() === '') {
      throw new Error(`allow-list entry ${key} needs a written reason`);
    }
    if (typeof entry.license !== 'string' || entry.license.trim() === '') {
      throw new Error(`allow-list entry ${key} needs the licence it was reviewed under`);
    }
  }
}

/**
 * @param {Record<string, Array<{ name: string, versions?: string[], license?: string }>>} groups
 * @param {Record<string, { license?: string, reason?: string }>} [allow]
 * groups: pnpm's JSON, { "<licence>": [{ name, versions: [...], license }] }.
 * Returns { rows, failures, weak, allowed } with rows sorted by name then version.
 */
export function evaluate(groups, allow = ALLOW) {
  checkAllow(allow);
  const seen = new Set();
  const rows = [];
  for (const [groupLicense, pkgs] of Object.entries(groups)) {
    for (const p of pkgs) {
      const license = p.license ?? groupLicense;
      const name = family(p.name);
      for (const version of p.versions ?? []) {
        const key = `${name}\u0000${version}\u0000${license}`;
        if (seen.has(key)) continue;
        seen.add(key);
        rows.push({ name, version, license, verdict: classify(license) });
      }
    }
  }
  const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  rows.sort((a, b) => byText(a.name, b.name) || byText(a.version, b.version));
  const failures = [];
  const allowed = [];
  const weak = [];
  for (const r of rows) {
    if (r.verdict === 'weak') weak.push(r);
    if (r.verdict !== 'copyleft' && r.verdict !== 'unknown') continue;
    const entry = allow[r.name];
    if (entry && entry.license === r.license) allowed.push({ ...r, reason: entry.reason });
    else failures.push(r);
  }
  return { rows, failures, weak, allowed };
}

const PRINT_WIDTH = 100; // prettier's width: wider tables fall back to the compact form

function table(headers, body) {
  const widths = headers.map((h, i) => Math.max(3, h.length, ...body.map((r) => r[i].length)));
  const aligned = (cells) => `| ${cells.map((c, i) => c.padEnd(widths[i])).join(' | ')} |`;
  const compact = (cells) => `| ${cells.join(' | ')} |`;
  const fits = aligned(headers).length <= PRINT_WIDTH;
  const line = fits ? aligned : compact;
  const sep = fits
    ? `| ${widths.map((w) => '-'.repeat(w)).join(' | ')} |`
    : `| ${headers.map(() => '---').join(' | ')} |`;
  return [line(headers), sep, ...body.map(line)].join('\n');
}

/** Render the notices file. Pure and deterministic: no date, no local path. */
export function renderNotices(result) {
  const { rows, weak, allowed } = result;
  const counts = new Map();
  for (const r of rows) counts.set(r.license, (counts.get(r.license) ?? 0) + 1);
  const summary = [...counts.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const out = [];
  out.push('# Third party notices');
  out.push(
    'Production dependencies of this repository and their declared licences, generated by ' +
      '`node scripts/licenses-report.mjs` from `pnpm licenses list --json --prod`. Do not edit by ' +
      'hand. Platform specific binary packages are shown once as a family (`name-*`); only the ' +
      'variant for the build machine is installed. Licences are as declared in package metadata. ' +
      'This is an audit aid, not legal advice. The licence of this repository is Apache-2.0 (see `LICENSE`).',
  );
  out.push('## Summary');
  out.push(
    table(
      ['Licence', 'Packages'],
      summary.map(([l, n]) => [l, String(n)]),
    ),
  );
  out.push('## Reviewed exceptions');
  if (allowed.length === 0) out.push('None.');
  else {
    out.push(
      'These packages have a copyleft or unknown licence and are accepted on a written reason in ' +
        '`scripts/licenses-report.mjs`.',
    );
    out.push(
      allowed.map((a) => `- \`${a.name}\` ${a.version}, ${a.license}: ${a.reason}`).join('\n'),
    );
  }
  out.push('## Weak copyleft');
  if (weak.length === 0) out.push('None.');
  else {
    out.push('File level copyleft licences. Used unmodified; listed so the choice is visible.');
    out.push(weak.map((w) => `- \`${w.name}\` ${w.version}, ${w.license}`).join('\n'));
  }
  out.push('## All production packages');
  out.push(
    table(
      ['Package', 'Version', 'Licence'],
      rows.map((r) => [r.name, r.version, r.license]),
    ),
  );
  return `${out.join('\n\n')}\n`;
}

function parseArgs(argv) {
  const opts = { check: false, input: null, out: resolve(ROOT, 'THIRD-PARTY-NOTICES.md') };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--check') opts.check = true;
    else if (a === '--input') opts.input = resolve(argv[++i]);
    else if (a === '--out') opts.out = resolve(argv[++i]);
    else throw new Error(`unknown argument ${a}`);
  }
  return opts;
}

function readGroups(input) {
  if (input) return JSON.parse(readFileSync(input, 'utf8'));
  const r = spawnSync('corepack', ['pnpm', 'licenses', 'list', '--json', '--prod'], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0) {
    throw new Error(
      `pnpm licenses failed (exit ${r.status}): ${(r.stderr || '').trim().slice(0, 400)}`,
    );
  }
  return JSON.parse(r.stdout);
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const result = evaluate(readGroups(opts.input));
  const notices = renderNotices(result);
  let problems = 0;

  if (opts.check) {
    const current = existsSync(opts.out) ? readFileSync(opts.out, 'utf8') : null;
    if (current === null) {
      console.error(
        `licenses-report: ${opts.out} is missing; run node scripts/licenses-report.mjs`,
      );
      problems += 1;
    } else if (current !== notices) {
      console.error(
        `licenses-report: ${opts.out} is stale (out of date); run node scripts/licenses-report.mjs`,
      );
      problems += 1;
    }
  } else {
    writeFileSync(opts.out, notices);
  }

  for (const a of result.allowed) {
    console.log(`licenses-report: allowed ${a.name}@${a.version} (${a.license}): ${a.reason}`);
  }
  for (const w of result.weak) {
    console.log(`licenses-report: weak copyleft ${w.name}@${w.version} (${w.license})`);
  }
  for (const f of result.failures) {
    console.error(
      `licenses-report: FAIL ${f.name}@${f.version} has ${f.verdict} licence ${f.license || '(none)'}`,
    );
    problems += 1;
  }
  console.log(
    `licenses-report: ${result.rows.length} production packages, ${result.failures.length} failing, ` +
      `${result.allowed.length} allowed by exception, ${result.weak.length} weak copyleft`,
  );
  process.exit(problems > 0 ? 1 : 0);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (e) {
    console.error(`licenses-report: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(2);
  }
}
