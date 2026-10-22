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
import ts from 'typescript';
import { listFiles, read, report, resolveRoot } from './lib/walk.mjs';

const NAME = 'check-no-live-host';
const ROOT = resolveRoot(process.argv, import.meta.url);

const ALLOWED_DOCS_DIR = 'docs/design/';
const MARKER = '.allow-live-hostnames';
const SANDBOX_CONSTANT_MODULE = 'packages/transport/src/endpoints.ts';

// Built from parts so this file does not contain the strings it forbids.
const P = 'paypal' + '.com';
const PAYPAL = 'pay' + 'pal';
// Any host under the two registrable names, with or without subdomains (review 4 M5). The label
// boundary on both sides keeps "notpaypal.com" and "paypal.community" out.
const HOST = new RegExp(
  `(?<![a-z0-9-])((?:[a-z0-9-]+\\.)*)${PAYPAL}(?:objects)?\\.com(?![a-z0-9-])`,
  'gi',
);
const SANDBOX_TAIL = new RegExp(`(?:^|\\.)sandbox\\.${P.replace('.', '\\.')}$`, 'i');
// Any sandbox API host spelling (api-m. or api.) counts: only the constant module may name one.
const SANDBOX_API_HOST = new RegExp(
  `^(?:.*\\.)?api(?:-m)?\\.sandbox\\.${P.replace('.', '\\.')}$`,
  'i',
);

/** { live, sandboxApi } for the hosts named in one piece of text. */
const LEGACY_LIVE = new RegExp(
  `(?<![a-z0-9-])(?:api-m|api|api-3t|api-aa|api-aa-3t|ipnpb|www|svcs|payflowpro|pilot-payflowpro)\\.${P.replace('.', '\\.')}`,
  'i',
);
function classify(view, strict = true) {
  let live = false;
  let sandboxApi = false;
  if (!strict) {
    // Test files hold name pieces ('paypal.com' alone) on purpose: only complete API hosts count.
    return { live: LEGACY_LIVE.test(view) && !SANDBOX_TAIL.test(view), sandboxApi: false };
  }
  for (const m of view.matchAll(HOST)) {
    const full = m[0];
    if (/^developer\.paypal\.com$/i.test(full)) continue; // documentation links, no API behind it
    if (SANDBOX_TAIL.test(full)) {
      if (SANDBOX_API_HOST.test(full)) sandboxApi = true;
    } else live = true;
  }
  return { live, sandboxApi };
}

// Review L1 and review 4 M5: look at the text the way a parser would, not as typed. Decode JSON and
// JS escapes (\\uXXXX, \\xXX, \\/), percent-escapes (repeatedly), NFKC-normalise (fullwidth letters
// and dots), map the other full-stop characters to a dot, and remove the code points IDNA ignores
// (soft hyphen, U+034F, zero-width characters, variation selectors, bidi and format controls).
const DOTS = /[\u3002\uFF61\uFE52\u2024\u2E2E]/g;
const IGNORED_RANGES = [
  [0xad, 0xad],
  [0x34f, 0x34f],
  [0x61c, 0x61c],
  [0x115f, 0x1160],
  [0x17b4, 0x17b5],
  [0x180b, 0x180f],
  [0x200b, 0x200f],
  [0x202a, 0x202e],
  [0x2060, 0x206f],
  [0x3164, 0x3164],
  [0xfe00, 0xfe0f],
  [0xfeff, 0xfeff],
  [0xffa0, 0xffa0],
  [0xe0000, 0xe01ef],
];
// Not a regex character class: lint rejects combining marks and joiners inside one.
const stripIgnored = (t) =>
  Array.from(t)
    .filter((ch) => {
      const cp = ch.codePointAt(0);
      return !IGNORED_RANGES.some(([lo, hi]) => cp >= lo && cp <= hi);
    })
    .join('');
function decodeOnce(line) {
  return line
    .replace(/\\u\{([0-9a-fA-F]{1,6})\}/g, (m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/\\u([0-9a-fA-F]{4})/g, (m, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\x([0-9a-fA-F]{2})/g, (m, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\\//g, '/')
    .replace(/%([0-9a-fA-F]{2})/g, (m, h) => String.fromCharCode(parseInt(h, 16)));
}
function decode(line) {
  let t = line;
  for (let i = 0; i < 3; i++) {
    const next = decodeOnce(t);
    if (next === t) break;
    t = next;
  }
  return stripIgnored(t.normalize('NFKC').replace(DOTS, '.'));
}
const viewsOf = (text) => [text, decode(text)];

// Long base64 tokens are decoded and looked at too.
function base64Views(line) {
  const out = [];
  for (const m of line.matchAll(/[A-Za-z0-9+/_-]{20,}={0,2}/g)) {
    const raw = Buffer.from(m[0].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString(
      'latin1',
    );
    if (/^[\x20-\x7e]+$/.test(raw)) out.push(raw);
  }
  return out;
}

// ---- AST pass for code files: fold concatenations, templates, constants, join and concat -------
const CODE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
function foldNode(node, consts) {
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node))
    return foldNode(node.expression, consts);
  if (ts.isIdentifier(node)) return consts.has(node.text) ? consts.get(node.text) : null;
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const l = foldNode(node.left, consts);
    const r = foldNode(node.right, consts);
    return l === null || r === null ? null : l + r;
  }
  if (ts.isTemplateExpression(node)) {
    let out = node.head.text;
    for (const span of node.templateSpans) {
      const v = foldNode(span.expression, consts);
      if (v === null) return null;
      out += v + span.literal.text;
    }
    return out;
  }
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
    const { expression: target, name } = node.expression;
    if (name.text === 'join' && ts.isArrayLiteralExpression(target)) {
      const parts = target.elements.map((e) => foldNode(e, consts));
      const sep = node.arguments.length === 0 ? ',' : foldNode(node.arguments[0], consts);
      return parts.includes(null) || sep === null ? null : parts.join(sep);
    }
    if (name.text === 'concat') {
      const base = foldNode(target, consts);
      const rest = node.arguments.map((a) => foldNode(a, consts));
      return base === null || rest.includes(null) ? null : base + rest.join('');
    }
    if (name.text === 'toLowerCase' || name.text === 'toUpperCase') {
      const base = foldNode(target, consts);
      return base === null
        ? null
        : name.text === 'toLowerCase'
          ? base.toLowerCase()
          : base.toUpperCase();
    }
  }
  return null;
}

const STRING_METHODS_BARRED = true;
function codeFindings(file, text) {
  const out = [];
  const kind = /\.tsx$/.test(file.rel)
    ? ts.ScriptKind.TSX
    : /\.jsx$/.test(file.rel)
      ? ts.ScriptKind.JSX
      : undefined;
  const sf = ts.createSourceFile(file.rel, text, ts.ScriptTarget.Latest, true, kind);
  const lineOf = (n) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const consts = new Map();
  for (let pass = 0; pass < 3; pass++) {
    const collect = (n) => {
      if (
        ts.isVariableDeclaration(n) &&
        ts.isIdentifier(n.name) &&
        n.initializer &&
        !consts.has(n.name.text)
      ) {
        const v = foldNode(n.initializer, consts);
        if (v !== null) consts.set(n.name.text, v);
      }
      ts.forEachChild(n, collect);
    };
    collect(sf);
  }
  // Names that stand for SANDBOX_API: the constant, any import alias of it, any lower-case spelling.
  const sandboxNames = new Set();
  const collectNames = (n) => {
    if (ts.isImportSpecifier(n) && (n.propertyName ?? n.name).text === 'SANDBOX_API')
      sandboxNames.add(n.name.text);
    ts.forEachChild(n, collectNames);
  };
  collectNames(sf);
  const isSandboxRef = (e) =>
    (ts.isIdentifier(e) && (sandboxNames.has(e.text) || /^sandbox_api$/i.test(e.text))) ||
    (ts.isPropertyAccessExpression(e) && /^sandbox_api$/i.test(e.name.text));
  const visit = (n) => {
    const folded =
      ts.isBinaryExpression(n) || ts.isTemplateExpression(n) || ts.isCallExpression(n)
        ? foldNode(n, consts)
        : null;
    if (folded !== null) out.push({ line: lineOf(n), views: viewsOf(folded) });
    if (STRING_METHODS_BARRED) {
      if (ts.isPropertyAccessExpression(n) && isSandboxRef(n.expression))
        out.push({ line: lineOf(n), sandboxMethod: `.${n.name.text}` });
      if (ts.isElementAccessExpression(n) && isSandboxRef(n.expression))
        out.push({ line: lineOf(n), sandboxMethod: '[...]' });
      if (ts.isSpreadElement(n) && isSandboxRef(n.expression))
        out.push({ line: lineOf(n), sandboxMethod: '...spread' });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

const FOLD_EXEMPT =
  /(\.test\.tsx?|(^|\/)test-(support|helpers)\.ts|^scripts\/check-no-live-host\.mjs)$/;

const docsAllowed = existsSync(join(ROOT, ALLOWED_DOCS_DIR, MARKER));

const violations = [];
const seen = new Set();
const addOnce = (file, line, message) => {
  const key = `${file}:${line}:${message}`;
  if (seen.has(key)) return;
  seen.add(key);
  violations.push({ file, line, message });
};
const LIVE_MESSAGE = `live PayPal hostname (forbidden; only docs under ${ALLOWED_DOCS_DIR} may name one)`;
for (const file of listFiles(ROOT)) {
  const inDocsAllow =
    docsAllowed && file.rel.startsWith(ALLOWED_DOCS_DIR) && file.rel.endsWith('.md');
  const isConstant = file.rel === SANDBOX_CONSTANT_MODULE;
  const text = read(file);
  const check = (line, views) => {
    if (inDocsAllow) return;
    for (const v of views) {
      const c = classify(v, !FOLD_EXEMPT.test(file.rel));
      if (c.live) addOnce(file.rel, line, LIVE_MESSAGE);
      if (c.sandboxApi && !isConstant)
        addOnce(
          file.rel,
          line,
          `sandbox hostname outside the one constant module (${SANDBOX_CONSTANT_MODULE})`,
        );
    }
  };
  // Logical lines: a backslash at the end of a line continues it on the next.
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    let logical = lines[i];
    const start = i + 1;
    while (logical.endsWith('\\') && i + 1 < lines.length) {
      logical = logical.slice(0, -1) + lines[++i].replace(/^\s+/, '');
    }
    check(start, [...viewsOf(logical), ...base64Views(logical).flatMap(viewsOf)]);
  }
  if (CODE.test(file.rel)) {
    for (const f of codeFindings(file, text)) {
      // Tests, their helpers and this guard assemble host names from parts on purpose (so the
      // tree holds no literal); a host folded from parts is therefore flagged only elsewhere.
      if (!f.sandboxMethod && FOLD_EXEMPT.test(file.rel)) continue;
      if (f.sandboxMethod)
        addOnce(
          file.rel,
          f.line,
          `SANDBOX_API is used whole only (new URL(path, SANDBOX_API)); ${f.sandboxMethod} would rebuild or cut the host`,
        );
      else check(f.line, f.views);
    }
  }
}
process.exit(report(NAME, violations));
