// Reads one committed file with local git: `git -C <repo> show HEAD:<path>`. Used by the spike
// kit's preflight (FIX-MVPB-SEAL2 M1) to prove docs/decision-log.md equals its committed copy.
// Local git only: no fetch, no remote, no network. It is its own small file so that spike.ts
// itself imports no process-spawning module; spike.ts loads it only for a real run.
//
// The child gets a minimal environment (PATH, plus HOME and SystemRoot when set) so GIT_DIR,
// GIT_WORK_TREE, GIT_OBJECT_DIRECTORY, GIT_CONFIG_* and proxy variables cannot redirect it.
import { execFileSync } from 'node:child_process';

const SAFE_PATH = /^[A-Za-z0-9._][A-Za-z0-9._/-]*$/;

/** The committed text of `relPath` at HEAD, or null when git cannot answer for any reason. */
export function gitShowHead(
  repoRoot: string,
  relPath: string,
  env: Record<string, string | undefined>,
): string | null {
  if (!SAFE_PATH.test(relPath) || relPath.split('/').includes('..')) return null;
  const childEnv: Record<string, string> = { GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' };
  for (const k of ['PATH', 'HOME', 'SystemRoot', 'USERPROFILE']) {
    const v = env[k];
    if (typeof v === 'string' && v !== '') childEnv[k] = v;
  }
  try {
    return execFileSync('git', ['-C', repoRoot, 'show', `HEAD:${relPath}`], {
      encoding: 'utf8',
      env: childEnv,
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 4 * 1024 * 1024,
      timeout: 10_000,
      windowsHide: true,
    });
  } catch {
    return null;
  }
}
