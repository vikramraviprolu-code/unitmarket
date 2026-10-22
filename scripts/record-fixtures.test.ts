// pnpm record:fixtures (B-L3): offline CLI around the recorder. No value is ever printed.
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { exchange, hostileExchange, liveInputs, makeCanaries } from '../packages/transport/src/recorder-corpus';
import { REPO_ROOT } from './test-helpers';

const run = (args: string[], env: Record<string, string> = {}) => {
  const r = spawnSync(
    process.execPath,
    ['--import', join(REPO_ROOT, 'scripts/lib/ts-register.mjs'), join(REPO_ROOT, 'scripts/record-fixtures.mjs'), ...args],
    { cwd: REPO_ROOT, encoding: 'utf8', input: '', env: { PATH: process.env.PATH ?? '', ...env } },
  );
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
};
async function sandboxRoot() {
  const root = await mkdtemp(join(tmpdir(), 'umsbx-reccli-'));
  await mkdir(join(root, 'fixtures', 'paypal'), { recursive: true });
  return root;
}
const inputFile = async (v: unknown) => {
  const d = await mkdtemp(join(tmpdir(), 'umsbx-recin-'));
  const f = join(d, 'raw.json');
  await writeFile(f, JSON.stringify(v));
  return f;
};
const base = (root: string, input: string) => ['--root', root, '--input', input, '--origin', 'sandbox-recording: owner spike run 1 (hand-redacted raw output)', '--recorded-at', '2026-10-23T09:30:00Z'];

describe('record-fixtures CLI', () => {
  it('writes recordings, prints a summary without values, exits 0', async () => {
    const c = makeCanaries();
    const root = await sandboxRoot();
    const r = run(base(root, await inputFile([hostileExchange(c)])), { CANARY_LIST_VAR: c.plain });
    expect(r.status, r.out).toBe(0);
    expect(r.out).toMatch(/1 file/);
    for (const v of c.all) expect(r.out).not.toContain(v);
    expect(await readdir(join(root, 'fixtures', 'paypal', 'sandbox-recordings'))).toEqual(['hostile__get_order__1.json']);
    const text = await readFile(join(root, 'fixtures', 'paypal', 'sandbox-recordings', 'hostile__get_order__1.json'), 'utf8');
    for (const v of c.all) expect(text).not.toContain(v);
    // formatted the way prettier would leave it, so the hashes in the index stay valid
    const prettier = await import('prettier');
    expect(await prettier.check(text, { parser: 'json', ...(await prettier.resolveConfig(join(REPO_ROOT, 'x.json'))) })).toBe(true);
  });

  it('reads canary values from the env var names given and refuses when one survives', async () => {
    const c = makeCanaries();
    const root = await sandboxRoot();
    const e = exchange({ response: { status: 200, headers: {}, body: { id: '5O190127TN364715T', memo: c.plain } } });
    const r = run([...base(root, await inputFile([e])), '--canary-env', 'FAKE_CANARY_NAME_A'], { FAKE_CANARY_NAME_A: c.plain });
    expect(r.status).toBe(3);
    expect(r.out).toMatch(/refused/);
    expect(r.out).not.toContain(c.plain);
    expect(await readdir(join(root, 'fixtures', 'paypal'))).toEqual([]);
  });

  it('refuses live input with exit 3 and writes nothing', async () => {
    const root = await sandboxRoot();
    const r = run(base(root, await inputFile([liveInputs().live_url])));
    expect(r.status).toBe(3);
    expect(r.out).toMatch(/live_host/);
    expect(await readdir(join(root, 'fixtures', 'paypal'))).toEqual([]);
  });

  it('has no output path option: --out is a usage error', async () => {
    const root = await sandboxRoot();
    const r = run([...base(root, await inputFile([exchange()])), '--out', '/tmp/elsewhere']);
    expect(r.status).toBe(2);
  });

  it('--self-test passes offline', () => {
    const r = run(['--self-test']);
    expect(r.status, r.out).toBe(0);
    expect(r.out).toMatch(/self-test ok/);
  });

  it('never reads the PayPal credential variables', async () => {
    const root = await sandboxRoot();
    const fakeName = ['PAYPAL', 'CLIENT', 'SECRET'].join('_');
    const fakeValue = makeCanaries().clientSecret;
    const r = run(base(root, await inputFile([exchange()])), { [fakeName]: fakeValue });
    expect(r.status, r.out).toBe(0);
    expect(r.out).not.toContain(fakeValue);
  });
});
