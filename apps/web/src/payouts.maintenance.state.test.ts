// POB-M1: in maintenance mode the database is not open: runPayouts rejects with the maintenance error and no job loop
// starts (so no payout pass can run). Same arrangement as maintenance.state.test.ts.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MaintenanceError, createApp, installApp } from '../composition.server';
import type { App } from '../composition.server';
import { testEnv } from './support';

const spies = vi.hoisted(() => ({ openDatabase: vi.fn(), startLoop: vi.fn() }));
type Fn = (...a: unknown[]) => unknown;
vi.mock('server-only', () => ({}));
vi.mock('@umsbx/db', async (orig) => {
  const m = (await orig()) as Record<string, Fn>;
  spies.openDatabase.mockImplementation(m['openDatabase'] as Fn);
  return { ...m, openDatabase: spies.openDatabase };
});
vi.mock('@umsbx/jobs', async (orig) => {
  const m = (await orig()) as Record<string, Fn>;
  spies.startLoop.mockImplementation(m['startLoop'] as Fn);
  return { ...m, startLoop: spies.startLoop };
});

let tmp: string;
let app: App | null = null;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'pob-m1-maint-'));
  spies.openDatabase.mockClear();
  spies.startLoop.mockClear();
});
afterEach(async () => {
  await app?.close();
  app = null;
  rmSync(tmp, { recursive: true, force: true });
});

describe('maintenance mode and payouts', () => {
  it('runPayouts rejects with the maintenance error; no database is opened, no loop starts', async () => {
    const flag = join(tmp, 'ums-maintenance');
    writeFileSync(flag, '');
    const env = await testEnv({
      UMS_DB: 'pglite-disk',
      UMS_PGLITE_DIR: join(tmp, 'pglite'),
      UMS_MAINTENANCE_FLAG: flag,
    });
    app = createApp(env, { switch_cache_ms: 0, log_sink: () => undefined });
    installApp(app);
    await expect(app.engine.runPayouts()).rejects.toBeInstanceOf(MaintenanceError);
    const jobs = await app.startJobs();
    await jobs.stop();
    expect(spies.startLoop).not.toHaveBeenCalled();
    expect(spies.openDatabase).not.toHaveBeenCalled();
  });
});
