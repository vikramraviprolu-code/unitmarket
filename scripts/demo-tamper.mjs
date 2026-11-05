// INT-E2E (item E2E.2, F9): the tamper demo for the video. It shows, in plain words, that the transaction
// journal catches an edit made behind the app's back, and that the same check is clean once the edit is undone.
//
//   node scripts/demo-tamper.mjs          (with the offline env the app needs, e.g. from .env.local)
//
// In-memory only. The target is read through the config loader (loadConfigFromProcess, as
// scripts/lib/safety-cli-main.mjs does; S3: no process.env here). UMS_DB unset means pglite-memory and is
// accepted. Any other kind exits 2 with "demo-tamper runs on pglite-memory only", before any database module is
// imported: a Postgres URL is never dialled and a PGlite directory is never created.
//
// Then it boots the dry-run app in-process on a fresh in-memory database (synthetic test values, the same as
// scripts/perf-offline.mjs), makes one purchase inside the buyer's trace context so a ledger row exists, and runs:
//   step 1  turn off the guards of ledger_entries and change one amount: verify exits 1, naming the drift;
//   step 2  put the amount back and turn the guards on again: verify exits 0;
//   step 3  turn off the guards of trace_events and change one journal row: verify exits 1, naming its chain
//           and seq; put it back: verify exits 0.
// Verify is the verifier of scripts/trace-verify.mjs (verifyTrace and traceInvariants), run in-process on the
// demo database: a spawned trace:verify would open a database of its own. Exit 0 when every step showed what it
// should, 1 when one did not, 2 when refused, 78 when the configuration was refused. Nothing reaches a network.
import { registerTs } from './lib/register-ts.mjs';

registerTs();

const say = (line) => process.stdout.write(`${line}\n`);
const fail = (line, code = 1) => {
  process.stderr.write(`demo-tamper: ${line}\n`);
  process.exit(code);
};

// Only the config package is loaded before the check. No database module is imported above this line.
const { loadConfigFromProcess } = await import('../packages/config/src/index.ts');
const loaded = loadConfigFromProcess();
if (!loaded.ok) fail(`boot refused: ${loaded.error.code} (${loaded.error.name})`, 78);
if (loaded.value.db.kind !== 'pglite-memory') fail('demo-tamper runs on pglite-memory only', 2);

const { createApp, installApp } = await import('../apps/web/composition.server.ts');
const { PASSCODE, testEnv } = await import('../apps/web/src/support.ts');
const { withTraceContext } = await import('../packages/obs/src/index.ts');
const { formatTraceFinding, traceInvariants, verifyTrace } =
  await import('../packages/db/src/index.ts');

const app = createApp(await testEnv(), { switch_cache_ms: 0 });
installApp(app);

/** The in-process verifier: the same calls, lines and exit code as scripts/trace-verify.mjs. */
async function verify() {
  const report = await verifyTrace(app.db);
  const invariants = await traceInvariants(app.db);
  const lines = [
    ...report.findings.map(formatTraceFinding),
    ...invariants.filter((l) => !l.startsWith('INV-T1')),
  ];
  const code = report.findings.length === 0 && invariants.length === 0 ? 0 : 1;
  say(
    `  verify exit ${code}${code === 0 ? ': the journal and the data agree' : ': tampering found'}`,
  );
  for (const l of lines) say(`    ${l}`);
  return { code, lines };
}

let ok = true;
const expectCode = (got, want, what) => {
  if (got !== want) {
    ok = false;
    say(`  UNEXPECTED: ${what} gave exit ${got}, expected ${want}`);
  }
};

try {
  await app.ready();
  say(`database: ${app.config.db.kind} (fresh, in this process only), mode: ${app.environment}`);

  // Setup: sign the demo buyer in (a system write on the seed channel), then one purchase as that buyer on the
  // web channel, the way the return page writes it (engine.asPageActor).
  const at = app.security.clock.now().toISOString();
  const session = await withTraceContext(
    {
      id: `ctx_demo_tamper_${app.security.ids.nonce()}`,
      at,
      channel: 'seed',
      actor_kind: 'system',
      actor_id: null,
      on_behalf_of: null,
      mandate_id: null,
      mfa: false,
      req_id: null,
      ip_hash: null,
      ua_family: null,
      api_key_id: null,
      job: 'demo_tamper',
      tool: null,
    },
    () => app.engine.signIn({ persona: 'buyer-a', passcode: PASSCODE }),
  );
  if (session === null || session.actor.kind !== 'buyer') fail('the demo buyer could not sign in');
  const actor = session.actor;
  const order_ref = await app.engine.asPageActor(actor, async () => {
    const q = await app.engine.quote({
      offer: { publisher_slug: 'harbour-ledger', offer_code: 'tide-tables' },
      actor,
      source: 'direct',
      option: 'online_read',
    });
    if (!q.ok || q.value.kind !== 'quote') throw new Error('no quote');
    const g = await app.engine.requestApproval({
      actor,
      selection: { kind: 'quote', quote_id: q.value.quote_id },
      consent: { terms: true, identity_share: false },
    });
    if (!g.ok) throw new Error(`no approval: ${g.error.code}`);
    const placed = await app.engine.payments.placeOrder({
      approval_id: g.value.approval_id,
      token: g.value.token,
      actor,
    });
    if (!placed.ok) throw new Error('the order was not placed');
    const co = await app.engine.payments.beginCheckout({ order_id: placed.value.order_id, actor });
    if (!co.ok) throw new Error(`checkout: ${co.error.code}`);
    const ref = placed.value.order_ref;
    await app.engine.dryRunApprove({ order_ref: ref, actor, scenario: 'happy' });
    const r = await app.engine.payments.onBuyerReturn({ order_ref: ref, actor, scenario: 'happy' });
    if (!r.ok) throw new Error('the return did not complete');
    return ref;
  });
  const ledger = (
    await app.db.query(
      `SELECT l.id, l.amount_minor FROM ledger_entries l JOIN order_units u ON u.id = l.unit_id
         JOIN orders o ON o.id = u.order_id WHERE o.order_ref = $1 AND l.kind = 'sale' LIMIT 1`,
      [order_ref],
    )
  ).rows[0];
  if (ledger === undefined) fail('no ledger row after the purchase');
  const amount = Number(ledger.amount_minor);
  say(`one purchase made: order ${order_ref}, sale ledger row ${ledger.id} of ${amount} cents`);
  say('before any edit:');
  expectCode((await verify()).code, 0, 'the clean journal');

  say('');
  say(`step 1: someone with database access turns off the ledger guards and changes ${ledger.id}`);
  say(`        from ${amount} to ${amount + 100} cents, leaving no journal row behind`);
  await app.db.exec('ALTER TABLE ledger_entries DISABLE TRIGGER USER');
  await app.db.query('UPDATE ledger_entries SET amount_minor = $2 WHERE id = $1', [
    ledger.id,
    amount + 100,
  ]);
  const v1 = await verify();
  expectCode(v1.code, 1, 'the changed amount');
  if (!v1.lines.some((l) => l.includes(`drift ledger_entries ${ledger.id} amount_minor`))) {
    ok = false;
    say('  UNEXPECTED: no drift line for the changed amount');
  }

  say('');
  say(`step 2: the amount is put back to ${amount} cents and the guards are turned on again`);
  await app.db.query('UPDATE ledger_entries SET amount_minor = $2 WHERE id = $1', [
    ledger.id,
    amount,
  ]);
  await app.db.exec('ALTER TABLE ledger_entries ENABLE TRIGGER USER');
  expectCode((await verify()).code, 0, 'the restored amount');

  say('');
  const row = (
    await app.db.query(
      `SELECT e.chain_key, e.seq::int AS seq, e.body FROM trace_events e JOIN orders o ON e.chain_key = 'ord:' || o.id
        WHERE o.order_ref = $1 AND e.source_table = 'orders' ORDER BY e.seq LIMIT 1`,
      [order_ref],
    )
  ).rows[0];
  const original = JSON.stringify(row.body);
  say(`step 3: the journal itself is edited: row ${row.chain_key} seq ${row.seq} is rewritten`);
  await app.db.exec('ALTER TABLE trace_events DISABLE TRIGGER USER');
  await app.db.query(
    `UPDATE trace_events SET body = jsonb_set(body, '{n}', to_jsonb(999)) WHERE chain_key = $1 AND seq = $2`,
    [row.chain_key, row.seq],
  );
  const v3 = await verify();
  expectCode(v3.code, 1, 'the edited journal row');
  if (!v3.lines.some((l) => l.includes(`${row.chain_key} seq ${row.seq}`))) {
    ok = false;
    say('  UNEXPECTED: no line names the edited chain and seq');
  }
  say('        the row is put back and the journal guards are turned on again');
  await app.db.query('UPDATE trace_events SET body = $3::jsonb WHERE chain_key = $1 AND seq = $2', [
    row.chain_key,
    row.seq,
    original,
  ]);
  await app.db.exec('ALTER TABLE trace_events ENABLE TRIGGER USER');
  expectCode((await verify()).code, 0, 'the restored journal row');
} catch (e) {
  ok = false;
  process.stderr.write(`demo-tamper: ${e instanceof Error ? e.message : String(e)}\n`);
} finally {
  await app.close();
}
say('');
say(
  ok
    ? 'demo done: every edit was caught, and every restore came back clean'
    : 'demo done with a surprise: see the UNEXPECTED lines',
);
process.exit(ok ? 0 : 1);
