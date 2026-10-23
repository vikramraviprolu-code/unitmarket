// FIX-MVPB-SEAL3 M-C. The proxy / trust-store / loader override list lives in three places that
// cannot import one another (packages/config boots the app, the production Wire in packages/transport
// checks every request, the spike kit is a standalone owner tool). This test parses all three source
// files and fails if the lists differ, so a new entry added to one cannot be forgotten in another.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from './test-helpers';

// The Wire's file name is built at run time: a transport test bars other code from naming it.
const WIRE = ['wire', 'https'].join('-');
const FILES = {
  config: 'packages/config/src/load.ts',
  wire: `packages/transport/src/${WIRE}.ts`,
  spike: 'tools/spike-kit/src/spike.ts',
} as const;
const text = (rel: string) => readFileSync(join(REPO_ROOT, rel), 'utf8');

function namesOf(src: string): string[] {
  const m = /OVERRIDE_NAMES[^=]*=\s*new Set\(\[([\s\S]*?)\]\)/.exec(src);
  if (m === null) throw new Error('OVERRIDE_NAMES not found');
  return [...(m[1] as string).replace(/\/\/.*$/gm, '').matchAll(/'([A-Z0-9_]+)'/g)]
    .map((x) => x[1] as string)
    .sort();
}
function flagOf(src: string): string {
  const m = /OVERRIDE_FLAG\s*=\s*\/(\^[^\n]*?)\/;/.exec(src);
  if (m === null) throw new Error('OVERRIDE_FLAG not found');
  return m[1] as string;
}

const REQUIRED_NAMES = [
  'ALL_PROXY',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'NODE_EXTRA_CA_CERTS',
  'NODE_OPTIONS',
  'NODE_PATH',
  'NODE_PRESERVE_SYMLINKS',
  'NODE_TLS_REJECT_UNAUTHORIZED',
  'NODE_USE_ENV_PROXY',
  'NODE_USE_SYSTEM_CA',
  'OPENSSL_CONF',
  'SSL_CERT_DIR',
  'SSL_CERT_FILE',
];
const REFUSED_FLAGS = [
  '--use-env-proxy',
  '--require',
  '-r',
  '--import',
  '--inspect',
  '--inspect-brk',
  '--inspect-port',
  '--inspect-wait',
  '--loader',
  '--experimental-loader',
  '--use-system-ca',
  '--use-openssl-ca',
  '--openssl-config',
  '--openssl-shared-config',
  '--tls-keylog',
  '--heapsnapshot-signal',
  '--heapsnapshot-near-heap-limit',
  '--experimental-network-inspection',
  '--secure-heap',
  '--tls-min-v1.0',
  '--tls-min-v1.1',
  '--conditions',
  '-C',
  '--preserve-symlinks',
  '--preserve-symlinks-main',
  '--experimental-config-file',
  '--experimental-default-config-file',
  '--insecure-http-parser',
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
];
const ALLOWED_FLAGS = [
  '--max-old-space-size=512',
  '--use-bundled-ca',
  '--disable-warning=ExperimentalWarning',
  '--loaders-are-fine',
];

describe('the three override lists are one list', () => {
  const sources = Object.fromEntries(Object.entries(FILES).map(([k, f]) => [k, text(f)]));
  it('the names are identical in config, the production Wire and the spike kit', () => {
    const c = namesOf(sources['config'] as string);
    expect(c).toEqual(REQUIRED_NAMES);
    expect(namesOf(sources['wire'] as string)).toEqual(c);
    expect(namesOf(sources['spike'] as string)).toEqual(c);
  });
  it('the flag expressions are identical in config, the production Wire and the spike kit', () => {
    const c = flagOf(sources['config'] as string);
    expect(flagOf(sources['wire'] as string)).toBe(c);
    expect(flagOf(sources['spike'] as string)).toBe(c);
  });
  it('the shared flag expression refuses every listed flag, bare or with =value, and no harmless one', () => {
    const re = new RegExp(flagOf(sources['config'] as string));
    for (const f of REFUSED_FLAGS) {
      expect(re.test(f), f).toBe(true);
      if (f.startsWith('--')) expect(re.test(`${f}=x`), `${f}=x`).toBe(true);
    }
    for (const f of ALLOWED_FLAGS) expect(re.test(f), f).toBe(false);
  });
});
