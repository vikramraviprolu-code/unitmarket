import { createHash } from 'node:crypto';
import { formatId, hex } from './ids-format';
import type { Ids } from '@umsbx/contracts';

// Deterministic ids for tests only: sha256(seed, counter) truncated to 128 bits. Same seed, same
// sequence. Never wire this into a production composition root.
export function seededIds(seed: string): Ids {
  let counter = 0;
  const draw = (): Uint8Array => {
    const h = createHash('sha256').update(`${seed}\u0000${counter++}`).digest();
    return h.subarray(0, 16);
  };
  return {
    next: (prefix) => formatId(prefix, draw()),
    nonce: () => hex(draw()),
  };
}
