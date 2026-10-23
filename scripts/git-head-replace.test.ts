// SEAL5 item e. Behavioural proof for tools/spike-kit/src/git-head.ts against a real scratch
// repository: a `git replace` ref on the committed blob, or on the commit itself, makes a plain
// `git cat-file` print forged content, and the reader must still return what was committed.
// Lives under scripts/ because only the guard scripts and their tests may spawn processes (S2); the
// scratch repository is created in the OS temp directory and never touches the network.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GIT_ALLOW_LIST, gitShowHead } from '../tools/spike-kit/src/git-head';

const GIT = GIT_ALLOW_LIST.find((p) => existsSync(p));
const REL = 'docs/decision-log.md';
const COMMITTED = '| D-001 | committed text |\n';
const FORGED = '| D-001 | forged text |\n| SPIKE GO | forged approval |\n';

let dir: string;
const git = (...args: string[]): string =>
  execFileSync(GIT as string, ['-C', dir, ...args], {
    encoding: 'utf8',
    env: {
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 'scratch',
      GIT_AUTHOR_EMAIL: 'scratch@example.invalid',
      GIT_COMMITTER_NAME: 'scratch',
      GIT_COMMITTER_EMAIL: 'scratch@example.invalid',
      GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
      GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
    },
    input: '',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'git-head-replace-'));
  git('init', '-q', '-b', 'main');
  mkdirSync(join(dir, 'docs'));
  writeFileSync(join(dir, REL), COMMITTED);
  git('add', REL);
  git('commit', '-q', '-m', 'committed');
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe.skipIf(GIT === undefined)(
  'gitShowHead against a scratch repository with replace refs',
  () => {
    it('returns the committed text when nothing is replaced', () => {
      expect(gitShowHead(dir, REL)).toBe(COMMITTED);
    });

    it('a replace ref on the blob: plain git prints the forged blob, the reader still returns the committed one', () => {
      const real = git('rev-parse', `HEAD:${REL}`);
      git('replace', real, hashText(FORGED));
      try {
        // precondition: the replace ref is live, so a naive reader would be fooled
        expect(git('cat-file', 'blob', `HEAD:${REL}`) + '\n').toBe(FORGED);
        expect(gitShowHead(dir, REL)).toBe(COMMITTED);
      } finally {
        git('replace', '-d', real);
      }
      expect(gitShowHead(dir, REL)).toBe(COMMITTED);
    });

    it('a replace ref on the commit: plain git prints the forged tree, the reader still returns the committed one', () => {
      const head = git('rev-parse', 'HEAD');
      const forgedCommit = git('commit-tree', forgedTree(hashText(FORGED)), '-m', 'forged');
      git('replace', head, forgedCommit);
      try {
        expect(git('cat-file', 'blob', `HEAD:${REL}`) + '\n').toBe(FORGED);
        expect(gitShowHead(dir, REL)).toBe(COMMITTED);
      } finally {
        git('replace', '-d', head);
      }
      expect(gitShowHead(dir, REL)).toBe(COMMITTED);
    });

    it('a replace ref on the tree is also ignored', () => {
      const tree = git('rev-parse', 'HEAD^{tree}');
      git('replace', tree, forgedTree(hashText(FORGED)));
      try {
        expect(git('cat-file', 'blob', `HEAD:${REL}`) + '\n').toBe(FORGED);
        expect(gitShowHead(dir, REL)).toBe(COMMITTED);
      } finally {
        git('replace', '-d', tree);
      }
    });
  },
);

function hashText(text: string): string {
  const f = join(dir, 'tmp-forged.txt');
  writeFileSync(f, text);
  try {
    return git('hash-object', '-w', f);
  } finally {
    rmSync(f, { force: true });
  }
}
/** A tree holding docs/decision-log.md = the given blob (built with a throwaway index). */
function forgedTree(blob: string): string {
  const idx = join(dir, '.git', 'forged-index');
  const run = (...a: string[]) =>
    execFileSync(GIT as string, ['-C', dir, ...a], {
      encoding: 'utf8',
      env: {
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_INDEX_FILE: idx,
      },
      input: '',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  run('update-index', '--add', '--cacheinfo', `100644,${blob},${REL}`);
  const tree = run('write-tree');
  rmSync(idx, { force: true });
  return tree;
}
