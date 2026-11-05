// BR-1: the one file in this package that hashes. The digest is sha256 of the canonical JSON of the
// resolved values (keys sorted, no whitespace). node:crypto createHash is deterministic; the S1
// lint bars node:* in domain code, so eslint.config.mjs exempts this file for hashing only (HASH_ONLY).
// This package does not import @umsbx/approval for its sha256Hex: BR-3 makes approval import rules,
// which would be a cycle.
import { createHash } from 'node:crypto';

/** Canonical JSON of a flat record of integers: keys in code-point order, no whitespace. */
export function canonicalValues(values: Readonly<Record<string, number>>): string {
  const keys = Object.keys(values).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${String(values[k])}`).join(',')}}`;
}

export function termsDigest(values: Readonly<Record<string, number>>): string {
  return createHash('sha256').update(canonicalValues(values), 'utf8').digest('hex');
}
