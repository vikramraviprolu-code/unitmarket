// Operator password reset, the composition behind scripts/accounts-cli.mjs (ID-ACCOUNTS). It joins config, db,
// runtime, obs and security, which the packages themselves may not do. Offline: it never connects to PayPal.
//
//   pnpm accounts:reset-password --username <name> [--operator <id>]
//
// A person's terminal only: it refuses in CI, in an AI session and without a terminal, before the database is
// opened. The new password is asked twice with the typed characters hidden and is never an argument, never
// printed and never logged. It passes the same environment guard as the other operator scripts (the config
// loader), so a stray database setting or the connect switch is refused first. The app must not hold the
// database (single-opener lock): on a laptop stop it, reset, restart.
import { createHash } from 'node:crypto';
import { userInfo } from 'node:os';
import { Writable } from 'node:stream';
import { createInterface } from 'node:readline';
import { loadConfigFromProcess, terminalEnv } from '../../packages/config/src/index.ts';
import { migrate, openDatabase, withTraceDb } from '../../packages/db/src/index.ts';
import { cliTraceContext, createAuditSink, createLogger } from '../../packages/obs/src/index.ts';
import { cryptoIds, systemClock } from '../../packages/runtime/src/index.ts';
import { runResetPassword } from '../../packages/security/src/index.ts';

const rest = process.argv.slice(2);
const flag = (name) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
};
const say = (line) => process.stdout.write(`${line}\n`);
const fail = (line, code = 1) => {
  process.stderr.write(`accounts: ${line}\n`);
  process.exit(code);
};
const USAGE = 'usage: accounts-cli.mjs --username <name> [--operator <id>]';

const username = flag('username');
// Only these two flags exist: a password can never be given as an argument (it would sit in the shell history).
if (
  username === undefined ||
  username.startsWith('--') ||
  rest.some((a) => a.startsWith('--') && a !== '--username' && a !== '--operator')
)
  fail(USAGE, 2);

const tty = { isTTY: process.stdin.isTTY, env: terminalEnv() };
// The terminal checks run again inside runResetPassword; they are made here too so nothing is loaded first.
if (tty.isTTY !== true) fail('refused: not a terminal');

const loaded = loadConfigFromProcess();
if (!loaded.ok) fail(`boot refused: ${loaded.error.code} (${loaded.error.name})`, 78);
const config = loaded.value;
const clock = systemClock();
const ids = cryptoIds();
const target =
  config.db.kind === 'postgres' ? { kind: 'postgres', url: config.db.url.reveal() } : config.db;
const rawDb = await openDatabase(target).catch((e) => {
  fail(e instanceof Error ? e.message : String(e));
  throw e; // not reached: fail() exits
});
// INT-TR0: every write of this run is journaled as an operator on the cli channel. The actor is the hash of the
// OS user name (user_hash), never the name; the migration below runs on the plain database.
const user_hash = createHash('sha256')
  .update(`os:${userInfo().username}`)
  .digest('hex')
  .slice(0, 16);
const traceCtx = cliTraceContext({
  id: `ctx_cli_${ids.nonce()}`,
  at: clock.now().toISOString(),
  user_hash,
  job: 'accounts:reset-password',
});
const db = withTraceDb(rawDb, () => traceCtx, clock);

// Reads one line with the typed characters hidden. The prompt is written, the echo is muted for the answer.
function askSecret(prompt) {
  return new Promise((resolve) => {
    let muted = false;
    const out = new Writable({
      write(chunk, enc, cb) {
        if (!muted) process.stdout.write(chunk, enc);
        cb();
      },
    });
    const rl = createInterface({ input: process.stdin, output: out, terminal: true });
    let answered = false;
    // Ctrl-C (or the terminal closing) before an answer: close the prompt, close the database, exit 130.
    rl.on('SIGINT', () => rl.close());
    rl.on('close', () => {
      if (answered) return;
      muted = false;
      process.stdout.write('\n');
      process.stderr.write('accounts: interrupted, nothing changed\n');
      db.close().then(
        () => process.exit(130),
        () => process.exit(130),
      );
    });
    process.stdout.write(prompt);
    muted = true;
    rl.question('', (answer) => {
      answered = true;
      muted = false;
      process.stdout.write('\n');
      rl.close();
      resolve(answer);
    });
  });
}

let code = 0;
try {
  await migrate(rawDb, clock);
  say(`mode=${config.mode} db=${config.db.kind}`);
  const log = createLogger(() => undefined, {}, clock);
  const r = await runResetPassword({
    deps: {
      db,
      clock,
      ids,
      log,
      audit: createAuditSink(ids, clock),
      session_secret: config.session_secret,
      passcode_hash: null,
      public_origin: config.public_origin,
    },
    tty,
    operator_id: flag('operator') ?? 'opr_terminal',
    username,
    askSecret,
    write: say,
  });
  if (!r.ok) {
    process.stderr.write(`refused: ${r.error}${r.reason ? ` (${r.reason})` : ''}\n`);
    code = 1;
  } else say(`Password reset. ${r.value.revoked} session(s) ended.`);
} finally {
  await db.close();
}
process.exit(code);
