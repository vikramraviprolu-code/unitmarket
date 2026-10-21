import { describe, expect, it } from 'vitest';
import { materialize, runGuard } from './test-helpers';

const GUARD = 'check-no-live-host.mjs';

describe('check-no-live-host', () => {
  it.each([
    ['bad-api-m', 'packages/paypal/src/client.ts'],
    ['bad-api', 'src/x.ts'],
    ['bad-ipn', 'src/ipn.ts'],
    ['bad-json-fixture', 'packages/testkit/fixtures/order.json'],
    ['bad-docs-outside-allowlist', 'docs/notes.md'],
  ])('fails on a live hostname in %s', (name, file) => {
    const r = runGuard(GUARD, materialize(`live-host/${name}`));
    expect(r.status).toBe(1);
    expect(r.out).toContain(file);
    expect(r.out).toMatch(/live PayPal hostname/);
  });

  it('fails on the sandbox hostname outside the one constant module', () => {
    const r = runGuard(GUARD, materialize('live-host/bad-sandbox-outside-constant'));
    expect(r.status).toBe(1);
    expect(r.out).toContain('src/other.ts');
    expect(r.out).toMatch(/sandbox hostname outside/);
  });

  it('passes when the sandbox host is only in endpoints.ts and live names only in docs/design', () => {
    const r = runGuard(GUARD, materialize('live-host/good'));
    expect(r.out).toContain('check-no-live-host: ok');
    expect(r.status).toBe(0);
  });

  it('passes on the clean repository', () => {
    const r = runGuard(GUARD);
    expect(r.out).toContain('check-no-live-host: ok');
    expect(r.status).toBe(0);
  });
});
