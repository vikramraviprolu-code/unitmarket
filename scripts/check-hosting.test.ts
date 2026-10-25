import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT, materialize, runGuard } from './test-helpers';

const GUARD = 'check-hosting.mjs';

// Each bad fixture is the real blueprint with exactly one unsafe change. The guard must exit 1 and
// name the rule. It must never print a value (a secret with a value is the point of one fixture).
const BAD: Array<[fixture: string, rule: string]> = [
  // secrets, live values, hosts
  ['bad-secret-value', 'secret-with-value'],
  ['bad-secret-generated', 'secret-with-value'],
  ['bad-secret-missing', 'secret-with-value'],
  ['bad-secret-fromservice', 'secret-with-value'],
  ['bad-secret-sync-true', 'secret-with-value'],
  ['bad-live-value', 'live-value'],
  ['bad-live-uppercase', 'live-value'],
  ['bad-production-mode', 'live-value'],
  ['bad-prod-elsewhere', 'live-value'],
  ['bad-service-name-live', 'live-value'],
  ['bad-key-live', 'live-value'],
  ['bad-paypal-host', 'paypal-host'],
  ['bad-disk-name-paypal', 'paypal-host'],
  // shape of the service
  ['bad-two-instances', 'instances'],
  ['bad-instances-string', 'instances'],
  ['bad-no-disk', 'disk'],
  ['bad-disk-size', 'disk'],
  ['bad-disk-name', 'disk'],
  ['bad-disk-mount', 'disk'],
  ['bad-pglite-outside', 'pglite-dir'],
  ['bad-pglite-traversal', 'pglite-dir'],
  ['bad-pglite-dot', 'pglite-dir'],
  ['bad-pglite-doubleslash', 'pglite-dir'],
  ['bad-pglite-mount-itself', 'pglite-dir'],
  ['bad-free-plan', 'service-shape'],
  ['bad-pro-plan', 'service-shape'],
  ['bad-second-service', 'service-shape'],
  ['bad-health', 'service-shape'],
  ['bad-type', 'service-shape'],
  ['bad-runtime', 'service-shape'],
  ['bad-build', 'service-shape'],
  ['bad-start', 'service-shape'],
  ['bad-node-options-in-start', 'service-shape'],
  ['bad-node-options-in-build', 'service-shape'],
  ['bad-predeploy', 'service-shape'],
  ['bad-service-key', 'service-shape'],
  ['bad-autodeploy-trigger', 'service-shape'],
  ['bad-top-key', 'service-shape'],
  ['bad-envvargroups', 'service-shape'],
  ['bad-no-envvars', 'service-shape'],
  ['bad-fixed-generatevalue', 'service-shape'],
  ['bad-fixed-sync-false', 'service-shape'],
  // names and fixed values
  ['bad-unknown-name', 'unknown-name'],
  ['bad-corridors-name', 'unknown-name'],
  ['bad-node-options', 'node-options'],
  ['bad-proxy-var', 'proxy-var'],
  ['bad-proxy-var-lower', 'proxy-var'],
  ['bad-public-secret', 'public-name'],
  ['bad-public-vite', 'public-name'],
  ['bad-public-react', 'public-name'],
  ['bad-public-label-value', 'fixed-value'],
  ['bad-autodeploy-on', 'auto-deploy'],
  ['bad-autodeploy-missing', 'auto-deploy'],
  ['bad-autodeploy-dup', 'duplicate-key'],
  ['bad-telemetry', 'telemetry'],
  ['bad-trusted-proxies', 'fixed-value'],
  ['bad-trusted-proxies-zero', 'fixed-value'],
  ['bad-connect-on', 'fixed-value'],
  ['bad-node-version', 'fixed-value'],
  ['bad-node-env-value', 'fixed-value'],
  ['bad-fixed-missing', 'fixed-value'],
  ['bad-duplicate-key', 'duplicate-key'],
  // value types: every env value is a quoted string
  ['bad-bare-value', 'value-type'],
  ['bad-bare-number', 'value-type'],
  ['bad-bare-bool', 'value-type'],
  ['bad-list-value', 'value-type'],
  // the parser refuses what it does not model (a checker must read what Render reads)
  ['bad-tab', 'parse'],
  ['bad-empty-file', 'parse'],
  ['bad-bare-onoff', 'parse'],
  ['bad-anchor', 'parse'],
  ['bad-alias', 'parse'],
  ['bad-flow-map', 'parse'],
  ['bad-flow-list', 'parse'],
  ['bad-block-scalar', 'parse'],
  ['bad-plain-continuation', 'parse'],
  ['bad-plain-colon-space', 'parse'],
  ['bad-dash-key', 'parse'],
  // F1: bytes YAML reads as line breaks or that hide text from an LF-only reader
  ['bad-cr-comment-node-options', 'parse'],
  ['bad-cr-hidden-env', 'parse'],
  ['bad-cr-secret-value', 'parse'],
  ['bad-cr-plan-hidden-keys', 'parse'],
  ['bad-cr-health-dup', 'parse'],
  ['bad-nel-in-name', 'parse'],
  ['bad-nel-in-plan', 'parse'],
  ['bad-ls-in-comment', 'parse'],
  ['bad-bom', 'parse'],
  ['bad-nonascii-comment', 'parse'],
  // comment and quote handling
  ['bad-hash-in-quoted-live', 'live-value'],
  ['bad-hash-no-space', 'service-shape'],
  ['bad-quote-unterminated', 'parse'],
  ['bad-quote-inner', 'parse'],
  ['bad-quote-mismatch', 'parse'],
  ['bad-quote-single-char', 'parse'],
  ['bad-escape', 'parse'],
  ['bad-indent-odd', 'parse'],
  ['bad-no-colon', 'parse'],
  ['bad-comments-only', 'parse'],
  ['bad-service-scalar', 'service-shape'],
  ['bad-env-entry-scalar', 'service-shape'],
  ['bad-fixed-novalue', 'service-shape'],
  ['bad-fixed-extra-field', 'service-shape'],
  ['bad-disk-extra-key', 'disk'],
  // CO-7b: the maintenance flag sits on the persistent disk, beside the PGlite folder (D-037)
  ['bad-maintenance-flag-missing', 'maintenance-flag'],
  ['bad-maintenance-flag-tmp', 'maintenance-flag'],
  ['bad-maintenance-flag-inside-pglite', 'maintenance-flag'],
  ['bad-maintenance-flag-sibling-folder', 'maintenance-flag'],
  ['bad-maintenance-flag-traversal', 'maintenance-flag'],
  ['bad-maintenance-flag-name', 'maintenance-flag'],
  ['bad-maintenance-flag-relative', 'maintenance-flag'],
  ['bad-maintenance-flag-sync-false', 'maintenance-flag'],
  ['bad-maintenance-flag-dup', 'duplicate-key'],
  ['bad-maintenance-flag-pglite-moved', 'maintenance-flag'],
];

describe('check-hosting', () => {
  it('passes on the real render.yaml', () => {
    const r = runGuard(GUARD);
    expect(r.out).toContain('hosting ok');
    expect(r.status).toBe(0);
  });

  it('passes on the good fixture', () => {
    const r = runGuard(GUARD, materialize('hosting/good'));
    expect(r.out).toContain('hosting ok');
    expect(r.status).toBe(0);
  });

  it.each(BAD)('fails on %s with rule %s', (name, rule) => {
    const r = runGuard(GUARD, materialize(`hosting/${name}`));
    expect(r.status).toBe(1);
    expect(r.out).toContain(`hosting: FAIL ${rule}`);
    expect(r.out).not.toContain('hosting ok');
  });

  it('never prints a value from the file', () => {
    const r = runGuard(GUARD, materialize('hosting/bad-secret-value'));
    expect(r.out).toContain('UMS_SESSION_SECRET');
    expect(r.out).not.toContain('not-a-real-value-0001');
  });

  it('fails when render.yaml is missing', () => {
    const r = runGuard(GUARD, materialize('hosting/good') + '/does-not-exist');
    expect(r.status).toBe(1);
    expect(r.out).toContain('hosting: FAIL parse');
  });

  it('the real render.yaml holds no value for any secret name', () => {
    const text = readFileSync(`${REPO_ROOT}/render.yaml`, 'utf8');
    for (const name of [
      'PAYPAL_CLIENT_ID',
      'PAYPAL_CLIENT_SECRET',
      'PAYPAL_WEBHOOK_ID',
      'UMS_OUTBOUND_APPROVAL_REF',
      'UMS_SESSION_SECRET',
      'UMS_APPROVAL_SECRET',
      'UMS_LINK_SECRET',
      'UMS_DEMO_PASSCODE_HASH',
      'UMS_OPERATOR_TOTP_KEYS',
      'UMS_PUBLIC_ORIGIN',
    ]) {
      expect(text).toMatch(new RegExp(`key: ${name}\\n\\s+sync: false\\n`));
    }
  });

  it('every bad fixture is a distinct, existing fixture and none passes', () => {
    expect(new Set(BAD.map(([n]) => n)).size).toBe(BAD.length);
  });

  const names = (loadText: string): string[] => {
    const read = new Set(
      [...loadText.matchAll(/'((?:UMS_|PAYPAL_|NEXT_PUBLIC_)[A-Z0-9_]+|DATABASE_URL)'/g)].map(
        (m) => m[1] as string,
      ),
    );
    // Deliberately not allowed in the blueprint: the default corridor list is kept, a database
    // URL is a secret that PGlite-on-disk does not need, and the webhook certificate learn window
    // (CO-1d, D-038) is a dashboard-only, time-limited setting that must never be committed.
    for (const n of ['UMS_CORRIDORS', 'DATABASE_URL', 'UMS_WEBHOOK_CERT_LEARN_UNTIL'])
      read.delete(n);
    const extras = [
      'UMS_OUTBOUND_SCOPE',
      'UMS_OPERATOR_TOTP_KEYS',
      'NODE_VERSION',
      'NODE_ENV',
      'NEXT_TELEMETRY_DISABLED',
    ];
    // A set: other lanes make load.ts read the extras too, and that must not break this test.
    return [...new Set([...read, ...extras])].sort();
  };

  it('allowed env names are the names packages/config reads plus the reviewed extras', () => {
    const load = readFileSync(`${REPO_ROOT}/packages/config/src/load.ts`, 'utf8');
    const r = spawnSync(
      process.execPath,
      [`${REPO_ROOT}/scripts/check-hosting.mjs`, '--print-names'],
      { encoding: 'utf8' },
    );
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual(names(load));
    expect(JSON.parse(r.stdout)).not.toContain('UMS_WEBHOOK_CERT_LEARN_UNTIL');
  });

  it('the names comparison tolerates a load.ts that already reads an extra name', () => {
    const base = "val(env, 'UMS_MODE'); val(env, 'UMS_CORRIDORS'); val(env, 'DATABASE_URL');";
    const withExtras = `${base} val(env, 'UMS_OUTBOUND_SCOPE'); val(env, 'UMS_OPERATOR_TOTP_KEYS');`;
    expect(names(withExtras)).toEqual(names(base));
    expect(new Set(names(withExtras)).size).toBe(names(withExtras).length);
  });

  it('refuses an upper-case PayPal host', () => {
    const dir = materialize('hosting/bad-paypal-host');
    const file = `${dir}/render.yaml`;
    const text = readFileSync(file, 'utf8');
    writeFileSync(
      file,
      text.replace(/api-m\.sandbox\.paypal\.com/, (h) => h.toUpperCase()),
    );
    expect(readFileSync(file, 'utf8')).toContain('API-M.SANDBOX.');
    const r = runGuard(GUARD, dir);
    expect(r.status).toBe(1);
    expect(r.out).toContain('hosting: FAIL paypal-host');
  });

  it('the real render.yaml pins the maintenance flag on the disk, beside the PGlite folder (CO-7b)', () => {
    const text = readFileSync(`${REPO_ROOT}/render.yaml`, 'utf8');
    expect(text).toMatch(/key: UMS_MAINTENANCE_FLAG\n\s+value: '\/var\/data\/ums-maintenance'\n/);
    expect(text).toMatch(/key: UMS_PGLITE_DIR\n\s+value: '\/var\/data\/pglite'\n/);
  });

  it('the real render.yaml is printable ASCII plus LF only', () => {
    const text = readFileSync(`${REPO_ROOT}/render.yaml`, 'utf8');
    expect(text.search(/[^\x20-\x7E\n]/)).toBe(-1);
  });
});
