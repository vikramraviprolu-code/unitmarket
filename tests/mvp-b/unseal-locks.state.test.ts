// BU-2 acceptance (state): the five locks decide every call at the time of the call. Real in-memory
// database, real scoped gate (through buildOutbound), real approval rows (in-memory only), a
// counting fake Wire. Nothing reaches a network; the production Wire is never built here.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAuditSink } from '@umsbx/obs';
import { cryptoIds, systemClock } from '@umsbx/runtime';
import { runResume } from '@umsbx/safety';
import {
  DOMAIN_CONFIG,
  SANDBOX_MIN_CALL_GAP_MS,
  SANDBOX_REREAD_PAID_EVERY_MS,
  createApp,
  installApp,
} from '../../apps/web/composition.server';
import { DomainConfigSchema } from '@umsbx/contracts';
import { loadConfig } from '@umsbx/config';
import type { App } from '../../apps/web/composition.server';
import { call, signIn, testEnv } from '../../apps/web/src/support';
import {
  REF,
  T0,
  countingWire,
  insertApproval,
  makeRig,
  req,
  sandboxEnv,
  setOutboundSwitch,
} from './unseal-support';
import type { Rig, RigOptions } from './unseal-support';

vi.mock('server-only', () => ({}));
// Every rig opens and migrates its own in-memory database: slow on a loaded machine.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const rigs: Rig[] = [];
const apps: App[] = [];
afterEach(async () => {
  for (const r of rigs.splice(0)) await r.close();
  for (const a of apps.splice(0)) await a.close();
});
async function rig(o: RigOptions = {}): Promise<Rig> {
  const r = await makeRig(o);
  rigs.push(r);
  return r;
}
const builtLines = (r: Rig) => r.log.events.filter((e) => e.msg === 'outbound.transport_built');

describe('each lock missing alone (L1 to L5) gives blocked with its reason and 0 Wire calls', () => {
  const cases: [
    string,
    RigOptions,
    string,
    keyof Awaited<ReturnType<Rig['outbound']['status']>>['locks'],
  ][] = [
    ['L1 mode is offline', { mode: 'offline' }, 'connect_off', 'l1_mode_sandbox'],
    ['L2 connect flag off', { connect: false }, 'connect_off', 'l2_connect_on'],
    ['L3 no approval row', { approval: false }, 'no_approval', 'l3_approval_active'],
    [
      'L3 approval row for another scope',
      { approval: { scope: 'mvp_c_refunds' } },
      'no_approval',
      'l3_approval_active',
    ],
    ['L3 approval ref not configured', { ref: null }, 'no_approval', 'l3_approval_active'],
    [
      'L3 approval row already expired',
      { approval: { valid_until: '2026-10-23T09:00:00Z' } },
      'no_approval',
      'l3_approval_active',
    ],
    ['L4 kill switch off', { switch_on: false }, 'kill_switch', 'l4_switch_on'],
    ['L5 no credentials', { credentials: false }, 'egress', 'l5_credentials_and_wire_ok'],
    [
      'L5 production Wire with an override in the environment',
      {
        wire: null,
        selfcheck: () => ({
          impl: 'node-https' as const,
          env_override: true,
          builtins_intact: true,
          global_fetch_changed_since_load: false,
        }),
      },
      'egress',
      'l5_credentials_and_wire_ok',
    ],
    [
      'L5 production Wire with changed builtins',
      {
        wire: null,
        selfcheck: () => ({
          impl: 'node-https' as const,
          env_override: false,
          builtins_intact: false,
          global_fetch_changed_since_load: false,
        }),
      },
      'egress',
      'l5_credentials_and_wire_ok',
    ],
  ];
  it.each(cases)('%s', async (_name, o, by, lock) => {
    const r = await rig(o);
    expect(await r.outbound.transport.send(req.getOrder())).toEqual({ kind: 'blocked', by });
    expect(r.counting.calls).toHaveLength(0);
    expect(builtLines(r)).toHaveLength(0);
    // a lock that is missing means no build attempt at all, not an attempt that fails
    expect(r.log.events.some((e) => e.msg === 'outbound.build_failed')).toBe(false);
    expect(await r.reservations()).toBe(0);
    const st = await r.outbound.status();
    expect(st.open).toBe(false);
    expect(st.transport_built).toBe(false);
    expect(st.locks[lock]).toBe(false);
    // every other lock reads open (mode L1 and connect L2 are config; the rest come from the rows)
    for (const [k, v] of Object.entries(st.locks)) if (k !== lock) expect(v, k).toBe(true);
  });
});

describe('all five present', () => {
  it('all five present: one Wire call per allowed request', async () => {
    const r = await rig();
    const out = [];
    for (let i = 0; i < 3; i += 1) out.push(await r.outbound.transport.send(req.getOrder()));
    expect(out.map((x) => x.kind)).toEqual(['response', 'response', 'response']);
    expect(r.counting.calls).toHaveLength(3);
    expect(await r.reservations()).toBe(3);
    expect(builtLines(r)).toHaveLength(1);
    const st = await r.outbound.status();
    expect(st.open).toBe(true);
    expect(st.blocked_by).toBeNull();
    expect(st.transport_built).toBe(true);
    // the Wire saw only the sandbox host, over https
    for (const c of r.counting.calls) expect(c.url.startsWith('https://')).toBe(true);
  });
});

describe('status() reads the approval row the way the gate does (BU-2 review nit)', () => {
  it('a row that does not list the operations of the scope is not reported as an active approval', async () => {
    const r = await rig({ approval: { ops: ['oauth_token'] } });
    const st = await r.outbound.status();
    expect(st.locks.l3_approval_active).toBe(false);
    expect(st.open).toBe(false);
    expect(st.blocked_by).toBe('no_approval');
  });
  it('a row listing the five operations of the phase is', async () => {
    const r = await rig();
    expect((await r.outbound.status()).locks.l3_approval_active).toBe(true);
  });
  it('a row missing just one of the five (get_capture) is not', async () => {
    const r = await rig({
      approval: { ops: ['oauth_token', 'create_order', 'get_order', 'capture_order'] },
    });
    expect((await r.outbound.status()).locks.l3_approval_active).toBe(false);
  });
});

describe('the gate decides each request after the build', () => {
  it('approval row expires mid-session: next request blocked no_approval, 0 Wire calls', async () => {
    const r = await rig();
    expect((await r.outbound.transport.send(req.getOrder())).kind).toBe('response');
    expect(r.counting.calls).toHaveLength(1);
    r.clock.set('2026-10-24T00:00:01Z');
    expect(await r.outbound.transport.send(req.getOrder())).toEqual({
      kind: 'blocked',
      by: 'no_approval',
    });
    expect(r.counting.calls).toHaveLength(1);
    expect((await r.outbound.status()).locks.l3_approval_active).toBe(false);
  });

  it('switch turned off mid-session: next request blocked kill_switch, 0 Wire calls', async () => {
    const r = await rig();
    await r.outbound.transport.send(req.getOrder());
    await setOutboundSwitch(r.db, false);
    expect(await r.outbound.transport.send(req.getOrder())).toEqual({
      kind: 'blocked',
      by: 'kill_switch',
    });
    expect(r.counting.calls).toHaveLength(1);
    // and back on: the same built transport serves again, no second build
    await setOutboundSwitch(r.db, true);
    expect((await r.outbound.transport.send(req.getOrder())).kind).toBe('response');
    expect(builtLines(r)).toHaveLength(1);
  });

  it('budget spent: blocked budget', async () => {
    const r = await rig({ approval: { max_calls: 2 } });
    expect((await r.outbound.transport.send(req.getOrder())).kind).toBe('response');
    expect((await r.outbound.transport.send(req.getOrder())).kind).toBe('response');
    expect(await r.outbound.transport.send(req.getOrder())).toEqual({
      kind: 'blocked',
      by: 'budget',
    });
    expect(r.counting.calls).toHaveLength(2);
  });

  it('an amount above the approval cap is blocked budget before the Wire', async () => {
    const r = await rig({ approval: { max_amount_minor: 50 } });
    expect(await r.outbound.transport.send(req.createOrder({ value: '1.00', minor: 100 }))).toEqual(
      { kind: 'blocked', by: 'budget' },
    );
    expect(r.counting.calls).toHaveLength(0);
  });

  it('an operation outside the approval row is blocked no_approval', async () => {
    const r = await rig({ approval: { ops: ['oauth_token'] } });
    expect(await r.outbound.transport.send(req.getOrder())).toEqual({
      kind: 'blocked',
      by: 'no_approval',
    });
    expect(r.counting.calls).toHaveLength(0);
  });
});

describe('stop via /api/ops/stop', () => {
  async function sandboxApp(): Promise<{
    app: App;
    wire: ReturnType<typeof countingWire>;
    stop: (typeof import('../../apps/web/src/app/api/ops/stop/route'))['POST'];
    session: { POST: Parameters<typeof signIn>[0] };
  }> {
    const wire = countingWire();
    const app = createApp(await sandboxEnv(), { switch_cache_ms: 0, test_wire: wire.wire });
    installApp(app);
    await app.ready();
    apps.push(app);
    await insertApproval(app.db, { ref: REF });
    await setOutboundSwitch(app.db, true);
    const stop = (await import('../../apps/web/src/app/api/ops/stop/route')).POST;
    const session = await import('../../apps/web/src/app/api/session/route');
    return { app, wire, stop, session };
  }

  it('stop via /api/ops/stop: next request blocked kill_switch', async () => {
    const { app, wire, stop, session } = await sandboxApp();
    const out = app.outbound;
    expect(out).not.toBeNull();
    expect((await out!.transport.send(req.getOrder())).kind).toBe('response');
    const op = await signIn(session.POST, 'operator');
    expect(op).not.toBeNull();
    const res = await call(stop, {
      url: '/api/ops/stop',
      method: 'POST',
      session: op,
      body: { reason: 'drill from the ops page' },
    });
    expect(res.status).toBe(200);
    expect(await out!.transport.send(req.getOrder())).toEqual({
      kind: 'blocked',
      by: 'kill_switch',
    });
    expect(wire.calls).toHaveLength(1);
    const audit = await app.db.query<{ action: string; reason: string }>(
      `SELECT action, reason FROM audit_log WHERE action = 'switch.paypal_outbound.off'`,
    );
    expect(audit.rows).toEqual([
      { action: 'switch.paypal_outbound.off', reason: 'drill from the ops page' },
    ]);
  });

  it('the route is guarded: no session 401, a buyer 403, no CSRF token 403, no reason refused; nothing turns on', async () => {
    const { app, stop, session } = await sandboxApp();
    const buyer = await signIn(session.POST, 'buyer-a');
    const op = await signIn(session.POST, 'operator');
    const body = { reason: 'x reason' };
    expect((await call(stop, { url: '/api/ops/stop', method: 'POST', body })).status).toBe(401);
    expect(
      (await call(stop, { url: '/api/ops/stop', method: 'POST', session: buyer, body })).status,
    ).toBe(403);
    expect(
      (await call(stop, { url: '/api/ops/stop', method: 'POST', session: op, body, csrf: false }))
        .status,
    ).toBe(403);
    for (const bad of [{}, { reason: '' }, { reason: '   ' }, { reason: 'ok', on: true }]) {
      const r = await call(stop, { url: '/api/ops/stop', method: 'POST', session: op, body: bad });
      expect(r.status, JSON.stringify(bad)).toBeGreaterThanOrEqual(400);
      expect(r.status).toBeLessThan(500);
    }
    const sw = await app.db.query<{ on: boolean }>(
      `SELECT "on" FROM safety_switches WHERE name = 'paypal_outbound'`,
    );
    expect(sw.rows[0]?.on).toBe(true);
  });

  it('the route can only turn the switch off: a second press keeps it off and never turns anything on', async () => {
    const { app, stop, session } = await sandboxApp();
    const op = await signIn(session.POST, 'operator');
    for (let i = 0; i < 2; i += 1) {
      const r = await call(stop, {
        url: '/api/ops/stop',
        method: 'POST',
        session: op,
        body: { reason: `press ${i}` },
      });
      expect(r.status).toBe(200);
    }
    const sw = await app.db.query<{ name: string; on: boolean }>(
      `SELECT name, "on" FROM safety_switches WHERE name = 'paypal_outbound'`,
    );
    expect(sw.rows).toEqual([{ name: 'paypal_outbound', on: false }]);
  });
});

describe('safety:resume refuses without TTY, in CI, without an active row, with a wrong typed scope', () => {
  async function resumeRig(o: RigOptions = {}) {
    const r = await rig({ switch_on: false, ...o });
    const asked: string[] = [];
    const said: string[] = [];
    const base = {
      db: r.db,
      clock: r.clock,
      audit: createAuditSink(cryptoIds(), systemClock()),
      tty: { isTTY: true as boolean | undefined, env: {} as Record<string, string | undefined> },
      ask: async (p: string) => {
        asked.push(p);
        return 'mvp_b_polling';
      },
      write: (l: string) => void said.push(l),
      operator_id: 'owner-1',
      approval_ref: REF as string | null,
      scope: 'mvp_b_polling',
      reason: 'owner resumes after the drill',
    };
    const sw = async () =>
      (
        await r.db.query<{ on: boolean }>(
          `SELECT "on" FROM safety_switches WHERE name = 'paypal_outbound'`,
        )
      ).rows[0]?.on;
    const audits = async () =>
      Number(
        (
          await r.db.query<{ n: string }>(
            `SELECT count(*) AS n FROM audit_log WHERE action = 'switch.paypal_outbound.on'`,
          )
        ).rows[0]?.n,
      );
    return { r, base, asked, said, sw, audits };
  }

  it.each([
    ['no TTY', { isTTY: false, env: {} }, 'not_a_tty'],
    ['stdin TTY unknown', { isTTY: undefined, env: {} }, 'not_a_tty'],
    ['CI set', { isTTY: true, env: { CI: 'true' } }, 'ci_set'],
    ['GITHUB_ACTIONS set', { isTTY: true, env: { GITHUB_ACTIONS: 'true' } }, 'ci_set'],
    ['an AI session (CLAUDECODE)', { isTTY: true, env: { CLAUDECODE: '1' } }, 'ai_session'],
    [
      'an AI session (CLAUDE_CODE_REMOTE)',
      { isTTY: true, env: { CLAUDE_CODE_REMOTE: 'true' } },
      'ai_session',
    ],
  ])('refuses: %s, asks nothing, changes nothing', async (_n, tty, code) => {
    const t = await resumeRig();
    const res = await runResume({ ...t.base, tty });
    expect(res).toEqual({ ok: false, error: code });
    expect(t.asked).toEqual([]);
    expect(await t.sw()).toBe(false);
    expect(await t.audits()).toBe(0);
  });

  it('refuses without an active approval row for the configured ref (none, expired, other ref, no ref)', async () => {
    for (const o of [
      { approval: false as const },
      { approval: { valid_until: '2026-10-23T09:00:00Z' } },
    ]) {
      const t = await resumeRig(o);
      expect(await runResume(t.base)).toEqual({ ok: false, error: 'no_active_approval' });
      expect(t.asked).toEqual([]);
      expect(await t.sw()).toBe(false);
    }
    const t = await resumeRig();
    expect(await runResume({ ...t.base, approval_ref: 'some-other-ref' })).toEqual({
      ok: false,
      error: 'no_active_approval',
    });
    expect(await runResume({ ...t.base, approval_ref: null })).toEqual({
      ok: false,
      error: 'no_active_approval',
    });
    expect(await t.sw()).toBe(false);
  });

  it('refuses when the row is for another scope than the app serves', async () => {
    const t = await resumeRig({ approval: { scope: 'mvp_c_refunds' } });
    expect(await runResume(t.base)).toEqual({ ok: false, error: 'scope_mismatch' });
    expect(await t.sw()).toBe(false);
  });

  it.each(['mvp_c_refunds', '', 'mvp_b_pollin', 'MVP_B_POLLING'])(
    'refuses a wrong typed scope (%j) and writes nothing',
    async (typed) => {
      const t = await resumeRig();
      const res = await runResume({ ...t.base, ask: async () => typed });
      expect(res).toEqual({ ok: false, error: 'scope_not_confirmed' });
      expect(await t.sw()).toBe(false);
      expect(await t.audits()).toBe(0);
    },
  );

  it('refuses an empty reason before it asks anything', async () => {
    const t = await resumeRig();
    expect(await runResume({ ...t.base, reason: '   ' })).toEqual({
      ok: false,
      error: 'reason_required',
    });
    expect(t.asked).toEqual([]);
    expect(await t.sw()).toBe(false);
  });

  it('a row that expires while the owner is typing is checked again by the switch change: refused, switch stays off', async () => {
    const t = await resumeRig();
    const res = await runResume({
      ...t.base,
      ask: async () => {
        t.r.clock.set('2026-10-24T00:00:01Z');
        return 'mvp_b_polling';
      },
    });
    expect(res).toEqual({ ok: false, error: 'no_active_approval' });
    expect(await t.sw()).toBe(false);
    expect(await t.audits()).toBe(0);
  });

  it('with a terminal, an active row and the scope typed back: the switch goes on, with an audit row for an operator with mfa', async () => {
    const t = await resumeRig();
    const res = await runResume(t.base);
    expect(res).toEqual({ ok: true, value: { approval_ref: REF, scope: 'mvp_b_polling' } });
    expect(t.asked).toHaveLength(1);
    expect(t.asked[0]).toContain('mvp_b_polling');
    expect(await t.sw()).toBe(true);
    const rows = await t.r.db.query<{
      actor_kind: string;
      actor_id: string;
      reason: string;
      detail: unknown;
    }>(
      `SELECT actor_kind, actor_id, reason, detail FROM audit_log WHERE action = 'switch.paypal_outbound.on'`,
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({
      actor_kind: 'operator',
      actor_id: 'owner-1',
      reason: 'owner resumes after the drill',
    });
    // and the lock reads open now
    expect((await t.r.outbound.status()).locks.l4_switch_on).toBe(true);
  });

  it('the CLI command is wired in package.json and the script knows resume', () => {
    const pkg = JSON.parse(
      readFileSync(join(import.meta.dirname, '../../package.json'), 'utf8'),
    ) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts['safety:resume']).toContain('scripts/safety-cli.mjs');
    expect(pkg.scripts['safety:resume']).toMatch(/safety-cli\.mjs resume$/);
    // BU-6: scripts/safety-cli.mjs is a launcher; the commands live in its body
    const cli = readFileSync(
      join(import.meta.dirname, '../../scripts/lib/safety-cli-main.mjs'),
      'utf8',
    );
    expect(cli).toContain("'resume'");
    expect(cli).toContain('runResume');
  });
});

describe('the rig itself', () => {
  it('starts with the paypal_outbound switch off in a fresh database (the migration seeds it off)', async () => {
    const r = await rig({ switch_on: false });
    expect((await r.outbound.status()).locks.l4_switch_on).toBe(false);
    expect(T0).toBe('2026-10-23T10:00:00Z');
  });
});

describe('the polling wiring of the sandbox app (BU-5 notes for BU-2)', () => {
  it('the sandbox domain config re-reads paid orders every 21,600,000 ms and spaces calls 500 ms; dry run sets neither', async () => {
    const sandbox = loadConfig(await sandboxEnv());
    const offline = loadConfig(
      await sandboxEnv({ UMS_MODE: 'offline', UMS_PAYPAL_CONNECT: 'off' }),
    );
    if (!sandbox.ok || !offline.ok) throw new Error('config');
    const dc = DOMAIN_CONFIG(sandbox.value);
    expect(dc.reread_paid_every_ms).toBe(21_600_000);
    expect(dc.min_call_gap_ms).toBe(500);
    expect([SANDBOX_REREAD_PAID_EVERY_MS, SANDBOX_MIN_CALL_GAP_MS]).toEqual([21_600_000, 500]);
    expect(DomainConfigSchema.safeParse(dc).success).toBe(true);
    const dry = DOMAIN_CONFIG(offline.value);
    expect(dry.reread_paid_every_ms).toBeUndefined();
    expect(dry.min_call_gap_ms).toBeUndefined();
  });

  it('a cadence outside 1 ms to 24 h does not take the app down: the loop stays off, a loud log says so, /ops still answers', async () => {
    const lines: string[] = [];
    const app = createApp(await sandboxEnv(), {
      switch_cache_ms: 0,
      log_sink: (l) => lines.push(l),
      test_wire: countingWire().wire,
      test_domain: { reread_paid_every_ms: 90_000_000 },
    });
    installApp(app);
    await app.ready();
    apps.push(app);
    const jobs = await app.startJobs();
    await jobs.stop();
    const off = lines.filter((l) => l.includes('jobs.loop.not_started'));
    expect(off).toHaveLength(1);
    expect(JSON.parse(off[0] as string).level).toBe('error');
    expect(lines.some((l) => l.includes('jobs.loop.bad_config'))).toBe(true);
    const snap = await app.engine.opsSnapshot({
      kind: 'operator',
      operator_id: 'opr_demo',
      mfa: false,
    });
    expect(snap).not.toBeNull();
  });

  it('the call budget is never null in sandbox mode: with no approval row the loop reads 0 remaining, makes no call and never logs no_call_budget; one loop per app', async () => {
    const lines: string[] = [];
    const wire = countingWire();
    const app = createApp(await sandboxEnv(), {
      switch_cache_ms: 0,
      log_sink: (l) => lines.push(l),
      test_wire: wire.wire,
    });
    installApp(app);
    await app.ready();
    apps.push(app);
    await setOutboundSwitch(app.db, true);
    const a = await app.startJobs();
    const b = await app.startJobs();
    expect(b).toBe(a);
    await new Promise((r) => setTimeout(r, 500));
    await a.stop();
    expect(lines.some((l) => l.includes('jobs.loop.no_call_budget'))).toBe(false);
    expect(wire.calls).toHaveLength(0);
  });

  it('transport.selfcheck is logged once per process and is part of the ops snapshot', async () => {
    const lines: string[] = [];
    const app = createApp(await sandboxEnv(), {
      switch_cache_ms: 0,
      log_sink: (l) => lines.push(l),
      test_wire: countingWire().wire,
    });
    installApp(app);
    await app.ready();
    apps.push(app);
    const op = { kind: 'operator', operator_id: 'opr_demo', mfa: false } as const;
    await app.engine.opsSnapshot(op);
    await app.engine.opsSnapshot(op);
    const jobs = await app.startJobs();
    await jobs.stop();
    expect(lines.filter((l) => l.includes('transport.selfcheck'))).toHaveLength(1);
  });
});

// ---- BU-7 (D-028): the sandbox seed of the one MVP-B publisher ----
describe('BU-7 own payee seed (D-028)', () => {
  const OWN_ID = 'SBXOWNMERCH01';
  const OTHER_ID = 'SBXOWNMERCH02';
  const live: App[] = [];
  const dirs: string[] = [];

  async function boot(env: Record<string, string>, sandbox = true): Promise<App> {
    const counting = countingWire();
    const full = sandbox ? await sandboxEnv(env) : await testEnv(env);
    const app = createApp(full, { switch_cache_ms: 0, test_wire: counting.wire });
    installApp(app);
    live.push(app);
    await app.ready();
    expect(counting.calls).toHaveLength(0);
    return app;
  }
  const publishers = async (app: App) =>
    (
      await app.db.query<{
        slug: string;
        paypal_merchant_id: string | null;
        payee_verified_at: unknown;
      }>('SELECT slug, paypal_merchant_id, payee_verified_at FROM publishers ORDER BY slug')
    ).rows;

  afterEach(async () => {
    while (live.length > 0) await live.pop()!.close();
    while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  describe('sandbox seed of the MVP-B publisher payee', () => {
    it('own id set: harbour-ledger gets it, verified now; the other publisher stays unset', async () => {
      const app = await boot({ UMS_OWN_MERCHANT_ID: OWN_ID });
      const rows = await publishers(app);
      const harbour = rows.find((r) => r.slug === 'harbour-ledger');
      expect(harbour?.paypal_merchant_id).toBe(OWN_ID);
      expect(harbour?.payee_verified_at).not.toBeNull();
      const rest = rows.filter((r) => r.slug !== 'harbour-ledger');
      expect(rest.length).toBeGreaterThan(0);
      for (const r of rest) {
        expect(r.paypal_merchant_id).toBeNull();
        expect(r.payee_verified_at).toBeNull();
      }
    });

    it('own id unset: every publisher stays without a merchant id (approval refuses, as today)', async () => {
      const app = await boot({});
      for (const r of await publishers(app)) {
        expect(r.paypal_merchant_id).toBeNull();
        expect(r.payee_verified_at).toBeNull();
      }
    });

    it('offline mode keeps its synthetic labels, never the own id', async () => {
      const app = await boot({ UMS_OWN_MERCHANT_ID: OWN_ID }, false);
      const rows = await publishers(app);
      expect(rows.length).toBeGreaterThan(0);
      for (const r of rows) {
        expect(r.paypal_merchant_id).toMatch(/^DRYRUN/);
        expect(r.paypal_merchant_id).not.toBe(OWN_ID);
      }
    });

    it('a value already stored is never overwritten by a later start with another own id', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'bu7-seed-'));
      dirs.push(dir);
      const disk = { UMS_DB: 'pglite-disk', UMS_PGLITE_DIR: dir };

      let app = await boot({ ...disk });
      expect((await publishers(app)).every((r) => r.paypal_merchant_id === null)).toBe(true);
      await app.close();
      live.pop();

      app = await boot({ ...disk, UMS_OWN_MERCHANT_ID: OWN_ID });
      expect(
        (await publishers(app)).find((r) => r.slug === 'harbour-ledger')?.paypal_merchant_id,
      ).toBe(OWN_ID);
      await app.close();
      live.pop();

      app = await boot({ ...disk, UMS_OWN_MERCHANT_ID: OTHER_ID });
      expect(
        (await publishers(app)).find((r) => r.slug === 'harbour-ledger')?.paypal_merchant_id,
      ).toBe(OWN_ID);
    }, 60_000);

    it('the value is not written to any log line or audit row', async () => {
      const lines: string[] = [];
      const counting = countingWire();
      const app = createApp(await sandboxEnv({ UMS_OWN_MERCHANT_ID: OWN_ID }), {
        switch_cache_ms: 0,
        log_sink: (l) => lines.push(l),
        test_wire: counting.wire,
      });
      installApp(app);
      live.push(app);
      await app.ready();
      expect(lines.join('\n')).not.toContain(OWN_ID);
      const audit = await app.db.query<Record<string, unknown>>('SELECT * FROM audit_log');
      expect(JSON.stringify(audit.rows)).not.toContain(OWN_ID);
    });
  });
});
