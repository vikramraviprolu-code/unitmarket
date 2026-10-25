// MVP-C offline acceptance C-11 restart_mid_capture (mvp-plan MVP-C table; nfr.md REL-2; lane CO-G).
// A child process runs the real app (sandbox mode, the approved sandbox transport behind a real scoped
// gate, an on-disk PGlite directory). Its Wire is not a socket: every request goes over the child's IPC
// pipe to this test, which plays PayPal with the dry-run order model, and PayPal outlives the child. When
// the child's capture request arrives, this test lets PayPal capture and then kills the child with
// SIGKILL without answering: the capture was sent and its answer never came back. A second child
// opens the same directory (breaking the dead process's lock), recovers, and within two job passes the
// order is terminal or frozen with one sale. A third restart changes nothing. Only scripts may spawn
// (S2). Nothing here reaches a network; the children trace net, tls, http, https, dns and fetch and
// report zero, and each attempt is also sent as one message when it happens, so the child that is
// killed mid-capture is watched while it runs and not only when it reports. The wrappers REFUSE (throw);
// they do not call through.
// The child entry is written to a temp folder, so this file is the only one of the lane. It stays a
// string on purpose (CO-Gb L1): as a real file it would import node:net, tls, http, https, http2, dns
// and diagnostics_channel (S2) and use Date.now() and new Date() (S6), and lint would need a new pinned
// exemption for each. Inside the string those rules do not apply, and nothing here runs outside the
// temp copy.
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createDryRunModel } from '../apps/web/src/server/dryrun-model';
import { systemClock } from '../packages/runtime/src/index';

const ROOT = join(__dirname, '..');

// ---------------------------------------------------------------------------------------------
// The child entry. Plain node with an empty execArgv (sandbox mode refuses loader flags); the
// TypeScript hooks are registered inside the process, as scripts that load the sandbox config do.
// ---------------------------------------------------------------------------------------------
const CHILD = String.raw`
import { pathToFileURL } from 'node:url';
import { syncBuiltinESMExports } from 'node:module';
import dc from 'node:diagnostics_channel';
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
import http2 from 'node:http2';
import dns from 'node:dns';

// Every way to open a connection or resolve a name is refused: the wrapper sends one message to the
// parent AT THE MOMENT of the attempt (so a child that is killed later has already told it) and throws.
const trace = [];
const report = (label) => {
  trace.push(label);
  try { process.send({ t: 'net', label }); } catch { /* the parent is gone */ }
};
const refuse = (label) => () => { report(label); throw new Error(label + ': this child is offline'); };
const guard = (obj, name, label) => { obj[name] = refuse(label); };
for (const n of ['connect', 'createConnection']) guard(net, n, 'net.' + n);
guard(tls, 'connect', 'tls.connect');
for (const n of ['request', 'get']) { guard(http, n, 'http.' + n); guard(https, n, 'https.' + n); }
guard(http2, 'connect', 'http2.connect');
for (const n of ['lookup', 'resolve', 'resolve4', 'resolve6']) guard(dns, n, 'dns.' + n);
// shapes that replacing module exports misses (CO-Gb L1)
guard(net.Socket.prototype, 'connect', 'net.Socket.prototype.connect');
guard(http.Agent.prototype, 'createConnection', 'http.Agent.prototype.createConnection');
guard(https.Agent.prototype, 'createConnection', 'https.Agent.prototype.createConnection');
for (const n of ['lookup', 'lookupService', 'resolve', 'resolve4', 'resolve6', 'resolveAny', 'resolveTxt', 'reverse']) guard(dns.promises, n, 'dns.promises.' + n);
globalThis.fetch = () => { report('fetch'); return Promise.reject(new Error('fetch is not available')); };
// the backstop: Node publishes this for every client socket, whatever route created it
dc.subscribe('net.client.socket', () => report('net.client.socket'));
syncBuiltinESMExports();

const root = process.argv[2];
const load = (p) => import(pathToFileURL(root + '/' + p).href);
(await load('scripts/lib/register-ts.mjs')).registerTs();
const { createApp, installApp } = await load('apps/web/composition.server.ts');
const { testEnv } = await load('apps/web/src/support.ts');

const REF = 'DL-2026-10-25-c11';
const pending = new Map();
let nextId = 0;
const wire = {
  request(r) {
    return new Promise((resolve) => {
      const id = ++nextId;
      pending.set(id, resolve);
      process.send({ t: 'wire', id, req: r });
    });
  },
};

let app = null;
let actor = null;
let jobs = null;
const logs = [];
const send = (m) => process.send(m);
const one = async (sql, p = []) => (await app.db.query(sql, p)).rows[0];

async function init(dir) {
  const env = await testEnv({
    UMS_MODE: 'sandbox',
    UMS_PAYPAL_CONNECT: 'on',
    UMS_OUTBOUND_APPROVAL_REF: REF,
    UMS_OUTBOUND_SCOPE: 'mvp_c_refunds',
    PAYPAL_CLIENT_ID: ['placeholder', 'client', 'id'].join('-'),
    PAYPAL_CLIENT_SECRET: ['placeholder', 'client', 'secret'].join('-'),
    UMS_DB: 'pglite-disk',
    UMS_PGLITE_DIR: dir,
  });
  app = createApp(env, { switch_cache_ms: 0, test_wire: wire, log_sink: (l) => logs.push(l) });
  installApp(app);
  await app.ready();
  const at = new Date().toISOString();
  if ((await one('SELECT 1 AS x FROM outbound_approvals WHERE approval_ref = $1', [REF])) === undefined) {
    await app.db.query(
      "INSERT INTO outbound_approvals (id, approval_ref, scope, operations, max_amount_minor, max_calls_per_day, valid_until, approved_by, created_at, updated_at) VALUES ('oap_c11_00000000000000001', $1, 'mvp_c_refunds', $2, 2000, 300, '2999-01-01T00:00:00Z', 'c11-test', $3, $3)",
      [REF, ['oauth_token', 'create_order', 'get_order', 'capture_order', 'get_capture', 'refund_capture', 'get_refund'], at],
    );
    await app.db.query("UPDATE safety_switches SET \"on\" = true WHERE name = 'paypal_outbound'");
    await app.db.query(
      "UPDATE publishers SET paypal_merchant_id = 'SBXM' || upper(left(md5(slug), 9)), payee_verified_at = $1 WHERE paypal_merchant_id IS NULL",
      [at],
    );
  }
  const b = await one("SELECT id FROM buyers WHERE auth_subject = 'persona:buyer-a'");
  actor = { kind: 'buyer', buyer_id: b.id };
}

async function purchase() {
  const offer = 'knot-notebook';
  const q = await app.engine.quote({ offer: { publisher_slug: 'harbour-ledger', offer_code: offer }, actor, source: 'direct', option: 'online_read' });
  const g = await app.engine.requestApproval({ actor, selection: { kind: 'quote', quote_id: q.value.quote_id }, consent: { terms: true, identity_share: false } });
  const placed = await app.engine.payments.placeOrder({ approval_id: g.value.approval_id, token: g.value.token, actor });
  const co = await app.engine.payments.beginCheckout({ order_id: placed.value.order_id, actor });
  if (!co.ok) throw new Error('checkout ' + co.error.code);
  send({ t: 'purchasing' });
  // The capture request goes out here and is never answered: the parent kills this process.
  await app.engine.payments.onBuyerReturn({ order_ref: placed.value.order_ref, actor });
  send({ t: 'purchase-returned' });
}

const TERMINAL = new Set(['paid', 'paid_partial', 'failed', 'abandoned', 'frozen']);
async function snapshot() {
  const o = await one('SELECT id, status FROM orders ORDER BY created_at DESC LIMIT 1');
  if (o === undefined) return null;
  const n = async (sql) => Number((await one(sql, [o.id])).c);
  const ops = (await app.db.query('SELECT kind, state, attempt, next_retry_at, lease_until, reconcile_until FROM operations WHERE order_id = $1 ORDER BY created_at', [o.id])).rows;
  return {
    ops,
    status: o.status,
    sales: await n("SELECT count(*) AS c FROM ledger_entries l JOIN order_units u ON u.id = l.unit_id WHERE u.order_id = $1 AND l.kind = 'sale'"),
    capture_ids: await n('SELECT count(DISTINCT capture_id) AS c FROM order_units WHERE order_id = $1 AND capture_id IS NOT NULL'),
    entitlements: await n('SELECT count(*) AS c FROM entitlements e JOIN order_units u ON u.id = e.unit_id WHERE u.order_id = $1'),
    open_ops: await n("SELECT count(*) AS c FROM operations WHERE order_id = $1 AND state IN ('prepared','sent','unknown')"),
  };
}

async function runJobs(limitMs) {
  // The lease of a capture that was sent and never answered: a live process may still own it, so the
  // sweeper takes it only when the lease has run out (ASM-05B-1). Passes are counted from that moment.
  const first = await snapshot();
  const lease = first && first.ops.find((o) => o.lease_until) ? new Date(first.ops.find((o) => o.lease_until).lease_until).toISOString() : null;
  jobs = await app.startJobs();
  const all = new Set();
  const afterLease = new Set();
  const t0 = Date.now();
  let snap = await snapshot();
  let resolvedAtMs = null;
  const sample = async () => {
    const h = await app.engine.health();
    if (h.last_pass_at) {
      all.add(h.last_pass_at);
      if (lease === null || h.last_pass_at >= lease) afterLease.add(h.last_pass_at);
    }
  };
  await sample();
  while (!(snap && TERMINAL.has(snap.status) && snap.open_ops === 0) && Date.now() - t0 < limitMs) {
    await new Promise((r) => setTimeout(r, 40));
    await sample();
    snap = await snapshot();
    if (snap && TERMINAL.has(snap.status) && snap.open_ops === 0) resolvedAtMs = Date.now() - t0;
  }
  await sample();
  return { snap, passes: all.size, passes_after_lease: afterLease.size, lease, resolved_after_ms: resolvedAtMs, ms: Date.now() - t0 };
}

// The canary: tries every shape above and counts the refusals. No app is needed.
async function probeNet() {
  const loop = '127.0.0.1';
  const probes = [
    () => net.connect(1, loop),
    () => net.createConnection(1, loop),
    () => tls.connect(1, loop),
    () => http.request('http://127.0.0.1:1/'),
    () => http.get('http://127.0.0.1:1/'),
    () => https.request('https://127.0.0.1:1/'),
    () => https.get('https://127.0.0.1:1/'),
    () => dns.lookup('localhost', () => {}),
    () => dns.resolve('localhost', () => {}),
    () => new net.Socket().connect(1, loop),
    () => dns.promises.lookup('localhost'),
    () => dns.promises.resolve('localhost'),
    () => http2.connect('http://127.0.0.1:1'),
    () => new http.Agent().createConnection({ host: loop, port: 1 }),
    () => new https.Agent().createConnection({ host: loop, port: 1 }),
    () => globalThis.fetch('http://127.0.0.1:1/'),
  ];
  let refused = 0;
  for (const probe of probes) {
    try {
      const r = probe();
      if (r && typeof r.then === 'function') await r.then(() => {}, () => { refused += 1; });
    } catch { refused += 1; }
  }
  return refused;
}

// The parent is gone (a failed test, a killed run): do not outlive it.
process.on('disconnect', () => process.exit(0));

process.on('message', async (m) => {
  try {
    if (m.t === 'probe-net') { send({ t: 'probe-done', refused: await probeNet() }); return; }
    if (m.t === 'wire-reply') { pending.get(m.id)?.(m.result); pending.delete(m.id); return; }
    if (m.t === 'init') { await init(m.dir); send({ t: 'ready', trace }); return; }
    if (m.t === 'purchase') { await purchase(); return; }
    if (m.t === 'jobs') {
      const r = await runJobs(m.limit_ms);
      send({ t: 'jobs-done', ...r, trace, logs: logs.slice(-40) });
      return;
    }
    if (m.t === 'snapshot') { send({ t: 'snapshot', snap: await snapshot(), trace }); return; }
    if (m.t === 'exit') {
      await jobs?.stop();
      await app.close();
      send({ t: 'bye', trace });
      process.exit(0);
    }
  } catch (e) {
    send({ t: 'error', message: e instanceof Error ? e.message : String(e) });
  }
});
send({ t: 'up' });
`;

// ---------------------------------------------------------------------------------------------
// The parent: PayPal, played by the order model, and the process control.
// ---------------------------------------------------------------------------------------------
interface Snap {
  status: string;
  sales: number;
  capture_ids: number;
  entitlements: number;
  open_ops: number;
}
type Msg = { t: string; [k: string]: unknown };
interface WireReq {
  method: 'GET' | 'POST';
  url: string;
  headers: Record<string, string>;
  body: string | null;
}

const made: string[] = [];
const started: ChildProcess[] = [];
afterAll(() => {
  // a failed run must not leave a child behind
  for (const c of started) if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL');
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

function world() {
  const dir = mkdtempSync(join(tmpdir(), 'c11-'));
  made.push(dir);
  const data = join(dir, 'pglite');
  const script = join(dir, 'child.mjs');
  writeFileSync(script, CHILD);
  const model = createDryRunModel(systemClock(), { own_merchant_id: null });
  const seen: { op: string; path: string }[] = [];
  let killOnCapture = false;
  let lastCreated = '';

  const reply = (status: number, body: unknown) => ({
    kind: 'response' as const,
    status,
    headers: { 'content-type': 'application/json', 'paypal-debug-id': `c11dbg${seen.length}` },
    body: JSON.stringify(body),
  });
  /** PayPal. Returns null for "do not answer" (the capture request that kills its caller). */
  function paypal(r: WireReq, child: ChildProcess) {
    const path = new URL(r.url).pathname;
    if (r.method === 'POST' && path === '/v1/oauth2/token') {
      seen.push({ op: 'oauth_token', path });
      return reply(200, {
        access_token: 'c11-tok-c0ffee',
        token_type: 'Bearer',
        expires_in: 32400,
      });
    }
    const op =
      r.method === 'POST' && path === '/v2/checkout/orders'
        ? 'create_order'
        : r.method === 'GET' && path.startsWith('/v2/checkout/orders/')
          ? 'get_order'
          : r.method === 'POST' && path.endsWith('/capture')
            ? 'capture_order'
            : r.method === 'GET' && path.startsWith('/v2/payments/captures/')
              ? 'get_capture'
              : 'unknown';
    seen.push({ op, path });
    if (op === 'unknown') return reply(404, { name: 'RESOURCE_NOT_FOUND' });
    const out = model.send({
      operation: op,
      method: r.method,
      path,
      headers: r.headers,
      body: r.body,
      order_ref: null,
      amount_minor: null,
      scenario: null,
    } as never);
    if (op === 'capture_order' && killOnCapture) {
      // PayPal took the capture. The answer never reaches the app: its process dies first.
      child.kill('SIGKILL');
      return null;
    }
    if (out.kind !== 'response') return { kind: 'error' as const, error: 'other' as const };
    if (op === 'create_order') {
      lastCreated = (JSON.parse(out.body) as { id: string }).id;
      model.approve(lastCreated, 'happy'); // the buyer approves at PayPal
    }
    return { kind: 'response' as const, status: out.status, headers: out.headers, body: out.body };
  }

  interface Running {
    child: ChildProcess;
    waitFor(t: string, ms?: number): Promise<Msg>;
    send(m: Msg): void;
    exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
    traces: string[][];
    /** CO-Gb L1: every network attempt the child made, as it made it (one message each, live). */
    net: string[];
  }
  function start(): Running {
    // empty environment and no Node flags: sandbox mode refuses loader flags and proxy variables
    const child = spawn(process.execPath, [script, ROOT], {
      cwd: ROOT,
      env: {},
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    started.push(child);
    const waiters: { t: string; ok: (m: Msg) => void; bad: (e: Error) => void }[] = [];
    const inbox: Msg[] = [];
    const traces: string[][] = [];
    const net: string[] = [];
    let stderr = '';
    child.stderr?.on('data', (d: Buffer) => (stderr += d.toString()));
    child.stdout?.on('data', () => undefined);
    const deliver = (m: Msg) => {
      if (Array.isArray(m['trace'])) traces.push(m['trace'] as string[]);
      const i = waiters.findIndex((w) => w.t === m.t || m.t === 'error');
      if (i >= 0) {
        const w = waiters.splice(i, 1)[0]!;
        if (m.t === 'error') w.bad(new Error(String(m['message'])));
        else w.ok(m);
      } else inbox.push(m);
    };
    child.on('message', (raw) => {
      const m = raw as Msg;
      if (m.t === 'net') {
        net.push(String(m['label']));
        return;
      }
      if (m.t === 'wire') {
        const answer = paypal(m['req'] as WireReq, child);
        if (answer !== null && child.connected)
          child.send({ t: 'wire-reply', id: m['id'], result: answer });
        return;
      }
      deliver(m);
    });
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((res) =>
      child.on('exit', (code, signal) => res({ code, signal })),
    );
    void exited.then(() => {
      for (const w of waiters.splice(0))
        w.bad(new Error(`child exited. stderr: ${stderr.slice(-400)}`));
    });
    return {
      child,
      traces,
      net,
      exited,
      send: (m) => void child.send(m),
      waitFor(t, ms = 60_000) {
        const i = inbox.findIndex((m) => m.t === t);
        if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]!);
        return new Promise<Msg>((ok, bad) => {
          const timer = setTimeout(() => bad(new Error(`timeout waiting for ${t}`)), ms);
          waiters.push({
            t,
            ok: (m) => (clearTimeout(timer), ok(m)),
            bad: (e) => (clearTimeout(timer), bad(e)),
          });
        });
      },
    };
  }
  return {
    data,
    seen,
    start,
    kill_on_capture(on: boolean) {
      killOnCapture = on;
    },
    captures: () => seen.filter((s) => s.op === 'capture_order').length,
    created: () => lastCreated,
  };
}

/** The child's final reports and the live messages it sent while it ran (a killed child sent only those). */
const noSockets = (...children: Array<{ traces: string[][]; net: string[] }>) =>
  expect(children.flatMap((c) => [...c.traces.flat(), ...c.net])).toEqual([]);

// Every way a child could open a connection or resolve a name, as the child's own `probe-net` message
// tries them (CO-Gb L1). Each is refused by the child's wrapper and sent to the parent when it happens.
const PROBED = [
  'net.connect',
  'net.createConnection',
  'tls.connect',
  'http.request',
  'http.get',
  'https.request',
  'https.get',
  'dns.lookup',
  'dns.resolve',
  'net.Socket.prototype.connect',
  'dns.promises.lookup',
  'dns.promises.resolve',
  'http2.connect',
  'http.Agent.prototype.createConnection',
  'https.Agent.prototype.createConnection',
  'fetch',
];

describe('C-11 restart_mid_capture', () => {
  it('C-11 the children watch the network while they run: every way to open a connection is refused and sent live, before any report', async () => {
    const w = world();
    const a = w.start();
    await a.waitFor('up');
    a.send({ t: 'probe-net' });
    const done = await a.waitFor('probe-done', 15_000);
    expect(done['refused']).toBe(PROBED.length);
    // the live messages alone (no `ready` or `bye` report has been sent) name every probe, in order
    expect(a.net).toEqual(PROBED);
    expect(a.traces).toEqual([]);
    a.child.kill('SIGKILL');
    await a.exited;
  }, 60_000);

  it('C-11 kill -9 between the capture send and its answer: after the restart the order is terminal or frozen within two job passes, with one sale', async () => {
    const w = world();

    // run 1: buy, and die when the capture request is out
    const a = w.start();
    await a.waitFor('up');
    a.send({ t: 'init', dir: w.data });
    await a.waitFor('ready');
    w.kill_on_capture(true);
    a.send({ t: 'purchase' });
    await a.waitFor('purchasing');
    const gone = await a.exited;
    expect(gone.signal).toBe('SIGKILL');
    expect(w.captures()).toBe(1); // PayPal has the capture; the app never saw the answer
    w.kill_on_capture(false);

    // run 2: same directory (the dead process's lock must not block it), recovery, job passes
    const b = w.start();
    await b.waitFor('up');
    b.send({ t: 'init', dir: w.data });
    await b.waitFor('ready', 90_000);
    b.send({ t: 'snapshot' });
    const before = (await b.waitFor('snapshot'))['snap'] as Snap;
    expect(before.sales).toBe(0); // nothing was booked before the crash
    b.send({ t: 'jobs', limit_ms: 120_000 });
    const done = await b.waitFor('jobs-done', 150_000);
    const snap = done['snap'] as Snap;
    // The capture's lease (60 s) keeps the sweeper off it while a live process might own it; the passes
    // that count are the ones from the lease's end. The ones before it are no-ops by design.
    const passes = done['passes_after_lease'] as number;
    console.info(
      `C-11 measured: resolved ${String(done['resolved_after_ms'])} ms after the restart, passes from the lease end ${String(passes)}, passes in all ${String(done['passes'])}, final ${snap.status}`,
    );
    expect(['paid', 'paid_partial', 'failed', 'abandoned', 'frozen']).toContain(snap.status);
    expect(passes).toBeLessThanOrEqual(2);
    expect(snap.open_ops).toBe(0);
    // PayPal captured once, so the right end is paid with exactly one sale and one unlock
    expect(snap).toMatchObject({ status: 'paid', sales: 1, capture_ids: 1, entitlements: 1 });
    expect(w.captures()).toBe(1); // recovery read the order; it never sent a second capture
    b.send({ t: 'exit' });
    await b.waitFor('bye');
    await b.exited;
    noSockets(a, b);

    // run 3: another restart changes nothing
    const c = w.start();
    await c.waitFor('up');
    c.send({ t: 'init', dir: w.data });
    await c.waitFor('ready', 90_000);
    c.send({ t: 'jobs', limit_ms: 15_000 });
    const again = (await c.waitFor('jobs-done', 90_000))['snap'] as Snap;
    expect(again).toMatchObject({ status: 'paid', sales: 1, capture_ids: 1, entitlements: 1 });
    expect(w.captures()).toBe(1);
    c.send({ t: 'exit' });
    await c.waitFor('bye');
    await c.exited;
    noSockets(c);
  }, 300_000);
});
