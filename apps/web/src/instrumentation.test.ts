// BU-2 / ASM-73: a boot failure in register() (a refused database, a refused configuration, a failed
// start) writes one line to stderr and exits with the boot-refusal code, so the host's restart policy
// fires and no zombie server answers 500 to every request. The access module is replaced by fakes.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const EXIT = 78; // sysexits EX_CONFIG, BOOT_REFUSAL_EXIT_CODE in packages/config

class DbInUseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DbInUseError';
  }
}

let stderr: string[];
let exits: number[];
beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('NEXT_RUNTIME', 'nodejs');
  stderr = [];
  exits = [];
  vi.spyOn(process.stderr, 'write').mockImplementation(((s: string | Uint8Array) => {
    stderr.push(String(s));
    return true;
  }) as never);
  vi.spyOn(process, 'exit').mockImplementation(((c?: number) => {
    exits.push(c ?? 0);
    return undefined as never;
  }) as never);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.doUnmock('./server/access');
});

async function registerWith(access: Record<string, unknown>): Promise<void> {
  vi.doMock('./server/access', () => ({ BOOT_REFUSAL_EXIT_CODE: EXIT, ...access }));
  const { register } = await import('./instrumentation');
  await register();
}

describe('register() boot failures', () => {
  it('a database that is in use: one stderr line naming the error, exit code 78', async () => {
    await registerWith({
      app: async () => {
        throw new DbInUseError(
          'database directory is in use; stop the other process or use the ops page Stop button',
        );
      },
    });
    expect(exits).toEqual([EXIT]);
    const text = stderr.join('');
    expect(text.split('\n').filter((l) => l !== '')).toHaveLength(1);
    expect(text.endsWith('\n')).toBe(true);
    expect(text).toContain('DbInUseError');
    expect(text).toContain('ops page Stop button');
  });

  it('a refusal while starting the jobs exits the same way', async () => {
    await registerWith({
      app: async () => ({
        startJobs: async () => {
          throw new Error('postgres is not wired');
        },
      }),
    });
    expect(exits).toEqual([EXIT]);
    expect(stderr.join('')).toContain('postgres is not wired');
  });

  it('a throw that is not an Error (a string, an object) still exits, with a fixed line', async () => {
    await registerWith({
      app: async () => {
        throw 'plain string failure';
      },
    });
    expect(exits).toEqual([EXIT]);
    expect(
      stderr
        .join('')
        .split('\n')
        .filter((l) => l !== ''),
    ).toHaveLength(1);
  });

  it('the line carries no URL, no userinfo and is cut short', async () => {
    await registerWith({
      app: async () => {
        throw new Error(
          `connect failed for ${['postgres', '://user:hunter2@db.internal:5432/app'].join('')} ${'x'.repeat(2000)}`,
        );
      },
    });
    const text = stderr.join('');
    expect(text).not.toContain('hunter2');
    expect(text).not.toContain('://');
    expect(text.length).toBeLessThan(600);
  });

  it('when the access module cannot even load, the process still exits with 78', async () => {
    vi.doMock('./server/access', () => {
      throw new Error('module graph broke');
    });
    const { register } = await import('./instrumentation');
    await register();
    expect(exits).toEqual([EXIT]);
  });

  it('a clean boot exits nothing and writes nothing', async () => {
    const stop = vi.fn(async () => undefined);
    await registerWith({ app: async () => ({ startJobs: async () => ({ stop }) }) });
    expect(exits).toEqual([]);
    expect(stderr).toEqual([]);
  });

  it('outside the node runtime nothing is imported and nothing exits', async () => {
    vi.stubEnv('NEXT_RUNTIME', 'edge');
    await registerWith({
      app: async () => {
        throw new Error('must not run');
      },
    });
    expect(exits).toEqual([]);
  });
});
