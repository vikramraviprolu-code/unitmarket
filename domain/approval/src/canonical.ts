// Origin: AIC_Hackathon_UnitMarket@a36ddc03fd0b962000f686291c145b50ee337f90:packages/core/approval/canonical.ts. Adapted; owned by SBX.
// Canonical JSON and sha256: the pure parts of approval. Keys sorted, no whitespace, integers
// only, and every integer under a key ending `_minor` written as a decimal string using the
// corridor's number of minor-unit digits (0, 2 or 3).
// node:crypto createHash is deterministic (no randomness); the S1 lint bars node:* in domain
// packages, so this one import is exempted with a reason (change request in the lane 06 hand-off).
// eslint-disable-next-line no-restricted-imports -- hashing only; see header
import { createHash } from 'node:crypto';

export type MinorUnits = 0 | 2 | 3;

// 405 with 2 digits is "4.05", with 3 digits "0.405", with 0 digits "405".
function formatMinor(n: number, digits: MinorUnits): string {
  if (digits === 0) return String(n);
  const text = String(n).padStart(digits + 1, '0');
  return `${text.slice(0, -digits)}.${text.slice(-digits)}`;
}

function write(value: unknown, key: string | null, digits: MinorUnits): string {
  if (value === undefined) throw new TypeError('canonicalJson: undefined is not allowed');
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TypeError(`canonicalJson: ${String(value)} is not a non-negative integer`);
    }
    return key !== null && key.endsWith('_minor')
      ? JSON.stringify(formatMinor(value, digits))
      : String(value);
  }
  if (Array.isArray(value)) {
    return `[${(value as unknown[]).map((item) => write(item, null, digits)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const proto: unknown = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      throw new TypeError('canonicalJson: only plain objects are allowed');
    }
    const record = value as Record<string, unknown>;
    const parts = Object.keys(record)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${write(record[k], k, digits)}`);
    return `{${parts.join(',')}}`;
  }
  throw new TypeError(`canonicalJson: ${typeof value} is not allowed`);
}

export function canonicalJson(v: unknown, minor_units: MinorUnits): string {
  return write(v, null, minor_units);
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
