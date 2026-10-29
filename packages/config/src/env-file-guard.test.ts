// F8, D-059: a process environment that silently overrides .env.local is refused at boot.
// Every value below is fake. The URL with a password is the canary: it must never be printed.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BOOT_REFUSAL_EXIT_CODE,
  bootOrExit,
  findEnvOverride,
  loadConfigFromProcess,
} from './index';
import { refusalLine } from './refusal';

const CANARY_URL = 'postgres://owner:canary-pw-7731@db.example.invalid:5432/prod';
const FILE_URL = 'postgres://laptop:canary-pw-0042@localhost:5432/dev';

const GUARDED = [
  'UMS_MODE',
  'UMS_PAYPAL_CONNECT',
  'UMS_DB',
  'UMS_PGLITE_DIR',
  'DATABASE_URL',
  'UMS_OUTBOUND_APPROVAL_REF',
  'UMS_OUTBOUND_SCOPE',
  'UMS_OWN_MERCHANT_ID',
  'UMS_PUBLIC_ORIGIN',
] as const;

describe('findEnvOverride (pure)', () => {
  it('passes when every guarded value equals the file', () => {
    const file = 'UMS_DB=pglite-memory\nUMS_MODE=offline\n';
    expect(findEnvOverride({ UMS_DB: 'pglite-memory', UMS_MODE: 'offline' }, file)).toBeNull();
  });
  it('names UMS_DB when it differs from the file', () => {
    expect(findEnvOverride({ UMS_DB: 'postgres' }, 'UMS_DB=pglite-memory\n')).toBe('UMS_DB');
  });
  it('names DATABASE_URL when the process holds it and the file does not define it', () => {
    expect(findEnvOverride({ DATABASE_URL: CANARY_URL }, 'UMS_DB=pglite-memory\n')).toBe(
      'DATABASE_URL',
    );
  });
  it('passes when the process holds no value and the file does (the file was not loaded)', () => {
    expect(findEnvOverride({}, `UMS_DB=postgres\nDATABASE_URL=${FILE_URL}\n`)).toBeNull();
    expect(findEnvOverride({ UMS_DB: undefined }, 'UMS_DB=postgres\n')).toBeNull();
  });
  it('passes on an empty file when the process holds no guarded value', () => {
    expect(findEnvOverride({ PATH: '/usr/bin' }, '')).toBeNull();
  });
  it('parses quoted values and comments as util.parseEnv does', () => {
    const file = [
      '# a comment line',
      'UMS_PUBLIC_ORIGIN="http://localhost:3000"',
      "UMS_OUTBOUND_SCOPE='mvp_b_polling'",
      'UMS_MODE=offline # trailing comment',
      '',
    ].join('\n');
    expect(
      findEnvOverride(
        {
          UMS_PUBLIC_ORIGIN: 'http://localhost:3000',
          UMS_OUTBOUND_SCOPE: 'mvp_b_polling',
          UMS_MODE: 'offline',
        },
        file,
      ),
    ).toBeNull();
    expect(findEnvOverride({ UMS_MODE: 'offline # trailing comment' }, file)).toBe('UMS_MODE');
    expect(findEnvOverride({ UMS_PUBLIC_ORIGIN: '"http://localhost:3000"' }, file)).toBe(
      'UMS_PUBLIC_ORIGIN',
    );
  });
  it('checks each of the nine guarded names', () => {
    for (const name of GUARDED) {
      expect(findEnvOverride({ [name]: 'process-value' }, `${name}=file-value\n`)).toBe(name);
      expect(findEnvOverride({ [name]: 'same' }, `${name}=same\n`)).toBeNull();
      expect(findEnvOverride({ [name]: 'process-value' }, '')).toBe(name);
    }
  });
  it('never compares other names, secrets included', () => {
    const file = [
      'NODE_ENV=production',
      'PATH=/somewhere/else',
      'UMS_SESSION_SECRET=file-session',
      'UMS_APPROVAL_SECRET=file-approval',
      'UMS_LINK_SECRET=file-link',
      'PAYPAL_CLIENT_SECRET=file-client',
      '',
    ].join('\n');
    const env = {
      NODE_ENV: 'test',
      PATH: '/usr/bin',
      UMS_SESSION_SECRET: 'process-session',
      UMS_APPROVAL_SECRET: 'process-approval',
      UMS_LINK_SECRET: 'process-link',
      PAYPAL_CLIENT_SECRET: 'process-client',
    };
    expect(findEnvOverride(env, file)).toBeNull();
    expect(findEnvOverride(env, '')).toBeNull();
  });
  it('returns the first violating guarded name in the guarded order', () => {
    const env = { UMS_DB: 'postgres', UMS_MODE: 'sandbox' };
    expect(findEnvOverride(env, 'UMS_DB=pglite-memory\nUMS_MODE=offline\n')).toBe('UMS_MODE');
  });
  it('returns only the name, never a value', () => {
    const r = findEnvOverride({ DATABASE_URL: CANARY_URL }, `DATABASE_URL=${FILE_URL}\n`);
    expect(r).toBe('DATABASE_URL');
    expect(JSON.stringify(r)).not.toContain('canary-pw');
  });
});

describe('refusal line', () => {
  it('names the variable, says env -u NAME or fix the file, and holds no value', () => {
    const line = refusalLine({ code: 'env_overrides_file', name: 'UMS_DB' });
    expect(line).toContain('env_overrides_file');
    expect(line).toContain('UMS_DB');
    expect(line).toContain('env -u UMS_DB');
    expect(line).toContain('.env.local');
    expect(line).not.toContain('canary-pw');
  });
});

describe('loadConfigFromProcess', () => {
  const S1 = 'Qm7vK2pLx9RbT4zWc8NdYh3JfG6sAe1U';
  const S2 = 'Zr5tB8nKd2VwXq7LmC4yHj9PgF3sEa6U';
  const S3 = 'Jd4wN7xQk2ZcR9vTb5LmY8hGp3FsAe6U';

  const stubProcess = (over: Record<string, string> = {}) => {
    for (const name of GUARDED) vi.stubEnv(name, undefined);
    vi.stubEnv('UMS_SESSION_SECRET', S1);
    vi.stubEnv('UMS_APPROVAL_SECRET', S2);
    vi.stubEnv('UMS_LINK_SECRET', S3);
    for (const [k, v] of Object.entries(over)) vi.stubEnv(k, v);
  };
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('refuses before loadConfig runs, naming the variable and no value', () => {
    stubProcess({ UMS_DB: 'postgres', DATABASE_URL: CANARY_URL });
    const r = loadConfigFromProcess({ readEnvFile: () => 'UMS_DB=pglite-memory\n' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toEqual({ code: 'env_overrides_file', name: 'UMS_DB' });
    expect(JSON.stringify(r)).not.toContain('canary-pw');
    expect(refusalLine(r.error)).not.toContain('canary-pw');
  });
  it('refuses a DATABASE_URL the file does not define, without printing it', () => {
    stubProcess({ DATABASE_URL: CANARY_URL });
    const r = loadConfigFromProcess({ readEnvFile: () => 'UMS_DB=pglite-memory\n' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toEqual({ code: 'env_overrides_file', name: 'DATABASE_URL' });
    expect(JSON.stringify(r)).not.toContain('canary-pw');
  });
  it('refuses in offline mode too (the rehearsal ran offline)', () => {
    stubProcess({ UMS_MODE: 'offline' });
    const r = loadConfigFromProcess({ readEnvFile: () => 'UMS_MODE=sandbox\n' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('env_overrides_file');
  });
  it('passes and loads when the process equals the file', () => {
    stubProcess({ UMS_DB: 'pglite-memory' });
    const r = loadConfigFromProcess({ readEnvFile: () => 'UMS_DB=pglite-memory\n' });
    expect(r.ok).toBe(true);
  });
  it('passes when the process holds no guarded value although the file has one', () => {
    stubProcess();
    const r = loadConfigFromProcess({
      readEnvFile: () => `UMS_DB=postgres\nDATABASE_URL=${FILE_URL}\n`,
    });
    expect(r.ok).toBe(true);
  });
  it('passes when there is no .env.local (the hosted app has none)', () => {
    stubProcess({ UMS_DB: 'pglite-memory', UMS_PUBLIC_ORIGIN: 'http://localhost:3000' });
    const r = loadConfigFromProcess({ readEnvFile: () => null });
    expect(r.ok).toBe(true);
  });
  it('reads the file named .env.local from the current folder', () => {
    stubProcess();
    const seen: string[] = [];
    loadConfigFromProcess({
      readEnvFile: (p) => {
        seen.push(p);
        return null;
      },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(`${process.cwd()}/.env.local`);
  });
  it('without options the default reader finds no .env.local in a folder that has none', () => {
    stubProcess({ UMS_DB: 'pglite-memory' });
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue('/nonexistent-folder-for-f8-test');
    try {
      expect(loadConfigFromProcess().ok).toBe(true);
    } finally {
      cwd.mockRestore();
    }
  });
  it('still returns the loadConfig refusal when the guard passes', () => {
    stubProcess({ UMS_MODE: 'live' });
    const r = loadConfigFromProcess({ readEnvFile: () => 'UMS_MODE=live\n' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('live_not_available');
  });
});

describe('bootOrExit with an env file', () => {
  it('exits 78 naming the variable and never a value', () => {
    const lines: string[] = [];
    const exit = vi.fn((code: number): never => {
      throw new Error(`exit ${code}`);
    });
    const env = {
      UMS_SESSION_SECRET: 'Qm7vK2pLx9RbT4zWc8NdYh3JfG6sAe1U',
      UMS_APPROVAL_SECRET: 'Zr5tB8nKd2VwXq7LmC4yHj9PgF3sEa6U',
      UMS_LINK_SECRET: 'Jd4wN7xQk2ZcR9vTb5LmY8hGp3FsAe6U',
      UMS_DB: 'postgres',
      DATABASE_URL: CANARY_URL,
    };
    expect(() =>
      bootOrExit(
        env,
        exit,
        (l) => lines.push(l),
        () => 'UMS_DB=pglite-memory\n',
      ),
    ).toThrow('exit 78');
    expect(exit).toHaveBeenCalledWith(BOOT_REFUSAL_EXIT_CODE);
    const out = lines.join('\n');
    expect(out).toContain('env_overrides_file');
    expect(out).toContain('UMS_DB');
    expect(out).toContain('env -u UMS_DB');
    expect(out).not.toContain('canary-pw');
  });
});
