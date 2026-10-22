import { describe, expect, it } from 'vitest';
import { materialize, runGuard } from './test-helpers';

const GUARD = 'check-isolation.mjs';

describe('check-isolation', () => {
  it.each([
    ['bad-sim-path', 'packages/paypal/src/a.ts'],
    ['bad-sim-scope', 'domain/payments/src/a.ts'],
    ['bad-product-scope', 'domain/payments/src/a.ts'],
    ['bad-repo-name-import', 'packages/paypal/src/a.ts'],
    ['bad-relative-escape', 'packages/config/src/a.ts'],
    ['bad-dynamic-import', 'packages/db/src/a.ts'],
    ['bad-package-json', 'packages/db/package.json'],
    ['bad-workspace-link', 'package.json'],
    ['bad-tsconfig-path', 'tsconfig.json'],
    // review H3: shapes the line-based scan missed
    ['bad-multiline-import', 'packages/db/src/a.ts'],
    ['bad-multiline-export', 'packages/db/src/a.ts'],
    ['bad-template-import', 'packages/db/src/a.ts'],
    ['bad-require-absolute', 'packages/db/src/a.ts'],
    ['bad-concat-import', 'packages/db/src/a.ts'],
    ['bad-nonstatic-import', 'packages/db/src/a.ts'],
    ['bad-relative-multiline', 'packages/db/src/a.ts'],
    ['bad-tsconfig-paths-outside', 'tsconfig.json'],
    ['bad-tsconfig-extends-array', 'packages/db/tsconfig.json'],
    ['bad-workspace-yaml', 'pnpm-workspace.yaml'],
    ['bad-link-dotdot', 'package.json'],
  ])('fails on %s', (name, file) => {
    const r = runGuard(GUARD, materialize(`isolation/${name}`));
    expect(r.status).toBe(1);
    expect(r.out).toContain(file);
    expect(r.out).toMatch(/isolation/i);
  });

  it('passes on a clean tree with a provenance header and @umsbx imports', () => {
    const r = runGuard(GUARD, materialize('isolation/good'));
    expect(r.out).toContain('check-isolation: ok');
    expect(r.status).toBe(0);
  });

  it('passes on multi-line imports, comments naming forbidden text, and in-root config paths', () => {
    const r = runGuard(GUARD, materialize('isolation/good-multiline'));
    expect(r.out).toContain('check-isolation: ok');
    expect(r.status).toBe(0);
  });

  it('passes on the clean repository', () => {
    const r = runGuard(GUARD);
    expect(r.out).toContain('check-isolation: ok');
    expect(r.status).toBe(0);
  });
});
