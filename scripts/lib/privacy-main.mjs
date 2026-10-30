// Operator privacy script, the composition behind scripts/privacy.mjs (OPS-PRIV, PRIV-3 and PRIV-4).
// It joins config, db, runtime and obs, which the packages themselves may not do. Offline: it never
// connects to PayPal and reads no env file itself. Run it with the prefix
//   env -u DATABASE_URL -u UMS_DB -u UMS_PAYPAL_CONNECT
// so a stray database setting or the connect switch in the shell cannot reach it (D-059).
//
//   export <buyer_id>                            one JSON document on stdout; the mode line goes to stderr
//   delete <buyer_id> --operator <id> --reason <text>
//                                                pseudonymises the buyer; the buyer id is typed back first
//
// Both refuse, before the database is opened, without a terminal, in CI and in an AI session. Names and
// counts only in anything printed except the export document itself, which is the buyer's own data.
import { createInterface } from 'node:readline/promises';
import { loadConfigFromProcess, terminalEnv } from '../../packages/config/src/index.ts';
import { migrate, openDatabase } from '../../packages/db/src/index.ts';
import { createAuditSink } from '../../packages/obs/src/index.ts';
import { cryptoIds, systemClock } from '../../packages/runtime/src/index.ts';
import { refusal, runDelete, runExport } from './privacy.mjs';

const [command, ...rest] = process.argv.slice(2);
const flag = (name) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
};
const say = (line) => process.stdout.write(`${line}\n`);
const fail = (line, code = 1) => {
  process.stderr.write(`${line}\n`);
  process.exit(code);
};
const USAGE =
  'usage: privacy.mjs export <buyer_id> | delete <buyer_id> --operator <id> --reason <text>   (run with: env -u DATABASE_URL -u UMS_DB -u UMS_PAYPAL_CONNECT)';

if (!['export', 'delete'].includes(command ?? '')) fail(USAGE, 2);

const tty = { isTTY: process.stdin.isTTY, env: terminalEnv() };
const refused = refusal(tty);
if (refused !== null) fail(`refused: ${refused}`);

const buyerId = rest[0];
if (buyerId === undefined || buyerId.startsWith('--')) fail(USAGE, 2);
const operator = flag('operator');
if (command === 'delete' && (operator === undefined || flag('reason') === undefined))
  fail(USAGE, 2);

const loaded = loadConfigFromProcess();
if (!loaded.ok) fail(`boot refused: ${loaded.error.code} (${loaded.error.name})`, 78);
const config = loaded.value;
const clock = systemClock();
const ids = cryptoIds();
const target =
  config.db.kind === 'postgres' ? { kind: 'postgres', url: config.db.url.reveal() } : config.db;
const db = await openDatabase(target).catch((e) => {
  fail(e instanceof Error ? e.message : String(e));
  throw e; // not reached: fail() exits
});
let code = 0;
try {
  await migrate(db, clock);
  // The database this will touch, shown first, as safety:status does. The export keeps stdout for the document.
  const mode = `mode=${config.mode} db=${config.db.kind}`;
  if (command === 'export') process.stderr.write(`${mode}\n`);
  else say(mode);

  if (command === 'export') {
    const r = await runExport({ db, now: clock.now(), tty, buyer_id: buyerId });
    if (!r.ok) {
      process.stderr.write(`refused: ${r.error}\n`);
      code = 1;
    } else say(JSON.stringify(r.value, null, 2));
  } else {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const r = await runDelete({
        db,
        clock,
        audit: createAuditSink(ids, clock),
        tty,
        ask: (prompt) => rl.question(prompt),
        write: say,
        buyer_id: buyerId,
        operator_id: operator,
        reason: flag('reason'),
      });
      if (!r.ok) {
        process.stderr.write(`refused: ${r.error}\n`);
        code = 1;
      }
    } finally {
      rl.close();
    }
  }
} finally {
  await db.close();
}
process.exit(code);
