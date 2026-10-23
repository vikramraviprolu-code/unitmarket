import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GIT_ALLOW_LIST, gitShowHead } from './git-head';

// FIX-MVPB-SEAL2 M1, hardened in SEAL3 M-B. The reader runs local git only (`git cat-file blob
// HEAD:<path>`): no remote, no network. These tests run it against this repository and against
// places git cannot answer, and check that nothing in the parent environment reaches the child.
const REPO = path.resolve(new URL('../../..', import.meta.url).pathname);
const LOG = path.join(REPO, 'docs/decision-log.md');
const HERE = fs
  .readFileSync(new URL('./git-head.ts', import.meta.url), 'utf8')
  .replace(/^\s*\/\/.*$/gm, ''); // code only, no comments
afterEach(() => vi.unstubAllEnvs());

describe('gitShowHead', () => {
  it('returns the committed text of a tracked file', () => {
    const text = gitShowHead(REPO, 'docs/decision-log.md');
    expect(typeof text).toBe('string');
    // The log is committed and these tests do not edit it, so HEAD and the working copy agree.
    expect(text).toBe(fs.readFileSync(LOG, 'utf8'));
  });
  it('returns null for a path that is not in HEAD', () => {
    expect(gitShowHead(REPO, 'docs/no-such-file-anywhere.md')).toBeNull();
  });
  it('returns null for a directory that is not a repository', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-head-'));
    try {
      expect(gitShowHead(dir, 'docs/decision-log.md')).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  it('runs only a git from the fixed allow-list, by absolute path', () => {
    expect(GIT_ALLOW_LIST).toEqual(['/usr/bin/git', '/usr/local/bin/git', '/opt/homebrew/bin/git']);
    // Candidates can only narrow the list: an unlisted path, a relative name and PATH lookup all fail.
    for (const bad of [['/nonexistent/git'], ['git'], ['/tmp/git'], [], ['./git']])
      expect(gitShowHead(REPO, 'docs/decision-log.md', bad), bad.join()).toBeNull();
  });
  it('refuses a path that could name something other than a file in the tree', () => {
    for (const bad of ['', '../x', '/etc/passwd', 'a:b', '-p', 'HEAD:docs/x', 'a\nb', '--help'])
      expect(gitShowHead(REPO, bad), bad).toBeNull();
  });
  it('ignores GIT_*, HOME, PATH and proxy variables of the parent process', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-head-'));
    try {
      for (const [k, v] of [
        ['GIT_DIR', dir],
        ['GIT_WORK_TREE', dir],
        ['GIT_OBJECT_DIRECTORY', dir],
        ['GIT_EXEC_PATH', dir],
        ['GIT_CONFIG_COUNT', '1'],
        ['GIT_CONFIG_KEY_0', 'core.pager'],
        ['GIT_CONFIG_VALUE_0', 'false'],
        ['HOME', dir],
        ['PATH', dir],
        ['HTTPS_PROXY', 'http://127.0.0.1:9'],
      ] as const)
        vi.stubEnv(k, v);
      expect(gitShowHead(REPO, 'docs/decision-log.md')).toBe(fs.readFileSync(LOG, 'utf8'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  it('the source hands the child exactly two variables and uses cat-file, not a PATH lookup', () => {
    expect(HERE).toContain("'cat-file', 'blob'");
    expect(HERE).toContain("env: { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }");
    expect(HERE).not.toMatch(/process\.env|\bPATH\b|\bHOME\b|\bshow\b/);
    expect(HERE).not.toMatch(/execFileSync\(\s*['"]git['"]/);
  });
});
