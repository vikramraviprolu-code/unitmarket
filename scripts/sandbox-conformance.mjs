// pnpm sandbox:conformance (BU-6): the ONLY way to run the owner-run sandbox subset. For the owner,
// at a terminal, on their own machine (ASM-40). Nobody else runs it, and no agent ever does.
//
// It refuses unless stdin and stderr are terminals, no CI marker and no AI-session marker is set,
// and UMS_SANDBOX_TESTS=1. Then, in THIS plain node process (no vitest, because a vitest worker
// always carries --require and --conditions, which the transport guard refuses on purpose):
//   config (packages/config, the guard unchanged) -> the owner's database folder -> the app's own
//   outbound builder (production Wire, real scoped gate) -> the sandbox subject -> the owner subset.
// With any of the five locks missing the first call is answered blocked and the suite stops there,
// before any Wire call. It writes ~/unitmarket-sandbox-run/<utc date>/calls.json (redacted, the input
// of `pnpm record:fixtures`) and summary.md (ids cut to their last 6 characters), never inside the
// repository, and never a credential.
//
// Environment: this file reads process.env for UMS_SANDBOX_TESTS and the CI and AI marker names ONLY
// (pinned by scripts/sandbox-conformance-env.test.ts). Everything else, credentials included, is read by
// packages/config alone.
//
// Exit codes: 0 every selected case passed, 1 a case failed or the suite stopped, 2 refused,
// 78 the config refused to boot.
//   node --env-file-if-exists=.env.local scripts/sandbox-conformance.mjs [--only payee-echo]
import { resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { registerTs } from './lib/register-ts.mjs';

export const CI_MARKERS = [
  'CI',
  'GITHUB_ACTIONS',
  'GITLAB_CI',
  'BUILDKITE',
  'CIRCLECI',
  'TRAVIS',
  'JENKINS_URL',
  'TF_BUILD',
  'TEAMCITY_VERSION',
  'APPVEYOR',
  'DRONE',
  'CODEBUILD_BUILD_ID',
  'BITBUCKET_BUILD_NUMBER',
  'RENDER',
];
export const AI_MARKERS = ['CLAUDECODE', 'CLAUDE_CODE_REMOTE'];

const set = (v) => v !== undefined && v !== '';

/** The only environment this file reads. One static access per name; see the pin test. */
export function markerEnv() {
  return {
    UMS_SANDBOX_TESTS: process.env.UMS_SANDBOX_TESTS,
    CI: process.env.CI,
    GITHUB_ACTIONS: process.env.GITHUB_ACTIONS,
    GITLAB_CI: process.env.GITLAB_CI,
    BUILDKITE: process.env.BUILDKITE,
    CIRCLECI: process.env.CIRCLECI,
    TRAVIS: process.env.TRAVIS,
    JENKINS_URL: process.env.JENKINS_URL,
    TF_BUILD: process.env.TF_BUILD,
    TEAMCITY_VERSION: process.env.TEAMCITY_VERSION,
    APPVEYOR: process.env.APPVEYOR,
    DRONE: process.env.DRONE,
    CODEBUILD_BUILD_ID: process.env.CODEBUILD_BUILD_ID,
    BITBUCKET_BUILD_NUMBER: process.env.BITBUCKET_BUILD_NUMBER,
    RENDER: process.env.RENDER,
    CLAUDECODE: process.env.CLAUDECODE,
    CLAUDE_CODE_REMOTE: process.env.CLAUDE_CODE_REMOTE,
  };
}

const HELP = {
  not_a_tty: 'stdin and stderr must both be a terminal: run this yourself, in your own terminal',
  ci_set: 'a CI marker is set: this suite never runs in CI',
  ai_session: 'an AI-session marker is set: this suite is owner-run, an assistant never runs it',
  flag_missing: 'set UMS_SANDBOX_TESTS=1 (exactly 1) to confirm you mean to call the sandbox',
  output_in_repo:
    'the output folder would be inside the repository; run with your real home folder',
  bad_args: 'the only argument is: --only payee-echo',
};

/**
 * @param {{
 *   stdinIsTTY: boolean, stderrIsTTY: boolean,
 *   env: Record<string, string | undefined>,
 *   argv: string[], homedir: string, repoRoot: string,
 *   say: (line: string) => void, err: (line: string) => void,
 *   run?: (ctx: { outBase: string, only: 'payee-echo' | undefined }) => Promise<number>,
 * }} d
 * @returns {Promise<{ code: number, reason?: string }>}
 */
export async function runSandboxConformance(d) {
  const refuse = (reason) => {
    d.err(`sandbox:conformance refused: ${reason} (${HELP[reason]})`);
    return { code: 2, reason };
  };
  if (!d.stdinIsTTY || !d.stderrIsTTY) return refuse('not_a_tty');
  if (CI_MARKERS.some((n) => set(d.env[n]))) return refuse('ci_set');
  if (AI_MARKERS.some((n) => set(d.env[n]))) return refuse('ai_session');
  if (d.env.UMS_SANDBOX_TESTS !== '1') return refuse('flag_missing');
  let only;
  if (d.argv.length === 2 && d.argv[0] === '--only' && d.argv[1] === 'payee-echo')
    only = 'payee-echo';
  else if (d.argv.length !== 0) return refuse('bad_args');
  const outBase = resolve(d.homedir, 'unitmarket-sandbox-run');
  const repo = resolve(d.repoRoot);
  if (outBase === repo || outBase.startsWith(repo + sep)) return refuse('output_in_repo');
  const run = d.run ?? ((ctx) => realRun(d, ctx));
  return { code: await run({ outBase, only }) };
}

async function realRun(d, ctx) {
  // The TypeScript hooks go in first, in this process (no --import flag, see scripts/lib/register-ts.mjs);
  // the body has static imports of the workspace sources.
  registerTs();
  const { runOwnerSuite } = await import('./lib/sandbox-conformance-run.mjs');
  return runOwnerSuite(d, ctx);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const r = await runSandboxConformance({
    stdinIsTTY: process.stdin.isTTY === true,
    stderrIsTTY: process.stderr.isTTY === true,
    env: markerEnv(),
    argv: process.argv.slice(2),
    homedir: (await import('node:os')).homedir(),
    repoRoot: resolve(import.meta.dirname, '..'),
    say: (l) => process.stdout.write(`${l}\n`),
    err: (l) => process.stderr.write(`${l}\n`),
  });
  process.exit(r.code);
}
