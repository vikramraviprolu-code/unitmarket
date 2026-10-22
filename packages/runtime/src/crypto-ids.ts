import { randomBytes } from 'node:crypto';
import { formatId, hex } from './ids-format';
import type { Ids } from './temp-contracts-f1';

// Production ids: 128 random bits from node:crypto. This package is the only place allowed to
// draw randomness (lint rule S6).
export function cryptoIds(): Ids {
  return {
    next: (prefix) => formatId(prefix, randomBytes(16)),
    nonce: () => hex(randomBytes(16)),
  };
}
