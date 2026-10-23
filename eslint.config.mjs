// ESLint flat config for the SBX repository.
// Adapted from AIC_Hackathon_UnitMarket eslint.config.mjs at a36ddc0 (structure, NO_REAL_TIME
// rule set). Owned by SBX. Enforces docs/design/architecture.md sections 2.2 and 2.3.
//
// Flat config gives a file the LAST matching entry's value for each rule name, so every
// package entry below is built by `entry()` and lists every clause that applies to its files.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import path from 'node:path';
import fs from 'node:fs';

// FIX-MVPB-SEAL2 L: .jsx too, otherwise ESLint ignores such a file and no rule sees it.
const CODE = [
  '**/*.ts',
  '**/*.tsx',
  '**/*.mts',
  '**/*.cts',
  '**/*.mjs',
  '**/*.js',
  '**/*.cjs',
  '**/*.jsx',
];
const TESTS = ['**/*.test.ts', '**/*.test.tsx'];
const at = (dir) => [`${dir}/**/*.{ts,tsx,mts,cts,mjs,js,cjs,jsx}`];
const inDir = (dir) => at(dir);

// ---------------------------------------------------------------------------------------------
// Rule 2.2: isolation from the simulation. No import of any simulation path or package scope.
// ---------------------------------------------------------------------------------------------
const SIM = [
  '**/simulation',
  '**/simulation/**',
  '@unitmarket/*',
  '@unitmarket-sim/*',
  '**/AIC_Hackathon_UnitMarket',
  '**/AIC_Hackathon_UnitMarket/**',
];
const MSG_SIM =
  'Isolation (architecture 2.2): SBX never imports the simulation repo, its paths or its package scopes. Copy and adapt with a provenance header instead.';

// Rule S2: network clients live only in packages/transport.
const NETWORK_MODULES = [
  'http',
  'node:http',
  'https',
  'node:https',
  'http2',
  'node:http2',
  'net',
  'node:net',
  'tls',
  'node:tls',
  'dns',
  'node:dns',
  'dns/promises',
  'node:dns/promises',
  'dgram',
  'node:dgram',
  'undici',
  'node-fetch',
  'cross-fetch',
  'isomorphic-fetch',
  'axios',
  'got',
  'ky',
  'superagent',
  'ws',
  // Review 4 H1: Node internals that open sockets (require('_http_client')).
  '_http_*',
  '_tls_*',
];
// Review 4 H1: modules that load code or spawn processes (createRequire(...)('node:https'),
// execSync('curl ...'), workers, vm). Only the guard scripts and their tests may use them.
const PROC_MODULES = [
  'module',
  'node:module',
  'child_process',
  'node:child_process',
  'worker_threads',
  'node:worker_threads',
  'vm',
  'node:vm',
  'cluster',
  'node:cluster',
];
const MSG_PROC =
  'S2: node:module, node:child_process, node:worker_threads and node:vm can load or run code outside the lint rules; only the guard scripts use them.';
const MSG_NET =
  'S2: only packages/transport may use network clients (fetch, node:http, node:https, node:net, node:tls, node:dns, undici).';

// Layering helpers: names of the workspace packages (scope @umsbx).
const DOMAIN = [
  'offer-entry',
  'discovery',
  'fit',
  'approval',
  'payments',
  'entitlements',
  'access-clock',
  'delivery',
  'ledger',
  'receipts',
  'recovery',
  'catalogue',
  'library',
];
const INFRA = [
  'config',
  'runtime',
  'safety',
  'transport',
  'paypal',
  'db',
  'obs',
  'security',
  'model',
  'jobs',
  'testkit',
  'web',
  'spike-kit',
];
const pkg = (names) => names.map((n) => `@umsbx/${n}`);
// Only the package root (its index.ts) is public: `@umsbx/x/anything` is barred everywhere.
const DEEP = { group: ['@umsbx/*/*'], message: 'Only a package root export is public (S1).' };

const pat = (group, message) => ({ group, message });
const BASE_PATTERNS = [
  pat(SIM, MSG_SIM),
  pat(NETWORK_MODULES, MSG_NET),
  pat(PROC_MODULES, MSG_PROC),
  DEEP,
];

// Every randomness entry point of node:crypto. Hashing and HMAC (createHash, createHmac,
// timingSafeEqual) stay available to the two approval files that are allowed to import it.
const RANDOM_FNS = [
  'randomUUID',
  'randomBytes',
  'randomInt',
  'randomFill',
  'randomFillSync',
  'getRandomValues',
  'webcrypto',
  'subtle',
];
// Review 4 H1: default and namespace imports hand over the whole module (proc.env, cr.randomUUID),
// so they are barred together with the named bad members.
const PROCESS_BAD = [
  'env',
  'hrtime',
  'getBuiltinModule',
  'binding',
  'dlopen',
  'mainModule',
  'default',
  '*',
];
const BASE_PATHS = [
  {
    name: 'node:process',
    importNames: PROCESS_BAD,
    message: 'S3: only packages/config reads process.env (no default or namespace import either).',
  },
  {
    name: 'process',
    importNames: PROCESS_BAD,
    message: 'S3: only packages/config reads process.env (no default or namespace import either).',
  },
  {
    name: 'node:crypto',
    importNames: [...RANDOM_FNS, 'default', '*'],
    message:
      'S6: randomness and ids only in packages/runtime (inject Ids or an Rng); import createHash and friends by name.',
  },
  {
    name: 'crypto',
    importNames: [...RANDOM_FNS, 'default', '*'],
    message:
      'S6: randomness and ids only in packages/runtime (inject Ids or an Rng); import createHash and friends by name.',
  },
  {
    name: 'node:perf_hooks',
    importNames: ['performance', 'default', '*'],
    message: 'S6: use the injected Clock.',
  },
  {
    name: 'perf_hooks',
    importNames: ['performance', 'default', '*'],
    message: 'S6: use the injected Clock.',
  },
];

const NO_FETCH_GLOBALS = ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource'].map((name) => ({
  name,
  message: MSG_NET,
}));

// S6: no real time or randomness outside packages/runtime.
const TIME_PROPS = [
  { object: 'Date', property: 'now', message: 'S6: use the injected Clock (packages/runtime).' },
  { object: 'Math', property: 'random', message: 'S6: use an injected Rng or Ids.' },
  { object: 'performance', property: 'now', message: 'S6: use the injected Clock.' },
  { object: 'crypto', property: 'randomUUID', message: 'S6: use injected Ids.' },
  { object: 'crypto', property: 'getRandomValues', message: 'S6: use an injected Rng.' },
  { object: 'crypto', property: 'randomBytes', message: 'S6: use injected Ids or an Rng.' },
  { object: 'crypto', property: 'randomInt', message: 'S6: use an injected Rng.' },
  { object: 'crypto', property: 'randomFillSync', message: 'S6: use an injected Rng.' },
  { object: 'crypto', property: 'randomFill', message: 'S6: use an injected Rng.' },
  { object: 'globalThis', property: 'fetch', message: MSG_NET },
  { object: 'process', property: 'env', message: 'S3: only packages/config reads process.env.' },
];
const GLOBAL_OBJ = '/^(globalThis|self|window|global)$/';
const GLOBAL_THIS = 'globalThis';
const NET_GLOBAL = '/^(fetch|WebSocket|XMLHttpRequest|EventSource)$/';
const SYNTAX = {
  // Review H2: every spelling of "read the clock" that the plain Date.now rule misses.
  time: [
    {
      selector:
        "NewExpression[callee.name='Date'][arguments.length=0], NewExpression[callee.property.name='Date'][arguments.length=0]",
      message: 'S6: new Date() reads real time; use the injected Clock.',
    },
    {
      selector:
        "NewExpression[callee.name='Date'] > Identifier.arguments[name='undefined'], NewExpression[callee.property.name='Date'] > Identifier.arguments[name='undefined']",
      message: 'S6: new Date(undefined) reads real time; use the injected Clock.',
    },
    {
      selector: "CallExpression[callee.object.name='Reflect'][callee.property.name='construct']",
      message: 'S6: Reflect.construct can build a real-time Date; use the injected Clock.',
    },
    {
      selector: `MemberExpression[object.property.name='Date'][property.name='now']`,
      message: 'S6: use the injected Clock.',
    },
    {
      selector: `MemberExpression[object.name=${GLOBAL_OBJ}][property.name=/^(crypto|performance)$/], MemberExpression[object.name=${GLOBAL_OBJ}][computed=true][property.value=/^(crypto|performance)$/]`,
      message: 'S6: crypto and performance through the global object read randomness or time.',
    },
    {
      selector: `MemberExpression[object.name=${GLOBAL_OBJ}][property.name='Date']:not(NewExpression > .callee)`,
      message: 'S6: do not take Date from the global object; use the injected Clock.',
    },
    {
      selector:
        "MemberExpression[object.object.name='crypto'][object.property.name='subtle']:not([property.name='digest'])",
      message: 'S6: only crypto.subtle.digest is allowed; key generation is random.',
    },
    {
      selector: 'NewExpression[callee.type=/^TS/]',
      message: 'S6: a type assertion on the constructor hides new Date(); use the injected Clock.',
    },
  ],
  // Review H2: network globals reached through globalThis/self/window, by name or computed.
  network: [
    {
      selector: `MemberExpression[object.name=${GLOBAL_OBJ}][property.name=${NET_GLOBAL}]`,
      message: MSG_NET,
    },
    {
      selector: `MemberExpression[object.name=${GLOBAL_OBJ}][computed=true][property.value=${NET_GLOBAL}]`,
      message: MSG_NET,
    },
    {
      selector: `MemberExpression[object.name=${GLOBAL_OBJ}][computed=true]:not([property.type='Literal'])`,
      message: 'S2: a computed lookup on the global object can reach fetch; name the property.',
    },
    {
      selector: `VariableDeclarator[init.name=${GLOBAL_THIS}], AssignmentExpression[right.name=${GLOBAL_THIS}], CallExpression > Identifier.arguments[name=${GLOBAL_THIS}], NewExpression > Identifier.arguments[name=${GLOBAL_THIS}], ReturnStatement > Identifier.argument[name=${GLOBAL_THIS}], Property > Identifier.value[name=${GLOBAL_THIS}], ArrayExpression > Identifier[name=${GLOBAL_THIS}], SpreadElement > Identifier[name=${GLOBAL_THIS}], TSAsExpression > Identifier.expression[name=${GLOBAL_THIS}], ConditionalExpression > Identifier[name=${GLOBAL_THIS}], LogicalExpression > Identifier[name=${GLOBAL_THIS}], SequenceExpression > Identifier[name=${GLOBAL_THIS}]`,
      message:
        'S2: do not alias, pass or destructure the global object; Reflect.get(globalThis, ...) and const g = globalThis reach fetch.',
    },
    {
      selector: "MemberExpression[object.type='SequenceExpression']",
      message: 'S2: (0, globalThis).fetch style access is barred.',
    },
    {
      selector:
        "MemberExpression[property.name='getBuiltinModule'], MemberExpression[computed=true][property.value='getBuiltinModule']",
      message:
        'S2: process.getBuiltinModule loads node:https and friends outside the import rules.',
    },
    {
      selector:
        "MemberExpression[property.name='require'], MemberExpression[computed=true][property.value='require'], Identifier[name='createRequire']",
      message: 'S2: module.require and createRequire load modules outside the import rules.',
    },
  ],
  // Review 4 H1: reading the environment through the global object.
  env: [
    {
      selector: `MemberExpression[object.name=${GLOBAL_OBJ}][property.name='process'], MemberExpression[object.name=${GLOBAL_OBJ}][computed=true][property.value='process']`,
      message: 'S3: globalThis.process reaches process.env; only packages/config reads it.',
    },
  ],
  // Review 4 H1: building code from a string or from a function constructor (all packages).
  dynamicCode: [
    {
      selector:
        "NewExpression[callee.name='Function'], CallExpression[callee.name='Function'], CallExpression[callee.property.name='constructor'], CallExpression[callee.property.name='Function']",
      message: 'S2: no Function constructor; it compiles code outside every lint rule.',
    },
  ],
  // Name-based: client-exposed prefixes may never carry a secret. Only the label is allowed.
  publicName: {
    selector:
      'Literal[value=/^(NEXT_PUBLIC|VITE|REACT_APP|EXPO_PUBLIC|PUBLIC)_(?!UMS_ENV_LABEL$)/], Identifier[name=/^(NEXT_PUBLIC|VITE|REACT_APP|EXPO_PUBLIC)_(?!UMS_ENV_LABEL$)/]',
    message:
      'No client-exposed (NEXT_PUBLIC_ and similar) variables except NEXT_PUBLIC_UMS_ENV_LABEL.',
  },
};

// Local rule: a relative import may not leave the package that contains the file (nor the repo).
const root = path.dirname(new URL(import.meta.url).pathname);
const packageRootOf = (file) => {
  let dir = path.dirname(file);
  while (dir.startsWith(root) && dir.length >= root.length) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    if (dir === root) break;
    dir = path.dirname(dir);
  }
  return root;
};
const noPackageEscape = {
  meta: { type: 'problem', schema: [], messages: { escape: '{{msg}}' } },
  create(context) {
    const file = context.filename;
    const base = packageRootOf(file);
    const check = (node) => {
      const src = node.source?.value ?? node.arguments?.[0]?.value;
      if (typeof src !== 'string' || !src.startsWith('.')) return;
      const target = path.resolve(path.dirname(file), src);
      const rel = path.relative(base, target);
      if (rel.startsWith('..') || path.isAbsolute(rel)) {
        const outsideRepo = path.relative(root, target).startsWith('..');
        context.report({
          node,
          messageId: 'escape',
          data: {
            msg: outsideRepo
              ? 'Isolation (architecture 2.2): relative import leaves the SBX repository.'
              : 'S1: relative import leaves its package; import the other package by its @umsbx name.',
          },
        });
      }
    };
    return {
      ImportDeclaration: check,
      ExportAllDeclaration: check,
      ExportNamedDeclaration: (n) => n.source && check(n),
      ImportExpression: (n) => check({ ...n, arguments: [n.source] }),
      CallExpression(n) {
        if (n.callee.name === 'require') check(n);
      },
    };
  },
};

// Review H2: no-restricted-imports does not see import() or require(). This rule applies the same
// patterns and paths to them, and bars a specifier it cannot read statically (a variable, a
// concatenation, a template with a placeholder).
const globToRegExp = (glob) => {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      i++;
      if (glob[i + 1] === '/') {
        i++;
        re += '(?:.*/)?';
      } else re += '.*';
    } else if (c === '*') re += '[^/]*';
    else re += c.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}(?:/.*)?$`);
};
const noRestrictedDynamicImport = {
  meta: {
    type: 'problem',
    schema: [{ type: 'object' }],
    messages: {
      barred: '{{msg}}',
      dynamic: 'Dynamic import needs a string literal specifier.',
      dynamicRequire: 'require() needs a string literal specifier.',
    },
  },
  create(context) {
    const opts = context.options[0] ?? {};
    const patterns = (opts.patterns ?? []).map((p) => ({
      res: p.group.filter((g) => !g.startsWith('!')).map(globToRegExp),
      not: p.group.filter((g) => g.startsWith('!')).map((g) => globToRegExp(g.slice(1))),
      message: p.message,
    }));
    // A dynamic import or require hands over the whole module, so a path barred by importNames is
    // barred outright here (await import('node:crypto')).randomUUID()).
    const paths = opts.paths ?? [];
    const staticSpec = (n) => {
      if (n?.type === 'Literal' && typeof n.value === 'string') return n.value;
      if (n?.type === 'TemplateLiteral' && n.expressions.length === 0)
        return n.quasis[0].value.cooked;
      return null;
    };
    const check = (node, arg, isRequire) => {
      const spec = staticSpec(arg);
      if (spec === null) {
        context.report({ node, messageId: isRequire ? 'dynamicRequire' : 'dynamic' });
        return;
      }
      const hit =
        patterns.find((p) => p.res.some((r) => r.test(spec)) && !p.not.some((r) => r.test(spec))) ??
        paths.find((p) => p.name === spec);
      if (hit) context.report({ node, messageId: 'barred', data: { msg: hit.message } });
    };
    return {
      ImportExpression: (n) => check(n, n.source, false),
      CallExpression(n) {
        if (n.callee.type === 'Identifier' && n.callee.name === 'require' && n.arguments.length > 0)
          check(n, n.arguments[0], true);
      },
    };
  },
};

// Review 4 H1: the global objects whose members read time, randomness or the environment may not be
// aliased, passed around or looked up with a computed key (const D = Date; new D()). `names` maps a
// global to the members that stay usable (`safe`) or the members that are barred (`deny`).
const noGlobalAlias = {
  meta: {
    type: 'problem',
    schema: [{ type: 'object' }],
    messages: {
      alias: '{{name}}: do not alias or pass this global; use the injected Clock, Rng or Ids.',
      member: '{{name}}.{{prop}}: not available here; use the injected Clock, Rng or Ids.',
    },
  },
  create(context) {
    const names = context.options[0] ?? {};
    const isLocal = (node) => {
      for (let sc = context.sourceCode.getScope(node); sc; sc = sc.upper) {
        const v = sc.set.get(node.name);
        if (v && v.defs.length > 0) return true;
      }
      return false;
    };
    const TS_VALUE = new Set([
      'TSAsExpression',
      'TSNonNullExpression',
      'TSSatisfiesExpression',
      'TSTypeAssertion',
      'TSInstantiationExpression',
    ]);
    return {
      Identifier(node) {
        const cfg = Object.hasOwn(names, node.name) ? names[node.name] : undefined;
        if (!cfg || isLocal(node)) return;
        const parent = node.parent;
        const t = parent.type;
        if (t === 'MemberExpression' && parent.property === node && !parent.computed) return;
        if (
          (t === 'Property' || t === 'PropertyDefinition' || t === 'MethodDefinition') &&
          parent.key === node &&
          !parent.computed &&
          !(t === 'Property' && parent.shorthand)
        )
          return;
        if (
          /^(Import|Export)/.test(t) ||
          t === 'LabeledStatement' ||
          t === 'BreakStatement' ||
          t === 'ContinueStatement'
        )
          return;
        if (t.startsWith('TS') && !TS_VALUE.has(t)) return;
        if (t === 'UnaryExpression' && parent.operator === 'typeof') return;
        if (t === 'BinaryExpression' && parent.operator === 'instanceof') return;
        if (t === 'NewExpression' && parent.callee === node) return;
        if (t === 'MemberExpression' && parent.object === node) {
          let prop = null;
          if (!parent.computed) prop = parent.property.name;
          else if (parent.property.type === 'Literal' && typeof parent.property.value === 'string')
            prop = parent.property.value;
          if (prop === null) {
            context.report({
              node,
              messageId: 'member',
              data: { name: node.name, prop: '[computed]' },
            });
            return;
          }
          const ok = cfg.safe ? cfg.safe.includes(prop) : !(cfg.deny ?? []).includes(prop);
          if (!ok) context.report({ node, messageId: 'member', data: { name: node.name, prop } });
          return;
        }
        context.report({ node, messageId: 'alias', data: { name: node.name } });
      },
    };
  },
};

// FIX-MVPB-SEAL2 H1 and FIX-MVPB-SEAL3 H-A: the approved sandbox transport factory, the approval
// minter and the scoped-gate factory are reachable only from packages/safety (and the few pinned
// files, see NAMED_EXEMPTIONS). The built-in no-restricted-imports cannot say "this export, from
// this entry, except in these files" together with namespaces, re-exports, import(), require() and
// paths, so one rule covers every way in:
//  - the package name: namespace and default imports (they hand over every export), `export *`,
//    `export { name } from`, import(), require(), `import x = require()` and the vitest
//    importActual family; plus the named sealed exports;
//  - a relative or absolute path, a file: URL or a node_modules symlink path to ANY file under
//    packages/transport or packages/safety from outside that package (the public way in is the
//    package name, so the sources are not importable by path at all);
//  - inside the two packages, the test-only minters (createApprovalMinter, mintCapability,
//    isIssuedGate) and transport's test-support.ts are for test files;
//  - any use of `require` other than a direct call (const q = require; (0, require)(...)).
// Type-only imports load nothing and stay allowed.
const SEALED_PKG = {
  '@umsbx/transport': {
    dir: 'packages/transport',
    names: new Set([
      'createApprovedSandboxTransport',
      'claimApprovalMinter',
      'createApprovalMinter',
      // SEAL4: the token that selects the production Wire; a string selects nothing.
      'PRODUCTION_WIRE',
    ]),
  },
  '@umsbx/safety': { dir: 'packages/safety', names: new Set(['createScopedGate']) },
};
// Names that only test files (and the one named non-test file) may import from a sibling.
const IN_PKG_NAMES = {
  createApprovalMinter: [],
  mintCapability: [],
  isIssuedGate: ['packages/safety/src/scoped-gate.ts'],
};
const IN_PKG_INTERNAL = new Set([
  'packages/transport/src/approval',
  'packages/transport/src/test-support',
  'packages/safety/src/scoped-gate',
  'packages/safety/src/gate',
]);
const TESTY = /\.test\.[cm]?[jt]sx?$/;
const MSG_SEALED =
  'SEAL2/SEAL3: the approved sandbox transport, the approval minter and the scoped-gate factory are reachable only from packages/safety (and pinned test files). Import the plain public names from the package; a namespace import, re-export, import(), require(), importActual or a path into packages/transport or packages/safety reaches them too, and test-only minters and test-support.ts are for test files.';
const MSG_REQUIRE_ALIAS =
  'SEAL3 H-A: require may only be called directly; aliasing or passing it hides what is loaded.';
const specOf = (n) => {
  if (n?.type === 'Literal' && typeof n.value === 'string') return n.value;
  if (n?.type === 'TemplateLiteral' && n.expressions.length === 0) return n.quasis[0].value.cooked;
  return null;
};
const posix = (p) => p.split(path.sep).join('/');
const stripExt = (p) => p.replace(/\.[cm]?[jt]sx?$/, '');
/** Absolute candidates (lexical, and real path when it exists) for a path-like specifier. */
const pathCandidates = (spec, file) => {
  let abs = null;
  if (spec.startsWith('file:')) {
    try {
      abs = new URL(spec).pathname;
    } catch {
      return [];
    }
  } else if (spec.startsWith('.')) abs = path.resolve(path.dirname(file), spec);
  else if (path.isAbsolute(spec)) abs = path.resolve(spec);
  if (abs === null) return [];
  const out = [abs];
  try {
    out.push(fs.realpathSync(abs));
  } catch {
    /* a path without an extension need not exist */
  }
  return out;
};
const sealedPkgOfPath = (abs) => {
  const rel = posix(path.relative(root, abs));
  for (const cfg of Object.values(SEALED_PKG))
    if (rel === cfg.dir || rel.startsWith(`${cfg.dir}/`)) return cfg.dir;
  const m = /\/node_modules\/@umsbx\/(transport|safety)(?:\/|$)/.exec(posix(abs));
  return m ? `packages/${m[1]}` : null;
};
const sealedTransport = {
  meta: {
    type: 'problem',
    schema: [],
    messages: { sealed: '{{msg}}' },
  },
  create(context) {
    const file = context.filename;
    const fileRel = posix(path.relative(root, file));
    const ownPkg =
      Object.values(SEALED_PKG).find((c) => fileRel.startsWith(`${c.dir}/`))?.dir ?? null;
    const testy = TESTY.test(fileRel) || fileRel === 'packages/transport/src/test-support.ts';
    const report = (node, msg = MSG_SEALED) =>
      context.report({ node, messageId: 'sealed', data: { msg } });
    const nameOf = (id) => (id.type === 'Literal' ? String(id.value) : id.name);
    // What the package entry exports: everything via a whole-module load or export *, else by name.
    const byName = (node, key, kind, names) => {
      if (kind === 'whole' || kind === 'exportAll') return report(node);
      for (const { sp, name, whole } of names)
        if (whole || SEALED_PKG[key].names.has(name)) report(sp);
    };
    // kind: 'whole' (dynamic import, require, importActual), 'import', 'exportAll', 'exportNamed'.
    const check = (node, spec, kind, specifiers = []) => {
      if (typeof spec !== 'string') return;
      const names = specifiers
        .filter((sp) => sp.importKind !== 'type' && sp.exportKind !== 'type')
        .map((sp) => ({
          sp,
          name: nameOf(sp.imported ?? sp.local),
          whole: sp.type === 'ImportNamespaceSpecifier' || sp.type === 'ImportDefaultSpecifier',
        }));
      // 0. A percent escape in a relative, file: or absolute specifier is decoded by the module
      // loader but not by a string match (`transp%6Frt`): refuse it wherever it appears.
      if (
        (spec.startsWith('.') || spec.startsWith('file:') || path.isAbsolute(spec)) &&
        spec.includes('%')
      )
        return report(node);
      // 1. the package name
      const base = Object.keys(SEALED_PKG).find((k) => spec === k || spec.startsWith(`${k}/`));
      if (base !== undefined) return byName(node, base, kind, names);
      // 2. a path
      for (const abs of pathCandidates(spec, file)) {
        const pkg = sealedPkgOfPath(abs);
        if (pkg === null) continue;
        const target = stripExt(posix(path.relative(root, abs)));
        if (pkg !== ownPkg) {
          // The package's own entry file, spelled as a path, is the package name in disguise.
          if ([pkg, `${pkg}/src`, `${pkg}/src/index`].includes(target)) {
            const key = Object.keys(SEALED_PKG).find((k) => SEALED_PKG[k].dir === pkg);
            return byName(node, key, kind, names);
          }
          return report(node);
        }
        if (testy) return;
        if (target === 'packages/transport/src/test-support') return report(node);
        for (const { sp, name } of names)
          if (Object.hasOwn(IN_PKG_NAMES, name) && !IN_PKG_NAMES[name].includes(fileRel))
            report(sp);
        const handsOver = kind === 'whole' || kind === 'exportAll' || names.some((n) => n.whole);
        if (handsOver && IN_PKG_INTERNAL.has(target)) report(node);
        return;
      }
    };
    const IMPORT_ACTUAL = new Set(['importActual', 'importMock', 'requireActual', 'requireMock']);
    return {
      ImportDeclaration(n) {
        if (n.importKind !== 'type') check(n, n.source.value, 'import', n.specifiers);
      },
      ExportAllDeclaration(n) {
        if (n.exportKind !== 'type') check(n, n.source.value, 'exportAll');
      },
      ExportNamedDeclaration(n) {
        if (n.source && n.exportKind !== 'type')
          check(n, n.source.value, 'exportNamed', n.specifiers);
      },
      ImportExpression(n) {
        check(n, specOf(n.source), 'whole');
      },
      CallExpression(n) {
        const c = n.callee;
        if (c.type === 'Identifier' && c.name === 'require')
          check(n, specOf(n.arguments[0]), 'whole');
        else if (
          c.type === 'MemberExpression' &&
          IMPORT_ACTUAL.has(c.property.name ?? c.property.value)
        ) {
          const spec = specOf(n.arguments[0]);
          // A specifier that cannot be read statically could be anything: refuse it too.
          if (spec === null) report(n);
          else check(n, spec, 'whole');
        }
      },
      TSImportEqualsDeclaration(n) {
        const ref = n.moduleReference;
        if (ref?.type === 'TSExternalModuleReference') check(n, specOf(ref.expression), 'whole');
      },
      Identifier(n) {
        if (n.name !== 'require') return;
        const p = n.parent;
        if (p.type === 'CallExpression' && p.callee === n) return;
        if (p.type === 'MemberExpression' && p.property === n && !p.computed) return;
        if (p.type === 'Property' && p.key === n && !p.computed && !p.shorthand) return;
        if (p.type === 'UnaryExpression' && p.operator === 'typeof') return;
        if (p.type === 'VariableDeclarator' && p.id === n) return;
        if (/^(TS|Import|Export)/.test(p.type)) return;
        report(n, MSG_REQUIRE_ALIAS);
      },
    };
  },
};

// ---------------------------------------------------------------------------------------------
// SEAL5. Two more ways to reach the sealed names without writing the package name, closed by rules
// that NO named exemption can switch off (the config refuses to load one that tries):
//  - sbx/no-sealed-alias: a package.json `imports` alias (`#ap`) whose target is a sealed package,
//    and a bare specifier that Node resolves into packages/transport or packages/safety through a
//    node_modules link (any name other than the official ones). Official names stay the business
//    of sbx/sealed-transport.
//  - sbx/no-bundler-glob: import.meta.glob, import.meta.globEager and import.meta.webpackContext
//    load files by pattern at build time, so no import statement names them; they are barred
//    everywhere, and so is any use of `import.meta` that lets one hide (aliasing, destructuring,
//    a computed key).
// ---------------------------------------------------------------------------------------------
const NON_EXEMPTABLE = ['sbx/no-sealed-alias', 'sbx/no-bundler-glob'];
const SEALED_OFFICIAL = Object.keys(SEALED_PKG);
const isOfficialName = (spec) =>
  SEALED_OFFICIAL.some((k) => spec === k || spec.startsWith(`${k}/`));
const pkgNameOf = (spec) =>
  spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
const realRoot = (() => {
  try {
    return fs.realpathSync(root);
  } catch {
    return root;
  }
})();
/** True when an absolute path lies inside packages/transport or packages/safety (lexical or real). */
const pathIntoSealed = (abs) => {
  for (const base of new Set([root, realRoot]))
    for (const cfg of Object.values(SEALED_PKG)) {
      const dir = path.join(base, cfg.dir);
      if (abs === dir || abs.startsWith(`${dir}${path.sep}`)) return true;
    }
  return sealedPkgOfPath(abs) !== null;
};
const nearestPackageJson = (dir) => {
  for (let d = dir; ; d = path.dirname(d)) {
    const p = path.join(d, 'package.json');
    if (fs.existsSync(p)) return p;
    if (path.dirname(d) === d) return null;
  }
};
const importsCache = new Map();
const importsOf = (pj) => {
  let mtime = 0;
  try {
    mtime = fs.statSync(pj).mtimeMs;
  } catch {
    return {};
  }
  const hit = importsCache.get(pj);
  if (hit && hit.mtime === mtime) return hit.imports;
  let imports = {};
  try {
    const j = JSON.parse(fs.readFileSync(pj, 'utf8'));
    if (j && typeof j.imports === 'object' && j.imports !== null && !Array.isArray(j.imports))
      imports = j.imports;
  } catch {
    imports = {};
  }
  importsCache.set(pj, { mtime, imports });
  return imports;
};
const flattenTarget = (t, star) => {
  if (typeof t === 'string') return [star === null ? t : t.split('*').join(star)];
  if (Array.isArray(t)) return t.flatMap((x) => flattenTarget(x, star));
  if (t && typeof t === 'object') return Object.values(t).flatMap((x) => flattenTarget(x, star));
  return [];
};
/** Every target of every `imports` entry that could match the `#` specifier. */
const importTargets = (imports, spec) => {
  const out = [];
  for (const [key, t] of Object.entries(imports)) {
    if (key === spec) out.push(...flattenTarget(t, null));
    else if (key.includes('*')) {
      const [pre, post = ''] = key.split('*');
      if (spec.startsWith(pre) && spec.endsWith(post) && spec.length >= pre.length + post.length)
        out.push(...flattenTarget(t, spec.slice(pre.length, spec.length - post.length)));
    }
  }
  return out;
};
const linkCache = new Map();
const bareResolvesIntoSealed = (spec, fromDir) => {
  const name = pkgNameOf(spec);
  for (let d = fromDir; ; d = path.dirname(d)) {
    const cand = path.join(d, 'node_modules', name);
    let hit = linkCache.get(cand);
    if (hit === undefined) {
      try {
        hit = pathIntoSealed(fs.realpathSync(cand));
      } catch {
        hit = false;
      }
      linkCache.set(cand, hit);
    }
    if (hit) return true;
    if (path.dirname(d) === d) return false;
  }
};
/** Does this specifier, seen from `fromDir`, end up in a sealed package other than by its official name? */
const reachesSealed = (spec, fromDir, viaAlias, depth) => {
  if (depth > 8) return true; // an alias chain this deep is not an accident: refuse
  if (spec.startsWith('node:')) return false;
  if (spec.startsWith('#')) {
    const pj = nearestPackageJson(fromDir);
    if (pj === null) return false;
    const pdir = path.dirname(pj);
    return importTargets(importsOf(pj), spec).some((t) =>
      t.startsWith('.')
        ? pathIntoSealed(path.resolve(pdir, t))
        : reachesSealed(t, pdir, true, depth + 1),
    );
  }
  if (spec.startsWith('.') || spec.startsWith('file:') || path.isAbsolute(spec)) return false;
  if (isOfficialName(spec)) return viaAlias;
  return bareResolvesIntoSealed(spec, fromDir);
};
const MSG_ALIAS =
  'SEAL5: this specifier reaches packages/transport or packages/safety through a package.json imports alias or a node_modules link. Import the official package name instead; the sealed names are reachable only as sbx/sealed-transport allows.';
const noSealedAlias = {
  meta: { type: 'problem', schema: [], messages: { alias: '{{msg}}' } },
  create(context) {
    const fromDir = path.dirname(context.filename);
    const check = (node, spec) => {
      if (typeof spec === 'string' && reachesSealed(spec, fromDir, false, 0))
        context.report({ node, messageId: 'alias', data: { msg: MSG_ALIAS } });
    };
    const typeOnly = (specs) => specs.length > 0 && specs.every((sp) => sp.importKind === 'type');
    return {
      ImportDeclaration(n) {
        if (n.importKind !== 'type' && !typeOnly(n.specifiers)) check(n, n.source.value);
      },
      ExportAllDeclaration(n) {
        if (n.exportKind !== 'type') check(n, n.source.value);
      },
      ExportNamedDeclaration(n) {
        if (n.source && n.exportKind !== 'type') check(n, n.source.value);
      },
      ImportExpression(n) {
        check(n, specOf(n.source));
      },
      CallExpression(n) {
        const c = n.callee;
        if (c.type === 'Identifier' && c.name === 'require') check(n, specOf(n.arguments[0]));
        else if (
          c.type === 'MemberExpression' &&
          ['importActual', 'importMock', 'requireActual', 'requireMock'].includes(
            c.property.name ?? c.property.value,
          )
        )
          check(n, specOf(n.arguments[0]));
      },
      TSImportEqualsDeclaration(n) {
        const ref = n.moduleReference;
        if (ref?.type === 'TSExternalModuleReference') check(n, specOf(ref.expression));
      },
    };
  },
};

const BUNDLER_GLOBS = new Set(['glob', 'globEager', 'webpackContext']);
const MSG_GLOB =
  'SEAL5: import.meta.glob, import.meta.globEager and import.meta.webpackContext load modules by pattern, which hides what is imported. They are barred everywhere, with no exemption.';
const MSG_META =
  'SEAL5: use import.meta only as import.meta.url, .dirname, .filename, .resolve or .env; aliasing, destructuring or a computed key could hide a bundler glob.';
const TS_WRAPPERS = new Set([
  'TSAsExpression',
  'TSNonNullExpression',
  'TSSatisfiesExpression',
  'TSTypeAssertion',
  'ChainExpression',
]);
const noBundlerGlob = {
  meta: { type: 'problem', schema: [], messages: { glob: '{{msg}}' } },
  create(context) {
    return {
      MetaProperty(n) {
        if (n.meta.name !== 'import' || n.property.name !== 'meta') return;
        let node = n;
        let parent = n.parent;
        while (TS_WRAPPERS.has(parent.type)) {
          node = parent;
          parent = parent.parent;
        }
        if (parent.type === 'MemberExpression' && parent.object === node) {
          const prop = parent.computed ? specOf(parent.property) : parent.property.name;
          if (prop === null)
            return context.report({ node: parent, messageId: 'glob', data: { msg: MSG_META } });
          if (BUNDLER_GLOBS.has(prop))
            return context.report({ node: parent, messageId: 'glob', data: { msg: MSG_GLOB } });
          return;
        }
        context.report({ node: n, messageId: 'glob', data: { msg: MSG_META } });
      },
    };
  },
};

const sbx = {
  rules: {
    'no-package-escape': noPackageEscape,
    'no-global-alias': noGlobalAlias,
    'no-restricted-dynamic-import': noRestrictedDynamicImport,
    'sealed-transport': sealedTransport,
    'no-sealed-alias': noSealedAlias,
    'no-bundler-glob': noBundlerGlob,
  },
};

/**
 * Build one config entry.
 * extra: more import patterns. allow: { time, network, env } relax the global bans for a package.
 */
function entry(files, { extra = [], paths = [], ignores = [], allow = {} } = {}) {
  const props = TIME_PROPS.filter(
    (p) =>
      !(
        (allow.time && ['Date', 'Math', 'performance', 'crypto'].includes(p.object)) ||
        (allow.network && p.object === 'globalThis') ||
        (allow.env && p.object === 'process')
      ),
  );
  // allow.dbTesting: test files and test helpers may import the db test entry (resetDatabase).
  const patterns = BASE_PATTERNS.filter(
    (p) =>
      !(allow.network && (p.message === MSG_NET || p.message === MSG_PROC)) &&
      !(allow.proc && p.message === MSG_PROC),
  )
    .map((p) =>
      allow.dbTesting && p === DEEP ? { ...DEEP, group: [...DEEP.group, '!@umsbx/db/testing'] } : p,
    )
    // allow.childProcess: lift the node:child_process bar alone (vm, worker_threads, module stay barred).
    .map((p) =>
      allow.childProcess && p.message === MSG_PROC
        ? { ...p, group: p.group.filter((g) => !/^(node:)?child_process$/.test(g)) }
        : p,
    )
    .concat(extra);
  const basePaths = BASE_PATHS.filter(
    (p) =>
      !(allow.time && (p.name.endsWith('crypto') || p.name.endsWith('perf_hooks'))) &&
      !(allow.env && p.name.endsWith('process')),
  );
  const processDeny = [
    ...(allow.env ? [] : ['env']),
    ...(allow.time ? [] : ['hrtime']),
    ...(allow.network ? [] : ['getBuiltinModule', 'binding', 'dlopen', 'mainModule']),
  ];
  const aliasNames = {
    ...(allow.time
      ? {}
      : {
          Date: { safe: ['UTC', 'parse'] },
          Math: { deny: ['random'] },
          performance: { safe: [] },
          crypto: { safe: ['subtle'] },
        }),
    ...(processDeny.length ? { process: { deny: processDeny } } : {}),
    // Scope-aware: a local variable named window or self is fine; the real global is not aliased.
    ...(allow.network
      ? {}
      : Object.fromEntries(
          ['globalThis', 'self', 'window', 'global'].map((n) => [n, { deny: [] }]),
        )),
  };
  return {
    files,
    ...(ignores.length ? { ignores } : {}),
    plugins: { sbx },
    rules: {
      'sbx/no-package-escape': 'error',
      'sbx/sealed-transport': 'error',
      'sbx/no-sealed-alias': 'error',
      'sbx/no-bundler-glob': 'error',
      'no-restricted-imports': ['error', { patterns, paths: [...basePaths, ...paths] }],
      'no-restricted-globals': allow.network ? 'off' : ['error', ...NO_FETCH_GLOBALS],
      'no-restricted-properties': ['error', ...props],
      'sbx/no-global-alias': ['error', aliasNames],
      'no-eval': 'error',
      'no-new-func': 'error',
      'no-implied-eval': 'off',
      'sbx/no-restricted-dynamic-import': [
        'error',
        { patterns, paths: [...basePaths, ...paths], allowNetwork: Boolean(allow.network) },
      ],
      'no-restricted-syntax': [
        'error',
        ...(allow.time ? [] : SYNTAX.time),
        ...(allow.network ? [] : SYNTAX.network),
        ...(allow.env ? [] : SYNTAX.env),
        ...SYNTAX.dynamicCode,
        SYNTAX.publicName,
      ],
    },
  };
}

// Pair of entries: production files and test files (tests may import the testkit and vitest).
function pair(dir, opts = {}) {
  const prod = [...(opts.prod ?? []), pat(pkg(['testkit']), 'testkit is for tests only.')];
  return [
    entry(inDir(dir), {
      ...opts,
      extra: [...(opts.extra ?? []), ...prod],
      ignores: TESTS.map((t) => `${dir}/${t}`),
    }),
    entry(
      TESTS.map((t) => `${dir}/${t}`),
      opts.testExtra === undefined ? opts : { ...opts, extra: opts.testExtra },
    ),
  ];
}

const others = (keep) => pkg([...DOMAIN, ...INFRA].filter((n) => !keep.includes(n)));
const except = (names, keep) => pkg(names.filter((n) => !keep.includes(n)));

const S1_MSG = 'S1: domain modules import only @umsbx/contracts and sibling domain modules.';
const S4_MSG =
  'S4: discovery, fit and model never import payments, approval, entitlements, paypal, safety or transport.';
const AGENT_FORBIDDEN = pkg([
  'payments',
  'approval',
  'entitlements',
  'paypal',
  'safety',
  'transport',
  'db',
  'config',
  'ledger',
  'receipts',
  'access-clock',
  'recovery',
  'delivery',
  'jobs',
  'security',
]);
const FRAMEWORK = ['next', 'next/*', 'react', 'react/*', 'react-dom', 'react-dom/*', 'server-only'];
const DRIVERS = ['pg', 'pg/*', '@electric-sql/*', 'zod', 'zod/*', 'node:*'];

const HELPERS = ['test-fixtures.ts', 'world.ts', 'support.ts'];
const HASH_ONLY = { delivery: ['link-token.ts', 'store-pg.ts'] };
const HASH_HELPERS = { delivery: ['world.ts'] };
const packageEntries = [
  // Z2/Z3 domain: pure TypeScript. Contracts and sibling domain modules only (S1).
  // Tests and test helpers (test-fixtures.ts, world.ts, support.ts) may also use the database,
  // runtime doubles and the scripted model; only *.test.ts may use node:fs and node:crypto.
  ...DOMAIN.flatMap((name) => {
    const dir = `domain/${name}`;
    const s4 = ['discovery', 'fit'].includes(name);
    // S4/9.10 (lane 14b CR-1): only discovery calls the model port implementation.
    const modelOk = name === 'discovery' ? ['model'] : [];
    const prodExtra = [
      pat(except(INFRA, ['testkit', ...modelOk]), S1_MSG),
      pat(FRAMEWORK, S1_MSG),
      pat(DRIVERS, S1_MSG),
      ...(s4 ? [pat(AGENT_FORBIDDEN, S4_MSG)] : []),
    ];
    const harnessExtra = (nodeAllowed) => [
      pat(except(INFRA, ['testkit', 'db', 'runtime', ...modelOk]), S1_MSG),
      pat(FRAMEWORK, S1_MSG),
      pat(nodeAllowed ? DRIVERS.filter((d) => d !== 'node:*') : DRIVERS, S1_MSG),
      ...(s4
        ? [
            pat(
              AGENT_FORBIDDEN.filter((p) => p !== '@umsbx/db'),
              S4_MSG,
            ),
          ]
        : []),
    ];
    const helpers = HELPERS.map((h) => `${dir}/**/${h}`);
    // Files that hash with node:crypto by name (createHash, createHmac, timingSafeEqual); the
    // random functions stay barred by RANDOM_FNS. world.ts is the delivery test helper.
    const hashOnly = HASH_ONLY[name] ?? [];
    const cryptoOk = (list) =>
      list.map((p) =>
        p.group === DRIVERS || p.group.includes('node:*')
          ? pat(p.group.filter((d) => d !== 'node:*').concat(['node:*', '!node:crypto']), S1_MSG)
          : p,
      );
    return [
      entry(inDir(dir), {
        extra: [...prodExtra, pat(pkg(['testkit']), 'testkit is for tests only.')],
        ignores: [...TESTS.map((t) => `${dir}/${t}`), ...helpers],
      }),
      entry(helpers, { extra: harnessExtra(false), allow: { dbTesting: true } }),
      ...(hashOnly.length
        ? [
            entry(
              hashOnly.map((f) => `${dir}/src/${f}`),
              {
                extra: [
                  ...cryptoOk(prodExtra),
                  pat(pkg(['testkit']), 'testkit is for tests only.'),
                ],
              },
            ),
          ]
        : []),
      ...((HASH_HELPERS[name] ?? []).length
        ? [
            entry(
              HASH_HELPERS[name].map((f) => `${dir}/src/${f}`),
              { extra: cryptoOk(harnessExtra(false)), allow: { dbTesting: true } },
            ),
          ]
        : []),
      entry(
        TESTS.map((t) => `${dir}/${t}`),
        { extra: harnessExtra(true), allow: { dbTesting: true } },
      ),
    ];
  }),
  // approval: hashing and HMAC need node:crypto, nothing else from node:*. The random functions
  // stay banned by name (RANDOM_FNS), so these two files cannot mint ids, nonces or salts.
  entry(['domain/approval/src/canonical.ts', 'domain/approval/src/token.ts'], {
    extra: [
      pat(except(INFRA, []), S1_MSG),
      pat(FRAMEWORK, S1_MSG),
      pat(DRIVERS.filter((d) => d !== 'node:*').concat(['node:*', '!node:crypto']), S1_MSG),
      pat(pkg(['testkit']), 'testkit is for tests only.'),
    ],
  }),
  // contracts: zod only.
  ...pair('packages/contracts', {
    extra: [pat(others(['contracts']), 'contracts imports no other workspace package.')],
  }),
  // config: the only reader of process.env.
  ...pair('packages/config', {
    allow: { env: true },
    extra: [pat(others(['contracts', 'config']), 'config imports only contracts.')],
  }),
  // runtime: the only place for real clock, crypto ids and rng.
  ...pair('packages/runtime', {
    allow: { time: true },
    extra: [pat(others(['contracts', 'runtime']), 'runtime imports only contracts.')],
  }),
  // transport: the only network code (S2).
  ...pair('packages/transport', {
    allow: { network: true },
    extra: [pat(others(['contracts', 'transport']), 'transport imports only contracts.')],
  }),
  // paypal: the only importer of transport besides safety (S2).
  ...pair('packages/paypal', {
    extra: [
      pat(
        except([...DOMAIN, ...INFRA], ['contracts', 'transport', 'paypal', 'obs', 'testkit']),
        'paypal imports contracts, transport and obs only.',
      ),
    ],
  }),
  ...pair('packages/safety', {
    // Lane 02 follow-up: safety tests use the real database, logger and runtime doubles.
    testExtra: [
      pat(
        except(
          [...DOMAIN, ...INFRA],
          ['contracts', 'transport', 'safety', 'testkit', 'db', 'obs', 'runtime'],
        ),
        'safety tests import contracts, transport, db, obs and runtime only.',
      ),
    ],
    extra: [
      pat(
        except([...DOMAIN, ...INFRA], ['contracts', 'transport', 'safety', 'testkit']),
        'safety imports contracts (Database port) and transport only.',
      ),
    ],
  }),
  ...pair('packages/db', {
    extra: [
      pat(
        pkg([...DOMAIN, 'paypal', 'transport', 'safety', 'web', 'jobs', 'security', 'model']),
        'db is a driver layer: no domain or provider imports.',
      ),
    ],
  }),
  ...pair('packages/obs', {
    extra: [pat(others(['contracts', 'obs']), 'obs imports only contracts.')],
  }),
  ...pair('packages/security', {
    extra: [
      pat(
        pkg([...DOMAIN, 'paypal', 'transport', 'safety', 'web', 'jobs', 'model']),
        'security imports contracts, db, config and obs only.',
      ),
    ],
  }),
  // model: scripted agent model, Z6.
  ...pair('packages/model', {
    extra: [pat(AGENT_FORBIDDEN, S4_MSG), pat(FRAMEWORK, S4_MSG)],
  }),
  // jobs: reconciler loop; the only package besides composition that imports paypal.
  ...pair('packages/jobs', {
    extra: [
      pat(
        pkg(['web', 'security', 'discovery', 'fit', 'model']),
        'jobs does not import UI or agent code.',
      ),
    ],
  }),
  // testkit: fakes and conformance; may import anything except the app.
  ...pair('packages/testkit', { extra: [pat(pkg(['web']), 'testkit never imports the web app.')] }),
  // tools/spike-kit: owner-run checks; node only (contracts and runtime).
  ...pair('tools/spike-kit', {
    extra: [
      pat(
        others(['contracts', 'runtime', 'spike-kit']),
        'spike-kit imports contracts and runtime only.',
      ),
    ],
  }),
  // FIX-MVPB-SEAL3: the one spike-kit file that may use node:child_process (a fixed git binary, local
  // `git cat-file`). Only that one module restriction is lifted; the network, SIM and every other
  // import rule still apply to it, and the rest of the kit stays barred from process modules.
  entry(['tools/spike-kit/src/git-head.ts'], {
    allow: { childProcess: true },
    extra: [
      pat(
        others(['contracts', 'runtime', 'spike-kit']),
        'spike-kit imports contracts and runtime only.',
      ),
      pat(pkg(['testkit']), 'testkit is for tests only.'),
    ],
  }),
];

// apps/web: Z1 reaches the engine only through composition.server.ts (S2, S5, architecture 2).
const WEB_FORBIDDEN = pkg([
  ...DOMAIN,
  'db',
  'transport',
  'paypal',
  'safety',
  'config',
  'runtime',
  'jobs',
  'model',
]);
const webEntries = [
  entry(['apps/web/composition.server.ts'], {
    extra: [pat(pkg(['testkit']), 'testkit is for tests only.')],
  }),
  ...pair('apps/web', {
    extra: [
      pat(
        WEB_FORBIDDEN,
        'Z1: route handlers and components reach the engine only through composition.server.ts.',
      ),
    ],
    ignores: ['apps/web/composition.server.ts'],
  }).map((e, i) =>
    i === 0 ? { ...e, ignores: [...e.ignores, 'apps/web/composition.server.ts'] } : e,
  ),
];

// Built at run time: the transport package's test bars every file outside it from naming the
// production Wire module, and this list names two files of that family.
const WIRE_HTTPS = ['packages/transport/src/wire', 'https'].join('-');

// Named exemptions (review 4 H1: no inline disables). Each entry is one file, one reason, and the list
// is pinned by scripts/lint-rules.test.ts so it cannot grow unnoticed. Decision D-015.
export const NAMED_EXEMPTIONS = [
  {
    files: ['apps/web/src/server/singleton.ts'],
    reason: 'process-wide app holder shared by route bundles and instrumentation (globalThis key)',
    off: ['sbx/no-global-alias', 'no-restricted-syntax'],
  },
  {
    files: ['apps/web/src/instrumentation.ts'],
    reason: 'reads the framework flag NEXT_RUNTIME, which is not application configuration',
    off: ['no-restricted-properties', 'sbx/no-global-alias'],
  },
  {
    files: ['apps/web/src/lib/client-api.ts'],
    reason: 'browser same-origin fetch to this app JSON API; S2 targets payment network clients',
    off: ['no-restricted-globals'],
  },
  {
    files: ['packages/paypal/src/paypal.sandbox.contract.test.ts'],
    reason: 'test spies on globalThis.fetch to prove the sandbox subject opens no socket',
    off: ['sbx/no-global-alias', 'no-restricted-syntax'],
  },
  {
    files: ['domain/library/src/world.ts', 'domain/recovery/src/world.ts'],
    reason: 'test world hashes seeded article bytes with node:crypto (hash only, no randomness)',
    off: ['no-restricted-imports', 'sbx/no-restricted-dynamic-import'],
  },
  {
    files: ['domain/payments/src/support.ts', 'domain/payments/src/payments.integration.test.ts'],
    reason:
      'payments test helpers: node:async_hooks (provider-call spy), node:crypto hashing, real adapter over the dry-run transport',
    off: ['no-restricted-imports', 'sbx/no-restricted-dynamic-import'],
  },
  {
    files: [
      'tests/mvp-a/app-a20-a22-perf.integration.test.ts',
      'tests/mvp-a/dryrun-kill-switch.integration.test.ts',
      'tests/mvp-a/safety-a01-a04.integration.test.ts',
    ],
    reason:
      'MVP-A gate (lane 18, FIX-GATE2): the web composition and route handlers are reachable only by relative path (@umsbx/web exports no composition); needed for the HTTP-level A-20, A-22 and PERF-2 checks, the dry-run kill switch (M1) and the refused-boot check (A-01)',
    off: ['sbx/no-package-escape'],
  },
  {
    files: ['tests/mvp-b/b09-logs-clean.integration.test.ts'],
    reason:
      'MVP-B offline acceptance (lane B-L5/B-L7): the web composition and route handlers are reachable only by relative path (@umsbx/web exports no composition); needed for the logs_clean journey through the route handlers (B-09). It also builds the approved transport (FIX-MVPB-SEAL2) from a real scoped gate over an in-memory database to check the sandbox.send log lines',
    off: ['sbx/no-package-escape', 'sbx/sealed-transport'],
  },
  {
    files: ['tests/mvp-b/b06-b08.integration.test.ts'],
    reason:
      'MVP-B offline acceptance (lane B-L5/B-L7): the web composition and route handlers are reachable only by relative path (@umsbx/web exports no composition); needed for the dry-run kill switch, timeout reconcile and call budget (B-06 to B-08) and the logs_clean journey through the route handlers (B-09)',
    off: ['sbx/no-package-escape'],
  },
  {
    files: ['tools/spike-kit/src/spike.ts'],
    reason:
      'B-L6 spike kit: the owner-run entry reads process.env, the real clock and passes the global fetch to the guarded wire; --dry-run never builds that wire (tests spy on every network entry point)',
    off: [
      'no-restricted-properties',
      'no-restricted-globals',
      'no-restricted-syntax',
      'sbx/no-global-alias',
    ],
  },
  {
    files: ['tools/spike-kit/src/spike.test.ts'],
    reason:
      'B-L6: the test imports node:net, tls, http, https and dns only to spy on them and prove zero network use',
    off: ['no-restricted-imports', 'sbx/no-restricted-dynamic-import'],
  },
  {
    files: ['tools/spike-kit/src/spike-cli.integration.test.ts'],
    reason:
      'B-L6: runs the kit as a child process under a network-blocking preload and passes it a minimal environment',
    off: ['no-restricted-imports', 'no-restricted-properties', 'sbx/no-global-alias'],
  },
  {
    files: [`${WIRE_HTTPS}.ts`],
    reason:
      'FIX-MVPB-SEAL2 M3: the production Wire rechecks process.env and process.execArgv for proxy, trust-store and loader overrides before every request (boot-time checks alone miss a later change)',
    off: ['no-restricted-properties', 'sbx/no-global-alias'],
  },
  {
    files: [`${WIRE_HTTPS}.env.test.ts`],
    reason:
      'FIX-MVPB-SEAL2 M3: the test sets process.execArgv per case to prove the Wire refuses Node flags on every request (it runs against fake node:https, node:tls and node:dns modules and cannot reach a network)',
    off: ['sbx/no-global-alias'],
  },
  {
    files: ['scripts/record-fixtures.test.ts'],
    reason:
      "SEAL3 H-A: the recorder CLI test feeds the recorder's hostile corpus (packages/transport/src/recorder-corpus.ts, deliberately not exported) to the CLI; it opens no network and builds no transport",
    off: ['sbx/sealed-transport'],
  },
  {
    files: [
      'packages/safety/src/scoped-gate.ts',
      'packages/safety/src/scoped-gate.state.test.ts',
      'packages/safety/src/seal.adversarial.test.ts',
    ],
    reason:
      'FIX-MVPB-SEAL2 H1 (narrowed in SEAL3): scoped-gate.ts claims the one approval minter when it loads; its state test builds the approved transport from a real scoped gate; the adversarial probe takes the transport namespace. No other safety file may',
    off: ['sbx/sealed-transport'],
  },
  {
    files: ['packages/paypal/src/sandbox-wire.integration.test.ts'],
    reason:
      'FIX-MVPB-SEAL2 H1: the test never loads @umsbx/safety, so its own module registry claims the minter with a permissive predicate to mint a capability for a fake gate and drive the adapter over the approved transport and a fake Wire',
    off: ['sbx/sealed-transport'],
  },
  {
    files: ['tests/mvp-b/no-mint-by-path.test.ts'],
    reason:
      'FIX-MVPB-SEAL4 item 1: the runtime test that imports the transport and safety sources by plain and percent-encoded path, and shows none of them yields a minter (the safety package already holds the claim). It is the one file that spells those paths on purpose',
    off: ['sbx/no-package-escape', 'sbx/sealed-transport'],
  },
];
for (const e of NAMED_EXEMPTIONS)
  for (const r of e.off)
    if (NON_EXEMPTABLE.includes(r))
      throw new Error(
        `SEAL5: ${r} cannot be switched off by a named exemption (${e.files.join(', ')})`,
      );
const namedExemptions = NAMED_EXEMPTIONS.map((e) => ({
  files: e.files,
  rules: Object.fromEntries(e.off.map((r) => [r, 'off'])),
}));

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/.next/**',
      '**/dist/**',
      '**/coverage/**',
      '.data/**',
      '.pglite/**',
      'pnpm-lock.yaml',
      'docs/design/**',
      // Written by next build; not ours to lint or format (L4).
      'apps/web/next-env.d.ts',
    ],
  },
  // Review 4 H1: an inline eslint-disable comment would switch off any guard above, so none is
  // honoured anywhere. Exemptions live in this file, named by path.
  { linterOptions: { noInlineConfig: true, reportUnusedDisableDirectives: 'off' } },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { files: CODE, languageOptions: { globals: { ...globals.node } } },
  { files: ['**/*.jsx'], languageOptions: { parserOptions: { ecmaFeatures: { jsx: true } } } },
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
  },
  // Default for every other code file (root scripts, configs): global bans apply.
  entry(CODE),
  // The ESLint config itself and the guard scripts name forbidden patterns as data.
  { files: ['eslint.config.mjs'], rules: { 'no-restricted-syntax': 'off' } },
  // The guard scripts and their tests spawn processes (node:child_process) to run each other.
  entry(['scripts/**/*.{ts,mjs,js}'], { allow: { proc: true } }),
  // Per-package entries come last so their clause lists win.
  ...packageEntries,
  ...webEntries,
  ...namedExemptions,
  prettier,
);
