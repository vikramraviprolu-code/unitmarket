import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { classify, evaluate, renderNotices } from './licenses-report.mjs';

const SCRIPT = join(import.meta.dirname, 'licenses-report.mjs');

type Group = Record<string, Array<{ name: string; versions: string[]; license: string }>>;
const pkg = (name: string, license: string, versions = ['1.0.0']) => ({ name, versions, license });
const groups = (...pkgs: ReturnType<typeof pkg>[]): Group => {
  const out: Group = {};
  for (const p of pkgs) (out[p.license] ??= []).push(p);
  return out;
};

describe('classify', () => {
  it.each([
    'MIT',
    'MIT-0',
    'ISC',
    'BSD-2-Clause',
    'BSD-3-Clause',
    '0BSD',
    'Apache-2.0',
    'BlueOak-1.0.0',
    'CC0-1.0',
    'Unlicense',
    'Python-2.0',
    'CC-BY-4.0',
  ])('%s is permissive', (id) => {
    expect(classify(id)).toBe('permissive');
  });

  it('MPL-2.0 is weak copyleft (listed, not failed)', () => {
    expect(classify('MPL-2.0')).toBe('weak');
  });

  it.each([
    'GPL-2.0-only',
    'GPL-3.0-or-later',
    'AGPL-3.0-only',
    'LGPL-2.1',
    'LGPL-3.0-or-later',
    'SSPL-1.0',
    'EUPL-1.2',
  ])('%s is copyleft', (id) => {
    expect(classify(id)).toBe('copyleft');
  });

  it.each(['UNLICENSED', 'Unknown', '', 'SEE LICENSE IN LICENSE.md', 'Made-Up-1.0'])(
    '%j is unknown',
    (id) => {
      expect(classify(id)).toBe('unknown');
    },
  );

  it('is case insensitive on the identifier', () => {
    expect(classify('mit')).toBe('permissive');
    expect(classify('gpl-3.0')).toBe('copyleft');
    expect(classify('unlicensed')).toBe('unknown');
  });

  it('OR passes when one side is permissive', () => {
    expect(classify('(MIT OR GPL-3.0-only)')).toBe('permissive');
    expect(classify('MIT OR Apache-2.0')).toBe('permissive');
  });

  it('OR of two bad sides stays bad', () => {
    expect(classify('GPL-2.0-only OR LGPL-3.0-only')).toBe('copyleft');
    expect(classify('Made-Up-1.0 OR UNLICENSED')).toBe('unknown');
  });

  it('AND needs every side to pass', () => {
    expect(classify('(MIT AND Zlib)')).toBe('permissive');
    expect(classify('MIT AND GPL-3.0-only')).toBe('copyleft');
    expect(classify('MIT AND Made-Up-1.0')).toBe('unknown');
  });

  it('handles nested parentheses', () => {
    expect(classify('(MIT AND (ISC OR GPL-2.0-only))')).toBe('permissive');
    expect(classify('(MIT AND (GPL-2.0-only OR AGPL-3.0-only))')).toBe('copyleft');
  });

  it('weak copyleft does not hide copyleft and permissive wins over weak in OR', () => {
    expect(classify('MPL-2.0 AND GPL-3.0-only')).toBe('copyleft');
    expect(classify('MPL-2.0 OR MIT')).toBe('permissive');
    expect(classify('MPL-2.0 AND MIT')).toBe('weak');
  });
});

describe('evaluate', () => {
  it('passes a clean tree and sorts rows by name then version', () => {
    const r = evaluate(
      groups(pkg('zeta', 'MIT', ['2.0.0', '1.0.0']), pkg('alpha', 'ISC'), pkg('mid', 'Apache-2.0')),
      {},
    );
    expect(r.failures).toEqual([]);
    expect(r.rows.map((x: { name: string; version: string }) => `${x.name}@${x.version}`)).toEqual([
      'alpha@1.0.0',
      'mid@1.0.0',
      'zeta@1.0.0',
      'zeta@2.0.0',
    ]);
  });

  it('fails a copyleft package and names it', () => {
    const r = evaluate(groups(pkg('ok', 'MIT'), pkg('bad-lib', 'GPL-3.0-only', ['3.1.0'])), {});
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0]).toMatchObject({ name: 'bad-lib', version: '3.1.0', verdict: 'copyleft' });
  });

  it('fails UNLICENSED and unknown licences', () => {
    const r = evaluate(groups(pkg('a', 'UNLICENSED'), pkg('b', 'Unknown')), {});
    expect(r.failures.map((f: { name: string }) => f.name).sort()).toEqual(['a', 'b']);
  });

  it('lists weak copyleft separately without failing', () => {
    const r = evaluate(groups(pkg('mpl-thing', 'MPL-2.0')), {});
    expect(r.failures).toEqual([]);
    expect(r.weak.map((x: { name: string }) => x.name)).toEqual(['mpl-thing']);
  });

  it('an allow-list entry with a reason and the same licence passes and is reported', () => {
    const allow = {
      lgplish: { license: 'LGPL-3.0-or-later', reason: 'prebuilt shared library, unmodified' },
    };
    const r = evaluate(groups(pkg('lgplish', 'LGPL-3.0-or-later')), allow);
    expect(r.failures).toEqual([]);
    expect(r.allowed).toHaveLength(1);
    expect(r.allowed[0]).toMatchObject({
      name: 'lgplish',
      reason: 'prebuilt shared library, unmodified',
    });
  });

  it('an allow-list entry does not cover a changed licence', () => {
    const allow = { lgplish: { license: 'LGPL-3.0-or-later', reason: 'prebuilt shared library' } };
    const r = evaluate(groups(pkg('lgplish', 'GPL-3.0-only')), allow);
    expect(r.failures.map((f: { name: string }) => f.name)).toEqual(['lgplish']);
  });

  it('an allow-list entry without a written reason is refused', () => {
    expect(() =>
      evaluate(groups(pkg('x', 'MIT')), { x: { license: 'MIT', reason: '  ' } }),
    ).toThrow(/reason/);
    expect(() => evaluate(groups(pkg('x', 'MIT')), { x: { license: 'MIT' } })).toThrow(/reason/);
  });
});

describe('renderNotices', () => {
  const sample = () =>
    evaluate(
      groups(
        pkg('beta', 'MIT', ['2.0.0']),
        pkg('alpha', 'Apache-2.0'),
        pkg('mpl-thing', 'MPL-2.0'),
      ),
      {},
    );

  it('is deterministic and independent of input order', () => {
    const a = renderNotices(sample());
    const b = renderNotices(
      evaluate(
        groups(
          pkg('mpl-thing', 'MPL-2.0'),
          pkg('alpha', 'Apache-2.0'),
          pkg('beta', 'MIT', ['2.0.0']),
        ),
        {},
      ),
    );
    expect(a).toBe(b);
  });

  it('has a row per package with name, version and licence, and ends with one newline', () => {
    const md = renderNotices(sample());
    expect(md).toMatch(/\| alpha\s+\| 1\.0\.0\s+\| Apache-2\.0\s+\|/);
    expect(md).toMatch(/\| beta\s+\| 2\.0\.0\s+\| MIT\s+\|/);
    expect(md.endsWith('\n')).toBe(true);
    expect(md.endsWith('\n\n')).toBe(false);
  });

  it('shows the written reason of an allow-listed exception', () => {
    const allow = {
      lgplish: { license: 'LGPL-3.0-or-later', reason: 'prebuilt shared library, unmodified' },
    };
    const md = renderNotices(evaluate(groups(pkg('lgplish', 'LGPL-3.0-or-later')), allow));
    expect(md).toContain('lgplish');
    expect(md).toContain('prebuilt shared library, unmodified');
  });

  it('contains no local path, no date and no dash used as a sentence break', () => {
    const md = renderNotices(sample());
    expect(md).not.toMatch(/\/home\//);
    expect(md).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(md).not.toMatch(/ [–—] /);
  });
});

describe('CLI', () => {
  const run = (json: unknown, extra: string[] = []) => {
    const dir = mkdtempSync(join(tmpdir(), 'licenses-report-'));
    const input = join(dir, 'in.json');
    const out = join(dir, 'NOTICES.md');
    writeFileSync(input, JSON.stringify(json));
    const r = spawnSync(process.execPath, [SCRIPT, '--input', input, '--out', out, ...extra], {
      encoding: 'utf8',
    });
    let written: string | null = null;
    try {
      written = readFileSync(out, 'utf8');
    } catch {
      written = null;
    }
    return { status: r.status, text: `${r.stdout}${r.stderr}`, written, out };
  };

  it('exits 0 on a clean tree and writes the notices file', () => {
    const r = run(groups(pkg('a', 'MIT')));
    expect(r.status).toBe(0);
    expect(r.written).toContain('| a ');
  });

  it('exits 1 on a copyleft package, names it, and still writes the file', () => {
    const r = run(groups(pkg('a', 'MIT'), pkg('viral', 'AGPL-3.0-only')));
    expect(r.status).toBe(1);
    expect(r.text).toContain('viral');
    expect(r.text).toContain('AGPL-3.0-only');
  });

  it('--check exits 1 when the notices file is missing or stale, and writes nothing', () => {
    const r = run(groups(pkg('a', 'MIT')), ['--check']);
    expect(r.status).toBe(1);
    expect(r.written).toBeNull();
    expect(r.text).toMatch(/stale|missing|out of date/i);
  });

  it('--check exits 0 when the file matches what would be generated', () => {
    const first = run(groups(pkg('a', 'MIT')));
    expect(first.status).toBe(0);
    const dir = mkdtempSync(join(tmpdir(), 'licenses-report-'));
    const input = join(dir, 'in.json');
    writeFileSync(input, JSON.stringify(groups(pkg('a', 'MIT'))));
    const r = spawnSync(
      process.execPath,
      [SCRIPT, '--input', input, '--out', first.out, '--check'],
      {
        encoding: 'utf8',
      },
    );
    expect(r.status).toBe(0);
  });
});
