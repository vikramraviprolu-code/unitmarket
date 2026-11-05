// BR-10 (UNI-80): scripts/check-business-rules.mjs fails when RULES_REGISTRY and the section 3 key
// table of docs/business-rules/configurable-rules-design.md disagree. Fixtures are small tables in
// scripts/__fixtures__/business-rules/. The registry is always the real one.
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FIXTURES, REPO_ROOT } from './test-helpers';

const SCRIPT = join(REPO_ROOT, 'scripts', 'check-business-rules.mjs');
const run = (doc?: string) => {
  const r = spawnSync(
    process.execPath,
    [
      '--import',
      join(REPO_ROOT, 'scripts', 'lib', 'ts-register.mjs'),
      SCRIPT,
      ...(doc ? ['--doc', join(FIXTURES, 'business-rules', `${doc}.md`)] : []),
    ],
    { encoding: 'utf8', cwd: REPO_ROOT },
  );
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
};

describe('check-business-rules', () => {
  it('the committed design document is in step with the registry', () => {
    const r = run();
    expect(r.status, r.out).toBe(0);
    expect(r.out.trim()).toBe('business rules: 3 keys in step');
  });

  it('a fixture in step passes', () => {
    const r = run('in-step');
    expect(r.status, r.out).toBe(0);
    expect(r.out.trim()).toBe('business rules: 3 keys in step');
  });

  it('a registry key missing from the table fails and names the key', () => {
    const r = run('missing-key');
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/access\.window/);
    expect(r.out).toMatch(/missing/);
  });

  it('a wrong default fails and names the key, the document value and the registry value', () => {
    const r = run('wrong-default');
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/refund\.request_window/);
    expect(r.out).toMatch(/default/);
    expect(r.out).toMatch(/14/);
    expect(r.out).toMatch(/7/);
  });

  it('a wrong safe range fails and names the key', () => {
    const r = run('wrong-range');
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/mandate\.max_days/);
    expect(r.out).toMatch(/range/);
  });

  it('a wrong merge strategy fails and names the key', () => {
    const r = run('wrong-merge');
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/refund\.request_window/);
    expect(r.out).toMatch(/merge/);
  });

  it('a merge phrase outside the fixed table fails and quotes the phrase', () => {
    const r = run('unmapped-merge');
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/access\.window/);
    expect(r.out).toMatch(/whoever signed last/);
  });

  it('a row the registry lacks that is not marked later fails', () => {
    const r = run('extra-key');
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/basket\.max_value/);
    expect(r.out).toMatch(/later/);
  });

  it('a row the registry lacks that is marked later passes', () => {
    const r = run('extra-key-later');
    expect(r.status, r.out).toBe(0);
    expect(r.out.trim()).toBe('business rules: 3 keys in step');
  });

  it('a registry key marked later fails', () => {
    const r = run('registry-key-marked-later');
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/refund\.request_window/);
    expect(r.out).toMatch(/slice/i);
  });

  it('a missing document fails with exit 1 and a message', () => {
    const r = spawnSync(
      process.execPath,
      [
        '--import',
        join(REPO_ROOT, 'scripts', 'lib', 'ts-register.mjs'),
        SCRIPT,
        '--doc',
        join(FIXTURES, 'business-rules', 'nope.md'),
      ],
      { encoding: 'utf8', cwd: REPO_ROOT },
    );
    expect(r.status).toBe(1);
    expect(`${r.stdout}${r.stderr}`).toMatch(/nope\.md/);
  });
});
