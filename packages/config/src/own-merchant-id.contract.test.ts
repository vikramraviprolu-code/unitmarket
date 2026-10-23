// BU-7 (D-028): UMS_OWN_MERCHANT_ID is a non-secret, optional, validated config value. Its name is
// in .env.example; no value is anywhere in the repository.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadConfig } from './index';
import { ENV_NAMES } from './schema';

const S1 = 'Qm7vK2pLx9RbT4zWc8NdYh3JfG6sAe1U';
const S2 = 'Zr5tB8nKd2VwXq7LmC4yHj9PgF3sEa6U';
const S3 = 'Jd4wN7xQk2ZcR9vTb5LmY8hGp3FsAe6U';
const OWN = 'SBXOWNMERCH01';
const base = (over: Record<string, string | undefined> = {}) => ({
  UMS_SESSION_SECRET: S1,
  UMS_APPROVAL_SECRET: S2,
  UMS_LINK_SECRET: S3,
  ...over,
});
const sandbox = (over: Record<string, string | undefined> = {}) =>
  base({
    UMS_MODE: 'sandbox',
    UMS_OUTBOUND_APPROVAL_REF: 'DL-2026-10-23-01',
    PAYPAL_CLIENT_ID: 'client-id-value',
    PAYPAL_CLIENT_SECRET: 'client-secret-value-xyz',
    ...over,
  });

describe('UMS_OWN_MERCHANT_ID', () => {
  it('is optional: unset gives null, in both modes', () => {
    for (const env of [base(), sandbox()]) {
      const r = loadConfig(env);
      expect(r.ok && r.value.own_merchant_id).toBeNull();
    }
  });
  it.each(['', '   '])('an empty value %j means unset', (v) => {
    const r = loadConfig(sandbox({ UMS_OWN_MERCHANT_ID: v }));
    expect(r.ok && r.value.own_merchant_id).toBeNull();
  });
  it('accepts a 13 character upper-case alphanumeric id, in both modes', () => {
    for (const env of [base({ UMS_OWN_MERCHANT_ID: OWN }), sandbox({ UMS_OWN_MERCHANT_ID: OWN })]) {
      const r = loadConfig(env);
      expect(r.ok && r.value.own_merchant_id).toBe(OWN);
    }
  });
  it('is read as is: no case folding', () => {
    const r = loadConfig(sandbox({ UMS_OWN_MERCHANT_ID: ` ${OWN} ` }));
    // surrounding blanks come off like every other value; the id itself is not altered
    expect(r.ok && r.value.own_merchant_id).toBe(OWN);
  });
  it.each([
    ['lower case', OWN.toLowerCase()],
    ['too short', OWN.slice(0, 12)],
    ['too long', `${OWN}0`],
    ['inner space', 'SBXOWN MERCH01'],
    ['hyphen', 'SBXOWN-MERCH01'],
    ['underscore', 'SBXOWN_MERCH01'],
    ['Cyrillic look-alike', `\u0405${OWN.slice(1)}`],
    ['fullwidth', `\uFF33${OWN.slice(1)}`],
    ['trailing newline inside', `SBXOWN\nMERCH01`],
    ['an email', 'owner@example.invalid'],
    ['a url', 'https://example.invalid/x'],
    ['a list', `${OWN},${OWN}`],
  ])('refuses %s with invalid_value naming the variable, never the value', (_n, v) => {
    const r = loadConfig(sandbox({ UMS_OWN_MERCHANT_ID: v }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('invalid_value');
    expect(r.error.name).toBe('UMS_OWN_MERCHANT_ID');
    expect(JSON.stringify(r.error)).not.toContain(v.trim());
  });
  it('is refused in offline mode too when malformed', () => {
    const r = loadConfig(base({ UMS_OWN_MERCHANT_ID: 'nope' }));
    expect(r.ok).toBe(false);
  });
  it('the value is not a secret: it is a plain string on the config, never a Secret', () => {
    const r = loadConfig(sandbox({ UMS_OWN_MERCHANT_ID: OWN }));
    expect(r.ok && typeof r.value.own_merchant_id).toBe('string');
  });
  it('is one of the names packages/config reads', () => {
    expect(ENV_NAMES).toContain('UMS_OWN_MERCHANT_ID');
  });
});

describe('.env.example', () => {
  const lines = readFileSync(new URL('../../../.env.example', import.meta.url), 'utf8').split('\n');
  it('carries the name with no value', () => {
    const own = lines.filter((l) => l.startsWith('UMS_OWN_MERCHANT_ID'));
    expect(own).toEqual(['UMS_OWN_MERCHANT_ID=']);
  });
  it('every name packages/config reads is in the file, still names only', () => {
    const names = lines.filter((l) => /^[A-Z_]+=/.test(l)).map((l) => l.split('=')[0]);
    for (const n of ENV_NAMES.filter((x) => x !== 'DATABASE_URL')) expect(names).toContain(n);
    for (const l of lines.filter((x) => /^[A-Z_]+=/.test(x))) expect(l.split('=')[1]).toBe('');
  });
});
