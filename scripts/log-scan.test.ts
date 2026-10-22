// Tests of the log scanner (B-L7): its self-test, every rule on a runtime-built canary, no false
// alarm on the allowed forms, findings never carry the matched value, and the CLI exit codes.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SHAPES, countDebugIds, scanLines, scanRows, scanText, selfTest } from './log-scan.mjs';

const part = (...xs: string[]): string => xs.join('');
const SEED = part('seedvalue', '-', 'unit', '-', '5d1e77aa');
const CLI = join(__dirname, 'log-scan.mjs');
const run = (...args: string[]) =>
  spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });

describe('log-scan', () => {
  it('self-test passes: every canary is found, the clean fixture is clean', () => {
    expect(selfTest()).toEqual({ ok: true, missed: [], false_alarms: [] });
    expect(run('--self-test').status).toBe(0);
  });

  it('has a rule for every shape the nfr names: bearer, basic, token, jwt, key block, assignment, email', () => {
    const names = SHAPES.map((s) => s.name);
    for (const n of [
      'bearer_token',
      'basic_auth',
      'paypal_access_token',
      'jwt',
      'private_key_block',
      'secret_assignment',
      'email_address',
    ]) {
      expect(names).toContain(n);
    }
  });

  it('finds a seed in plain, url-encoded and base64 form, in a line and in a row', () => {
    const enc = encodeURIComponent(`${SEED} x`);
    const b64 = Buffer.from(SEED).toString('base64');
    for (const text of [`a ${SEED} b`, `q=${enc}`, `blob ${b64}`, SEED.toUpperCase()]) {
      expect(scanText(text, { seeds: [SEED] }).map((f) => f.rule)).toContain('seeded_value');
    }
    expect(scanRows([{ response_redacted: { x: SEED } }], { seeds: [SEED] })).toHaveLength(1);
  });

  it('does not alarm on the allowed forms: [redacted], hashed email, ids, debug ids', () => {
    const ok = [
      '{"authorization":"[redacted]","access_token":"[redacted]","email":"sha256:0123456789ab"}',
      'Bearer [redacted]',
      'paypal_debug_id=dbg1234567890ab order_ref=ord_0n31eja83zq8mgv3pbmdjtgswv',
      '{"token":null,"secret":false}',
    ];
    expect(scanLines(ok, { seeds: [SEED] })).toEqual([]);
  });

  it('a finding names the rule, place and length but never the matched value', () => {
    const f = scanLines([`x ${SEED} y`], { seeds: [SEED] });
    expect(JSON.stringify(f)).not.toContain(SEED);
    expect(f[0]).toMatchObject({ rule: 'seeded_value', where: 'log:1' });
  });

  it('refuses a seed too short to mean anything', () => {
    expect(() => scanText('abc', { seeds: ['abc'] })).toThrow(/at least 6/);
  });

  it('counts the rows that carry a debug id', () => {
    expect(countDebugIds([{ debug_id: 'a1' }, { debug_id: null }, {}, { debug_id: '' }])).toBe(1);
  });

  it('CLI: clean file exits 0, a file with the seed exits 1 and prints no value, no input exits 2', () => {
    const dir = mkdtempSync(join(tmpdir(), 'logscan-'));
    const clean = join(dir, 'clean.log');
    const dirty = join(dir, 'dirty.log');
    writeFileSync(clean, '{"msg":"ok","fields":{"operation":"create_order"}}\n');
    writeFileSync(dirty, `{"msg":"leak ${SEED}"}\n`);
    expect(run('--log', clean, '--seed', SEED).status).toBe(0);
    const bad = run('--log', dirty, '--seed', SEED);
    expect(bad.status).toBe(1);
    expect(bad.stdout).toContain('rule=seeded_value');
    expect(bad.stdout + bad.stderr).not.toContain(SEED);
    expect(run().status).toBe(2);
  });
});
