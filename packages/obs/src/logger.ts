import { redact } from './redact';
import type { Clock, LogEvent, Logger } from './temp-contracts-f1';

// One JSON line per event: ts (only when a clock is injected), level, msg, then base, child and
// event fields in that order of precedence (later wins), except that level, msg and ts cannot be
// overwritten. Every line passes through redact() before it reaches the sink.
export function createLogger(
  sink: (line: string) => void,
  base: LogEvent['fields'],
  clock?: Clock,
): Logger {
  const make = (fields: LogEvent['fields']): Logger => ({
    log(e: LogEvent): void {
      const merged: Record<string, unknown> = {};
      if (clock) merged.ts = clock.now().toISOString();
      merged.level = e.level;
      merged.msg = e.msg;
      for (const [k, v] of Object.entries({ ...fields, ...e.fields })) {
        if (k === 'ts' || k === 'level' || k === 'msg') continue;
        merged[k] = v;
      }
      sink(JSON.stringify(redact(merged)));
    },
    child(extra: LogEvent['fields']): Logger {
      return make({ ...fields, ...extra });
    },
  });
  return make(base);
}
