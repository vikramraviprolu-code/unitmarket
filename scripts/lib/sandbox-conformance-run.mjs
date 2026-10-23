// The body of pnpm sandbox:conformance (BU-6), imported by scripts/sandbox-conformance.mjs after it has
// refused outside a person's terminal and registered the TypeScript hooks in this process. Plain node,
// empty execArgv. It reads no environment variable itself: packages/config reads the real environment
// (and refuses overrides), the launcher reads the flag and the CI and AI markers.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfigFromProcess, makeSecret } from '../../packages/config/src/index.ts';
import { migrate, openDatabase } from '../../packages/db/src/index.ts';
import { createLogger } from '../../packages/obs/src/index.ts';
import { systemClock } from '../../packages/runtime/src/index.ts';
import { createSwitchReader } from '../../packages/safety/src/index.ts';
import { buildRecordings } from '../../packages/transport/src/index.ts';
import {
  ownerSubset,
  renderOwnerSummary,
  sandboxSubject,
} from '../../packages/testkit/src/sandbox-subject.ts';
import { buildOutbound } from '../../apps/web/src/server/outbound.server.ts';

/**
 * @param {{ say: (l: string) => void, err: (l: string) => void }} d
 * @param {{ outBase: string, only: 'payee-echo' | undefined }} ctx
 * @returns {Promise<number>} the exit code
 */
export async function runOwnerSuite(d, ctx) {
  // The guard, unchanged: it refuses --require, --import, --conditions, NODE_OPTIONS, proxies.
  const loaded = loadConfigFromProcess();
  if (!loaded.ok) {
    d.err(`boot refused: ${loaded.error.code} (${loaded.error.name}). Values are never printed.`);
    return 78;
  }
  const config = loaded.value;
  if (config.db.kind === 'postgres') {
    d.err('sandbox:conformance: the postgres target is not supported here');
    return 2;
  }
  const clock = systemClock();
  // The app must be stopped: the data folder has a single-opener lock.
  let db;
  try {
    db = await openDatabase(config.db);
  } catch (e) {
    d.err(`sandbox:conformance: ${e instanceof Error ? e.message : 'cannot open the database'}`);
    return 1;
  }
  try {
    await migrate(db, clock);
    const log = createLogger(() => undefined, {}, clock);
    const outbound = buildOutbound({
      config,
      db,
      clock,
      log,
      switches: createSwitchReader(db, clock, 0),
      wire: null, // the production Wire
    });
    const sc = outbound.selfcheck();
    d.say(
      sc === null
        ? 'wire self-check: not applicable'
        : `wire self-check: env_override ${sc.env_override}, builtins_intact ${sc.builtins_intact}`,
    );
    const credentials = config.paypal ?? {
      // No credentials: the first call is blocked by the locks (L1 or L5) before anything is built.
      client_id: makeSecret('credentials-missing'),
      client_secret: makeSecret('credentials-missing'),
    };
    const subject = sandboxSubject({
      transport: outbound.transport,
      clock,
      credentials: { client_id: credentials.client_id, client_secret: credentials.client_secret },
      own_merchant_id: config.own_merchant_id ?? null,
      stderr: d.err,
    });
    const run = ownerSubset(subject);
    const report = await run.runAll(ctx.only === undefined ? {} : { only: ctx.only });

    for (const c of report.cases) d.say(`${c.pass ? 'PASS' : 'FAIL'}  ${c.title}: ${c.detail}`);
    if (report.stopped !== null)
      d.say(`stopped: ${report.stopped.code} (${report.stopped.detail})`);

    const now = clock.now();
    const date = now.toISOString().slice(0, 10);
    let dir = join(ctx.outBase, date);
    for (let i = 2; existsSync(dir); i += 1) dir = join(ctx.outBase, `${date}-${i}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'summary.md'), renderOwnerSummary(report, { date }), { flag: 'wx' });
    const exchanges = subject.callLog();
    // The recorder's own residue check is the second opinion on the redaction.
    const built = await buildRecordings(exchanges, {
      recorded_at: now.toISOString(),
      origin: 'sandbox-recording: owner run of pnpm sandbox:conformance',
    });
    if (exchanges.length === 0 || built.ok) {
      writeFileSync(join(dir, 'calls.json'), `${JSON.stringify(exchanges, null, 2)}\n`, {
        flag: 'wx',
      });
    } else {
      d.err(
        `calls.json NOT written: the recorder refused the log (${built.refusal.code}: ${built.refusal.where}). Tell Sakthi; do not edit the log by hand.`,
      );
      writeFileSync(join(dir, 'calls.json'), '[]\n', { flag: 'wx' });
    }
    d.say(`wrote ${dir} (summary.md and calls.json)`);
    return report.cases.every((c) => c.pass) && report.stopped === null ? 0 : 1;
  } finally {
    await db.close();
  }
}
