import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { gitShowHead } from './git-head';

// FIX-MVPB-SEAL2 M1. The reader runs local git only (`git show HEAD:<path>`): no remote, no
// network. These tests run it against this repository and against places git cannot answer.
const REPO = path.resolve(new URL('../../..', import.meta.url).pathname);
const ENV = { PATH: '/usr/local/bin:/usr/bin:/bin' };

describe('gitShowHead', () => {
  it('returns the committed text of a tracked file', () => {
    const text = gitShowHead(REPO, 'docs/decision-log.md', ENV);
    expect(typeof text).toBe('string');
    // The log is committed and these tests do not edit it, so HEAD and the working copy agree.
    expect(text).toBe(fs.readFileSync(path.join(REPO, 'docs/decision-log.md'), 'utf8'));
  });
  it('returns null for a path that is not in HEAD', () => {
    expect(gitShowHead(REPO, 'docs/no-such-file-anywhere.md', ENV)).toBeNull();
  });
  it('returns null for a directory that is not a repository', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-head-'));
    try {
      expect(gitShowHead(dir, 'docs/decision-log.md', ENV)).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  it('returns null when git is not on the path', () => {
    expect(gitShowHead(REPO, 'docs/decision-log.md', { PATH: '/nonexistent' })).toBeNull();
  });
  it('refuses a path that could name something other than a file in the tree', () => {
    for (const bad of ['', '../x', '/etc/passwd', 'a:b', '-p', 'HEAD:docs/x', 'a\nb', '--help'])
      expect(gitShowHead(REPO, bad, ENV), bad).toBeNull();
  });
  it('ignores GIT_* variables that could redirect it to another repository', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-head-'));
    try {
      const text = gitShowHead(REPO, 'docs/decision-log.md', {
        ...ENV,
        GIT_DIR: dir,
        GIT_WORK_TREE: dir,
        GIT_OBJECT_DIRECTORY: dir,
      });
      expect(text).toBe(fs.readFileSync(path.join(REPO, 'docs/decision-log.md'), 'utf8'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
