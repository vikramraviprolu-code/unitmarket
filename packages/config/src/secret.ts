import { inspect } from 'node:util';
import type { Secret } from '@umsbx/contracts';

const REDACTED = '[redacted]' as const;

// Opaque wrapper: the value lives in a closure, not in a property, so spreading, Object.keys,
// JSON.stringify, string conversion and util.inspect cannot reach it (nfr.md P7).
export function makeSecret(value: string): Secret {
  const s = {
    reveal: () => value,
    toString: () => REDACTED,
    toJSON: () => REDACTED,
    [inspect.custom]: () => REDACTED,
  };
  return Object.freeze(s) as Secret;
}
