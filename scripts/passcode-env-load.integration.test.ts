// BU-6c: the demo passcode hash must survive the loader the web app uses under `next start`.
// Next loads apps/web/.env.local with @next/env (dotenv-expand), which reads `$16384` in the old
// stored form as a variable reference. This test writes a temp .env.local, loads it through the
// real @next/env that is installed for `next`, and checks the value is unchanged and verifies.
// @next/env is a dependency of `next`, not of the root, so it is imported by its pnpm store path.
// Offline: temp files only, fake passcode.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../packages/config/src/index';
import { hashPasscode, verifyPasscode } from '../packages/security/src/index';

type LoadEnv = (
  dir: string,
  dev: boolean,
  log?: { info: () => void; error: () => void },
  forceReload?: boolean,
) => { combinedEnv: Record<string, string | undefined> };

// The pinned @next/env of `next` 15.5.28 (pnpm-lock.yaml). A version bump moves this path and fails
// the import loudly: update the literal then. The lint rules bar createRequire and a computed
// import path, so the path is spelled out.
const nextEnv =
  (await import('../node_modules/.pnpm/@next+env@15.5.28/node_modules/@next/env/dist/index.js')) as {
    loadEnvConfig?: LoadEnv;
    default?: { loadEnvConfig: LoadEnv };
  };
const loadEnvConfig = (nextEnv.loadEnvConfig ?? nextEnv.default?.loadEnvConfig) as LoadEnv;

const NAME = 'UMS_DEMO_PASSCODE_HASH';
const PASSCODE = 'correct horse battery staple';
const SALT = '00112233445566778899aabbccddeeff';
const S1 = 'Qm7vK2pLx9RbT4zWc8NdYh3JfG6sAe1U';
const S2 = 'Zr5tB8nKd2VwXq7LmC4yHj9PgF3sEa6U';
const S3 = 'Jd4wN7xQk2ZcR9vTb5LmY8hGp3FsAe6U';
const quiet = { info: () => undefined, error: () => undefined };

let dir = '';
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bu6c-envload-'));
  // Next only reads .env.local outside test mode; the vitest run sets NODE_ENV=test.
  vi.stubEnv('NODE_ENV', 'production');
  // Records "absent" so the loader's write to the process environment is undone afterwards.
  vi.stubEnv(NAME, undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

function loadFrom(line: string): string | undefined {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '.env.local'), `${line}\n`);
  return loadEnvConfig(dir, false, quiet, true).combinedEnv[NAME];
}

describe('UMS_DEMO_PASSCODE_HASH through the Next env loader (BU-6c)', () => {
  it('the new form loads unchanged, verifies the passcode, and boots through loadConfig', async () => {
    const hash = await hashPasscode(PASSCODE, SALT);
    expect(hash).not.toContain('$');
    const loaded = loadFrom(`${NAME}=${hash}`);
    expect(loaded).toBe(hash);
    expect(await verifyPasscode(loaded as string, PASSCODE)).toBe(true);
    expect(await verifyPasscode(loaded as string, `${PASSCODE}!`)).toBe(false);
    const cfg = loadConfig({
      UMS_SESSION_SECRET: S1,
      UMS_APPROVAL_SECRET: S2,
      UMS_LINK_SECRET: S3,
      [NAME]: loaded,
    });
    expect(cfg.ok && cfg.value.passcode_hash).toBe(hash);
  });

  it('the new form also survives a double-quoted and a single-quoted line', async () => {
    const hash = await hashPasscode(PASSCODE, SALT);
    expect(loadFrom(`${NAME}="${hash}"`)).toBe(hash);
    expect(loadFrom(`${NAME}='${hash}'`)).toBe(hash);
  });

  it('documents the bug: the old form is mangled by the loader, and boot refuses what is left', async () => {
    const hash = await hashPasscode(PASSCODE, SALT);
    const old = hash.replaceAll(':', '$');
    const loaded = loadFrom(`${NAME}=${old}`);
    expect(loaded).not.toBe(old);
    expect(loaded).toBe('scrypt6384');
    expect(await verifyPasscode(loaded as string, PASSCODE)).toBe(false);
    const cfg = loadConfig({
      UMS_SESSION_SECRET: S1,
      UMS_APPROVAL_SECRET: S2,
      UMS_LINK_SECRET: S3,
      [NAME]: loaded,
    });
    expect(cfg.ok).toBe(false);
    if (!cfg.ok) expect(cfg.error).toEqual({ code: 'invalid_value', name: NAME });
  });

  it('the old form still verifies when it reaches the app unexpanded (shell export or host setting)', async () => {
    const hash = await hashPasscode(PASSCODE, SALT);
    expect(await verifyPasscode(hash.replaceAll(':', '$'), PASSCODE)).toBe(true);
  });
});
