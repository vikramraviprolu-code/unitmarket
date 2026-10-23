// BU-6: pnpm owner:secrets prints four NAME=value lines for the owner's .env.local and writes no file.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { verifyPasscode } from '../packages/security/src/index';
import { REPO_ROOT } from './test-helpers';
import { runOwnerSecrets } from './owner-secrets.mjs';

const PASSCODE = 'correct horse battery staple';
const NAMES = [
  'UMS_SESSION_SECRET',
  'UMS_APPROVAL_SECRET',
  'UMS_LINK_SECRET',
  'UMS_DEMO_PASSCODE_HASH',
];

function rig(
  o: {
    tty?: boolean;
    env?: Record<string, string | undefined>;
    answers?: string[];
  } = {},
) {
  const out: string[] = [];
  const prompts: string[] = [];
  const answers = [...(o.answers ?? [PASSCODE, PASSCODE])];
  const deps = {
    stdinIsTTY: o.tty ?? true,
    stderrIsTTY: o.tty ?? true,
    env: o.env ?? {},
    askHidden: async (p: string) => {
      prompts.push(p);
      return answers.shift() ?? '';
    },
    write: (l: string) => void out.push(l),
  };
  return { deps, out, prompts };
}

describe('owner:secrets', () => {
  it('prints exactly the four names as NAME=value lines', async () => {
    const r = rig();
    const res = await runOwnerSecrets(r.deps);
    expect(res).toEqual({ ok: true });
    const lines = r.out.join('\n').split('\n').filter((l) => /^[A-Z_]+=/.test(l));
    expect(lines.map((l) => l.split('=')[0])).toEqual(NAMES);
  });
  it('the three secrets are 32 random bytes each, distinct, strong enough for the config', async () => {
    const r = rig();
    await runOwnerSecrets(r.deps);
    const v = Object.fromEntries(
      r.out
        .join('\n')
        .split('\n')
        .filter((l) => /^[A-Z_]+=/.test(l))
        .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
    );
    const secrets = NAMES.slice(0, 3).map((n) => v[n] as string);
    for (const s of secrets) {
      expect(s).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(Buffer.from(s, 'base64url')).toHaveLength(32);
    }
    expect(new Set(secrets).size).toBe(3);
    // a second run gives different values
    const r2 = rig();
    await runOwnerSecrets(r2.deps);
    expect(r2.out.join('\n')).not.toContain(secrets[0] as string);
  });
  it('the passcode hash verifies against the typed passcode, uses a fresh salt, and the passcode is never printed', async () => {
    const r = rig();
    await runOwnerSecrets(r.deps);
    const all = r.out.join('\n');
    expect(all).not.toContain(PASSCODE);
    const hash = all
      .split('\n')
      .find((l) => l.startsWith('UMS_DEMO_PASSCODE_HASH='))
      ?.slice('UMS_DEMO_PASSCODE_HASH='.length) as string;
    expect(hash).toMatch(/^scrypt\$\d+\$\d+\$\d+\$[0-9a-f]{32}\$[0-9a-f]{64}$/);
    expect(await verifyPasscode(hash, PASSCODE)).toBe(true);
    expect(await verifyPasscode(hash, `${PASSCODE}x`)).toBe(false);
    const r2 = rig();
    await runOwnerSecrets(r2.deps);
    const hash2 = r2.out.find((l) => l.startsWith('UMS_DEMO_PASSCODE_HASH=')) as string;
    expect(hash2.split('$')[4]).not.toBe(hash.split('$')[4]);
  });
  it('asks for the passcode twice, hidden', async () => {
    const r = rig();
    await runOwnerSecrets(r.deps);
    expect(r.prompts).toHaveLength(2);
  });
  it('refuses a passcode typed twice that differs, or shorter than 12 characters, and prints no secret', async () => {
    for (const answers of [
      [PASSCODE, `${PASSCODE}!`],
      ['short', 'short'],
      ['', ''],
    ]) {
      const r = rig({ answers });
      const res = await runOwnerSecrets(r.deps);
      expect(res.ok).toBe(false);
      expect(r.out.join('\n')).not.toMatch(/^UMS_[A-Z_]+=/m);
    }
  });
  it.each([
    ['stdin is not a terminal', { tty: false }, 'not_a_tty'],
    ['CI is set', { env: { CI: '1' } }, 'ci_set'],
    ['GITHUB_ACTIONS is set', { env: { GITHUB_ACTIONS: 'true' } }, 'ci_set'],
    ['CLAUDECODE is set', { env: { CLAUDECODE: '1' } }, 'ai_session'],
    ['CLAUDE_CODE_REMOTE is set', { env: { CLAUDE_CODE_REMOTE: 'true' } }, 'ai_session'],
  ])('refuses when %s, before asking anything', async (_n, o, code) => {
    const r = rig(o as Parameters<typeof rig>[0]);
    const res = await runOwnerSecrets(r.deps);
    expect(res).toEqual({ ok: false, code });
    expect(r.prompts).toEqual([]);
    expect(r.out.join('\n')).not.toMatch(/^UMS_[A-Z_]+=/m);
  });
  it('writes no file: the module names no file-writing function', () => {
    const src = readFileSync(join(REPO_ROOT, 'scripts', 'owner-secrets.mjs'), 'utf8');
    expect(src).not.toMatch(/writeFile|appendFile|createWriteStream|writeSync|node:fs/);
  });
  it('the command refuses without a terminal and prints no secret line', () => {
    const r = spawnSync(process.execPath, [join(REPO_ROOT, 'scripts', 'owner-secrets.mjs')], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      input: '',
      env: {},
    });
    expect(r.status).not.toBe(0);
    expect(`${r.stdout}${r.stderr}`).toContain('not_a_tty');
    expect(`${r.stdout}${r.stderr}`).not.toMatch(/^UMS_[A-Z_]+=/m);
  }, 60_000);
  it('the root package.json wires the script without a node flag that the transport guard refuses', async () => {
    const pkg = (await import('../package.json', { with: { type: 'json' } })).default as {
      scripts: Record<string, string>;
    };
    const cmd = pkg.scripts['owner:secrets'] as string;
    expect(cmd).toContain('scripts/owner-secrets.mjs');
    expect(cmd).not.toMatch(/--import|--require|--loader|NODE_OPTIONS|--conditions/);
  });
});
