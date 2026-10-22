// Signed short-lived link tokens: base64url(link_id.exp.hmac). The token proves only that we issued
// it and when it expires; the links row binds it to an entitlement and a buyer.
// Adapted from packages/core/entitlements/links.ts at a36ddc03fd0b962000f686291c145b50ee337f90 (refusal codes); owned by SBX lane 09.
// node:crypto (hashing and HMAC only) is allowed for this file by name in eslint.config.mjs.
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { Id, Result, Secret } from '@umsbx/contracts';

const mac = (secret: Secret, link_id: string, exp: number): Buffer => {
  const key = secret.reveal();
  if (key.length === 0) throw new Error('link secret is empty');
  return createHmac('sha256', key).update(`${link_id}.${exp}`).digest();
};

/** Throws when the secret is empty or the inputs cannot be encoded (the readiness probe relies on it). */
export function makeLinkToken(secret: Secret, i: { link_id: Id; exp_unix: number }): string {
  if (!Number.isSafeInteger(i.exp_unix) || i.exp_unix < 0) throw new Error('bad exp');
  if (i.link_id.includes('.')) throw new Error('bad link id');
  const tag = mac(secret, i.link_id, i.exp_unix).toString('base64url');
  return Buffer.from(`${i.link_id}.${i.exp_unix}.${tag}`, 'utf8').toString('base64url');
}

export function readLinkToken(
  secret: Secret,
  token: string,
  now: Date,
): Result<{ link_id: Id }, 'bad_token' | 'expired'> {
  const bad = { ok: false, error: 'bad_token' } as const;
  if (!/^[A-Za-z0-9_-]{8,1024}$/.test(token)) return bad;
  const parts = Buffer.from(token, 'base64url').toString('utf8').split('.');
  if (parts.length !== 3) return bad;
  const [link_id, expText, tag] = parts as [string, string, string];
  if (link_id.length === 0 || !/^\d{1,12}$/.test(expText) || !/^[A-Za-z0-9_-]+$/.test(tag)) {
    return bad;
  }
  // Re-encoding must reproduce the token exactly, so no alternative spelling is accepted.
  const exp = Number(expText);
  let expected: Buffer;
  try {
    expected = mac(secret, link_id, exp);
  } catch {
    return bad;
  }
  const given = Buffer.from(tag, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return bad;
  if (Buffer.from(`${link_id}.${expText}.${tag}`, 'utf8').toString('base64url') !== token) {
    return bad;
  }
  if (now.getTime() >= exp * 1000) return { ok: false, error: 'expired' };
  return { ok: true, value: { link_id } };
}

/** What the links table stores: a hash of the token, never the token. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
