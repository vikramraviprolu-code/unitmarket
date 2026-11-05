// BR-2: POST /api/ops/rules through the real route wrapper and the real app. An operator who signed in with
// the authenticator code, a CSRF token and an Idempotency-Key add a rule setting; a replay of the same key
// and body gives the first answer; the same key with another body is refused; no other caller reaches it.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { issueKey } from '@umsbx/security';
import { traceInvariants } from '@umsbx/db';
import { NOW, bootStartRig } from './ops-start-support';
import type { StartRig } from './ops-start-support';
import { call, signIn } from './support';
import type { Session } from './support';
import { apiKeyDeps } from '../composition.server';

vi.mock('server-only', () => ({}));
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

let rig: StartRig | null = null;
let route: typeof import('./app/api/ops/rules/route');
const FROM = new Date(NOW).toISOString();
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  rig = await bootStartRig();
  route = await import('./app/api/ops/rules/route');
});
afterEach(async () => {
  await rig?.app.close();
  rig = null;
  vi.useRealTimers();
});

const body = (over: Record<string, unknown> = {}) => ({
  rule_key: 'refund.request_window',
  scope_kind: 'platform',
  scope_id: null,
  value: 14,
  effective_from: FROM,
  effective_until: null,
  reason: 'Longer window for the pilot',
  ...over,
});
const post = (
  s: Session | null,
  b: unknown,
  key: string | null = 'rules-key-0001',
  extra: Record<string, string> = {},
  csrf = true,
) =>
  call(route.POST, {
    url: '/api/ops/rules',
    method: 'POST',
    session: s,
    body: b,
    csrf,
    headers: { ...(key === null ? {} : { 'idempotency-key': key }), ...extra },
  });
const rows = async (): Promise<number> =>
  Number(
    (await rig!.app.db.query<{ n: string }>('SELECT count(*) AS n FROM rule_settings')).rows[0]!.n,
  );
const errCode = async (r: Response): Promise<string> =>
  ((await r.clone().json()) as { error: { code: string } }).error.code;

describe('the route is declared as the spec says', () => {
  it('routeMeta', () => {
    expect(route.routeMeta).toMatchObject({
      path: '/api/ops/rules',
      method: 'POST',
      auth: 'operator',
      csrf: true,
      idempotent: true,
      risk: 'high',
      rate: { name: 'ops_rules', per: 'actor', limit: 20, window_ms: 3_600_000 },
    });
  });
});

describe('POST /api/ops/rules', () => {
  it('an operator with the code adds a platform setting: 200, one row, one audit event, the journal is whole', async () => {
    const op = await rig!.mfaOperator();
    const res = await post(op, body());
    expect(res.status).toBe(200);
    const out = (await res.json()) as Record<string, unknown>;
    expect(out).toMatchObject({
      rule_key: 'refund.request_window',
      scope_kind: 'platform',
      scope_id: null,
      value: 14,
    });
    expect(String(out['id'])).toMatch(/^rls_/);
    expect(await rows()).toBe(1);
    expect(await rig!.count('rules.setting_added')).toBe(1);
    // the journal: attributed to the operator on the web channel, no unattributed row, chains intact
    const ev = await rig!.app.db.query<{ actor_kind: string; channel: string; mfa: boolean }>(
      "SELECT actor_kind, channel, mfa FROM trace_events WHERE source_table = 'rule_settings'",
    );
    expect(ev.rows).toEqual([{ actor_kind: 'operator', channel: 'web', mfa: true }]);
    expect(await traceInvariants(rig!.app.db)).toEqual([]);
  });

  it('adds a seller row for a real publisher and refuses an id of the other kind', async () => {
    const op = await rig!.mfaOperator();
    const pub = (
      await rig!.app.db.query<{ id: string }>('SELECT id FROM publishers ORDER BY id LIMIT 1')
    ).rows[0]!.id;
    const ok = await post(
      op,
      body({ rule_key: 'access.window', scope_kind: 'seller', scope_id: pub, value: 9 }),
      'rules-key-seller',
    );
    expect(ok.status).toBe(200);
    const bad = await post(
      op,
      body({ scope_kind: 'buyer', scope_id: pub }),
      'rules-key-wrong-kind',
    );
    expect(bad.status).toBe(422);
    expect(await errCode(bad)).toBe('scope_unknown');
    expect(await rows()).toBe(1);
  });

  it('a buyer mandate above the platform value is refused with plain words (N2-1)', async () => {
    const op = await rig!.mfaOperator();
    expect(
      (await post(op, body({ rule_key: 'mandate.max_days', value: 30 }), 'rules-key-cap-1')).status,
    ).toBe(200);
    const b = (await rig!.app.db.query<{ id: string }>('SELECT id FROM buyers ORDER BY id LIMIT 1'))
      .rows[0];
    if (b === undefined) {
      await rig!.app.db.query(
        `INSERT INTO buyers (id, display_name, auth_subject, country, created_at, updated_at) VALUES ('buy_rules', 'R', 'rules:buy_rules', 'GB', $1, $1)`,
        [FROM],
      );
    }
    const buyer = (
      await rig!.app.db.query<{ id: string }>('SELECT id FROM buyers ORDER BY id LIMIT 1')
    ).rows[0]!.id;
    const res = await post(
      op,
      body({ rule_key: 'mandate.max_days', scope_kind: 'buyer', scope_id: buyer, value: 31 }),
      'rules-key-cap-2',
    );
    expect(res.status).toBe(422);
    expect(await errCode(res)).toBe('above_platform_cap');
    const msg = ((await res.json()) as { error: { message: string } }).error.message;
    expect(msg).toMatch(/platform/i);
    expect(msg).not.toMatch(/mandate\.max_days|SQL|rls_|stack/i);
  });

  it('answers a domain refusal in plain words: rule_invalid, backdated', async () => {
    const op = await rig!.mfaOperator();
    const a = await post(op, body({ value: 99 }), 'rules-key-range');
    expect(a.status).toBe(422);
    expect(await errCode(a)).toBe('rule_invalid');
    const b = await post(
      op,
      body({ effective_from: new Date(NOW - 120_000).toISOString() }),
      'rules-key-back',
    );
    expect(b.status).toBe(422);
    expect(await errCode(b)).toBe('backdated');
    expect(await rows()).toBe(0);
  });

  it('needs an Idempotency-Key: without one, 422 idempotency_key and nothing stored', async () => {
    const res = await post(await rig!.mfaOperator(), body(), null);
    expect(res.status).toBe(422);
    expect(await errCode(res)).toBe('idempotency_key');
    expect(await rows()).toBe(0);
  });

  it('the same key and body replays the first answer: one row, one audit event', async () => {
    const op = await rig!.mfaOperator();
    const first = await post(op, body());
    expect(first.status).toBe(200);
    const a = await first.json();
    const second = await post(op, body());
    expect(second.status).toBe(200);
    expect(second.headers.get('idempotent-replay')).toBe('true');
    expect(await second.json()).toEqual(a);
    expect(await rows()).toBe(1);
    expect(await rig!.count('rules.setting_added')).toBe(1);
  });

  it('the same key with another body is 422 idempotency_key_reused and stores nothing more', async () => {
    const op = await rig!.mfaOperator();
    expect((await post(op, body())).status).toBe(200);
    const res = await post(op, body({ value: 21 }));
    expect(res.status).toBe(422);
    expect(await errCode(res)).toBe('idempotency_key_reused');
    expect(await rows()).toBe(1);
  });

  it('refuses an operator without the code (403 mfa_required), a buyer, a publisher, no session, no CSRF; nothing changes', async () => {
    expect((await post(null, body())).status).toBe(401);
    const b = await signIn(rig!.session.POST, 'buyer-a');
    expect((await post(b, body())).status).toBe(403);
    expect((await post(await rig!.publisher(), body())).status).toBe(403);
    const plain = await post(await rig!.plainOperator(), body());
    expect(plain.status).toBe(403);
    expect(await errCode(plain)).toBe('mfa_required');
    const noCsrf = await post(await rig!.mfaOperator(), body(), 'rules-key-csrf', {}, false);
    expect(noCsrf.status).toBe(403);
    expect(await rows()).toBe(0);
  });

  it('refuses a stray field, a missing field and a value of the wrong type (422)', async () => {
    const op = await rig!.mfaOperator();
    expect((await post(op, body({ approved_by: 'opr_other' }), 'rules-key-s1')).status).toBe(422);
    const { reason: _r, ...noReason } = body();
    expect((await post(op, noReason, 'rules-key-s2')).status).toBe(422);
    expect((await post(op, body({ value: '14' }), 'rules-key-s3')).status).toBe(422);
    expect(await rows()).toBe(0);
  });

  it('no API key of any scope reaches it', async () => {
    await rig!.app.db.query(
      `INSERT INTO buyers (id, display_name, auth_subject, country, created_at, updated_at)
       VALUES ('buy_w0a', 'W0', 'w0:buy_w0a', 'GB', $1, $1) ON CONFLICT (id) DO NOTHING`,
      [FROM],
    );
    const k = await issueKey(apiKeyDeps(rig!.app), {
      owner: { kind: 'buyer' as const, buyer_id: 'buy_w0a' },
      key_kind: 'api_client',
      scopes: ['catalogue:read', 'mandates:write'],
    });
    if (!k.ok) throw new Error(`issue refused: ${k.error}`);
    const res = await post(null, body(), 'rules-key-apikey', {
      authorization: `Bearer ${k.value.token}`,
    });
    expect([401, 403]).toContain(res.status);
    expect(await rows()).toBe(0);
  });

  it('the engine returns the active rows the route stored', async () => {
    const op = await rig!.mfaOperator();
    expect((await post(op, body({ value: 3 }), 'rules-key-noeffect')).status).toBe(200);
    const r = await rig!.app.engine.rules.activeRows(
      { seller_id: 'pub_none', buyer_id: 'buy_none', category: null },
      FROM,
    );
    expect(r.map((x) => x.value)).toEqual([3]);
  });
});
