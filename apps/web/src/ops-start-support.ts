// WEB-OPS-START test support: a sandbox-mode app over a counting fake Wire (so "no PayPal call goes out"
// can be counted), one approval row in the in-memory database, and operator sessions with and without
// the authenticator code. The TOTP key is the RFC 6238 test key, not a credential. Nothing reaches a network.
import { createHmac } from 'node:crypto';
import type { Wire, WireRequest } from '@umsbx/transport';
import { createApp, installApp } from '../composition.server';
import type { App } from '../composition.server';
import { PASSCODE, call, signIn, testEnv } from './support';
import type { Session } from './support';

export const REF = 'DL-ops-start-1';
export const SCOPE = 'mvp_b_polling';
export const NOW = Date.parse('2026-10-31T12:00:00.000Z');
export const TOTP_KEY = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 6238 (SHA-1, 30 s, 6 digits), written here so the test does not trust the code under test. */
export function totp(atMs: number, delta = 0): string {
  const bits = [...TOTP_KEY].map((c) => B32.indexOf(c).toString(2).padStart(5, '0')).join('');
  const bytes = (bits.match(/.{8}/g) ?? []).map((b) => parseInt(b, 2));
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(Math.floor(atMs / 30_000) + delta));
  const mac = createHmac('sha1', Buffer.from(bytes)).update(msg).digest();
  const o = (mac[19] ?? 0) & 15;
  return String((mac.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

export interface StartRig {
  app: App;
  wire: { calls: WireRequest[] };
  start: typeof import('./app/api/ops/start/route');
  stop: typeof import('./app/api/ops/stop/route');
  session: typeof import('./app/api/session/route');
  /** An operator signed in WITH the authenticator code (mfa true). */
  mfaOperator(): Promise<Session>;
  /** An operator signed in without a code (mfa false). */
  plainOperator(): Promise<Session>;
  startAs(
    s: Session | null,
    body: unknown,
    o?: { csrf?: boolean; headers?: Record<string, string> },
  ): Promise<Response>;
  isOn(): Promise<boolean>;
  count(action: string): Promise<number>;
  insertApproval(o?: {
    scope?: string;
    valid_until?: string;
    max_calls?: number;
    ref?: string;
  }): Promise<void>;
  spend(n: number): Promise<void>;
}

export async function bootStartRig(
  o: {
    connect?: boolean;
    approval?: false | Parameters<StartRig['insertApproval']>[0];
    on?: boolean;
  } = {},
): Promise<StartRig> {
  const calls: WireRequest[] = [];
  const wire: Wire = {
    async request(r) {
      calls.push(structuredClone(r));
      return { kind: 'response', status: 200, headers: {}, body: '{}' };
    },
  };
  const env = await testEnv({
    UMS_MODE: 'sandbox',
    UMS_PAYPAL_CONNECT: o.connect === false ? 'off' : 'on',
    UMS_OUTBOUND_APPROVAL_REF: REF,
    PAYPAL_CLIENT_ID: ['placeholder', 'client', 'id'].join('-'),
    PAYPAL_CLIENT_SECRET: ['placeholder', 'client', 'secret'].join('-'),
    UMS_OPERATOR_TOTP_KEYS: `vikram:${TOTP_KEY}`,
  });
  const app = createApp(env, { switch_cache_ms: 0, test_wire: wire });
  installApp(app);
  await app.ready();
  const start = await import('./app/api/ops/start/route');
  const stop = await import('./app/api/ops/stop/route');
  const session = await import('./app/api/session/route');
  const rig: StartRig = {
    app,
    wire: { calls },
    start,
    stop,
    session,
    async mfaOperator() {
      const res = await call(session.POST, {
        url: '/api/session',
        method: 'POST',
        body: {
          persona: 'operator',
          passcode: PASSCODE,
          operator: 'vikram',
          code: totp(Date.now()),
        },
      });
      if (res.status !== 200) throw new Error(`operator sign in with code answered ${res.status}`);
      const body = (await res.json()) as { csrf_token: string };
      return {
        cookie: (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '',
        csrf: body.csrf_token,
      };
    },
    async plainOperator() {
      const s = await signIn(session.POST, 'operator');
      if (s === null) throw new Error('plain operator sign in failed');
      return s;
    },
    startAs(s, body, x = {}) {
      return call(start.POST, {
        url: '/api/ops/start',
        method: 'POST',
        session: s,
        body,
        ...(x.csrf === undefined ? {} : { csrf: x.csrf }),
        ...(x.headers === undefined ? {} : { headers: x.headers }),
      });
    },
    async isOn() {
      const r = await app.db.query<{ on: boolean }>(
        `SELECT "on" FROM safety_switches WHERE name = 'paypal_outbound'`,
      );
      return r.rows[0]?.on === true;
    },
    async count(action) {
      const r = await app.db.query<{ n: string }>(
        `SELECT count(*) AS n FROM audit_log WHERE action = $1`,
        [action],
      );
      return Number(r.rows[0]?.n ?? 0);
    },
    async insertApproval(a = {}) {
      await app.db.query(
        `INSERT INTO outbound_approvals (id, approval_ref, scope, operations, max_amount_minor, max_calls_per_day, valid_until, approved_by, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 2000, $5, $6, 'test-owner', '2026-10-29T00:00:00Z', '2026-10-29T00:00:00Z')`,
        [
          `oap_${(a.ref ?? REF).slice(-8)}`,
          a.ref ?? REF,
          a.scope ?? SCOPE,
          ['oauth_token', 'create_order', 'get_order', 'capture_order', 'get_capture'],
          a.max_calls ?? 120,
          a.valid_until ?? '2026-11-03T12:00:00Z',
        ],
      );
    },
    async spend(n) {
      for (let i = 0; i < n; i += 1)
        await app.db.query(
          `INSERT INTO audit_log (id, actor_kind, actor_id, action, target, reason, detail, created_at, updated_at)
           VALUES ($1, 'system', NULL, 'gate.reserve', $2, 'reserved create_order', '{}', $3, $3)`,
          [`gres_test_${i}`, REF, '2026-10-31T09:00:00.000Z'],
        );
    },
  };
  if (o.approval !== false) await rig.insertApproval(o.approval ?? {});
  await app.db.query(`UPDATE safety_switches SET "on" = $1 WHERE name = 'paypal_outbound'`, [
    o.on === true,
  ]);
  return rig;
}
