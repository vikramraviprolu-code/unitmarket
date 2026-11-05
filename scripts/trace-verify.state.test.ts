// INT-TR0 / TR0.4: pnpm trace:verify. Run against a seeded PGlite data directory it prints what it
// checked and exits 0; a broken row exits 1 and is named; while the app holds the directory it exits 2 with
// "database in use" (single-opener lock, CO-9).
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { migrate, openDatabase } from '../packages/db/src/index';
import {
  EVENTS_GUARD,
  T,
  ins,
  j,
  seedWorld,
  updateWorld,
  withTriggersOff,
} from '../packages/db/src/trace-test-support';
import type { Db } from '../packages/db/src/trace-test-support';
import { REPO_ROOT } from './test-helpers';

const CWD = mkdtempSync(join(tmpdir(), 'sbx-trace-cwd-'));
const made: string[] = [CWD];
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

const run = (env: Record<string, string>) => {
  const r = spawnSync(
    process.execPath,
    [
      '--import',
      join(REPO_ROOT, 'scripts/lib/ts-register.mjs'),
      join(REPO_ROOT, 'scripts/trace-verify.mjs'),
    ],
    {
      cwd: CWD,
      encoding: 'utf8',
      input: '',
      env: {
        UMS_SESSION_SECRET: 'Qm7vK2pLx9RbT4zWc8NdYh3JfG6sAe1U',
        UMS_APPROVAL_SECRET: ['Zr5tB8nKd2Vw', 'Xq7LmC4yHj9PgF3sEa6U'].join(''),
        UMS_LINK_SECRET: ['Jd4wN7xQk2Zc', 'R9vTb5LmY8hGp3FsAe6U'].join(''),
        ...env,
      },
    },
  );
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
};

/** A seeded on-disk database, closed again so its lock is free. `after` may break something first. */
async function seededDir(after?: (db: Db) => Promise<void>): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'ums-trace-'));
  made.push(dir);
  const db = (await openDatabase({ kind: 'pglite-disk', dir })) as Db;
  try {
    await migrate(db, { now: () => new Date(T) });
    await seedWorld(db);
    await updateWorld(db);
    if (after) await after(db);
  } finally {
    await db.close();
  }
  return dir;
}
const env = (dir: string) => ({ UMS_DB: 'pglite-disk', UMS_PGLITE_DIR: dir });

describe('trace:verify on a PGlite data directory', () => {
  it('prints chains, rows, seals and values checked, then ok, and exits 0', async () => {
    const r = run(env(await seededDir()));
    expect(r.status, r.out).toBe(0);
    expect(r.out).toMatch(/chains \d+/);
    expect(r.out).toMatch(/rows \d+/);
    expect(r.out).toMatch(/seals \d+/);
    expect(r.out).toMatch(/checked \d+/);
    expect(r.out).toMatch(/^ok$/m);
    expect(r.out).not.toMatch(/\n\s+at /);
  }, 120_000);

  it('a broken row exits 1 and is named by chain and seq', async () => {
    const dir = await seededDir(async (db) => {
      await withTriggersOff(db, [EVENTS_GUARD], async () => {
        await db.exec(
          "UPDATE trace_events SET mfa = NOT mfa WHERE chain_key = 'buy:buy_1' AND seq = 1",
        );
      });
    });
    const r = run(env(dir));
    expect(r.status, r.out).toBe(1);
    expect(r.out).toMatch(/chain buy:buy_1 seq 1: row_hash/);
    expect(r.out).not.toMatch(/^ok$/m);
  }, 120_000);

  it('an unattributed write exits 1 and is listed as INV-T2', async () => {
    const dir = await seededDir(async (db) => {
      await ins(db, 'alerts', {
        id: 'alr_bare',
        kind: 'k',
        order_id: null,
        unit_id: null,
        detail: j({}),
      });
    });
    const r = run(env(dir));
    expect(r.status, r.out).toBe(1);
    expect(r.out).toMatch(/INV-T2.*alerts alr_bare/);
  }, 120_000);

  it('drift (state edited with the capture trigger off) exits 1 and is named', async () => {
    const dir = await seededDir(async (db) => {
      await db.exec('ALTER TABLE orders DISABLE TRIGGER trace_capture_orders');
      await db.exec("UPDATE orders SET status = 'frozen' WHERE id = 'ord_1'");
      await db.exec('ALTER TABLE orders ENABLE TRIGGER trace_capture_orders');
    });
    const r = run(env(dir));
    expect(r.status, r.out).toBe(1);
    expect(r.out).toMatch(/drift orders ord_1 status/);
  }, 120_000);

  it('while the app holds the directory it exits 2 with "database in use" and changes nothing', async () => {
    const dir = await seededDir();
    writeFileSync(
      join(dir, '.ums-open.lock'),
      `${JSON.stringify({ pid: process.pid, host: hostname(), started: '2026-03-04T05:06:07.089Z' })}\n`,
    );
    const r = run(env(dir));
    expect(r.status, r.out).toBe(2);
    expect(r.out).toContain('database in use');
    expect(r.out).not.toMatch(/\n\s+at /);
  }, 120_000);

  it('the root package.json wires trace:verify to the script', async () => {
    const pkg = (await import('../package.json', { with: { type: 'json' } })).default as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts['trace:verify']).toContain('scripts/trace-verify.mjs');
  });
});
