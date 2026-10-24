// node scripts/totp-enrol.mjs --operator <name>   (CO-6, ASM-56)
// For an operator, at a terminal, on their own machine. Makes a new TOTP secret (20 random bytes) and
// prints it as base32 plus the otpauth:// URI for an authenticator app, once, to the terminal. The operator
// then adds `<name>:<secret>` to UMS_OPERATOR_TOTP_KEYS in .env.local or the host settings.
// It writes no file, logs nothing, opens no connection, and reads no environment value other than the
// CI and AI marker names (the runner's lists). It refuses, before it draws any randomness, unless stdin and
// stdout are both a terminal (a redirect would put the secret in a file or a log), and in CI and in an AI session.
//
// A plain node process: the TypeScript hooks are registered in-process, so no --import flag appears in
// process.execArgv (see scripts/lib/register-ts.mjs).
import { pathToFileURL } from 'node:url';
// The same marker lists, and the same reader of those names, as the runner: one list to keep right.
import { AI_MARKERS, CI_MARKERS, markerEnv } from './sandbox-conformance.mjs';

const set = (v) => v !== undefined && v !== '';
const SECRET_BYTES = 20;

async function loadLibs() {
  const { base32Encode, isOperatorName, otpauthUri } =
    await import('../packages/security/src/index.ts');
  const { cryptoIds } = await import('../packages/runtime/src/index.ts');
  return { base32Encode, isOperatorName, otpauthUri, ids: cryptoIds() };
}

/**
 * @param {{
 *   stdinIsTTY: boolean, stdoutIsTTY: boolean,
 *   env: Record<string, string | undefined>,
 *   operator: string | undefined,
 *   write: (line: string) => void,
 *   note?: (line: string) => void,
 *   libs?: {
 *     base32Encode: (bytes: Uint8Array) => string,
 *     isOperatorName: (name: string) => boolean,
 *     otpauthUri: (operator: string, secret_b32: string) => string,
 *     ids: { nonce(): string },
 *   },
 * }} d
 * @returns {Promise<{ ok: true } | { ok: false, code: string }>}
 */
export async function runTotpEnrol(d) {
  if (d.stdinIsTTY !== true || d.stdoutIsTTY !== true) return { ok: false, code: 'not_a_tty' };
  if (CI_MARKERS.some((n) => set(d.env[n]))) return { ok: false, code: 'ci_set' };
  if (AI_MARKERS.some((n) => set(d.env[n]))) return { ok: false, code: 'ai_session' };
  const libs = d.libs ?? (await loadLibs());
  const operator = d.operator ?? '';
  if (!libs.isOperatorName(operator)) return { ok: false, code: 'bad_operator' };
  const note = d.note ?? (() => undefined);
  // 20 random bytes: the first 20 of two 128-bit nonces from the runtime package (the only place
  // that may draw randomness).
  const raw = Buffer.from(libs.ids.nonce() + libs.ids.nonce(), 'hex').subarray(0, SECRET_BYTES);
  const secret = libs.base32Encode(raw);
  d.write(`Operator: ${operator}`);
  d.write(
    'Secret (base32; type it into your authenticator app if you cannot scan or import the URI):',
  );
  d.write(`  ${secret}`);
  d.write('Authenticator URI (SHA1, 6 digits, 30 seconds):');
  d.write(`  ${libs.otpauthUri(operator, secret)}`);
  note(
    `Add "${operator}:<the secret above>" to UMS_OPERATOR_TOTP_KEYS in .env.local or the host settings (several operators: separate the entries with a comma).`,
  );
  note(
    'This is shown once. Nothing was written to disk. Clear your terminal scrollback when you are done.',
  );
  return { ok: true };
}

const USAGE = 'usage: node scripts/totp-enrol.mjs --operator <name>';

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--operator') {
    process.stderr.write(`totp:enrol refused: bad_args. ${USAGE}\n`);
    process.exit(2);
  }
  const { registerTs } = await import('./lib/register-ts.mjs');
  registerTs();
  const r = await runTotpEnrol({
    stdinIsTTY: process.stdin.isTTY === true,
    stdoutIsTTY: process.stdout.isTTY === true,
    env: markerEnv(),
    operator: args[1],
    write: (l) => process.stdout.write(`${l}\n`),
    note: (l) => process.stderr.write(`${l}\n`),
  });
  if (!r.ok) {
    process.stderr.write(`totp:enrol refused: ${r.code}. ${USAGE}\n`);
    process.exit(2);
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
