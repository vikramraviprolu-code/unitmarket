// Reads one committed file with local git: `git cat-file blob HEAD:<path>`. Used by the spike kit's
// preflight (FIX-MVPB-SEAL2 M1, hardened in SEAL3 M-B) to prove docs/decision-log.md equals its
// committed copy. Local git only: no fetch, no remote, no network. It is its own small file so that
// spike.ts itself imports no process-spawning module; spike.ts loads it only for a real run.
//
// The git binary is an ABSOLUTE path from a fixed allow-list (never looked up on PATH), and the
// child gets exactly three variables: GIT_CONFIG_NOSYSTEM=1, GIT_CONFIG_GLOBAL=/dev/null and
// GIT_NO_REPLACE_OBJECTS=1 (with --no-replace-objects: a replace ref cannot swap the committed blob). No PATH,
// no HOME, nothing inherited, so GIT_DIR, GIT_WORK_TREE, GIT_OBJECT_DIRECTORY, GIT_EXEC_PATH, config
// includes and proxy variables cannot redirect it.
//
// NOT a proof of owner approval: a commit in this clone is only "committed locally". Whether to also
// require the commit to be on origin/main or signed is an open owner decision (docs/READINESS.md).
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

export const GIT_ALLOW_LIST: readonly string[] = [
  '/usr/bin/git',
  '/usr/local/bin/git',
  '/opt/homebrew/bin/git',
];
const SAFE_PATH = /^[A-Za-z0-9._][A-Za-z0-9._/-]*$/;

/**
 * The committed text of `relPath` at HEAD, or null when git cannot answer for any reason (no
 * allow-listed git, not a repository, path not in HEAD, a path that could name something else).
 * `candidates` can only NARROW the allow-list (tests); a path outside it is never run.
 */
export function gitShowHead(
  repoRoot: string,
  relPath: string,
  candidates: readonly string[] = GIT_ALLOW_LIST,
): string | null {
  if (!SAFE_PATH.test(relPath) || relPath.split('/').includes('..')) return null;
  const git = GIT_ALLOW_LIST.filter((p) => candidates.includes(p)).find((p) => existsSync(p));
  if (git === undefined) return null;
  try {
    return execFileSync(
      git,
      ['--no-replace-objects', '-C', repoRoot, 'cat-file', 'blob', `HEAD:${relPath}`],
      {
        encoding: 'utf8',
        env: {
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_NO_REPLACE_OBJECTS: '1',
        },
        stdio: ['ignore', 'pipe', 'ignore'],
        maxBuffer: 4 * 1024 * 1024,
        timeout: 10_000,
        windowsHide: true,
      },
    );
  } catch {
    return null;
  }
}
