// INT-TR0 / TR0.4: pnpm trace:verify. Reads the transaction journal of the configured database and checks it:
// every chain (hash, seq, prev_hash), every head, every daily seal, the source digest of the append-only
// tables, and drift (the live state of each tracked row against what its events say). It also lists INV-T1
// and INV-T2. Read only: it never writes and never migrates.
//
//   node scripts/trace-verify.mjs
//
// The database is the one the app would open: UMS_DB (pglite-memory, pglite-disk with UMS_PGLITE_DIR, or
// postgres with DATABASE_URL), read through the config loader like the other operator scripts. On a PGlite
// directory it takes the single-opener lock (CO-9): while the app runs it exits 2 with "database in use". On
// Postgres it runs beside the app, in one REPEATABLE READ READ ONLY transaction, so every check sees one snapshot.
//
// Exit 0: ok. Exit 1: findings (printed one per line with the chain and seq) or an unreadable journal.
// Exit 2: database in use. Exit 78: the configuration was refused. No secret is printed.
import { registerTs } from './lib/register-ts.mjs';

registerTs();

const { loadConfigFromProcess } = await import('../packages/config/src/index.ts');
const { DbInUseError, formatTraceFinding, openDatabase, traceInvariants, verifyTrace } =
  await import('../packages/db/src/index.ts');

const say = (line) => process.stdout.write(`${line}\n`);
const fail = (line, code = 1) => {
  process.stderr.write(`trace:verify: ${line}\n`);
  process.exit(code);
};

const loaded = loadConfigFromProcess();
if (!loaded.ok) fail(`boot refused: ${loaded.error.code} (${loaded.error.name})`, 78);
const config = loaded.value;
// PG-2: the URL is a secret. It is revealed once, for the driver, which scrubs it from every error.
const target =
  config.db.kind === 'postgres' ? { kind: 'postgres', url: config.db.url.reveal() } : config.db;

let db;
try {
  db = await openDatabase(target);
} catch (e) {
  if (e instanceof DbInUseError) fail('database in use: the app holds it. Stop the app first.', 2);
  fail(e instanceof Error ? e.message : String(e));
}

let code = 0;
try {
  // One snapshot for every check on Postgres. On PGlite there is one connection and nobody else writes.
  const run = async (tx) => {
    const report = await verifyTrace(tx);
    const invariants = await traceInvariants(tx);
    return { report, invariants };
  };
  const { report, invariants } =
    config.db.kind === 'postgres'
      ? await db.transaction(async (tx) => {
          await tx.exec('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
          return run(tx);
        })
      : await run(db);
  say(`mode=${config.mode} db=${config.db.kind}`);
  say(
    `chains ${report.chains}, rows ${report.rows}, seals ${report.seals}, checked ${report.checked}, unattributed ${report.unattributed}`,
  );
  for (const f of report.findings) say(formatTraceFinding(f));
  for (const line of invariants) say(line);
  if (report.findings.length === 0 && invariants.length === 0) say('ok');
  else code = 1;
} catch (e) {
  // A database that was never migrated has no journal; say so in one line, no stack.
  process.stderr.write(
    `trace:verify: cannot read the journal: ${e instanceof Error ? e.message : String(e)}\n`,
  );
  code = 1;
} finally {
  await db.close();
}
process.exit(code);
