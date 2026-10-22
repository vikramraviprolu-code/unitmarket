// Shared id formatting for cryptoIds and seededIds (Crockford base32, lowercase).
import type { IdPrefix, Id } from '@umsbx/contracts';

const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';

// 128 bits, left-padded with two zero bits, written as 26 base32 characters.
export function base32of128(bytes: Uint8Array): string {
  if (bytes.length !== 16) throw new Error('expected 16 bytes');
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = '';
  for (let i = 0; i < 26; i++) {
    out = ALPHABET[Number(n & 31n)]! + out;
    n >>= 5n;
  }
  return out;
}

export function formatId(prefix: IdPrefix, bytes: Uint8Array): Id {
  return `${prefix}_${base32of128(bytes)}`;
}

export function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}
