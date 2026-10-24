// BU-6c: UMS_DEMO_PASSCODE_HASH must parse as the env-safe form (scrypt:N:r:p:salt:key) or the old
// dollar form, or boot is refused. The refusal names the variable and never the value, so a hash
// that a dotenv loader mangled (`scrypt6384`) fails loudly instead of as a silent sign-in failure.
import { describe, expect, it } from 'vitest';
import { loadConfig } from './index';

const S1 = 'Qm7vK2pLx9RbT4zWc8NdYh3JfG6sAe1U';
const S2 = 'Zr5tB8nKd2VwXq7LmC4yHj9PgF3sEa6U';
const S3 = 'Jd4wN7xQk2ZcR9vTb5LmY8hGp3FsAe6U';
const SALT = '00112233445566778899aabbccddeeff';
const KEY = 'ab'.repeat(32);
const NEW_FORM = `scrypt:16384:8:1:${SALT}:${KEY}`;
const OLD_FORM = `scrypt$16384$8$1$${SALT}$${KEY}`;

const base = (over: Record<string, string | undefined> = {}) => ({
  UMS_SESSION_SECRET: S1,
  UMS_APPROVAL_SECRET: S2,
  UMS_LINK_SECRET: S3,
  ...over,
});
const prod = (over: Record<string, string | undefined> = {}) =>
  base({ NODE_ENV: 'production', UMS_PUBLIC_ORIGIN: 'https://um.example.org', ...over });
const sandbox = (over: Record<string, string | undefined> = {}) =>
  base({
    UMS_MODE: 'sandbox',
    UMS_OUTBOUND_APPROVAL_REF: 'DL-2026-10-24-01',
    PAYPAL_CLIENT_ID: 'client-id-value',
    PAYPAL_CLIENT_SECRET: 'client-secret-value-xyz',
    ...over,
  });

describe('UMS_DEMO_PASSCODE_HASH shape (BU-6c)', () => {
  it.each([
    ['new form', NEW_FORM],
    ['old form', OLD_FORM],
    ['new form, longest salt', `scrypt:16384:8:1:${'cd'.repeat(64)}:${KEY}`],
    ['old form, longest salt', `scrypt$16384$8$1$${'cd'.repeat(64)}$${KEY}`],
    ['new form with blanks around it', `  ${NEW_FORM}  `],
  ])('accepts the %s, in offline, sandbox and production', (_n, v) => {
    for (const env of [
      base({ UMS_DEMO_PASSCODE_HASH: v }),
      sandbox({ UMS_DEMO_PASSCODE_HASH: v }),
      prod({ UMS_DEMO_PASSCODE_HASH: v }),
    ]) {
      const r = loadConfig(env);
      expect(r.ok).toBe(true);
      expect(r.ok && r.value.passcode_hash).toBe(v.trim());
    }
  });

  it('unset or blank stays allowed outside production offline', () => {
    for (const v of [undefined, '', '   ']) {
      const r = loadConfig(base({ UMS_DEMO_PASSCODE_HASH: v }));
      expect(r.ok && r.value.passcode_hash).toBeNull();
    }
  });

  it('unset in production offline is still the old missing_value refusal', () => {
    const r = loadConfig(prod());
    expect(!r.ok && r.error).toEqual({ code: 'missing_value', name: 'UMS_DEMO_PASSCODE_HASH' });
  });

  const mangled: Array<[string, string]> = [
    ['what dotenv-expand leaves of the old form', 'scrypt6384'],
    ['old form with the variables eaten', `scrypt${SALT}${KEY}`],
    ['old form missing the key', `scrypt$16384$8$1$${SALT}$`],
    ['old form missing the salt and key', 'scrypt$16384$8$1'],
    ['placeholder', 'scrypt$x'],
    ['not a hash', 'hunter2hunter2'],
    ['mixed separators', `scrypt$16384:8$1:${SALT}$${KEY}`],
    ['mixed separators, other way', `scrypt:16384$8:1$${SALT}:${KEY}`],
    ['five fields', `scrypt:16384:8:${SALT}:${KEY}`],
    ['seven fields', `scrypt:16384:8:1:${SALT}:${KEY}:00`],
    ['another algorithm', `argon2:16384:8:1:${SALT}:${KEY}`],
    ['upper-case scheme', `SCRYPT:16384:8:1:${SALT}:${KEY}`],
    ['non-numeric N', `scrypt:abc:8:1:${SALT}:${KEY}`],
    ['empty N', `scrypt::8:1:${SALT}:${KEY}`],
    ['zero N', `scrypt:0:8:1:${SALT}:${KEY}`],
    ['negative r', `scrypt:16384:-8:1:${SALT}:${KEY}`],
    ['decimal p', `scrypt:16384:8:1.0:${SALT}:${KEY}`],
    ['short salt', `scrypt:16384:8:1:${SALT.slice(0, 30)}:${KEY}`],
    ['odd-length salt', `scrypt:16384:8:1:${SALT}0:${KEY}`],
    ['non-hex salt', `scrypt:16384:8:1:${'zz'.repeat(16)}:${KEY}`],
    ['upper-case salt', `scrypt:16384:8:1:${SALT.toUpperCase()}:${KEY}`],
    ['salt too long', `scrypt:16384:8:1:${'cd'.repeat(65)}:${KEY}`],
    ['short key', `scrypt:16384:8:1:${SALT}:${KEY.slice(2)}`],
    ['long key', `scrypt:16384:8:1:${SALT}:${KEY}00`],
    ['upper-case key', `scrypt:16384:8:1:${SALT}:${KEY.toUpperCase()}`],
    ['scheme name only', 'scrypt'],
    ['scheme name with junk', 'scryptx'],
    ['old form, empty N', `scrypt$$8$1$${SALT}$${KEY}`],
    ['old form, zero N', `scrypt$0$8$1$${SALT}$${KEY}`],
    ['old form, salt too long', `scrypt$16384$8$1$${'cd'.repeat(65)}$${KEY}`],
    ['junk before the scheme', `x${NEW_FORM}`],
    ['junk before the old scheme', `x${OLD_FORM}`],
    ['trailing newline inside', `scrypt:16384:8:1:${SALT}:${KEY}\nX=1`],
  ];

  it.each(mangled)('refuses %s: invalid_value naming only the variable', (_n, v) => {
    for (const env of [
      base({ UMS_DEMO_PASSCODE_HASH: v }),
      sandbox({ UMS_DEMO_PASSCODE_HASH: v }),
      prod({ UMS_DEMO_PASSCODE_HASH: v }),
    ]) {
      const r = loadConfig(env);
      expect(r.ok).toBe(false);
      if (r.ok) continue;
      expect(r.error).toEqual({ code: 'invalid_value', name: 'UMS_DEMO_PASSCODE_HASH' });
      expect(JSON.stringify(r.error)).not.toContain(v.trim());
    }
  });

  it('the refusal message never carries the value', () => {
    const r = loadConfig(base({ UMS_DEMO_PASSCODE_HASH: 'scrypt6384' }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(JSON.stringify(r)).not.toContain('scrypt6384');
  });
});
