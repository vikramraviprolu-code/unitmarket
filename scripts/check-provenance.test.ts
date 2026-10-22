// Review M6: scripts/check-provenance.mjs. Every file carrying an Origin or Adapted-from header
// must be listed in docs/PROVENANCE.md, with a commit sha, and the list must name no missing file.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from './test-helpers';

const SCRIPT = join(REPO_ROOT, 'scripts', 'check-provenance.mjs');
const SIM = 'AIC_Hackathon_' + 'UnitMarket';
const HEADER = `// Origin: ${SIM}@a36ddc03fd0b962000f686291c145b50ee337f90:packages/x/y.ts. Adapted; owned by SBX.\n`;
const run = (root: string, ...args: string[]) => {
  const r = spawnSync(process.execPath, [SCRIPT, '--root', root, ...args], { encoding: 'utf8' });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
};
function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'prov-'));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  return root;
}
const DOC = (listed: string[]) =>
  `# Provenance\n\n<!-- provenance:begin -->\n${listed.map((f) => `- \`${f}\``).join('\n')}\n<!-- provenance:end -->\n`;

describe('check-provenance', () => {
  it('passes when every headered file is listed', () => {
    const root = tree({
      'packages/x/src/a.ts': `${HEADER}export const a = 1;\n`,
      'docs/PROVENANCE.md': DOC(['packages/x/src/a.ts']),
    });
    const r = run(root);
    expect(r.out).toContain('check-provenance: ok');
    expect(r.status).toBe(0);
  });
  it('fails on a headered file that is not listed', () => {
    const root = tree({
      'packages/x/src/a.ts': `${HEADER}export const a = 1;\n`,
      'docs/PROVENANCE.md': DOC([]),
    });
    const r = run(root);
    expect(r.status).toBe(1);
    expect(r.out).toContain('packages/x/src/a.ts');
    expect(r.out).toMatch(/not listed/);
  });
  it('fails on a listed file that does not exist', () => {
    const root = tree({ 'docs/PROVENANCE.md': DOC(['packages/x/src/gone.ts']) });
    const r = run(root);
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/missing/);
  });
  it('fails on a header without a commit sha', () => {
    const root = tree({
      'packages/x/src/a.ts': `// Adapted from ${SIM}/packages/x/y.ts\nexport const a = 1;\n`,
      'docs/PROVENANCE.md': DOC(['packages/x/src/a.ts']),
    });
    const r = run(root);
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/sha/);
  });
  it('accepts the "Adapted from <path> at <sha>" form', () => {
    const root = tree({
      'packages/x/src/a.mjs': `// Adapted from ${SIM}/scripts/y.mjs at a36ddc0\nexport const a = 1;\n`,
      'docs/PROVENANCE.md': DOC(['packages/x/src/a.mjs']),
    });
    expect(run(root).status).toBe(0);
  });
  it('a header deep in the file or in a string is not a header', () => {
    const body = `${'// filler\n'.repeat(40)}${HEADER}export const s = 'Origin: ${SIM}@a36ddc0:x';\n`;
    const root = tree({ 'packages/x/src/a.ts': body, 'docs/PROVENANCE.md': DOC([]) });
    expect(run(root).status).toBe(0);
  });
  it('--write regenerates the list', () => {
    const root = tree({
      'packages/x/src/a.ts': `${HEADER}export const a = 1;\n`,
      'docs/PROVENANCE.md': '# Provenance\n\nHand written text.\n',
    });
    expect(run(root, '--write').status).toBe(0);
    const doc = readFileSync(join(root, 'docs/PROVENANCE.md'), 'utf8');
    expect(doc).toContain('Hand written text.');
    expect(doc).toContain('`packages/x/src/a.ts`');
    expect(run(root).status).toBe(0);
  });
  it('passes on the repository as it stands', () => {
    const r = run(REPO_ROOT);
    expect(r.out).toContain('check-provenance: ok');
    expect(r.status).toBe(0);
  });
});
