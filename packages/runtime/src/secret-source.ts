import { createHash, randomBytes } from 'node:crypto';
import type { SecretSource } from '@umsbx/contracts';

// API-W0 (F3): secret bytes for API keys. The crypto source draws from node:crypto; the fixed source is
// the test double (deterministic per seed, a new value on each call). Neither uses the seeded Rng.
function checkLen(len: number): void {
  if (!Number.isInteger(len) || len < 1 || len > 1024) {
    throw new RangeError('secret length must be a whole number from 1 to 1024');
  }
}

export function cryptoSecretSource(): SecretSource {
  return {
    bytes(len) {
      checkLen(len);
      return new Uint8Array(randomBytes(len));
    },
  };
}

export function fixedSecretSource(seed: string): SecretSource {
  let counter = 0;
  return {
    bytes(len) {
      checkLen(len);
      counter += 1;
      const out = new Uint8Array(len);
      let filled = 0;
      let block = 0;
      while (filled < len) {
        const d = createHash('sha256').update(`${seed}|${counter}|${block}`).digest();
        const take = Math.min(d.length, len - filled);
        out.set(d.subarray(0, take), filled);
        filled += take;
        block += 1;
      }
      return out;
    },
  };
}
