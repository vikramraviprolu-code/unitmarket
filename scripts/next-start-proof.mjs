// BU-3: proof that the unsealed app boots and fails closed under the real `next start`, offline.
//
//   node --import ./scripts/lib/ts-register.mjs scripts/next-start-proof.mjs [--json <file>]
//
// What it does (docs/specs/web-next-start-proof.md), all under `flock /tmp/sbx-next-build.lock`:
//   1. makes a fresh temp directory, migrates a PGlite database in it, seeds the catalogue, gives the
//      publishers a made-up payee and inserts ONE outbound_approvals row for scope mvp_b_polling whose
//      operations are ['get_capture'] only, then turns paypal_outbound on. The row is inserted by
//      this script directly. That is allowed here only because the credentials are fake and every
//      operation the adapter needs first (oauth_token) is NOT in the row: the scoped gate mints a
//      capability and the approved transport is built with the production Wire, but the first call
//      the adapter makes is blocked `no_approval` by the gate before the Wire. No real approval row,
//      no real credential and not the owner's data directory is involved.
//   2. `next build` and `next start -H 127.0.0.1 -p <free port>` for apps/web, with
//      NEXT_TELEMETRY_DISABLED=1 (Next telemetry is itself an outbound call), UMS_MODE=sandbox,
//      UMS_PAYPAL_CONNECT=on, NEXT_PUBLIC_UMS_ENV_LABEL=Sandbox, UMS_DB=pglite-disk, FAKE
//      credentials assembled at run time and no NODE_OPTIONS. The child gets a minimal environment
//      of its own: nothing is inherited, so no proxy variable or real credential can reach it.
//   3. GETs /, an offer page, signs in as buyer A, starts a checkout, signs in as the operator and
//      reads /ops (the Wire self-check after Next loaded its route modules), GETs /healthz, stops
//      the server and reads its stdout and stderr, and the provider_calls rows.
//   4. a second `next start` with NODE_OPTIONS=--require=./x.cjs must exit 78 (transport_env_override).
//   5. deletes the temp directory.
// The only socket is localhost, driven with curl (fetch and node:http are barred in this repository
// outside packages/transport, and a script may spawn processes). Exit 0 when every check passes, 1
// when one fails, 2 when the proof could not run. The script reads no environment variable.
import { spawn, spawnSync } from 'node:child_process';
import { scryptSync } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cryptoIds, systemClock } from '../packages/runtime/src/index.ts';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ROOT = join(HERE, '..');
const SCRIPT = fileURLToPath(import.meta.url);
const WEB = join(ROOT, 'apps/web');
export const LOCK_FILE = '/tmp/sbx-next-build.lock';
const SAFE_PATH = '/usr/local/bin:/usr/bin:/bin';
export const APPROVAL_REF = 'DL-bu3-proof-offline';
const REFUSAL_EXIT = 78;
const PASSCODE = 'bu3 proof passcode one';
const SALT = '00112233445566778899aabbccddeeff';

// --- pure part: parser and verdict rules (unit-tested on canned logs) --------------------------

/** Splits program output into JSON log events (an object with a string `msg`) and plain lines. */
export function parseOutput(text) {
  const events = [];
  const plain = [];
  for (const raw of String(text).split('\n')) {
    const line = raw.replace(/\r$/, '').trim();
    if (line === '') continue;
    let parsed = null;
    if (line.startsWith('{')) {
      try {
        parsed = JSON.parse(line);
      } catch {
        parsed = null;
      }
    }
    if (parsed !== null && typeof parsed === 'object' && typeof parsed.msg === 'string')
      events.push(parsed);
    else plain.push(line);
  }
  return { events, plain };
}

const lineHasSecret = (line, secrets) => secrets.some((s) => s !== '' && line.includes(s));
const countSecretLines = (texts, secrets) =>
  texts.reduce(
    (n, t) =>
      n +
      String(t)
        .split('\n')
        .filter((l) => lineHasSecret(l, secrets)).length,
    0,
  );
const noSecretCheck = (texts, secrets) => {
  const usable = secrets.filter((s) => typeof s === 'string' && s !== '');
  if (usable.length === 0)
    return {
      id: 'no_secret_in_output',
      ok: false,
      detail: 'no secret values were given to look for',
    };
  const n = countSecretLines(texts, usable);
  return {
    id: 'no_secret_in_output',
    ok: n === 0,
    detail:
      n === 0
        ? `0 lines hold any of ${usable.length} fake values`
        : `${n} line(s) hold a fake value`,
  };
};
const isBool = (v) => typeof v === 'boolean';

/**
 * The verdict for the server run.
 * input: { stdout, stderr, secrets, provider_calls: [{operation,outcome}] | null, listened,
 *          exit: {code, signal}, ops_selfcheck: {...} | null, checkout_status: number | null }
 */
export function analyseStart(input) {
  const out = parseOutput(input.stdout);
  const err = parseOutput(input.stderr);
  const events = [...out.events, ...err.events];
  const checks = [];

  checks.push({
    id: 'listened',
    ok: input.listened === true,
    detail:
      input.listened === true ? 'GET /healthz answered 200 while running' : 'no 200 from /healthz',
  });
  const code = input.exit?.code ?? null;
  const signal = input.exit?.signal ?? null;
  const stoppedByUs = code === 0 || code === 143 || (code === null && signal === 'SIGTERM');
  checks.push({
    id: 'clean_stop',
    ok: stoppedByUs,
    detail: `exit code ${code === null ? 'none' : code}, signal ${signal ?? 'none'} after SIGTERM`,
  });

  const sc = events.find((e) => e.msg === 'transport.selfcheck') ?? null;
  const selfcheck =
    sc === null
      ? null
      : {
          wire_kind: sc.wire_kind,
          impl: sc.impl,
          env_override: sc.env_override,
          builtins_intact: sc.builtins_intact,
          global_fetch_changed: sc.global_fetch_changed,
        };
  checks.push({
    id: 'selfcheck_line',
    ok:
      selfcheck !== null &&
      selfcheck.wire_kind === 'production' &&
      selfcheck.impl === 'node-https' &&
      selfcheck.env_override === false &&
      selfcheck.builtins_intact === true,
    detail:
      selfcheck === null
        ? 'no transport.selfcheck line'
        : `wire_kind ${selfcheck.wire_kind}, impl ${selfcheck.impl}, env_override ${selfcheck.env_override}, builtins_intact ${selfcheck.builtins_intact}`,
  });

  const after = input.ops_selfcheck ?? null;
  checks.push({
    id: 'selfcheck_after_load',
    ok:
      after !== null &&
      after.impl === 'node-https' &&
      after.env_override === false &&
      after.builtins_intact === true,
    detail:
      after === null
        ? 'the /ops Wire self-check line was not read'
        : `impl ${after.impl}, env_override ${after.env_override}, builtins_intact ${after.builtins_intact} (read from /ops after Next loaded its routes)`,
  });

  const atStart =
    selfcheck !== null && isBool(selfcheck.global_fetch_changed)
      ? selfcheck.global_fetch_changed
      : null;
  const afterLoad =
    after !== null && isBool(after.global_fetch_changed_since_load)
      ? after.global_fetch_changed_since_load
      : null;
  checks.push({
    id: 'global_fetch_recorded',
    ok: atStart !== null && afterLoad !== null,
    detail: `global_fetch_changed_since_load: ${atStart === null ? 'not recorded' : atStart} in the startup line, ${afterLoad === null ? 'not recorded' : afterLoad} on /ops after load`,
  });

  const sends = events.filter((e) => e.msg === 'sandbox.send');
  const tally = {};
  for (const s of sends) {
    const key = `${String(s.operation)}:${String(s.outcome)}`.slice(0, 80);
    tally[key] = (tally[key] ?? 0) + 1;
  }
  const sendsOk =
    sends.length >= 1 &&
    sends.every((s) => s.operation === 'oauth_token' && s.outcome === 'blocked:no_approval');
  checks.push({
    id: 'sends_blocked',
    ok: sendsOk,
    detail:
      sends.length === 0
        ? 'no sandbox.send line: the gate was never reached'
        : `${sends.length} line(s): ${Object.entries(tally)
            .map(([k, n]) => `${k} x${n}`)
            .join(', ')}`,
  });

  const rows = Array.isArray(input.provider_calls) ? input.provider_calls : null;
  const blocked = (o) => typeof o === 'string' && /^blocked(?:[:;]|$)/.test(o);
  checks.push({
    id: 'provider_calls_blocked',
    ok: rows !== null && rows.length >= 1 && rows.every((r) => blocked(r.outcome)),
    detail:
      rows === null
        ? 'provider_calls could not be read'
        : `${rows.length} row(s), ${rows.filter((r) => blocked(r.outcome)).length} blocked`,
  });

  const status = typeof input.checkout_status === 'number' ? input.checkout_status : null;
  checks.push({
    id: 'checkout_not_completed',
    ok: status !== null && !(status >= 200 && status < 300),
    detail: `POST checkout answered ${status === null ? 'nothing' : status}`,
  });

  checks.push(noSecretCheck([input.stdout, input.stderr], input.secrets ?? []));

  return {
    ok: checks.every((c) => c.ok),
    checks,
    facts: {
      selfcheck,
      global_fetch_changed_at_start: atStart,
      global_fetch_changed_after_load: afterLoad,
      sends: sends.length,
      provider_calls: rows === null ? null : rows.length,
      checkout_status: status,
      log_events: events.length,
    },
  };
}

/**
 * The verdict for the NODE_OPTIONS=--require run.
 * input: { exit: {code, signal}, stdout, stderr, secrets, timed_out }
 */
export function analyseOverride(input) {
  const text = `${input.stdout}\n${input.stderr}`;
  const events = [...parseOutput(input.stdout).events, ...parseOutput(input.stderr).events];
  const code = input.exit?.code ?? null;
  const checks = [
    {
      id: 'exit_78',
      ok: input.timed_out !== true && code === REFUSAL_EXIT,
      detail: `exit code ${code === null ? 'none' : code}, signal ${input.exit?.signal ?? 'none'}${input.timed_out === true ? ', timed out' : ''}`,
    },
    {
      id: 'refusal_names_override',
      ok: text.includes('transport_env_override'),
      detail: text.includes('transport_env_override')
        ? 'the refusal line names transport_env_override'
        : 'no transport_env_override in the output',
    },
    {
      id: 'nothing_served',
      ok: events.length === 0,
      detail:
        events.length === 0
          ? 'no application log line: register() refused before the app started'
          : `${events.length} application log line(s) were written`,
    },
    noSecretCheck([input.stdout, input.stderr], input.secrets ?? []),
  ];
  return {
    ok: checks.every((c) => c.ok),
    checks,
    facts: {
      ready_line_seen: /Ready in/.test(text),
      refusal_line:
        parseOutput(text).plain.find(
          (l) => l.includes('transport_env_override') && !lineHasSecret(l, input.secrets ?? []),
        ) ?? null,
    },
  };
}

/** Candidate ports derived from the pid (no socket API is used to find a free one). */
export function portCandidates(pid, n) {
  return Array.from({ length: n }, (_, i) => 20000 + ((pid * 37 + i * 101) % 40000));
}

const pad = (s, n) => String(s).padEnd(n, ' ');
export function renderTable(result) {
  const rows = result.checks.map((c) => `${c.ok ? 'PASS' : 'FAIL'}  ${pad(c.id, 24)} ${c.detail}`);
  return `${rows.join('\n')}\n${result.ok ? 'verdict: PASS' : 'verdict: FAIL'}`;
}

// --- running part ------------------------------------------------------------------------------

const clock = systemClock();
const nowMs = () => clock.now().getTime();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (line) => process.stdout.write(`${line}\n`);

function collect(child) {
  const o = { stdout: '', stderr: '', exit: null };
  child.stdout.on('data', (d) => void (o.stdout += d.toString('utf8')));
  child.stderr.on('data', (d) => void (o.stderr += d.toString('utf8')));
  o.done = new Promise((resolve) => {
    child.on('close', (code, signal) => {
      o.exit = { code, signal };
      resolve(o.exit);
    });
    child.on('error', () => {
      o.exit = { code: null, signal: 'spawn_error' };
      resolve(o.exit);
    });
  });
  return o;
}

/** curl against localhost only: no proxy, IPv4, no config file. Resolves { status, headers, body }. */
function curl(method, url, o = {}) {
  const args = ['-q', '-4', '-sS', '-i', '--noproxy', '*', '--max-time', '60', '-X', method, url];
  for (const [k, v] of Object.entries(o.headers ?? {})) args.push('-H', `${k}: ${v}`);
  if (o.body !== undefined)
    args.push('-H', 'Content-Type: application/json', '--data-binary', '@-');
  return new Promise((resolve) => {
    const c = spawn('curl', args, { env: { PATH: SAFE_PATH }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = Buffer.alloc(0);
    c.stdout.on('data', (d) => void (out = Buffer.concat([out, d])));
    c.on('error', () => resolve({ status: 0, headers: {}, cookies: [], body: '' }));
    c.on('close', () => {
      const text = out.toString('utf8');
      const cut = text.indexOf('\r\n\r\n');
      const head = cut < 0 ? text : text.slice(0, cut);
      const body = cut < 0 ? '' : text.slice(cut + 4);
      const lines = head.split('\r\n');
      const status = Number(/^HTTP\/[\d.]+ (\d{3})/.exec(lines[0] ?? '')?.[1] ?? 0);
      const headers = {};
      const cookies = [];
      for (const l of lines.slice(1)) {
        const i = l.indexOf(':');
        if (i < 0) continue;
        const k = l.slice(0, i).toLowerCase();
        const v = l.slice(i + 1).trim();
        if (k === 'set-cookie') cookies.push(v.split(';')[0]);
        else headers[k] = v;
      }
      resolve({ status, headers, cookies, body });
    });
    c.stdin.end(o.body === undefined ? '' : JSON.stringify(o.body));
  });
}

async function portIsFree(port) {
  const r = await new Promise((resolve) => {
    const c = spawn(
      'curl',
      [
        '-q',
        '-4',
        '-s',
        '-o',
        '/dev/null',
        '--max-time',
        '2',
        '--noproxy',
        '*',
        `http://127.0.0.1:${port}/`,
      ],
      {
        env: { PATH: SAFE_PATH },
        stdio: 'ignore',
      },
    );
    c.on('close', (code) => resolve(code));
    c.on('error', () => resolve(-1));
  });
  return r === 7; // curl: could not connect
}

const stripTags = (html) =>
  html
    .replace(/<[^>]*>/g, '\n')
    .replace(/&amp;/g, '&')
    .replace(/&#x27;/g, "'");

async function prepareDatabase(dir, cred) {
  const { openDatabase, migrate } = await import('../packages/db/src/index.ts');
  const { seedCatalogue, SEED_DATA } = await import('../domain/catalogue/src/index.ts');
  const ids = cryptoIds();
  const db = await openDatabase({ kind: 'pglite-disk', dir });
  try {
    await migrate(db, clock);
    await seedCatalogue(db, clock, ids, SEED_DATA);
    const at = clock.now().toISOString();
    const until = new Date(clock.now().getTime() + 86_400_000).toISOString();
    await db.query(
      `UPDATE publishers SET paypal_merchant_id = 'SBXM' || upper(left(md5(slug), 9)), payee_verified_at = $1, updated_at = $1`,
      [at],
    );
    // Test-only direct insert (see the header): fake credentials, and 'oauth_token' is left out.
    await db.query(
      `INSERT INTO outbound_approvals (id, approval_ref, scope, operations, max_amount_minor, max_calls_per_day, valid_until, approved_by, created_at, updated_at)
       VALUES ($1, $2, 'mvp_b_polling', $3, 2000, 50, $4, 'bu3-proof-test-only', $5, $5)`,
      [ids.next('oap'), cred.ref, ['get_capture'], until, at],
    );
    await db.query(
      `UPDATE safety_switches SET "on" = true, changed_by = 'bu3-proof', changed_at = $1,
              reason = 'bu3 proof: fake credentials, offline', updated_at = $1 WHERE name = 'paypal_outbound'`,
      [at],
    );
  } finally {
    await db.close();
  }
}

async function readProviderCalls(dir) {
  const { openDatabase } = await import('../packages/db/src/index.ts');
  const db = await openDatabase({ kind: 'pglite-disk', dir });
  try {
    const r = await db.query(
      'SELECT operation, outcome FROM provider_calls ORDER BY created_at, id',
    );
    return r.rows.map((x) => ({ operation: String(x.operation), outcome: String(x.outcome) }));
  } finally {
    await db.close();
  }
}

function nextArgs(port, startArgs = []) {
  return [
    join(WEB, 'node_modules/next/dist/bin/next'),
    'start',
    WEB,
    '-H',
    '127.0.0.1',
    '-p',
    String(port),
    ...startArgs,
  ];
}

async function runProof() {
  const ids = cryptoIds();
  const tmp = mkdtempSync(join(tmpdir(), 'bu3-next-proof-'));
  const dbDir = join(tmp, 'db');
  const home = join(tmp, 'home');
  mkdirSync(home, { recursive: true });
  writeFileSync(join(tmp, 'x.cjs'), '// empty preload used only by the override run\n');
  const nonce = ids.nonce();
  const cred = {
    ref: APPROVAL_REF,
    client_id: `fake-client-id-bu3-${nonce.slice(0, 12)}`,
    client_secret: `fake-client-secret-bu3-${nonce.slice(12)}`,
  };
  const basic = Buffer.from(`${cred.client_id}:${cred.client_secret}`).toString('base64');
  const secrets = [cred.client_id, cred.client_secret, basic, PASSCODE];
  const passHash = `scrypt$16384$8$1$${SALT}$${scryptSync(PASSCODE.normalize('NFKC'), Buffer.from(SALT, 'hex'), 32, { N: 16384, r: 8, p: 1, maxmem: 256 * 16384 * 8 }).toString('hex')}`;
  const baseEnv = (port) => ({
    PATH: SAFE_PATH,
    HOME: home,
    TMPDIR: tmp,
    NEXT_TELEMETRY_DISABLED: '1',
    UMS_MODE: 'sandbox',
    UMS_PAYPAL_CONNECT: 'on',
    NEXT_PUBLIC_UMS_ENV_LABEL: 'Sandbox',
    UMS_OUTBOUND_APPROVAL_REF: cred.ref,
    UMS_DB: 'pglite-disk',
    UMS_PGLITE_DIR: dbDir,
    UMS_SESSION_SECRET: `bu3-proof-session-${nonce}`,
    UMS_APPROVAL_SECRET: `bu3-proof-approval-${nonce.split('').reverse().join('')}`,
    UMS_LINK_SECRET: `bu3-proof-link-${nonce.slice(8)}${nonce.slice(0, 8)}x`,
    PAYPAL_CLIENT_ID: cred.client_id,
    PAYPAL_CLIENT_SECRET: cred.client_secret,
    UMS_DEMO_PASSCODE_HASH: passHash,
    UMS_PUBLIC_ORIGIN: `http://localhost:${port}`,
    NODE_ENV: 'production',
  });

  const pids = [];
  let live = null;
  const result = { ok: false, temp_dir: tmp, server_pids: pids };
  try {
    // 1. the database
    say(
      'prepare: temp database, catalogue, made-up payee, one approval row (get_capture only), switch on',
    );
    await prepareDatabase(dbDir, cred);

    // 2. build (the lock is already held)
    say('build: next build (flock held)');
    const t0 = nowMs();
    const build = spawn(process.execPath, [join(WEB, 'node_modules/next/dist/bin/next'), 'build'], {
      cwd: WEB,
      env: baseEnv(3000),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const b = collect(build);
    await b.done;
    const buildMs = nowMs() - t0;
    if (b.exit.code !== 0) {
      const tail = `${b.stdout}\n${b.stderr}`
        .split('\n')
        .filter((l) => !lineHasSecret(l, secrets))
        .slice(-30)
        .join('\n');
      process.stderr.write(`next build failed (exit ${b.exit.code}):\n${tail}\n`);
      return { ...result, setup_error: 'build failed' };
    }

    // 3. start
    let port = 0;
    let server = null;
    const t1 = nowMs();
    for (const candidate of portCandidates(process.pid, 8)) {
      if (!(await portIsFree(candidate))) continue;
      const child = spawn(process.execPath, nextArgs(candidate), {
        cwd: WEB,
        env: baseEnv(candidate),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      pids.push(child.pid);
      const col = collect(child);
      let up = false;
      for (let i = 0; i < 240 && col.exit === null && !up; i += 1) {
        await sleep(250);
        up = (await curl('GET', `http://127.0.0.1:${candidate}/healthz`)).status === 200;
      }
      if (up) {
        port = candidate;
        server = { child, col };
        break;
      }
      child.kill('SIGKILL');
      await col.done;
      if (!/EADDRINUSE/.test(col.stderr + col.stdout)) {
        process.stderr.write('the server did not come up on its first free port\n');
        return { ...result, setup_error: 'server did not start' };
      }
    }
    if (server === null) return { ...result, setup_error: 'no free port' };
    live = server;
    const startMs = nowMs() - t1;
    say(`start: listening on 127.0.0.1:${port} after ${startMs} ms (health 200)`);

    // 4. requests
    const base = `http://127.0.0.1:${port}`;
    const origin = `http://localhost:${port}`;
    const steps = [];
    const note = (name, r) => steps.push({ step: name, status: r.status });
    note('GET /', await curl('GET', `${base}/`));
    note('GET offer page', await curl('GET', `${base}/o/harbour-ledger/tide-tables`));

    const signIn = async (persona) => {
      const r = await curl('POST', `${base}/api/session`, {
        headers: { Origin: origin },
        body: { persona, passcode: PASSCODE },
      });
      note(`POST /api/session ${persona}`, r);
      if (r.status !== 200) return null;
      const csrf = JSON.parse(r.body).csrf_token;
      return { cookie: r.cookies.join('; '), csrf };
    };
    const post = async (name, path, s, body, extra = {}) => {
      const r = await curl('POST', `${base}${path}`, {
        headers: { Origin: origin, Cookie: s.cookie, 'X-CSRF-Token': s.csrf, ...extra },
        body,
      });
      note(name, r);
      return r;
    };
    let checkoutStatus = null;
    const buyer = await signIn('buyer-a');
    if (buyer !== null) {
      const q = await post('POST /api/quotes', '/api/quotes', buyer, {
        publisher: 'harbour-ledger',
        offer: 'tide-tables',
        option: 'online_read',
      });
      const quoteId = q.status === 200 ? JSON.parse(q.body).quote_id : null;
      const a =
        quoteId === null
          ? null
          : await post('POST /api/approvals', '/api/approvals', buyer, {
              quote_id: quoteId,
              consent: { terms: true, identity_share: false },
            });
      const approval = a !== null && a.status === 201 ? JSON.parse(a.body) : null;
      const o =
        approval === null
          ? null
          : await post(
              'POST /api/orders',
              '/api/orders',
              buyer,
              { approval_id: approval.approval_id, token: approval.token },
              { 'Idempotency-Key': `bu3proof-${ids.nonce()}` },
            );
      const order = o !== null && o.status === 201 ? JSON.parse(o.body) : null;
      if (order !== null) {
        const c = await post('POST checkout', `/api/orders/${order.order_ref}/checkout`, buyer, {});
        checkoutStatus = c.status;
      }
    }
    let opsLine = null;
    let gateLines = [];
    const op = await signIn('operator');
    if (op !== null) {
      const page = await curl('GET', `${base}/ops`, { headers: { Cookie: op.cookie } });
      note('GET /ops', page);
      const text = stripTags(page.body)
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
      opsLine = text.find((l) => l.startsWith('Wire self-check:')) ?? null;
      gateLines = text.filter((l) =>
        /^(Mode|Connect flag|Scope served|L[1-5] |PayPal calls|Transport):?/.test(l),
      );
    }
    note('GET /healthz', await curl('GET', `${base}/healthz`));

    // 5. stop
    live.child.kill('SIGTERM');
    const stopTimer = setTimeout(() => live.child.kill('SIGKILL'), 20_000);
    const exit = await live.col.done;
    clearTimeout(stopTimer);
    live = null;
    const providerCalls = await readProviderCalls(dbDir);

    const m =
      opsLine === null
        ? null
        : /impl (\S+), override (yes|no), builtins intact (yes|no), global fetch changed (yes|no)/.exec(
            opsLine,
          );
    const opsSelfcheck =
      m === null
        ? null
        : {
            impl: m[1],
            env_override: m[2] === 'yes',
            builtins_intact: m[3] === 'yes',
            global_fetch_changed_since_load: m[4] === 'yes',
          };
    const start = analyseStart({
      stdout: server.col.stdout,
      stderr: server.col.stderr,
      secrets,
      provider_calls: providerCalls,
      listened: true,
      exit,
      ops_selfcheck: opsSelfcheck,
      checkout_status: checkoutStatus,
    });
    const selfcheckLine = parseOutput(server.col.stdout).events.find(
      (e) => e.msg === 'transport.selfcheck',
    );

    // 6. the override run
    say('override: next start with NODE_OPTIONS=--require=./x.cjs');
    const t2 = nowMs();
    let ovPort = 0;
    for (const candidate of portCandidates(process.pid + 1, 8)) {
      if (await portIsFree(candidate)) {
        ovPort = candidate;
        break;
      }
    }
    const ov = spawn(process.execPath, nextArgs(ovPort), {
      cwd: tmp,
      env: { ...baseEnv(ovPort), NODE_OPTIONS: '--require=./x.cjs' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    pids.push(ov.pid);
    const oc = collect(ov);
    let timedOut = false;
    const ovTimer = setTimeout(() => {
      timedOut = true;
      ov.kill('SIGKILL');
    }, 60_000);
    const ovExit = await oc.done;
    clearTimeout(ovTimer);
    const override = analyseOverride({
      exit: ovExit,
      stdout: oc.stdout,
      stderr: oc.stderr,
      secrets,
      timed_out: timedOut,
    });
    const overrideMs = nowMs() - t2;

    const table = [
      `next build: ${buildMs} ms; next start to first healthy answer: ${startMs} ms; override run: ${overrideMs} ms`,
      '',
      'server run (UMS_MODE=sandbox, fake credentials, approval row lists get_capture only)',
      renderTable(start),
      '',
      `transport.selfcheck line: ${selfcheckLine === undefined ? 'none' : JSON.stringify(selfcheckLine)}`,
      `/ops after load:          ${opsLine ?? 'not read'}`,
      ...gateLines.map((l) => `  /ops ${l}`),
      `steps: ${steps.map((s) => `${s.step} ${s.status}`).join('; ')}`,
      '',
      'override run (NODE_OPTIONS=--require=./x.cjs)',
      renderTable(override),
      `Next printed its Ready line before register() ran: ${override.facts.ready_line_seen}`,
      `refusal line: ${override.facts.refusal_line ?? 'none'}`,
    ].join('\n');

    return {
      ...result,
      ok: start.ok && override.ok,
      start,
      override,
      timings: { build_ms: buildMs, start_ms: startMs, override_ms: overrideMs },
      selfcheck_line: selfcheckLine === undefined ? null : JSON.stringify(selfcheckLine),
      ops_wire_line: opsLine,
      steps,
      table,
    };
  } finally {
    if (live !== null) {
      live.child.kill('SIGKILL');
      await live.col.done;
    }
    rmSync(tmp, { recursive: true, force: true });
  }
}

async function main(argv) {
  const ji = argv.indexOf('--json');
  const jsonPath = ji >= 0 ? argv[ji + 1] : undefined;
  if (!argv.includes('--locked')) {
    if (!existsSync(join(WEB, 'node_modules/next/package.json'))) {
      process.stderr.write(
        'next is not installed (run: corepack pnpm install --frozen-lockfile --offline)\n',
      );
      return 2;
    }
    say(`waiting for ${LOCK_FILE} (flock), then building and starting`);
    const r = spawnSync(
      'flock',
      [LOCK_FILE, process.execPath, ...process.execArgv, SCRIPT, '--locked', ...argv],
      {
        stdio: 'inherit',
        env: { PATH: SAFE_PATH },
      },
    );
    return r.status ?? 2;
  }
  const result = await runProof();
  if (result.setup_error !== undefined) return 2;
  say(result.table);
  if (jsonPath !== undefined) writeFileSync(jsonPath, JSON.stringify(result, null, 2));
  return result.ok ? 0 : 1;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      process.stderr.write(`next-start-proof: ${e instanceof Error ? e.name : 'error'}\n`);
      process.exit(2);
    },
  );
}
