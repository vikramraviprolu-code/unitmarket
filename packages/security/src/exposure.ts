// INT-CTL / CTL.5: the reader of api_exposure. Like createSwitchReader it reads through a cache of at most 5 s on an
// injected Clock, and every failure closes: a failed read, a missing row and an unknown group all answer "disabled".
import { isApiGroup } from '@umsbx/contracts';
import type { ApiGroup, Clock, Database, ExposureReader } from '@umsbx/contracts';

export const MAX_EXPOSURE_CACHE_MS = 5000;

export function createExposureReader(o: {
  db: Database;
  clock: Clock;
  /** Cache lifetime; held between 0 and 5000. Tests pass 0. */
  cache_ms?: number;
}): ExposureReader {
  const ttl = Math.max(0, Math.min(o.cache_ms ?? MAX_EXPOSURE_CACHE_MS, MAX_EXPOSURE_CACHE_MS));
  let cached: { at: number; open: ReadonlySet<string> } | null = null;
  const load = async (now: number): Promise<ReadonlySet<string>> => {
    let open: ReadonlySet<string>;
    try {
      const r = await o.db.query<{ group_name: string; enabled: boolean }>(
        'SELECT group_name, enabled FROM api_exposure',
      );
      open = new Set(r.rows.filter((x) => x.enabled === true).map((x) => x.group_name));
    } catch {
      open = new Set();
    }
    cached = { at: now, open };
    return open;
  };
  return {
    async isEnabled(group: ApiGroup): Promise<boolean> {
      if (!isApiGroup(group)) return false;
      const now = o.clock.now().getTime();
      const open =
        cached !== null && now >= cached.at && now - cached.at < ttl
          ? cached.open
          : await load(now);
      return open.has(group);
    },
  };
}
