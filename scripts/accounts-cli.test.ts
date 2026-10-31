// ID-ACCOUNTS: the operator reset entry point exists, is wired like the other operator CLIs, and puts the
// terminal and environment guards before the database is opened. Read as text; the behaviour is tested in
// packages/security/src/accounts-cli.state.test.ts.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (rel: string): string => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');

describe('pnpm accounts:reset-password', () => {
  it('is a package script that loads .env.local like safety:approve', () => {
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
    expect(pkg.scripts['accounts:reset-password']).toBe(
      'node --env-file-if-exists=.env.local scripts/accounts-cli.mjs',
    );
  });
  it('registers the TypeScript hooks in-process, then imports its body', () => {
    const entry = read('scripts/accounts-cli.mjs');
    expect(entry).toContain("import { registerTs } from './lib/register-ts.mjs'");
    expect(entry).toContain("await import('./lib/accounts-cli-main.mjs')");
  });
  it('checks the terminal and the config before it opens the database, and reads the password with echo off', () => {
    const main = read('scripts/lib/accounts-cli-main.mjs');
    const terminal = main.indexOf('terminalEnv()');
    const config = main.indexOf('loadConfigFromProcess()');
    const open = main.indexOf('openDatabase(');
    expect(terminal).toBeGreaterThan(0);
    expect(config).toBeGreaterThan(terminal);
    expect(open).toBeGreaterThan(config);
    expect(main).toContain('runResetPassword(');
    expect(main).toMatch(/--username/);
    expect(main).not.toMatch(/--password/);
    expect(main).not.toMatch(/argv.*password|process\.env\.[A-Z_]*PASS/i);
  });
});
