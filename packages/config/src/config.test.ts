import { describe, expect, it, vi } from 'vitest';
import { bootOrExit, loadConfig, makeSecret } from './index';

// Review 4 L8: a secret of one repeated character is refused, so the fixtures use mixed text.
const S1 = 'Qm7vK2pLx9RbT4zWc8NdYh3JfG6sAe1U';
const S2 = 'Zr5tB8nKd2VwXq7LmC4yHj9PgF3sEa6U';
const S3 = 'Jd4wN7xQk2ZcR9vTb5LmY8hGp3FsAe6U';
// Built at runtime so no live hostname literal sits in the tree (S7).
const LIVE_HOST = ['api-m', 'paypal', 'com'].join('.');
const SANDBOX_HOST = ['api-m', 'sandbox', 'paypal', 'com'].join('.');

const offline = (over: Record<string, string | undefined> = {}) => ({
  UMS_SESSION_SECRET: S1,
  UMS_APPROVAL_SECRET: S2,
  UMS_LINK_SECRET: S3,
  ...over,
});
const sandbox = (over: Record<string, string | undefined> = {}) =>
  offline({
    UMS_MODE: 'sandbox',
    UMS_OUTBOUND_APPROVAL_REF: 'DL-2026-10-22-01',
    PAYPAL_CLIENT_ID: 'client-id-value',
    PAYPAL_CLIENT_SECRET: 'client-secret-value-xyz',
    ...over,
  });

const refusal = (env: Record<string, string | undefined>) => {
  const r = loadConfig(env);
  if (r.ok) throw new Error('expected refusal');
  return r.error;
};

describe('loadConfig accepts', () => {
  it('offline defaults', () => {
    const r = loadConfig(offline());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.mode).toBe('offline');
    expect(r.value.connect).toBe(false);
    expect(r.value.paypal).toBeNull();
    expect(r.value.db).toEqual({ kind: 'pglite-memory' });
    expect(r.value.env_label).toBe('Dry run');
    expect(r.value.corridors).toEqual(['us-usd']);
    expect(r.value.node_env).toBe('development');
    expect(r.value.session_secret.reveal()).toBe(S1);
  });
  it('sandbox with credentials and approval ref', () => {
    const r = loadConfig(sandbox({ UMS_PAYPAL_CONNECT: 'on' }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.mode).toBe('sandbox');
    expect(r.value.connect).toBe(true);
    expect(r.value.env_label).toBe('Sandbox');
    expect(r.value.outbound_approval_ref).toBe('DL-2026-10-22-01');
    expect(r.value.paypal?.client_secret.reveal()).toBe('client-secret-value-xyz');
  });
  it('http://localhost origin with a port, pglite-disk and postgres targets', () => {
    expect(loadConfig(offline({ UMS_PUBLIC_ORIGIN: 'http://localhost:3000' })).ok).toBe(true);
    const d = loadConfig(offline({ UMS_DB: 'pglite-disk', UMS_PGLITE_DIR: '/tmp/x' }));
    expect(d.ok && d.value.db).toEqual({ kind: 'pglite-disk', dir: '/tmp/x' });
    const p = loadConfig(offline({ UMS_DB: 'postgres', DATABASE_URL: 'postgres://u:p@h/db' }));
    expect(p.ok && p.value.db.kind).toBe('postgres');
  });
});

describe('loadConfig refuses (P15, RLR-4)', () => {
  it('UMS_MODE=live refuses live_not_available', () => {
    expect(refusal(offline({ UMS_MODE: 'live' }))).toEqual({
      code: 'live_not_available',
      name: 'UMS_MODE',
    });
    expect(refusal(offline({ UMS_MODE: 'Production' })).code).toBe('live_not_available');
    expect(refusal(offline({ UMS_MODE: 'sandbox-live' })).code).toBe('live_not_available');
  });
  it('unknown mode refuses', () => {
    expect(refusal(offline({ UMS_MODE: 'staging' }))).toEqual({
      code: 'unknown_mode',
      name: 'UMS_MODE',
    });
  });
  it('a value containing a live PayPal host refuses non_sandbox_host', () => {
    expect(refusal(offline({ UMS_PUBLIC_ORIGIN: `https://${LIVE_HOST}` }))).toEqual({
      code: 'non_sandbox_host',
      name: 'UMS_PUBLIC_ORIGIN',
    });
    expect(
      refusal(
        offline({
          DATABASE_URL: `postgres://x@db/y?cb=https://www.${['paypal', 'com'].join('.')}/`,
        }),
      ).code,
    ).toBe('non_sandbox_host');
  });
  it('D-013: no environment variable may carry any PayPal host, not even the sandbox host', () => {
    const PP = ['paypal', 'com'].join('.');
    for (const v of [
      `https://${SANDBOX_HOST}`,
      `https://${LIVE_HOST}`,
      `HTTPS://API-M.SANDBOX.${PP.toUpperCase()}/x`,
      `https://api-m.sandbox.${PP.replace('.', '%2E')}`,
    ]) {
      expect(refusal(offline({ UMS_PUBLIC_ORIGIN: v })).code, v).toBe('non_sandbox_host');
    }
    // an unrelated variable (not in the known list) is refused as well
    const r = loadConfig({ ...offline(), SOME_OTHER_VAR: `https://${SANDBOX_HOST}` });
    expect(!r.ok && r.error).toEqual({ code: 'non_sandbox_host', name: 'SOME_OTHER_VAR' });
  });
  it('sandbox without approval ref refuses; without credentials refuses', () => {
    expect(refusal(sandbox({ UMS_OUTBOUND_APPROVAL_REF: undefined }))).toEqual({
      code: 'missing_value',
      name: 'UMS_OUTBOUND_APPROVAL_REF',
    });
    expect(refusal(sandbox({ PAYPAL_CLIENT_ID: undefined })).name).toBe('PAYPAL_CLIENT_ID');
    expect(refusal(sandbox({ PAYPAL_CLIENT_SECRET: '' })).name).toBe('PAYPAL_CLIENT_SECRET');
  });
  it('31-byte secret refuses; 32-byte passes', () => {
    expect(refusal(offline({ UMS_LINK_SECRET: 'x'.repeat(31) }))).toEqual({
      code: 'weak_secret',
      name: 'UMS_LINK_SECRET',
    });
    expect(loadConfig(offline({ UMS_LINK_SECRET: 'xY'.repeat(16) })).ok).toBe(true);
  });
  it('multi-byte characters count as bytes', () => {
    expect(loadConfig(offline({ UMS_LINK_SECRET: 'éa'.repeat(16) })).ok).toBe(true);
  });
  it('missing secret refuses missing_value', () => {
    expect(refusal(offline({ UMS_SESSION_SECRET: undefined }))).toEqual({
      code: 'missing_value',
      name: 'UMS_SESSION_SECRET',
    });
  });
  it('equal secrets refuse', () => {
    const r = refusal(offline({ UMS_APPROVAL_SECRET: S1 }));
    expect(r.code).toBe('equal_secrets');
  });
  it('http origin refuses except localhost', () => {
    expect(refusal(offline({ UMS_PUBLIC_ORIGIN: 'http://example.org' }))).toEqual({
      code: 'insecure_origin',
      name: 'UMS_PUBLIC_ORIGIN',
    });
    expect(refusal(offline({ UMS_PUBLIC_ORIGIN: 'http://localhost.evil.test' })).code).toBe(
      'insecure_origin',
    );
    expect(loadConfig(offline({ UMS_PUBLIC_ORIGIN: 'http://localhost' })).ok).toBe(true);
    expect(loadConfig(offline({ UMS_PUBLIC_ORIGIN: 'https://um.example.org' })).ok).toBe(true);
  });
  it('production, offline and no passcode hash refuses', () => {
    const env = offline({ NODE_ENV: 'production', UMS_PUBLIC_ORIGIN: 'https://um.example.org' });
    expect(refusal(env)).toEqual({ code: 'missing_value', name: 'UMS_DEMO_PASSCODE_HASH' });
    expect(
      loadConfig({
        ...env,
        UMS_DEMO_PASSCODE_HASH: `scrypt:16384:8:1:${'00'.repeat(16)}:${'ab'.repeat(32)}`,
      }).ok,
    ).toBe(true);
  });
  it('unknown corridor refuses', () => {
    expect(refusal(offline({ UMS_CORRIDORS: 'us-usd,xx-zzz' }))).toEqual({
      code: 'unknown_corridor',
      name: 'UMS_CORRIDORS',
    });
  });
  it('pglite-disk without a dir and postgres without a url refuse', () => {
    expect(refusal(offline({ UMS_DB: 'pglite-disk' })).name).toBe('UMS_PGLITE_DIR');
    expect(refusal(offline({ UMS_DB: 'postgres' })).name).toBe('DATABASE_URL');
    expect(refusal(offline({ UMS_DB: 'sqlite' })).name).toBe('UMS_DB');
  });
  it('bad connect flag refuses', () => {
    expect(refusal(offline({ UMS_PAYPAL_CONNECT: 'yes' })).name).toBe('UMS_PAYPAL_CONNECT');
  });
  it('refusal text never contains the value', () => {
    const secretish = 'v'.repeat(31);
    const cases = [
      offline({ UMS_MODE: 'live-zzzz-marker' }),
      offline({ UMS_LINK_SECRET: secretish }),
      offline({ UMS_PUBLIC_ORIGIN: `https://${LIVE_HOST}/marker-q` }),
      offline({ UMS_APPROVAL_SECRET: S1 }),
    ];
    for (const env of cases) {
      const text = JSON.stringify(refusal(env));
      for (const v of ['live-zzzz-marker', secretish, 'marker-q', S1, LIVE_HOST]) {
        expect(text).not.toContain(v);
      }
    }
  });
});

// Opus review 4 M1, M2, M3, L8.
describe('boot refusal bypasses (review 4)', () => {
  const PY = ['pay', 'pal'].join('');
  const PP = ['paypal', 'com'].join('.');
  const host = (sep: string, label = 'api-m') => `https://${label}${sep}${PP.replace('.', sep)}`;
  it('M1: characters URL parsing removes or maps still carry the host', () => {
    const variants = [
      `https://api-m.${PY}\u3002com`,
      `https://api-m.pay\u00ad${'pal'}.com`,
      `https://api-m.pay\u034f${'pal'}.com`,
      `https://api-m.pay\u200b${'pal'}.com`,
      `https://api-m.pay\u2060${'pal'}.com`,
      `https://api-m.pay\ufeff${'pal'}.com`,
      `https://api-m.pay\u180b${'pal'}.com`,
      `https://api-m.pay\ufe0f${'pal'}.com`,
      `https://api-m.\uff50\uff41\uff59${'\uff50\uff41\uff4c'}.com`,
      `https://api-m.${PY}\uff0ecom`,
      `https://api-m.${PY}\uff61com`,
      `https://api-m.${'paypa'}\u2113.com`,
      `https://api-m.${PY}%E3%80%82com`,
      `https://api-m.pay%C2%AD${'pal'}.com`,
      `https://www.${PY}objects.com/x`,
      `https://api-m.${'paypa'}\u200dl.com`,
    ];
    for (const v of variants) {
      expect(refusal(offline({ UMS_PUBLIC_ORIGIN: v })).code, JSON.stringify(v)).toBe(
        'non_sandbox_host',
      );
    }
    expect(host('.').length).toBeGreaterThan(0);
  });
  it('M1: an ordinary origin is not refused', () => {
    expect(loadConfig(offline({ UMS_PUBLIC_ORIGIN: 'https://um.example.org' })).ok).toBe(true);
  });
  it('M2: NODE_ENV in another casing counts as that value; unknown values refuse', () => {
    const env = offline({ UMS_PUBLIC_ORIGIN: 'https://um.example.org' });
    for (const v of ['Production', 'PRODUCTION', ' production ']) {
      expect(refusal({ ...env, NODE_ENV: v })).toEqual({
        code: 'missing_value',
        name: 'UMS_DEMO_PASSCODE_HASH',
      });
    }
    expect(refusal({ ...env, NODE_ENV: 'prod' })).toEqual({
      code: 'missing_value',
      name: 'NODE_ENV',
    });
    expect(refusal({ ...env, NODE_ENV: 'staging' }).name).toBe('NODE_ENV');
    const t = loadConfig({ ...env, NODE_ENV: 'TEST' });
    expect(t.ok && t.value.node_env).toBe('test');
    const d = loadConfig({ ...env, NODE_ENV: 'development' });
    expect(d.ok && d.value.node_env).toBe('development');
    const none = loadConfig(env);
    expect(none.ok && none.value.node_env).toBe('development');
  });
  it('M3: a public origin must be exactly an origin', () => {
    for (const v of [
      'https://evil.com@localhost',
      'https://x?y',
      'https://x#y',
      'https://x/path',
      'https://x/',
      'https://user:pw@um.example.org',
      'https://um.example.org:99999',
      'http://localhost:3000/x',
      'http://localhost@evil.test',
      'https://exa mple.org',
      'https://um.example.org\\@evil.test',
    ]) {
      expect(refusal(offline({ UMS_PUBLIC_ORIGIN: v })).code, v).toBe('insecure_origin');
    }
    for (const v of [
      'https://um.example.org',
      'https://um.example.org:8443',
      'http://localhost:3000',
    ])
      expect(loadConfig(offline({ UMS_PUBLIC_ORIGIN: v })).ok, v).toBe(true);
  });
  it('L8: repeated-character and blank secrets are weak; client id equal to secret is refused', () => {
    for (const v of [
      'a'.repeat(32),
      'é'.repeat(16),
      ' '.repeat(40),
      '\t'.repeat(40),
      '0'.repeat(64),
    ])
      expect(refusal(offline({ UMS_LINK_SECRET: v })), JSON.stringify(v)).toEqual({
        code: 'weak_secret',
        name: 'UMS_LINK_SECRET',
      });
    expect(
      refusal(
        sandbox({
          PAYPAL_CLIENT_ID: 'same-value-for-both',
          PAYPAL_CLIENT_SECRET: 'same-value-for-both',
        }),
      ).code,
    ).toBe('equal_secrets');
  });
});

describe('bootOrExit', () => {
  it('exits 78 naming the variable and never the value', () => {
    const lines: string[] = [];
    const exit = vi.fn((code: number): never => {
      throw new Error(`exit ${code}`);
    });
    const secretish = 'v'.repeat(31);
    expect(() =>
      bootOrExit(offline({ UMS_LINK_SECRET: secretish }), exit, (l) => lines.push(l)),
    ).toThrow('exit 78');
    expect(exit).toHaveBeenCalledWith(78);
    const out = lines.join('\n');
    expect(out).toContain('UMS_LINK_SECRET');
    expect(out).toContain('weak_secret');
    expect(out).not.toContain(secretish);
  });
  it('returns the config when safe and does not exit', () => {
    const exit = vi.fn((code: number): never => {
      throw new Error(`exit ${code}`);
    });
    const c = bootOrExit(offline(), exit, () => undefined);
    expect(c.mode).toBe('offline');
    expect(exit).not.toHaveBeenCalled();
  });
});

describe('Secret (P7)', () => {
  it('toString and JSON.stringify give [redacted]', () => {
    const s = makeSecret('super-secret-value');
    expect(String(s)).toBe('[redacted]');
    expect(`${s}`).toBe('[redacted]');
    expect(s.toString()).toBe('[redacted]');
    expect(JSON.stringify({ s })).toBe('{"s":"[redacted]"}');
    expect(s.reveal()).toBe('super-secret-value');
  });
  it('does not leak through inspect or own keys', async () => {
    const { inspect } = await import('node:util');
    const s = makeSecret('super-secret-value');
    expect(inspect(s)).not.toContain('super-secret-value');
    expect(Object.keys(s)).not.toContain('value');
    expect(JSON.stringify(Object.getOwnPropertyNames(s))).not.toContain('super-secret-value');
    const c = loadConfig(offline());
    expect(JSON.stringify(c)).not.toContain(S1);
  });
});

describe('F-1: PayPal- and live-looking names (A-01)', () => {
  it('unknown PayPal or live names are refused, whatever the value', () => {
    for (const name of [
      'PAYPAL_ENV',
      'PAYPAL_MODE',
      'PAYPAL_BASE_URL',
      'UMS_LIVE',
      'UMS_PAYPAL_ENV',
      'FEATURE_LIVE',
      'APP_PRODUCTION',
      'live',
    ]) {
      expect(refusal(offline({ [name]: '1' })), name).toEqual({
        code: 'live_not_available',
        name,
      });
    }
  });
  it('legitimate names still boot, and words inside other words are safe', () => {
    expect(
      loadConfig(sandbox({ PAYPAL_WEBHOOK_ID: 'WH-1AB23', UMS_PAYPAL_CONNECT: 'off' })).ok,
    ).toBe(true);
    expect(loadConfig(offline({ DELIVERY_RETRIES: '3', NODE_ENV: 'test' })).ok).toBe(true);
    expect(loadConfig(sandbox({ PAYPAL_CLIENT_ID: 'Alive-client-9' })).ok).toBe(true);
  });
  it('known identifiers with a live or production word are refused', () => {
    for (const name of ['UMS_OUTBOUND_APPROVAL_REF', 'PAYPAL_CLIENT_ID', 'PAYPAL_WEBHOOK_ID']) {
      expect(refusal(sandbox({ [name]: 'production-1' })).code, name).toBe('live_not_available');
    }
  });
});

// Gate review M3 and L3.
describe('UMS_TRUSTED_PROXIES (M3)', () => {
  it('defaults to 0 and accepts the integers 0 to 3', () => {
    const d = loadConfig(offline());
    expect(d.ok && d.value.trusted_proxies).toBe(0);
    for (const n of [0, 1, 2, 3]) {
      const r = loadConfig(offline({ UMS_TRUSTED_PROXIES: String(n) }));
      expect(r.ok && r.value.trusted_proxies, String(n)).toBe(n);
    }
  });
  it('refuses anything else, naming the variable', () => {
    for (const v of ['4', '-1', '1.5', 'abc', '1e1', '0x1', ' 2 x']) {
      expect(refusal(offline({ UMS_TRUSTED_PROXIES: v })), v).toEqual({
        code: 'invalid_value',
        name: 'UMS_TRUSTED_PROXIES',
      });
    }
  });
});

describe('the environment label must agree with the mode (L3)', () => {
  it('offline refuses a Sandbox label and sandbox refuses a Dry run label', () => {
    expect(refusal(offline({ NEXT_PUBLIC_UMS_ENV_LABEL: 'Sandbox' }))).toEqual({
      code: 'label_mode_mismatch',
      name: 'NEXT_PUBLIC_UMS_ENV_LABEL',
    });
    expect(refusal(sandbox({ NEXT_PUBLIC_UMS_ENV_LABEL: 'Dry run' })).code).toBe(
      'label_mode_mismatch',
    );
    expect(refusal(sandbox({ NEXT_PUBLIC_UMS_ENV_LABEL: 'Dry-run' })).code).toBe(
      'label_mode_mismatch',
    );
  });
  it('agreeing or unset labels boot', () => {
    expect(loadConfig(offline({ NEXT_PUBLIC_UMS_ENV_LABEL: 'Dry run' })).ok).toBe(true);
    expect(loadConfig(offline({ NEXT_PUBLIC_UMS_ENV_LABEL: 'Dry-run' })).ok).toBe(true);
    expect(loadConfig(sandbox({ NEXT_PUBLIC_UMS_ENV_LABEL: 'Sandbox' })).ok).toBe(true);
    expect(loadConfig(offline()).ok).toBe(true);
  });
  it('an unrecognised label still boots (it is a cosmetic string, the stored label wins)', () => {
    expect(loadConfig(offline({ NEXT_PUBLIC_UMS_ENV_LABEL: 'Demo' })).ok).toBe(true);
  });
});

// FIX-BPREP M1: a proxy, certificate or Node-option override changes where credentials go, so
// sandbox mode refuses to boot with one. Offline mode (the cloud container sets HTTPS_PROXY) does not.
describe('transport environment overrides (M1)', () => {
  const names = [
    'NODE_USE_ENV_PROXY',
    'NODE_TLS_REJECT_UNAUTHORIZED',
    'NODE_EXTRA_CA_CERTS',
    'NODE_OPTIONS',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'ALL_PROXY',
    // FIX-MVPB-SEAL2 M3: more ways to change which certificates or OpenSSL settings a connection uses.
    'NODE_USE_SYSTEM_CA',
    // SEAL5 / BU-1 review F3
    'NODE_PRESERVE_SYMLINKS',
    'OPENSSL_CONF',
    'SSL_CERT_FILE',
    'SSL_CERT_DIR',
  ];
  const variants = names.flatMap((n) => [n, n.toLowerCase()]);
  it.each(variants)('sandbox mode refuses %s', (name) => {
    expect(refusal(sandbox({ [name]: '1' }))).toEqual({
      code: 'transport_env_override',
      name: name.toUpperCase(),
    });
  });
  it('sandbox mode refuses a mixed-case proxy name', () => {
    expect(refusal(sandbox({ Https_Proxy: 'http://127.0.0.1:1' })).code).toBe(
      'transport_env_override',
    );
  });
  // BU-1 re-review H1. pnpm's command shims export NODE_PATH on every start (extendNodePath), so
  // refusing it would make every normal `pnpm start` fail closed. It only affects CommonJS lookup.
  const PNPM_NODE_PATH =
    '/srv/app/node_modules/.pnpm/next@15.5.4_react-dom@19.1.1_react@19.1.1/node_modules/next/dist/bin/node_modules:/srv/app/node_modules/.pnpm/next@15.5.4_react-dom@19.1.1_react@19.1.1/node_modules/next/dist/node_modules:/srv/app/node_modules/.pnpm/next@15.5.4_react-dom@19.1.1_react@19.1.1/node_modules/next/node_modules:/srv/app/node_modules/.pnpm/next@15.5.4_react-dom@19.1.1_react@19.1.1/node_modules:/srv/app/node_modules/.pnpm/node_modules';
  it('a pnpm-style NODE_PATH is not an override: sandbox mode boots with it', () => {
    expect(loadConfig(sandbox({ NODE_PATH: PNPM_NODE_PATH })).ok).toBe(true);
    expect(loadConfig(sandbox({ node_path: PNPM_NODE_PATH })).ok).toBe(true);
  });
  it('NODE_OPTIONS is still refused next to a pnpm-style NODE_PATH', () => {
    expect(
      refusal(sandbox({ NODE_PATH: PNPM_NODE_PATH, NODE_OPTIONS: '--require ./x.cjs' })),
    ).toEqual({ code: 'transport_env_override', name: 'NODE_OPTIONS' });
  });
  it('an empty value is not an override', () => {
    expect(loadConfig(sandbox({ HTTPS_PROXY: '', NODE_OPTIONS: '  ' })).ok).toBe(true);
  });
  it.each([
    '--use-env-proxy',
    '--require',
    '-r',
    '--import',
    '--inspect',
    '--inspect-brk',
    '--loader',
    '--experimental-loader',
    '--use-system-ca',
    '--use-openssl-ca',
    '--openssl-config',
    '--openssl-shared-config',
    '--tls-keylog',
    '--heapsnapshot-signal',
    '--heapsnapshot-near-heap-limit',
    '--inspect-port',
    '--inspect-wait',
    '--experimental-network-inspection',
    '--secure-heap',
    '--tls-min-v1.0',
    '--tls-min-v1.1',
    '--conditions',
    '-C',
    '--report-signal',
    '--report-on-signal',
    '--report-on-fatalerror',
    '--report-uncaught-exception',
    '--report-compact',
    '--report-dir',
    '--report-directory',
    '--report-filename',
    '--report-exclude-network',
    '--report-exclude-env',
    '--snapshot-blob',
    '--build-snapshot',
    '--preserve-symlinks',
    '--preserve-symlinks-main',
    '--experimental-config-file',
    '--experimental-config-file=./c.json',
    '--experimental-default-config-file',
    '--insecure-http-parser',
  ])('sandbox mode refuses execArgv %s', (flag) => {
    const r = loadConfig(sandbox(), { execArgv: ['--max-old-space-size=512', flag] });
    expect(!r.ok && r.error).toEqual({ code: 'transport_env_override', name: 'execArgv' });
  });
  it.each([
    '--require=./x.js',
    '--import=./x.mjs',
    '--inspect=0.0.0.0:9229',
    '--loader=./x.mjs',
    '--experimental-loader=./x.mjs',
    '--openssl-config=/tmp/x.cnf',
    '--openssl-shared-config=x',
    '--tls-keylog=/tmp/k.log',
    '--heapsnapshot-signal=SIGUSR2',
    '--heapsnapshot-near-heap-limit=3',
    '--inspect-port=9230',
    '--secure-heap=1048576',
    '--conditions=dev',
    '-C=dev',
  ])('sandbox mode refuses execArgv %s', (flag) => {
    const r = loadConfig(sandbox(), { execArgv: [flag] });
    expect(!r.ok && r.error.code).toBe('transport_env_override');
  });
  it('the system and OpenSSL certificate stores are refused together with their files', () => {
    const r = loadConfig(sandbox({ SSL_CERT_FILE: '/tmp/ca.pem' }), {
      execArgv: ['--use-openssl-ca'],
    });
    expect(!r.ok && r.error.code).toBe('transport_env_override');
    const r2 = loadConfig(sandbox(), { execArgv: ['--use-openssl-ca'] });
    expect(!r2.ok && r2.error).toEqual({ code: 'transport_env_override', name: 'execArgv' });
  });
  it('a flag that merely starts like a refused one is not refused', () => {
    expect(loadConfig(sandbox(), { execArgv: ['--loaders-are-fine', '--use-bundled-ca'] }).ok).toBe(
      true,
    );
  });
  it('sandbox mode accepts harmless execArgv', () => {
    expect(loadConfig(sandbox(), { execArgv: ['--max-old-space-size=512'] }).ok).toBe(true);
  });
  it('offline mode does not refuse them (the cloud container sets HTTPS_PROXY)', () => {
    const env = offline({
      HTTPS_PROXY: 'http://proxy.invalid:3128',
      NODE_OPTIONS: '--max-old-space-size=512',
      NODE_EXTRA_CA_CERTS: '/etc/ssl/ca.pem',
    });
    expect(loadConfig(env, { execArgv: ['--inspect'] }).ok).toBe(true);
  });
  it('the refusal line names the variable and never a value', () => {
    const w: string[] = [];
    expect(() =>
      bootOrExit(
        sandbox({ HTTPS_PROXY: 'http://user:pw-canary@proxy.invalid:3128' }),
        (c) => {
          throw new Error(`exit ${c}`);
        },
        (l) => w.push(l),
      ),
    ).toThrow('exit 78');
    expect(w.join()).toContain('transport_env_override (HTTPS_PROXY)');
    expect(w.join()).not.toContain('pw-canary');
  });
});
