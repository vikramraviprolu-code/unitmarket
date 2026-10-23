import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT, materialize, runGuard } from './test-helpers';

const GUARD = 'check-hosting.mjs';

// Each bad fixture is the real blueprint with exactly one unsafe change. The guard must exit 1 and
// name the rule. It must never print a value (a secret with a value is the point of one fixture).
const BAD: Array<[fixture: string, rule: string]> = [
  ['bad-secret-value', 'secret-with-value'],
  ['bad-secret-generated', 'secret-with-value'],
  ['bad-live-value', 'live-value'],
  ['bad-production-mode', 'live-value'],
  ['bad-paypal-host', 'paypal-host'],
  ['bad-two-instances', 'instances'],
  ['bad-no-disk', 'disk'],
  ['bad-disk-size', 'disk'],
  ['bad-pglite-outside', 'pglite-dir'],
  ['bad-pglite-traversal', 'pglite-dir'],
  ['bad-unknown-name', 'unknown-name'],
  ['bad-node-options', 'node-options'],
  ['bad-proxy-var', 'proxy-var'],
  ['bad-public-secret', 'public-name'],
  ['bad-public-label-value', 'fixed-value'],
  ['bad-autodeploy-on', 'auto-deploy'],
  ['bad-autodeploy-missing', 'auto-deploy'],
  ['bad-telemetry', 'telemetry'],
  ['bad-trusted-proxies', 'fixed-value'],
  ['bad-connect-on', 'fixed-value'],
  ['bad-node-version', 'fixed-value'],
  ['bad-free-plan', 'service-shape'],
  ['bad-second-service', 'service-shape'],
  ['bad-health', 'service-shape'],
  ['bad-tab', 'parse'],
  ['bad-duplicate-key', 'duplicate-key'],
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
});
