// TEST ONLY (PG-1). vitest setupFile. With UMS_TEST_DB=postgres every `openDatabase({ kind:
// 'pglite-memory' })` call in a test (the domain worlds, the testkit, the web tests) is answered by a
// fresh database on the throwaway Postgres from pg-global-setup.ts, so the existing state, integration
// and contract suites run once against a real server without being edited. Anything else (disk
// targets, an explicit postgres target) goes to the real openDatabase. Without the env switch this
// file does nothing.
import { vi } from 'vitest';
import type { DbTarget, SqlDriver } from './driver';

const dir = process.env['UMS_TEST_PG_SOCKET_DIR'];
if (process.env['UMS_TEST_DB'] === 'postgres' && dir !== undefined) {
  vi.doMock('@umsbx/db', async () => {
    const actual = await vi.importActual<typeof import('./index')>('./index');
    const { attachTestPostgres } = await import('./pg-testing');
    const server = attachTestPostgres(dir);
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
        return {
          ...db,
          close: async () => {
            try {
              await db.close();
            } finally {
              await server.dropDatabase(created.name).catch(() => undefined);
            }
          },
        };
      },
    };
  });
}
