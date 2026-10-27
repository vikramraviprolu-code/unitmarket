// TEST ONLY (PG-1). vitest globalSetup. With UMS_TEST_DB=postgres it starts one throwaway Postgres for
// the whole run and tells the workers where it is (UMS_TEST_PG_SOCKET_DIR). Otherwise it does nothing.
import { startTestPostgres } from './pg-testing';

export default async function setup(): Promise<(() => Promise<void>) | undefined> {
  if (process.env['UMS_TEST_DB'] !== 'postgres') return undefined;
  const server = await startTestPostgres();
  process.env['UMS_TEST_PG_SOCKET_DIR'] = server.socketDir;
  return () => server.stop();
}
