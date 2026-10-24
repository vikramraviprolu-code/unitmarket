// CO-6: scripts/totp-enrol.mjs prints a new operator TOTP secret and its authenticator URI to the
// operator's own terminal, once, and writes nothing. Fixed test ids stand in for the randomness.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../packages/config/src/index';
import { base32Decode, matchingSteps, stepAt, totpCode } from '../packages/security/src/index';
import { AI_MARKERS, CI_MARKERS } from './sandbox-conformance.mjs';
import { runTotpEnrol } from './totp-enrol.mjs';
import { REPO_ROOT } from './test-helpers';

const HEX_A = '00112233445566778899aabbccddeeff';
const HEX_B = 'fedcba98765432100123456789abcdef';
// the first 20 bytes of HEX_A + HEX_B
const EXPECTED_SECRET = 'AAISEM2EKVTHPCEZVK54ZXPO777NZOUY';

interface RunOptions {
  stdin?: boolean;
  stdout?: boolean;
  env?: Record<string, string | undefined>;
  operator?: string | undefined;
  nonces?: string[];
}

// The runner takes the real libraries by default; the tests pass an Ids stand-in with fixed nonces.
async function run(o: RunOptions = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const nonces = o.nonces ?? [HEX_A, HEX_B];
  const { base32Encode, otpauthUri, isOperatorName } =
    await import('../packages/security/src/index');
  const res = await runTotpEnrol({
    stdinIsTTY: o.stdin ?? true,
    stdoutIsTTY: o.stdout ?? true,
    env: o.env ?? {},
    operator: 'operator' in o ? o.operator : 'vikram',
    write: (l: string) => void out.push(l),
    note: (l: string) => void err.push(l),
    libs: { base32Encode, otpauthUri, isOperatorName, ids: { nonce: () => nonces.shift() ?? '' } },
  });
  return { res, out, err };
}

const secretOf = (out: string[]): string =>
  (out.find((l) => /^\s+[A-Z2-7]{32}$/.test(l)) ?? '').trim();
const uriOf = (out: string[]): string =>
  (out.find((l) => l.trim().startsWith('otpauth://')) ?? '').trim();

describe('totp:enrol output', () => {
  it('prints a 20 byte base32 secret and an otpauth URI that names the issuer', async () => {
    const { res, out } = await run();
    expect(res).toEqual({ ok: true });
    const secret = secretOf(out);
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(base32Decode(secret)).toHaveLength(20);
    const uri = uriOf(out);
    expect(uri).toBe(
      `otpauth://totp/UnitMarket%20Sandbox:vikram?secret=${secret}&issuer=UnitMarket%20Sandbox&algorithm=SHA1&digits=6&period=30`,
    );
    expect(uri).toContain('issuer=UnitMarket%20Sandbox');
  });
  it('the 20 bytes are the first 20 of two 128-bit nonces from the injected ids', async () => {
    const { out } = await run();
    expect(secretOf(out)).toBe(EXPECTED_SECRET);
    expect(base32Decode(EXPECTED_SECRET)?.toString('hex')).toBe((HEX_A + HEX_B).slice(0, 40));
  });
  it('another run gives another secret', async () => {
    const a = await run({ nonces: [HEX_A, HEX_B] });
    const b = await run({ nonces: [HEX_B, HEX_A] });
    expect(secretOf(a.out)).not.toBe(secretOf(b.out));
  });
  it('the secret is accepted by the config and produces codes the verifier accepts', async () => {
    const { out } = await run();
    const secret = secretOf(out);
    const r = loadConfig({
      UMS_SESSION_SECRET: 'Qm7vK2pLx9RbT4zWc8NdYh3JfG6sAe1U',
      UMS_APPROVAL_SECRET: 'Zr5tB8nKd2VwXq7LmC4yHj9PgF3sEa6U',
      UMS_LINK_SECRET: 'Jd4wN7xQk2ZcR9vTb5LmY8hGp3FsAe6U',
      UMS_OPERATOR_TOTP_KEYS: `vikram:${secret}`,
    });
    expect(r.ok).toBe(true);
    const key = base32Decode(secret) as Buffer;
    const t = 1_700_000_000_000;
    expect(matchingSteps(key, totpCode(key, stepAt(t)), t)).toEqual([stepAt(t)]);
  });
  it('tells the operator where the entry goes, without repeating the secret, and says nothing was written', async () => {
    const { out, err } = await run();
    const secret = secretOf(out);
    const all = [...out, ...err].join('\n');
    expect(all).toContain('UMS_OPERATOR_TOTP_KEYS');
    expect(all).toContain('vikram:');
    expect(all.split(secret).length - 1).toBe(2); // the secret line and the URI, nothing else
    expect(err.join('\n')).not.toContain(secret);
    expect(all.toLowerCase()).toContain('nothing was written');
  });
});

describe('totp:enrol refuses', () => {
  it.each([
    ['stdin is not a terminal', { stdin: false }, 'not_a_tty'],
    [
      'stdout is not a terminal (the secret would go to a file or a log)',
      { stdout: false },
      'not_a_tty',
    ],
    ['neither is a terminal', { stdin: false, stdout: false }, 'not_a_tty'],
    ...CI_MARKERS.map((m) => [`${m} is set`, { env: { [m]: '1' } }, 'ci_set'] as const),
    ...AI_MARKERS.map((m) => [`${m} is set`, { env: { [m]: '1' } }, 'ai_session'] as const),
  ])('when %s, before it draws any randomness and with no output', async (_n, o, code) => {
    const nonces = [HEX_A, HEX_B];
    const { res, out, err } = await run({ ...(o as object), nonces });
    expect(res).toEqual({ ok: false, code });
    expect(out).toEqual([]);
    expect(err).toEqual([]);
    expect(nonces).toEqual([HEX_A, HEX_B]);
  });
  it.each([
    undefined,
    '',
    'Vikram',
    'demo',
    '1vikram',
    'a b',
    'a:b',
    'a,b',
    '../x',
    'x'.repeat(33),
  ])('the operator name %j', async (operator) => {
    const { res, out } = await run({ operator });
    expect(res).toEqual({ ok: false, code: 'bad_operator' });
    expect(out).toEqual([]);
  });
});

describe('totp:enrol as a command', () => {
  const script = join(REPO_ROOT, 'scripts', 'totp-enrol.mjs');
  it('refuses without a terminal and prints no secret and no URI', () => {
    const r = spawnSync(process.execPath, [script, '--operator', 'vikram'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      input: '',
      env: {},
    });
    expect(r.status).toBe(2);
    const all = `${r.stdout}${r.stderr}`;
    expect(all).toContain('not_a_tty');
    expect(all).not.toMatch(/otpauth:|secret=|[A-Z2-7]{32}/);
  }, 60_000);
  it('refuses a missing or unknown argument with the usage line, also without a terminal', () => {
    for (const args of [[], ['--operator'], ['vikram'], ['--operator', 'vikram', '--out', 'x']]) {
      const r = spawnSync(process.execPath, [script, ...args], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        input: '',
        env: {},
      });
      expect(r.status, args.join(' ')).toBe(2);
      expect(`${r.stdout}${r.stderr}`).not.toMatch(/otpauth:/);
    }
  }, 60_000);
});

describe('totp:enrol source', () => {
  const src = readFileSync(join(REPO_ROOT, 'scripts', 'totp-enrol.mjs'), 'utf8');
  it('writes no file: no file-writing function and no node:fs', () => {
    expect(src).not.toMatch(
      /writeFile|appendFile|createWriteStream|writeSync|node:fs|copyFile|rename/,
    );
  });
  it('opens no network connection and does not log', () => {
    expect(src).not.toMatch(
      /fetch\(|node:(http|https|net|tls|dns|dgram)|undici|XMLHttpRequest|WebSocket/,
    );
    expect(src).not.toMatch(/console\.(log|error|warn|info|debug)/);
  });
  it('reads no environment value itself: the marker names come from the shared reader', () => {
    expect(src).not.toMatch(/process\.env/);
  });
});
