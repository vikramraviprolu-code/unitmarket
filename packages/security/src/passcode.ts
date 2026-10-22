// Passcode hashing for the demo personas: scrypt with a per-hash salt, timing-safe compare.
// Stored form: scrypt$N$r$p$salt_hex$hash_hex. A plain passcode is never stored or logged.
import { scrypt, timingSafeEqual } from 'node:crypto';

const N = 16384;
const R = 8;
const P = 1;
const KEYLEN = 32;
const MAX_N = 1 << 17; // refuse a stored hash that asks for absurd work
const MAX_ATTEMPT_BYTES = 1024;

function derive(plain: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      Buffer.from(plain.normalize('NFKC'), 'utf8'),
      salt,
      KEYLEN,
      { N: n, r, p, maxmem: 256 * n * r },
      (e, key) => (e ? reject(e) : resolve(key)),
    );
  });
}

// The salt is supplied by the caller (the operator CLI), 16 bytes as hex, because randomness comes
// only from injected Ids in this package (lint S6).
export async function hashPasscode(plain: string, salt_hex: string): Promise<string> {
  if (!/^[0-9a-f]{32,128}$/.test(salt_hex) || salt_hex.length % 2 !== 0) {
    throw new Error('hashPasscode: salt must be 16 to 64 bytes as lowercase hex');
  }
  const key = await derive(plain, Buffer.from(salt_hex, 'hex'), N, R, P);
  return `scrypt$${N}$${R}$${P}$${salt_hex}$${key.toString('hex')}`;
}

export async function verifyPasscode(hash: string, attempt: string): Promise<boolean> {
  try {
    const parts = hash.split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
    const [, ns, rs, ps, salt_hex, key_hex] = parts as [
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    const n = Number(ns);
    const r = Number(rs);
    const p = Number(ps);
    if (![n, r, p].every((v) => Number.isInteger(v) && v > 0)) return false;
    if (n > MAX_N || (n & (n - 1)) !== 0 || r > 16 || p > 4) return false;
    if (!/^[0-9a-f]{32,128}$/.test(salt_hex) || !/^[0-9a-f]{64}$/.test(key_hex)) return false;
    if (Buffer.byteLength(attempt, 'utf8') > MAX_ATTEMPT_BYTES) return false;
    const expected = Buffer.from(key_hex, 'hex');
    const actual = await derive(attempt, Buffer.from(salt_hex, 'hex'), n, r, p);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}
