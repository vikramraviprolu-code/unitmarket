// OPS-PRIV: deleting a demo buyer's personal data must not stop the app from starting next time.
// The demo buyers are seeded at every boot; after `privacy.mjs delete` their auth_subject has changed, so
// the seed must skip on the id, not only on the sign-in subject.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { createApp } from '../apps/web/composition.server';
import type { App } from '../apps/web/composition.server';
import { testEnv } from '../apps/web/src/support';
import { createAuditSink } from '../packages/obs/src/index';
import { fakeClock, seededIds } from '../packages/runtime/src/index';
import { runDelete } from './lib/privacy.mjs';

let tmp = '';
let app: App | null = null;
afterEach(async () => {
  await app?.close();
  app = null;
  if (tmp !== '') rmSync(tmp, { recursive: true, force: true });
});

describe('boot after a delete', () => {
  it('starts again on the same database, keeps the pseudonymised buyer and its id', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'sbx-privacy-boot-'));
    const env = await testEnv({ UMS_DB: 'pglite-disk', UMS_PGLITE_DIR: join(tmp, 'pglite') });
    app = createApp(env, { switch_cache_ms: 0 });
    await app.ready();
    const demo = await app.db.query<{ id: string }>(
      `SELECT id FROM buyers WHERE auth_subject LIKE 'persona:%' ORDER BY id`,
    );
    expect(demo.rows).toHaveLength(2);
    const target = demo.rows[0]!.id;
    const clock = fakeClock('2026-10-30T12:00:00Z');
    const r = await runDelete({
      db: app.db,
      clock,
      audit: createAuditSink(seededIds('boot-test'), clock),
      tty: { isTTY: true, env: {} },
      ask: async () => target,
      write: () => undefined,
      buyer_id: target,
      operator_id: 'opr_1',
      reason: 'boot test',
    });
    expect(r).toMatchObject({ ok: true, value: { changed: true } });
    await app.close();

    app = createApp(env, { switch_cache_ms: 0 });
    await app.ready();
    const after = await app.db.query<{ id: string; display_name: string; auth_subject: string }>(
      `SELECT id, display_name, auth_subject FROM buyers ORDER BY id`,
    );
    expect(after.rows).toHaveLength(2);
    const row = after.rows.find((x) => x.id === target)!;
    expect(row.display_name).toMatch(/^deleted-[0-9a-f]{8}$/);
    expect(row.auth_subject).toBe(`deleted:${row.display_name}`);
  }, 120_000);
});
