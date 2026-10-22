// Owned by SBX lane 05b. What the operator page and the readiness probe show about the job loop:
// whether the database answers, when the loop last finished a pass, how much work is due, which
// switches are on, and which kind of run this is. Reads only; it never throws.
import { SwitchNameSchema } from '@umsbx/contracts';
import type { CoreDeps, EnvironmentLabel, IsoUtc, SwitchName } from '@umsbx/contracts';

// The time of the last pass is kept per database handle: one loop per database, and tests that
// build their own dependencies never see each other's passes.
const passes = new WeakMap<object, IsoUtc>();

export function recordPass(d: Pick<CoreDeps, 'db'>, at: IsoUtc): void {
  passes.set(d.db, at);
}

export async function health(d: CoreDeps): Promise<{
  db: boolean;
  last_pass_at: IsoUtc | null;
  due: number;
  switches: Record<SwitchName, boolean>;
  transport: EnvironmentLabel;
}> {
  let db = false;
  let due = 0;
  try {
    const found = await d.db.query<{ n: number | string }>(
      "SELECT count(*)::int AS n FROM operations WHERE state = 'unknown' AND next_retry_at <= $1",
      [d.clock.now().toISOString()],
    );
    due = Number(found.rows[0]?.n ?? 0);
    db = true;
  } catch {
    db = false;
  }
  const switches = {} as Record<SwitchName, boolean>;
  for (const name of SwitchNameSchema.options) {
    try {
      switches[name] = await d.switches.isOn(name);
    } catch {
      switches[name] = false; // a switch that cannot be read counts as off (fail closed)
    }
  }
  return { db, last_pass_at: passes.get(d.db) ?? null, due, switches, transport: d.environment };
}
