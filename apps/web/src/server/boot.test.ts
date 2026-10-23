// BU-2 / ASM-73: a boot failure writes one line to stderr and exits with the boot-refusal code, so the
// host's restart policy fires and no zombie server answers 500 to every request. Fakes only.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bootFailureLine, bootOrExit } from './boot';
import type { BootDeps } from './boot';

const EXIT = 78; // sysexits EX_CONFIG, BOOT_REFUSAL_EXIT_CODE in packages/config

class DbInUseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DbInUseError';
  }
}

function rig(start: BootDeps['start'], exitCode: BootDeps['exitCode'] = async () => EXIT) {
  const written: string[] = [];
  const exits: number[] = [];
  const deps: BootDeps = {
    start,
    exit: (c) => void exits.push(c),
    write: (l) => void written.push(l),
    exitCode,
  };
  return { deps, written, exits };
}

describe('bootOrExit', () => {
  it('a database that is in use: one stderr line naming the error, exit code 78', async () => {
    const r = rig(async () => {
      throw new DbInUseError(
        'database directory is in use; stop the other process or use the ops page Stop button',
      );
    });
    await bootOrExit(r.deps);
    expect(r.exits).toEqual([EXIT]);
    const text = r.written.join('');
    expect(text.split('\n').filter((l) => l !== '')).toHaveLength(1);
    expect(text.endsWith('\n')).toBe(true);
    expect(text).toContain('DbInUseError');
    expect(text).toContain('ops page Stop button');
  });

  it('a refusal while starting the jobs exits the same way', async () => {
    const r = rig(async () => {
      throw new Error('postgres is not wired');
    });
    await bootOrExit(r.deps);
    expect(r.exits).toEqual([EXIT]);
    expect(r.written.join('')).toContain('postgres is not wired');
  });

  it('a throw that is not an Error (a string, an object) still exits, with one line', async () => {
    for (const thrown of ['plain string failure', { code: 1 }, null, undefined]) {
      const r = rig(async () => {
        throw thrown;
      });
      await bootOrExit(r.deps);
      expect(r.exits).toEqual([EXIT]);
      expect(
        r.written
          .join('')
          .split('\n')
          .filter((l) => l !== ''),
      ).toHaveLength(1);
    }
  });

  it('the line carries no URL, no userinfo and is cut short', async () => {
    const r = rig(async () => {
      throw new Error(
        `connect failed for ${['postgres', '://user:hunter2@db.internal:5432/app'].join('')} ${'x'.repeat(2000)}`,
      );
    });
    await bootOrExit(r.deps);
    const text = r.written.join('');
    expect(text).not.toContain('hunter2');
    expect(text).not.toContain('://');
    expect(text.length).toBeLessThan(600);
    expect(bootFailureLine(new Error('a\nb\n\nc'))).not.toMatch(/a\nb/);
  });

  it('when the module holding the exit code cannot load, the process still exits with 78', async () => {
    const r = rig(
      async () => {
        throw new Error('module graph broke');
      },
      async () => {
        throw new Error('cannot load');
      },
    );
    await bootOrExit(r.deps);
    expect(r.exits).toEqual([EXIT]);
  });

  it('a clean boot exits nothing and writes nothing', async () => {
    const r = rig(async () => undefined);
    await bootOrExit(r.deps);
    expect(r.exits).toEqual([]);
    expect(r.written).toEqual([]);
  });
});

describe('instrumentation.ts wiring', () => {
  const src = readFileSync(join(import.meta.dirname, '../instrumentation.ts'), 'utf8');
  it('hands the boot to bootOrExit with process.exit and stderr, only in the node runtime', () => {
    expect(src).toContain("process.env['NEXT_RUNTIME'] !== 'nodejs'");
    expect(src).toContain('bootOrExit(');
    expect(src).toContain('process.exit(code)');
    expect(src).toContain('process.stderr.write(line)');
    expect(src).toContain('BOOT_REFUSAL_EXIT_CODE');
  });
});
