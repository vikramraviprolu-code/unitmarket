// Operator entry points for pnpm safety:status, safety:stop and safety:approve (review 4 M11).
// This file is the composition: it joins config, db, runtime, obs and safety, which the packages
// themselves may not do. Run through the TypeScript hooks:
//   node --env-file-if-exists=.env.local --import ./scripts/lib/ts-register.mjs scripts/safety-cli.mjs <command>
//
//   status                                  switches and the call budget left; reads no secret; any terminal
//   stop    --operator <id> --reason <text> paypal_outbound off; person's terminal only
//   approve --operator <id> --ref <ref> --scope <name> --ops a,b --max-amount <minor>
//           --max-calls <n> --valid-until <ISO> --approved-by <name>
//                                           writes one append-only outbound_approvals row; terminal only
// The operator id names who is acting; the person at a TTY is the second factor the CLIs rely on.
import { createInterface } from 'node:readline/promises';
import { loadConfigFromProcess, terminalEnv } from '../packages/config/src/index.ts';
import { migrate, openDatabase } from '../packages/db/src/index.ts';
import { createAuditSink } from '../packages/obs/src/index.ts';
import { cryptoIds, systemClock } from '../packages/runtime/src/index.ts';
import { readSafetyStatus, runApprove, runStop } from '../packages/safety/src/index.ts';

const [command, ...rest] = process.argv.slice(2);
const flag = (name) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
};
const say = (line) => process.stdout.write(`${line}\n`);
const fail = (line, code = 1) => {
  process.stderr.write(`safety: ${line}\n`);
  process.exit(code);
};

if (!['status', 'stop', 'approve'].includes(command ?? '')) {
  fail(
    'usage: safety-cli.mjs status | stop --operator <id> --reason <text> | approve --operator <id> --ref ...',
    2,
  );
}

const loaded = loadConfigFromProcess();
if (!loaded.ok) fail(`boot refused: ${loaded.error.code} (${loaded.error.name})`, 78);
const config = loaded.value;
if (config.db.kind === 'postgres') fail('the postgres target is not supported by this CLI yet', 2);

const clock = systemClock();
const ids = cryptoIds();
// A live holder of the data directory (CO-9 lock) is one line and exit 1, not a stack trace.
const db = await openDatabase(config.db).catch((e) => {
  fail(e instanceof Error ? e.message : String(e));
  throw e; // not reached: fail() exits
});
try {
  await migrate(db, clock);
  const tty = { isTTY: process.stdin.isTTY, env: terminalEnv() };
  const operator = flag('operator');
  const by = operator ? { kind: 'operator', operator_id: operator, mfa: true } : { kind: 'system' };

  if (command === 'status') {
    const s = await readSafetyStatus(db, clock.now(), config.outbound_approval_ref);
    say(`mode=${config.mode} connect=${config.connect ? 'on' : 'off'} db=${config.db.kind}`);
    for (const sw of s.switches)
      say(
        `switch ${sw.name}=${sw.on ? 'on' : 'off'} (${sw.changed_by} at ${sw.changed_at}: ${sw.reason})`,
      );
    if (s.budget === null) say('budget: no active approval for the configured reference');
    else
      say(
        `budget ${s.budget.approval_ref}: ${s.budget.remaining_today} of ${s.budget.max_calls_per_day} calls left today; per-order cap ${s.budget.max_amount_minor} minor; valid until ${s.budget.valid_until}; operations ${s.budget.operations.join(',')}`,
      );
  } else if (command === 'stop') {
    if (!operator) fail('stop needs --operator <id>', 2);
    const r = await runStop({
      db,
      clock,
      audit: createAuditSink(ids, clock),
      tty,
      by,
      reason: flag('reason') ?? '',
    });
    if (!r.ok) fail(`refused: ${r.error}`);
    say('paypal_outbound is now off');
  } else {
    if (!operator) fail('approve needs --operator <id>', 2);
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const r = await runApprove({
        db,
        clock,
        ids,
        audit: createAuditSink(ids, clock),
        tty,
        ask: (prompt) => rl.question(prompt),
        write: say,
        by,
        input: {
          approval_ref: flag('ref') ?? '',
          scope: flag('scope') ?? '',
          operations: (flag('ops') ?? '').split(',').filter(Boolean),
          max_amount_minor: Number(flag('max-amount')),
          max_calls_per_day: Number(flag('max-calls')),
          valid_until: flag('valid-until') ?? '',
          approved_by: flag('approved-by') ?? '',
        },
      });
      if (!r.ok) fail(`refused: ${r.error}`);
      say(`approval ${r.value.approval_ref} recorded`);
    } finally {
      rl.close();
    }
  }
} finally {
  await db.close();
}
