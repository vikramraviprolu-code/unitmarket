import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { loadConfig } from './index';
import { ENV_NAMES } from './schema';

// CO-6 (ASM-56): UMS_OPERATOR_TOTP_KEYS = name:base32,name:base32. Parsed once into Secret values;
// every key at least 20 bytes; anything malformed refuses boot, naming the variable and never the value.
// The keys below are fixed test strings (the RFC 6238 test key and an ASCII alphabet), not credentials.
const S1 = 'Qm7vK2pLx9RbT4zWc8NdYh3JfG6sAe1U';
const S2 = 'Zr5tB8nKd2VwXq7LmC4yHj9PgF3sEa6U';
const S3 = 'Jd4wN7xQk2ZcR9vTb5LmY8hGp3FsAe6U';
const K1 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'; // 20 bytes
const K2 = 'IFBEGRCFIZDUQSKKJNGE2TSPKBIVEU2U'; // 20 bytes
const K19 = 'IFBEGRCFIZDUQSKKJNGE2TSPKBIVEUY='; // 19 bytes, padded
const K22 = 'IFBEGRCFIZDUQSKKJNGE2TSPKBIVEU2UKVLA===='; // 22 bytes, padded
const NAME = 'UMS_OPERATOR_TOTP_KEYS';

const env = (keys: string | undefined, over: Record<string, string | undefined> = {}) => ({
  UMS_SESSION_SECRET: S1,
  UMS_APPROVAL_SECRET: S2,
  UMS_LINK_SECRET: S3,
  ...(keys === undefined ? {} : { [NAME]: keys }),
  ...over,
});
const keysOf = (keys: string | undefined) => {
  const r = loadConfig(env(keys));
  if (!r.ok) throw new Error(`refused: ${r.error.code}`);
  return r.value.operator_totp_keys;
};
const refusal = (keys: string) => {
  const r = loadConfig(env(keys));
  if (r.ok) throw new Error('expected a refusal');
  return r.error;
};

describe('UMS_OPERATOR_TOTP_KEYS', () => {
  it('is a name the config reads', () => {
    expect(ENV_NAMES).toContain(NAME);
  });
  it.each([undefined, '', '   '])('unset or empty (%j) means no keys', (v) => {
    expect(keysOf(v)).toEqual([]);
  });
  it('one operator', () => {
    const k = keysOf(`vikram:${K1}`);
    expect(k.map((x) => x.name)).toEqual(['vikram']);
    expect(k[0]?.key.reveal()).toBe(K1);
  });
  it('two operators, in the order written', () => {
    const k = keysOf(`vikram:${K1},sakthi:${K2}`);
    expect(k.map((x) => x.name)).toEqual(['vikram', 'sakthi']);
    expect(k.map((x) => x.key.reveal())).toEqual([K1, K2]);
  });
  it('spaces around entries are ignored; lower case and padding are normalised to upper case without padding', () => {
    const k = keysOf(` vikram : ${K1.toLowerCase()} , sakthi:${K22} `);
    expect(k.map((x) => x.key.reveal())).toEqual([K1, K22.replace(/=+$/, '')]);
  });
  it('a key is a Secret: it prints as redacted however it is shown', () => {
    const k = keysOf(`vikram:${K1}`)[0];
    if (k === undefined) throw new Error('no key');
    expect(String(k.key)).toBe('[redacted]');
    expect(JSON.stringify(k)).not.toContain(K1);
    expect(JSON.stringify(k.key)).toBe('"[redacted]"');
    expect(inspect(k)).not.toContain(K1);
    const r = loadConfig(env(`vikram:${K1}`));
    expect(JSON.stringify(r)).not.toContain(K1);
    expect(inspect(r, { depth: 6 })).not.toContain(K1);
  });
  it('exactly 20 bytes is enough; 19 is too short (weak_secret)', () => {
    expect(keysOf(`vikram:${K1}`)).toHaveLength(1);
    expect(refusal(`vikram:${K19}`)).toEqual({ code: 'weak_secret', name: NAME });
    expect(refusal(`vikram:${K19.replace(/=+$/, '')}`)).toEqual({
      code: 'weak_secret',
      name: NAME,
    });
  });
  it('one repeated character is refused even when long enough (weak_secret)', () => {
    expect(refusal(`vikram:${'A'.repeat(32)}`)).toEqual({ code: 'weak_secret', name: NAME });
    expect(refusal(`vikram:${'7'.repeat(52)}`)).toEqual({ code: 'weak_secret', name: NAME });
  });
  it.each([
    ['no colon', K1],
    ['empty name', `:${K1}`],
    ['empty secret', 'vikram:'],
    ['empty entry', `vikram:${K1},`],
    ['empty entry in the middle', `vikram:${K1},,sakthi:${K2}`],
    ['a character outside the alphabet (1)', `vikram:${K1.slice(0, 31)}1`],
    ['a character outside the alphabet (8)', `vikram:${K1.slice(0, 31)}8`],
    ['a character outside the alphabet (-)', `vikram:${K1.slice(0, 31)}-`],
    ['a space inside the secret', `vikram:${K1.slice(0, 10)} ${K1.slice(10)}`],
    ['padding in the middle', `vikram:${K1.slice(0, 10)}=${K1.slice(10)}`],
    ['padding of the wrong length', `vikram:${K22.slice(0, 36)}==`],
    ['an upper case name', `Vikram:${K1}`],
    ['a name that starts with a digit', `1vikram:${K1}`],
    ['a name with a dash', `vik-ram:${K1}`],
    ['a name longer than 32', `${'a'.repeat(33)}:${K1}`],
    ['the name demo (the id of an unverified session)', `demo:${K1}`],
    ['the same name twice', `vikram:${K1},vikram:${K2}`],
    ['the same key for two names', `vikram:${K1},sakthi:${K1}`],
    ['the same key for two names, one in lower case', `vikram:${K1},sakthi:${K1.toLowerCase()}`],
    ['a second colon', `vikram:${K1}:${K2}`],
    ['nine operators', Array.from({ length: 9 }, (_, i) => `op${i}:${rotated(K1, i)}`).join(',')],
  ])('refuses %s with invalid_value', (_label, value) => {
    expect(refusal(value)).toEqual({ code: 'invalid_value', name: NAME });
  });
  it('eight operators are fine', () => {
    const value = Array.from({ length: 8 }, (_, i) => `op${i}:${rotated(K1, i)}`).join(',');
    expect(keysOf(value)).toHaveLength(8);
  });
  it('a refusal and its boot line never carry the value', () => {
    for (const value of [`vikram:${K19}`, `vikram:${K1}:x`, `VIKRAM:${K1}`]) {
      const r = loadConfig(env(value));
      expect(r.ok).toBe(false);
      expect(JSON.stringify(r)).not.toContain(K1.slice(0, 12));
    }
  });
});

/** K1 with its characters moved along, so each operator in a list has a different key of the same quality. */
function rotated(k: string, n: number): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  return [...k].map((c, i) => alphabet[(alphabet.indexOf(c) + n * 7 + i) % 32]).join('');
}
