import { describe, expect, it } from 'vitest';
import { materialize, runGuard } from './test-helpers';

const GUARD = 'check-secrets-names.mjs';

describe('check-secrets-names', () => {
  it.each([
    ['bad-env-secret', '.env.example', 'client-exposed'],
    ['bad-env-other-public', '.env.example', 'client-exposed'],
    ['bad-env-value', '.env.example', 'names only'],
    ['bad-code', 'src/a.ts', 'client-exposed'],
    ['bad-vite', 'src/a.ts', 'client-exposed'],
  ])('fails on %s', (name, file, why) => {
    const r = runGuard(GUARD, materialize(`secrets-names/${name}`));
    expect(r.status).toBe(1);
    expect(r.out).toContain(file);
    expect(r.out).toContain(why);
  });

  it('never prints a value from .env.example', () => {
    const r = runGuard(GUARD, materialize('secrets-names/bad-env-value'));
    expect(r.out).not.toContain('abc123notreal');
  });

  it('passes when only names are present and the only public name is the env label', () => {
    const r = runGuard(GUARD, materialize('secrets-names/good'));
    expect(r.out).toContain('check-secrets-names: ok');
    expect(r.status).toBe(0);
  });

  it('passes on the clean repository', () => {
    const r = runGuard(GUARD);
    expect(r.out).toContain('check-secrets-names: ok');
    expect(r.status).toBe(0);
  });
});
