// PG-2 test support (not a test file). A throwaway real Postgres 16 per test file, one fresh database
// per round, and a seeded stagger so the racers start in a different order each round. Everything
// runs on a unix socket in a temp directory; no byte leaves the machine.
import { pgBinConfigured, startTestPostgres } from '../../packages/db/src/pg-testing';
import type { TestPostgres } from '../../packages/db/src/pg-testing';
import { bootRig } from '../mvp-c/c-support';
import type { CRig, RigOptions } from '../mvp-c/c-support';

export { startTestPostgres };
export type { TestPostgres };

/** The PG-2 suites run only when UMS_TEST_PG_BIN is set (and the binaries are there). */
export const PG_ON = pgBinConfigured();

export interface PgRig {
  rig: CRig;
  url: string;
  dbName: string;
  close(): Promise<void>;
}

/** The C rig (sandbox mode, fake Wire, real approval row) on its own database of the throwaway server. */
export async function bootPgRig(server: TestPostgres, o: RigOptions = {}): Promise<PgRig> {
  const created = await server.createDatabase('ums_race');
  let rig: CRig;
  try {
    rig = await bootRig({
      ...o,
      env: { ...(o.env ?? {}), UMS_DB: 'postgres', DATABASE_URL: created.url },
    });
  } catch (e) {
    await server.dropDatabase(created.name).catch(() => undefined);
    throw e;
  }
  return {
    rig,
    url: created.url,
    dbName: created.name,
    close: async () => {
      try {
        await rig.close();
      } finally {
        await server.dropDatabase(created.name).catch(() => undefined);
      }
    },
  };
}

/** mulberry32: a small seeded generator, so a failing round can be replayed. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Starts every racer after its own seeded 0 to 12 ms delay; all of them are awaited, none is dropped. */
export async function race<T>(
  rnd: () => number,
  racers: (() => Promise<T>)[],
): Promise<PromiseSettledResult<T>[]> {
  return Promise.allSettled(
    racers.map(async (f) => {
      await sleep(Math.floor(rnd() * 13));
      return f();
    }),
  );
}

/** Throws with every rejection when any racer failed (a deadlock the retry gave up on shows here). */
export function assertNoRejection(results: PromiseSettledResult<unknown>[], label: string): void {
  const bad = results.flatMap((r, i) =>
    r.status === 'rejected'
      ? [`#${i}: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`]
      : [],
  );
  if (bad.length > 0) throw new Error(`${label}: racer failed: ${bad.join(' | ')}`);
}

/** Log lines that show a lock failure the retry did not absorb. */
export const lockFailures = (lines: string[]): string[] =>
  lines.filter((l) => /deadlock|could not serialize|40P01|40001/i.test(l));
