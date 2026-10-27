// PG-2: the pnpm safety:* entry points open the database through the same config path with
// UMS_DB=postgres. `status` runs in a separate node process against a throwaway real Postgres 16
// (unix socket), prints the switches and no URL, and sees an approval row written over another
// connection (the row `safety:approve` writes through runApprove). Runs only when UMS_TEST_PG_BIN is set.
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDatabase } from '../packages/db/src/index';
import { pgBinConfigured, startTestPostgres } from '../packages/db/src/pg-testing';
import type { TestDatabase, TestPostgres } from '../packages/db/src/pg-testing';
import { REPO_ROOT } from './test-helpers';

const REF = 'DL-2026-10-27-cli-pg2';
const runCli = (env: Record<string, string>, ...args: string[]) =>
  new Promise<{ status: number | null; out: string }>((resolve) => {
    const child = spawn(
      process.execPath,
      [
        '--import',
        join(REPO_ROOT, 'scripts/lib/ts-register.mjs'),
        join(REPO_ROOT, 'scripts/safety-cli.mjs'),
        ...args,
      ],
      {
        cwd: REPO_ROOT,
        env: {
          UMS_SESSION_SECRET: 'Qm7vK2pLx9RbT4zWc8NdYh3JfG6sAe1U',
          UMS_APPROVAL_SECRET: ['Zr5tB8nKd2Vw', 'Xq7LmC4yHj9PgF3sEa6U'].join(''),
          UMS_LINK_SECRET: ['Jd4wN7xQk2Zc', 'R9vTb5LmY8hGp3FsAe6U'].join(''),
          ...env,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (out += d.toString()));
    child.on('close', (status) => resolve({ status, out }));
  });

describe.skipIf(!pgBinConfigured())('PG-2 safety CLI on UMS_DB=postgres', () => {
  let server: TestPostgres;
  let database: TestDatabase;
  beforeAll(async () => {
    server = await startTestPostgres();
    database = await server.createDatabase('ums_cli');
  }, 120_000);
  afterAll(async () => {
    await server?.stop();
  });

  const env = (extra: Record<string, string> = {}) => ({
    UMS_DB: 'postgres',
    DATABASE_URL: database.url,
    UMS_OUTBOUND_APPROVAL_REF: REF,
    ...extra,
  });

  it('status opens Postgres through the config path, migrates, lists the switches and prints no URL', async () => {
    const r = await runCli(env(), 'status');
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain('db=postgres');
    expect(r.out).toContain('switch paypal_outbound=off');
    expect(r.out).toContain('budget: no active approval');
    for (const needle of [database.url, server.socketDir, 'postgres://'])
      expect(r.out).not.toContain(needle);
  }, 120_000);

  it('an approval row written over another connection shows in the next status run', async () => {
    // The row `pnpm safety:approve` writes (runApprove, TTY only, so not driven here), inserted over a
    // connection of this process while no CLI process is running; the next CLI run must see it.
    const db = await openDatabase({ kind: 'postgres', url: database.url, pool_max: 2 });
    try {
      await db.query(
        `INSERT INTO outbound_approvals (id, approval_ref, scope, operations, max_amount_minor, max_calls_per_day, valid_until, approved_by, created_at, updated_at)
         VALUES ('oap_pg2cli_000000001', $1, 'mvp_c_refunds', $2, 1000, 25, '2999-01-01T00:00:00Z', 'pg2-test', '2026-10-27T00:00:00Z', '2026-10-27T00:00:00Z')`,
        [REF, ['create_order', 'get_order']],
      );
    } finally {
      await db.close();
    }
    const r = await runCli(env(), 'status');
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain(`budget ${REF}: 25 of 25 calls left today`);
  }, 120_000);

  it('a bad URL stops with one safety: line and never prints the URL', async () => {
    const bad = 'postgres://nobody:s3cretpass@:54329/nodb?host=%2Fnonexistent-dir-pg2';
    const r = await runCli(env({ DATABASE_URL: bad }), 'status');
    expect(r.status).toBe(1);
    expect(r.out.trim().split('\n')).toHaveLength(1);
    expect(r.out).toMatch(/^safety: /);
    for (const needle of ['s3cretpass', 'nobody', 'nonexistent-dir-pg2', 'postgres://'])
      expect(r.out).not.toContain(needle);
  }, 120_000);
});
