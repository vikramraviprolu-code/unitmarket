// INT-OPS-C / OPS-C.3: the operator Agents and API tab and its two writes.
//   read   caps with spent and remaining, reservations, agent purchases, keys, webhook subscriptions and their
//          last delivery. A webhook signing secret, the path and query of a webhook URL and a key's secret hash
//          appear in no answer, with or without the second factor (C1, N-C3: the host is parsed inside the read).
//          Without the second factor there is no buyer id or name, and key ids show as the last four only.
//   write  POST /api/ops/mandates/[id]/revoke and POST /api/ops/api-keys/[id]/revoke: operator session with the
//          second factor, CSRF and an Idempotency-Key, 30 per hour per actor (N-C2). Buyers, sellers, bearer keys
//          and operator keys are refused; a replay gives the stored answer; a revoked cap refuses buy_unit with the
//          existing code; a revoked key gets 401 on its next call; the journal row is the operator on the web
//          channel with `audit_log.action` naming the code; a second revoke writes no second audit row.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createSession, issueKey } from '@umsbx/security';
import type { Actor } from '@umsbx/contracts';
import { bootRefundWorld, count, errorOf } from './refund-support';
import type { RefundWorld } from './refund-support';
import { call } from './support';
import type { Session } from './support';
import {
  buyArgs,
  extraOffers,
  newAgent,
  newClientKey,
  rpc,
  setAgentBuy,
  tool,
} from './app/api/v1/mcp/agent-test-support';
import { apiKeyDeps } from '../composition.server';

vi.mock('server-only', () => ({}));
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

type Handler = Parameters<typeof call>[0];
const here = fileURLToPath(new URL('.', import.meta.url));
const code = (rel: string): string =>
  readFileSync(join(here, rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

const MFA: Actor = { kind: 'operator', operator_id: 'opr_vikram', mfa: true };
const PLAIN: Actor = { kind: 'operator', operator_id: 'opr_demo', mfa: false };
const WHSEC = `whsec_${'5e'.repeat(32)}`;
const HOOK_URL = 'https://hooks.example.test/secret-path-canary/x?token=query-canary-77&b=2';

let w: RefundWorld;
let agents: typeof import('./composition/ops-agents');
let mandateRoute: { POST: Handler };
let keyRoute: { POST: Handler };
let seller: Session;
let buyerA = '';
let nameA = '';
let agent: Awaited<ReturnType<typeof newAgent>>;
let agent2: Awaited<ReturnType<typeof newAgent>>;
let client: { key_id: string; token: string };
let offers: string[] = [];
let n = 0;
const idem = (): string => `opsc-revoke-${String(++n).padStart(6, '0')}-key`;

const post = (
  route: { POST: Handler },
  base: string,
  id: string,
  session: Session | null,
  body: unknown,
  o: { idem?: string | null; csrf?: boolean; headers?: Record<string, string> } = {},
): Promise<Response> =>
  call(route.POST, {
    url: `${base}/${id}/revoke`,
    method: 'POST',
    body,
    session,
    params: { id },
    headers: {
      ...(o.idem === null ? {} : { 'idempotency-key': o.idem ?? idem() }),
      ...(o.headers ?? {}),
    },
    ...(o.csrf === undefined ? {} : { csrf: o.csrf }),
  });
const revokeCap = (id: string, s: Session | null, body: unknown, o = {}) =>
  post(mandateRoute, '/api/ops/mandates', id, s, body, o);
const revokeKey = (id: string, s: Session | null, body: unknown, o = {}) =>
  post(keyRoute, '/api/ops/api-keys', id, s, body, o);

const secretHashes = async (): Promise<string[]> =>
  (await w.app.db.query<{ secret_hash: string }>('SELECT secret_hash FROM api_keys')).rows.map(
    (r) => r.secret_hash,
  );

function scanClean(text: string, hashes: string[]): void {
  expect(text).not.toContain(WHSEC);
  expect(text).not.toContain('whsec_');
  expect(text).not.toContain('secret-path-canary');
  expect(text).not.toContain('query-canary-77');
  expect(text).not.toContain(HOOK_URL);
  expect(text).not.toMatch(/secret_hash|signing_secret/);
  for (const h of hashes) expect(text).not.toContain(h);
}

async function operatorKeyToken(): Promise<string> {
  const r = await issueKey(apiKeyDeps(w.app), {
    owner: MFA,
    key_kind: 'api_client',
    scopes: ['ops:read'],
  });
  if (!r.ok) throw new Error('no operator key');
  return r.value.token;
}

beforeAll(async () => {
  w = await bootRefundWorld();
  agents = await import('./composition/ops-agents');
  mandateRoute = (await import('./app/api/ops/mandates/[id]/revoke/route')) as never;
  keyRoute = (await import('./app/api/ops/api-keys/[id]/revoke/route')) as never;
  buyerA = (w.actorA as { buyer_id: string }).buyer_id;
  nameA = (
    await w.app.db.query<{ display_name: string }>(
      'SELECT display_name FROM buyers WHERE id = $1',
      [buyerA],
    )
  ).rows[0]!.display_name;
  const pub = (
    await w.app.db.query<{ id: string }>("SELECT id FROM publishers WHERE slug = 'harbour-ledger'")
  ).rows[0]!.id;
  const s = await createSession(w.app.security, { kind: 'publisher', publisher_id: pub });
  seller = { cookie: s.cookie.split(';')[0] ?? '', csrf: s.csrf_token };
  offers = await extraOffers(w.app, {
    publisher: 'harbour-ledger',
    from: 'tide-tables',
    count: 3,
    price_minor: 30,
    prefix: 'opsc',
  });
  await setAgentBuy(w.app, true);
  agent = await newAgent(w.app, w.actorA, { mandate: { max_count: 5, max_total_minor: 1000 } });
  agent2 = await newAgent(w.app, w.actorA, { mandate: { max_count: 2 } });
  client = await newClientKey(w.app, w.actorA, ['catalogue:read']);
  const bought = await tool(agent.token, 'buy_unit', buyArgs('harbour-ledger', offers[0]!));
  if (bought.out.status === 'invalid_arguments') throw new Error('buy_unit refused its arguments');
  const at = w.app.security.clock.now().toISOString();
  await w.app.db.query(
    `INSERT INTO webhook_subscriptions (id, owner_kind, owner_id, url, event_types, signing_secret, created_at, updated_at, disabled_at)
     VALUES ('whs_opsc_1', 'buyer', $1, $2, ARRAY['order.paid'], $3, $4, $4, NULL)`,
    [buyerA, HOOK_URL, WHSEC, at],
  );
  await w.app.db.query(
    `INSERT INTO event_outbox (id, type, payload, occurred_at) VALUES ('evt_opsc_1', 'order.paid', '{}'::jsonb, $1)`,
    [at],
  );
  await w.app.db.query(
    `INSERT INTO webhook_deliveries (id, event_id, subscription_id, attempt, status, next_at, last_error, created_at, updated_at)
     VALUES ('whd_opsc_1', 'evt_opsc_1', 'whs_opsc_1', 3, 'dead', NULL, 'http_5xx', $1, $1)`,
    [at],
  );
});
afterAll(async () => w.app.close());

describe('the read (C1, N-C3)', () => {
  it('with the second factor: caps with spent and remaining, reservations, purchases, keys and webhooks', async () => {
    const r = await agents.readOpsAgents(MFA);
    if (r === null) throw new Error('expected a read');
    expect(r.mfa).toBe(true);
    const cap = r.caps.find((c) => c.id === agent.mandate!.id)!;
    expect(cap).toMatchObject({ agent_key: agent.key_id, buyer: buyerA, currency: 'USD' });
    expect(cap.max_count).toBe(5);
    expect(cap.used_count + cap.remaining_count!).toBe(5);
    expect(cap.spent_minor + cap.remaining_total_minor!).toBe(1000);
    expect(r.purchases.some((p) => p.agent_key === agent.key_id)).toBe(true);
    expect(r.reservations.every((x) => typeof x.amount_minor === 'number')).toBe(true);
    expect(r.keys.map((k) => k.id)).toEqual(expect.arrayContaining([agent.key_id, client.key_id]));
    const hook = r.webhooks.find((h) => h.id === 'whs_opsc_1')!;
    expect(hook).toEqual({
      id: 'whs_opsc_1',
      owner_kind: 'buyer',
      host: 'hooks.example.test',
      event_types: ['order.paid'],
      created_at: expect.any(String),
      disabled_at: null,
      last_status: 'dead',
      last_error: 'http_5xx',
    });
    expect(r.revokeKeys[agent.mandate!.id]).toMatch(/\S{16,}/);
  });

  it('without the second factor: no buyer id or name, key ids as the last four only, no revoke keys', async () => {
    const r = await agents.readOpsAgents(PLAIN);
    if (r === null) throw new Error('expected a read');
    expect(r.mfa).toBe(false);
    const json = JSON.stringify(r);
    for (const v of [buyerA, nameA, agent.key_id, agent2.key_id, client.key_id])
      expect(json).not.toContain(v);
    expect(json).toContain(`…${agent.key_id.slice(-4)}`);
    expect(r.caps.every((c) => c.buyer === null)).toBe(true);
    expect(r.revokeKeys).toEqual({});
  });

  it('no answer carries a webhook secret, the URL path or query, or a key hash, with or without MFA', async () => {
    const hashes = await secretHashes();
    for (const actor of [MFA, PLAIN])
      scanClean(JSON.stringify(await agents.readOpsAgents(actor)), hashes);
  });

  it('is null for anyone who is not an operator', async () => {
    expect(await agents.readOpsAgents(w.actorA)).toBeNull();
  });

  it('the reads name their columns: never signing_secret or secret_hash, and the URL is cut to its host inside', () => {
    const src = code('composition/ops-agents.ts');
    expect(src).not.toMatch(/signing_secret|secret_hash/);
    expect(src).not.toMatch(/SELECT\s+\*/i);
    expect(src).toContain('webhookHost(');
    const page = code('app/ops/agents/page.tsx');
    expect(page).toMatch(/from '[./]+\/composition\/ops-agents'/);
    expect(page).not.toMatch(/\.url\b/);
  });
});

describe('who may revoke', () => {
  it('an operator without the second factor gets 403 mfa_required and nothing moves', async () => {
    const res = await revokeCap(agent2.mandate!.id, w.demo, { reason_code: 'abuse' });
    expect(res.status).toBe(403);
    expect((await errorOf(res)).code).toBe('mfa_required');
    const k = await revokeKey(agent2.key_id, w.demo, { reason_code: 'abuse' });
    expect(k.status).toBe(403);
    expect(
      await count(w.app, 'SELECT count(*) AS c FROM mandates WHERE revoked_at IS NOT NULL'),
    ).toBe(0);
    expect(
      await count(w.app, 'SELECT count(*) AS c FROM api_keys WHERE revoked_at IS NOT NULL'),
    ).toBe(0);
  });

  it('buyer, seller, no session, a bearer key and an operator key are refused', async () => {
    const body = { reason_code: 'abuse' };
    const opToken = await operatorKeyToken();
    for (const send of [revokeCap, revokeKey]) {
      const id = send === revokeCap ? agent2.mandate!.id : agent2.key_id;
      expect([401, 403]).toContain((await send(id, w.A, body)).status);
      expect([401, 403]).toContain((await send(id, seller, body)).status);
      expect((await send(id, null, body)).status).toBe(401);
      for (const token of [agent.token, opToken])
        expect([401, 403]).toContain(
          (await send(id, null, body, { headers: { authorization: `Bearer ${token}` } })).status,
        );
    }
    expect(
      await count(w.app, 'SELECT count(*) AS c FROM mandates WHERE revoked_at IS NOT NULL'),
    ).toBe(0);
    expect(
      await count(w.app, 'SELECT count(*) AS c FROM api_keys WHERE revoked_at IS NOT NULL'),
    ).toBe(0);
  });

  it('a missing CSRF token is 403, a missing Idempotency-Key 422, a free-text reason refused', async () => {
    const id = agent2.mandate!.id;
    expect((await revokeCap(id, w.op, { reason_code: 'abuse' }, { csrf: false })).status).toBe(403);
    expect((await revokeCap(id, w.op, { reason_code: 'abuse' }, { idem: null })).status).toBe(422);
    for (const body of [
      {},
      { reason_code: 'because' },
      { reason_code: 'abuse', reason: 'free text' },
    ])
      expect([400, 422]).toContain((await revokeCap(id, w.op, body)).status);
    expect([400, 422]).toContain(
      (await revokeKey(agent2.key_id, w.op, { reason_code: 'nope' })).status,
    );
    expect(
      await count(w.app, 'SELECT count(*) AS c FROM mandates WHERE revoked_at IS NOT NULL'),
    ).toBe(0);
  });

  it('an unknown id is 404', async () => {
    expect((await revokeCap('man_unknown_000', w.op, { reason_code: 'abuse' })).status).toBe(404);
    expect((await revokeKey('key_unknown_000', w.op, { reason_code: 'abuse' })).status).toBe(404);
  });
});

describe('revoke cap', () => {
  it('revokes, replays from the key, refuses buy_unit, journals the operator and the code, and is idempotent', async () => {
    const id = agent.mandate!.id;
    const k = idem();
    const first = await revokeCap(id, w.op, { reason_code: 'abuse' }, { idem: k });
    expect(first.status).toBe(200);
    const body = (await first.json()) as { id: string; revoked_at: string };
    expect(body.id).toBe(id);
    expect(body.revoked_at).toMatch(/Z$/);
    scanClean(JSON.stringify(body), await secretHashes());
    const again = await revokeCap(id, w.op, { reason_code: 'abuse' }, { idem: k });
    expect(again.status).toBe(200);
    expect(again.headers.get('idempotent-replay')).toBe('true');
    expect(await again.json()).toEqual(body);

    const buy = await tool(agent.token, 'buy_unit', buyArgs('harbour-ledger', offers[1]!));
    expect(buy.out).toMatchObject({ status: 'mandate_required', reason: 'revoked' });

    const audits = (
      await w.app.db.query<{ id: string; action: string; reason: string | null }>(
        "SELECT id, action, reason FROM audit_log WHERE target = $1 AND action LIKE 'mandate.revoked%'",
        [id],
      )
    ).rows;
    expect(audits.map((a) => [a.action, a.reason])).toEqual([['mandate.revoked.abuse', null]]);
    const t = (
      await w.app.db.query<{ actor_kind: string; actor_id: string; channel: string; mfa: boolean }>(
        "SELECT actor_kind, actor_id, channel, mfa FROM trace_events WHERE source_table = 'audit_log' AND source_id = $1",
        [audits[0]!.id],
      )
    ).rows;
    expect(t).toEqual([
      { actor_kind: 'operator', actor_id: 'opr_vikram', channel: 'web', mfa: true },
    ]);

    const second = await revokeCap(id, w.op2, { reason_code: 'other' });
    expect(second.status).toBe(200);
    expect(
      await count(
        w.app,
        "SELECT count(*) AS c FROM audit_log WHERE target = $1 AND action LIKE 'mandate.revoked%'",
        [id],
      ),
    ).toBe(1);
  });
});

describe('revoke key', () => {
  it('revokes, the key gets 401 on its next call, journals the operator and the code, and is idempotent', async () => {
    const id = client.key_id;
    const k = idem();
    const first = await revokeKey(id, w.op, { reason_code: 'compromised' }, { idem: k });
    expect(first.status).toBe(200);
    const body = (await first.json()) as { id: string; revoked_at: string };
    expect(body.id).toBe(id);
    scanClean(JSON.stringify(body), await secretHashes());
    const again = await revokeKey(id, w.op, { reason_code: 'compromised' }, { idem: k });
    expect(again.headers.get('idempotent-replay')).toBe('true');
    expect(await again.json()).toEqual(body);

    expect((await rpc(client.token, 'tools/list')).status).toBe(401);
    expect((await rpc(agent2.token, 'tools/list')).status).toBe(200);

    const audits = (
      await w.app.db.query<{ id: string; action: string; reason: string | null }>(
        "SELECT id, action, reason FROM audit_log WHERE target = $1 AND action LIKE 'api_key.revoked%'",
        [id],
      )
    ).rows;
    expect(audits.map((a) => [a.action, a.reason])).toEqual([
      ['api_key.revoked.compromised', null],
    ]);
    const t = (
      await w.app.db.query<{ actor_kind: string; actor_id: string; channel: string }>(
        "SELECT actor_kind, actor_id, channel FROM trace_events WHERE source_table = 'audit_log' AND source_id = $1",
        [audits[0]!.id],
      )
    ).rows;
    expect(t).toEqual([{ actor_kind: 'operator', actor_id: 'opr_vikram', channel: 'web' }]);

    expect((await revokeKey(id, w.op2, { reason_code: 'abuse' })).status).toBe(200);
    expect(
      await count(
        w.app,
        "SELECT count(*) AS c FROM audit_log WHERE target = $1 AND action LIKE 'api_key.revoked%'",
        [id],
      ),
    ).toBe(1);
  });
});

describe('rate (N-C2)', () => {
  it('the 31st revoke within the hour from one operator is 429', async () => {
    const s = await createSession(w.app.security, {
      kind: 'operator',
      operator_id: 'opr_ratecheck',
      mfa: true,
    });
    const op: Session = { cookie: s.cookie.split(';')[0] ?? '', csrf: s.csrf_token };
    const codes: number[] = [];
    for (let i = 0; i < 31; i++)
      codes.push((await revokeCap(`man_none_${String(i)}`, op, { reason_code: 'abuse' })).status);
    expect(codes.slice(0, 30).every((c) => c === 404)).toBe(true);
    expect(codes[30]).toBe(429);
  });

  it('both routes declare the rule of the spec', async () => {
    for (const r of [mandateRoute, keyRoute] as unknown as { routeMeta: Record<string, unknown> }[])
      expect(r.routeMeta).toMatchObject({
        method: 'POST',
        auth: 'operator',
        csrf: true,
        idempotent: true,
        risk: 'high',
        rate: { per: 'actor', limit: 30, window_ms: 3_600_000 },
      });
  });

  it('the routes import their writes from the Agents and API composition module (C7)', () => {
    for (const f of [
      'app/api/ops/mandates/[id]/revoke/route.ts',
      'app/api/ops/api-keys/[id]/revoke/route.ts',
    ])
      expect(code(f)).toMatch(/from '[./]+\/composition\/ops-agents'/);
  });
});
