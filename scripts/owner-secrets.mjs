// pnpm owner:secrets (BU-6). For the owner, at a terminal, on their own machine. Prints four
// NAME=value lines to paste into .env.local:
//   UMS_SESSION_SECRET, UMS_APPROVAL_SECRET, UMS_LINK_SECRET   32 random bytes each (base64url)
//   UMS_DEMO_PASSCODE_HASH                                     scrypt hash of a passcode typed twice
// It writes no file, reads no environment value other than the CI and AI markers (the runner's lists), and prints the
// passcode never. It refuses without a terminal, in CI and in an AI session, before it asks anything.
//
// A plain node process: the TypeScript hooks are registered in-process, so no --import flag appears
// in process.execArgv (see scripts/lib/register-ts.mjs).
import { pathToFileURL } from 'node:url';
// The same marker lists, and the same reader of those names, as the runner: one list to keep right.
import { AI_MARKERS, CI_MARKERS, markerEnv } from './sandbox-conformance.mjs';

export const MIN_PASSCODE_LENGTH = 12;
const set = (v) => v !== undefined && v !== '';

async function loadLibs() {
  const { hashPasscode } = await import('../packages/security/src/index.ts');
  const { cryptoIds } = await import('../packages/runtime/src/index.ts');
  return { hashPasscode, ids: cryptoIds() };
}

/** 32 random bytes as 43 base64url characters: two 128-bit nonces from the runtime package. */
const secret32 = (ids) => Buffer.from(ids.nonce() + ids.nonce(), 'hex').toString('base64url');

/**
 * @param {{
 *   stdinIsTTY: boolean, stderrIsTTY: boolean,
 *   env: Record<string, string | undefined>,
 *   askHidden: (prompt: string) => Promise<string>,
 *   write: (line: string) => void,
 *   note?: (line: string) => void,
 *   libs?: { hashPasscode: (plain: string, salt_hex: string) => Promise<string>, ids: { nonce(): string } },
 * }} d
 * @returns {Promise<{ ok: true } | { ok: false, code: string }>}
 */
export async function runOwnerSecrets(d) {
  if (!d.stdinIsTTY || !d.stderrIsTTY) return { ok: false, code: 'not_a_tty' };
  if (CI_MARKERS.some((n) => set(d.env[n]))) return { ok: false, code: 'ci_set' };
  if (AI_MARKERS.some((n) => set(d.env[n]))) return { ok: false, code: 'ai_session' };
  const note = d.note ?? (() => undefined);
  const first = await d.askHidden(
    'Demo passcode (at least 12 characters, you will type it to sign in): ',
  );
  const second = await d.askHidden('Type it again: ');
  if (first !== second) return { ok: false, code: 'passcode_mismatch' };
  if (first.length < MIN_PASSCODE_LENGTH) return { ok: false, code: 'passcode_too_short' };
  const libs = d.libs ?? (await loadLibs());
  const hash = await libs.hashPasscode(first, libs.ids.nonce());
  note('Paste these four lines into .env.local. Nothing was written to disk.');
  d.write(`UMS_SESSION_SECRET=${secret32(libs.ids)}`);
  d.write(`UMS_APPROVAL_SECRET=${secret32(libs.ids)}`);
  d.write(`UMS_LINK_SECRET=${secret32(libs.ids)}`);
  d.write(`UMS_DEMO_PASSCODE_HASH=${hash}`);
  return { ok: true };
}

/**
 * Asks with the typed text hidden: the prompt and a final newline reach `io.output`, the answer never does.
 * @param {string} prompt
 * @param {{ input: NodeJS.ReadableStream, output: NodeJS.WritableStream }} [io]
 */
export async function askHiddenOnTerminal(
  prompt,
  io = { input: process.stdin, output: process.stderr },
) {
  const { createInterface } = await import('node:readline');
  const { Writable } = await import('node:stream');
  let muted = false;
  const out = new Writable({
    write(chunk, _enc, cb) {
      if (!muted) io.output.write(chunk);
      cb();
    },
  });
  const rl = createInterface({ input: io.input, output: out, terminal: true });
  io.output.write(prompt);
  muted = true;
  try {
    return await new Promise((resolve) => rl.question('', resolve));
  } finally {
    muted = false;
    rl.close();
    io.output.write('\n');
  }
}

async function main() {
  const { registerTs } = await import('./lib/register-ts.mjs');
  registerTs();
  const r = await runOwnerSecrets({
    stdinIsTTY: process.stdin.isTTY === true,
    stderrIsTTY: process.stderr.isTTY === true,
    env: markerEnv(),
    askHidden: askHiddenOnTerminal,
    write: (l) => process.stdout.write(`${l}\n`),
    note: (l) => process.stderr.write(`${l}\n`),
  });
  if (!r.ok) {
    process.stderr.write(`owner:secrets refused: ${r.code}\n`);
    process.exit(2);
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
