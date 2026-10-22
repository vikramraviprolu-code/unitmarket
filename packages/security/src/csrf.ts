// CSRF: Origin must equal the configured public origin, and the x-csrf-token header must hash to
// the value stored with the session (double submit against a server-side hash).
import { createHash, timingSafeEqual } from 'node:crypto';

export const sha256Hex = (s: string): string =>
  createHash('sha256').update(s, 'utf8').digest('hex');

export const hashCsrfToken = sha256Hex;

export function originMatches(origin: string | null, public_origin: string): boolean {
  if (origin === null) return false;
  return origin === public_origin.replace(/\/+$/, '');
}

export function csrfTokenMatches(token: string | null, stored_hash: string): boolean {
  if (token === null || token.length === 0 || token.length > 256) return false;
  const a = Buffer.from(sha256Hex(token), 'hex');
  const b = Buffer.from(stored_hash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}
