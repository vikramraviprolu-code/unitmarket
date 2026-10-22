// Skeleton for the nightly logical export (architecture section 8): the table list in foreign-key
// order, parents first. Row rendering as INSERT statements arrives with the backup lane.
import type { SqlExecutor } from './temp-contracts-f1';

export async function tablesInDependencyOrder(db: SqlExecutor): Promise<string[]> {
  const tables = await db.query<{ tablename: string }>(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'schema_migrations' ORDER BY tablename",
  );
  const fks = await db.query<{ child: string; parent: string }>(
    `SELECT c.conrelid::regclass::text AS child, c.confrelid::regclass::text AS parent
     FROM pg_constraint c
     WHERE c.contype = 'f' AND c.connamespace = 'public'::regnamespace AND c.conrelid <> c.confrelid`,
  );
  const names = tables.rows.map((t) => t.tablename);
  const unmet = new Map<string, Set<string>>(names.map((n) => [n, new Set<string>()]));
  for (const { child, parent } of fks.rows) {
    const c = child.replace(/^"|"$/g, '');
    const p = parent.replace(/^"|"$/g, '');
    unmet.get(c)?.add(p);
  }
  const out: string[] = [];
  const left = new Set(names);
  while (left.size > 0) {
    const ready = [...left].filter((n) => [...unmet.get(n)!].every((p) => !left.has(p))).sort();
    if (ready.length === 0) throw new Error(`foreign-key cycle among: ${[...left].join(', ')}`);
    for (const n of ready) {
      out.push(n);
      left.delete(n);
    }
  }
  return out;
}
