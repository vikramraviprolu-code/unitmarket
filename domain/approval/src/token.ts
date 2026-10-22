// Origin: AIC_Hackathon_UnitMarket@a36ddc03fd0b962000f686291c145b50ee337f90:packages/core/approval/token.ts. Adapted; owned by SBX.
// Approval token: `${approval_id}.${hex}` with hex = HMAC-SHA256 over
// `approval_id|nonce|content_hash|expires_at`. The token is never stored; it is recomputed from
// the stored row and the server secret, so a reader of the database cannot mint one.
// node:crypto createHmac and timingSafeEqual are deterministic (no randomness). S1 bars node:* in
// domain packages; eslint.config.mjs exempts this file for node:crypto hashing only (random functions stay banned).

import { createHmac, timingSafeEqual } from 'node:crypto';

export interface TokenParts {
  approval_id: string;
  nonce: string;
  content_hash: string;
  /** ISO string as produced by Date.toISOString() */
  expires_at: string;
}

function hmacHex(secret: string, parts: TokenParts): string {
  return createHmac('sha256', secret)
    .update(`${parts.approval_id}|${parts.nonce}|${parts.content_hash}|${parts.expires_at}`, 'utf8')
    .digest('hex');
}

export function makeToken(secret: string, parts: TokenParts): string {
  return `${parts.approval_id}.${hmacHex(secret, parts)}`;
}

// True only when the token has the exact shape `${approval_id}.${hex}` and the hex matches.
export function tokenMatches(secret: string, parts: TokenParts, token: string): boolean {
  const prefix = `${parts.approval_id}.`;
  if (!token.startsWith(prefix)) return false;
  const given = Buffer.from(token.slice(prefix.length), 'utf8');
  const expected = Buffer.from(hmacHex(secret, parts), 'utf8');
  return given.length === expected.length && timingSafeEqual(given, expected);
}
