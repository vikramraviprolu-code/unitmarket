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

const CODE = ['**/*.ts', '**/*.tsx', '**/*.mts', '**/*.cts', '**/*.mjs', '**/*.js', '**/*.cjs'];
const TESTS = ['**/*.test.ts', '**/*.test.tsx'];
const at = (dir) => [`${dir}/**/*.{ts,tsx,mts,cts,mjs,js,cjs}`];
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
];
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
const BASE_PATTERNS = [pat(SIM, MSG_SIM), pat(NETWORK_MODULES, MSG_NET), DEEP];

const BASE_PATHS = [
  {
    name: 'node:process',
    importNames: ['env'],
    message: 'S3: only packages/config reads process.env.',
  },
  { name: 'process', importNames: ['env'], message: 'S3: only packages/config reads process.env.' },
  {
    name: 'node:crypto',
    importNames: ['randomUUID', 'randomBytes', 'randomInt', 'getRandomValues'],
    message: 'S6: randomness and ids only in packages/runtime (inject Ids or an Rng).',
  },
  {
    name: 'crypto',
    importNames: ['randomUUID', 'randomBytes', 'randomInt', 'getRandomValues'],
    message: 'S6: randomness and ids only in packages/runtime (inject Ids or an Rng).',
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
  { object: 'globalThis', property: 'fetch', message: MSG_NET },
  { object: 'process', property: 'env', message: 'S3: only packages/config reads process.env.' },
];
const GLOBAL_OBJ = '/^(globalThis|self|window|global)$/';
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
      selector: `VariableDeclarator[init.name=${GLOBAL_OBJ}][id.type='ObjectPattern']`,
      message: 'S2: do not destructure the global object; it can pull in fetch.',
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
    messages: { barred: '{{msg}}', dynamic: 'Dynamic import needs a string literal specifier.' },
  },
  create(context) {
    const opts = context.options[0] ?? {};
    const patterns = (opts.patterns ?? []).map((p) => ({
      res: p.group.map(globToRegExp),
      message: p.message,
    }));
    const paths = (opts.paths ?? []).filter((p) => p.importNames === undefined);
    const staticSpec = (n) => {
      if (n?.type === 'Literal' && typeof n.value === 'string') return n.value;
      if (n?.type === 'TemplateLiteral' && n.expressions.length === 0)
        return n.quasis[0].value.cooked;
      return null;
    };
    const check = (node, arg, isRequire) => {
      const spec = staticSpec(arg);
      if (spec === null) {
        if (!isRequire) context.report({ node, messageId: 'dynamic' });
        return;
      }
      const hit =
        patterns.find((p) => p.res.some((r) => r.test(spec))) ?? paths.find((p) => p.name === spec);
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
const sbx = {
  rules: {
    'no-package-escape': noPackageEscape,
    'no-restricted-dynamic-import': noRestrictedDynamicImport,
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
  const patterns = BASE_PATTERNS.filter((p) => !(allow.network && p.message === MSG_NET)).concat(
    extra,
  );
  const basePaths = BASE_PATHS.filter(
    (p) => !(allow.time && p.name.endsWith('crypto')) && !(allow.env && p.name.endsWith('process')),
  );
  return {
    files,
    ...(ignores.length ? { ignores } : {}),
    plugins: { sbx },
    rules: {
      'sbx/no-package-escape': 'error',
      'no-restricted-imports': ['error', { patterns, paths: [...basePaths, ...paths] }],
      'no-restricted-globals': allow.network ? 'off' : ['error', ...NO_FETCH_GLOBALS],
      'no-restricted-properties': ['error', ...props],
      'sbx/no-restricted-dynamic-import': [
        'error',
        { patterns, paths: [...basePaths, ...paths], allowNetwork: Boolean(allow.network) },
      ],
      'no-restricted-syntax': [
        'error',
        ...(allow.time ? [] : SYNTAX.time),
        ...(allow.network ? [] : SYNTAX.network),
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
      opts,
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

const packageEntries = [
  // Z2/Z3 domain: pure TypeScript. Contracts and sibling domain modules only (S1).
  ...DOMAIN.flatMap((name) => {
    const extra = [
      pat(except(INFRA, ['testkit']), S1_MSG),
      pat(FRAMEWORK, S1_MSG),
      pat(DRIVERS, S1_MSG),
      ...(['discovery', 'fit'].includes(name) ? [pat(AGENT_FORBIDDEN, S4_MSG)] : []),
    ];
    return pair(`domain/${name}`, { extra, prod: [] });
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
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { files: CODE, languageOptions: { globals: { ...globals.node } } },
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
  },
  // Default for every other code file (root scripts, configs): global bans apply.
  entry(CODE),
  // The ESLint config itself and the guard scripts name forbidden patterns as data.
  { files: ['eslint.config.mjs'], rules: { 'no-restricted-syntax': 'off' } },
  // Per-package entries come last so their clause lists win.
  ...packageEntries,
  ...webEntries,
  prettier,
);
