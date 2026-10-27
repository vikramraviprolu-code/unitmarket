// TEST ONLY (PG-1). vitest setupFile. With UMS_TEST_DB=postgres every `openDatabase({ kind:
// 'pglite-memory' })` call in a test (the domain worlds, the testkit, the web tests) is answered by a
// fresh database on the throwaway Postgres from pg-global-setup.ts, so the existing state, integration
// and contract suites run once against a real server without being edited. Anything else (disk
// targets, an explicit postgres target) goes to the real openDatabase. Without the env switch this
// file does nothing.
import { afterAll, vi } from 'vitest';
import type { DbTarget, SqlDriver } from './driver';

const dir = process.env['UMS_TEST_PG_SOCKET_DIR'];
if (process.env['UMS_TEST_DB'] === 'postgres' && dir !== undefined) {
  vi.doMock('@umsbx/db', async () => {
    const actual = await vi.importActual<typeof import('./index')>('./index');
    const { attachTestPostgres } = await import('./pg-testing');
    const server = attachTestPostgres(dir);
    // Tests that never close their database must not fill the disk: drop whatever is left per file.
    const open = new Map<string, SqlDriver>();
    afterAll(async () => {
      for (const [name, d] of open) {
        await d.close().catch(() => undefined);
        await server.dropDatabase(name).catch(() => undefined);
      }
      open.clear();
    });
    return {
      ...actual,
      openDatabase: async (t: DbTarget, opts?: Parameters<typeof actual.openDatabase>[1]) => {
        if (t.kind !== 'pglite-memory') return actual.openDatabase(t, opts);
        const created = await server.createDatabase();
        const db: SqlDriver = await actual.openDatabase({
          kind: 'postgres',
          url: created.url,
          pool_max: 3,
        });
        open.set(created.name, db);
        return {
          ...db,
          close: async () => {
            try {
              await db.close();
            } finally {
              open.delete(created.name);
              await server.dropDatabase(created.name).catch(() => undefined);
            }
          },
        };
      },
    };
  });
  // The suites call resetDatabase(db) on what they believe is an in-memory database. Here it is a
  // disposable ums_test_ database, which resetDatabase accepts only with the explicit flag; the flag is
  // added for tests under this switch only (reset.ts itself still refuses without it).
  vi.doMock('@umsbx/db/testing', async () => {
    const actual = await vi.importActual<typeof import('./testing')>('./testing');
    return {
      ...actual,
      resetDatabase: (db: Parameters<typeof actual.resetDatabase>[0], o?: object) =>
        actual.resetDatabase(db, { confirm: 'RESET_TEST_DATABASE', ...o }),
    };
  });
}
