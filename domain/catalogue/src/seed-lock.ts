// SEED-RACE (docs/specs/catalogue-seed-race.md): one lock key for every boot seed transaction that looks a
// row up and then inserts it. Transaction scoped, so it is released at commit or rollback; a second boot
// waits here, then finds what the first one wrote. Not exported from index.ts.
import type { SqlExecutor } from '@umsbx/contracts';

export async function takeSeedLock(tx: SqlExecutor): Promise<void> {
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', ['ums.seed.catalogue']);
}
