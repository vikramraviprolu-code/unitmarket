// Origin: AIC_Hackathon_UnitMarket@a36ddc03fd0b962000f686291c145b50ee337f90:packages/core/approval/canonical.ts. Adapted; owned by SBX.
// Canonical JSON and sha256: the pure parts of approval. Keys sorted, no whitespace, integers
// only, and every integer under a key ending `_minor` written as a decimal string using the
// corridor's number of minor-unit digits (0, 2 or 3).
// node:crypto createHash is deterministic (no randomness); the S1 lint bars node:* in domain
// packages; eslint.config.mjs exempts this file for node:crypto hashing only (random functions stay banned).

import { createHash } from 'node:crypto';

export type MinorUnits = 0 | 2 | 3;

// 405 with 2 digits is "4.05", with 3 digits "0.405", with 0 digits "405".
function formatMinor(n: number, digits: MinorUnits): string {
  if (digits === 0) return String(n);
  const text = String(n).padStart(digits + 1, '0');
  return `${text.slice(0, -digits)}.${text.slice(-digits)}`;
}

const isMinorKey = (key: string): boolean => key.endsWith('_minor');

// `minor` is true under a `_minor` key (and under an array held by one): numbers there are
// formatted with the corridor's digits and every other scalar except null is refused, so the
// number 405 and the string "4.05" can never produce the same text.
function write(value: unknown, digits: MinorUnits, minor: boolean): string {
  if (value === undefined) throw new TypeError('canonicalJson: undefined is not allowed');
  if (value === null) return 'null';
  if (typeof value === 'boolean' || typeof value === 'string') {
    if (minor) throw new TypeError(`canonicalJson: ${typeof value} under a _minor key`);
    return JSON.stringify(typeof value === 'string' ? value.normalize('NFC') : value);
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TypeError(`canonicalJson: ${String(value)} is not a non-negative integer`);
    }
    return minor ? JSON.stringify(formatMinor(value, digits)) : String(value);
  }
  if (Array.isArray(value)) {
    return `[${(value as unknown[]).map((item) => write(item, digits, minor)).join(',')}]`;
  }
  if (typeof value === 'object') {
    if (minor) throw new TypeError('canonicalJson: object under a _minor key');
    const proto: unknown = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      throw new TypeError('canonicalJson: only plain objects are allowed');
    }
    const record = value as Record<string, unknown>;
    const byKey = new Map<string, unknown>();
    for (const k of Object.keys(record)) {
      const nk = k.normalize('NFC');
      if (byKey.has(nk)) throw new TypeError('canonicalJson: keys collide after NFC');
      byKey.set(nk, record[k]);
    }
    const parts = [...byKey.keys()]
      .sort()
      .map((k) => `${JSON.stringify(k)}:${write(byKey.get(k), digits, isMinorKey(k))}`);
    return `{${parts.join(',')}}`;
  }
  throw new TypeError(`canonicalJson: ${typeof value} is not allowed`);
}

export function canonicalJson(v: unknown, minor_units: MinorUnits): string {
  return write(v, minor_units, false);
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
