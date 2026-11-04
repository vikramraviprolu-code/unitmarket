// API-W0 (F3): the three api-keys routes, through the real route modules on a booted app. Sessions only,
// CSRF and an Idempotency-Key on every change. A key cannot mint, list or revoke keys; one owner cannot
// touch another owner's keys; the secret is shown once and is not stored anywhere in clear.
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createSession } from '@umsbx/security';
import type { Actor } from '@umsbx/contracts';
import { bootPackApp, buyer } from '../composite-support';
import { ORIGIN } from '../support';
import type { App } from '../../composition.server';
import { expectOffline } from './offline-guard';

vi.mock('server-only', () => ({}));
vi.mock('node:net', async (orig) => (await import('./offline-guard')).netMock(await orig()));
vi.mock('node:dns', async (orig) => (await import('./offline-guard')).dnsMock(await orig()));
expectOffline();

type Handler = (req: Request, call?: { params?: Record<string, string> }) => Promise<Response>;
let issue: Handler;
let list: Handler;
let revoke: Handler;
let app: App;
let buyerA: Actor;
let buyerB: Actor;
let harbour: Actor;
let quayside: Actor;
interface Sess {
  cookie: string;
  csrf: string;
}
const sess: Record<string, Sess> = {};
let counter = 0;

const sign = async (name: string, actor: Actor): Promise<Sess> => {
  const s = await createSession(app.security, actor);
  return (sess[name] = { cookie: s.cookie.split(';')[0] ?? '', csrf: s.csrf_token });
};

beforeAll(async () => {
  app = await bootPackApp();
  const keys = await import('../app/api/v1/api-keys/route');
  const one = await import('../app/api/v1/api-keys/[id]/route');
  issue = keys.POST as Handler;
  list = keys.GET as Handler;
  revoke = one.DELETE as Handler;
  buyerA = await buyer(app, 'a');
  buyerB = await buyer(app, 'b');
  const pub = async (slug: string): Promise<Actor> => ({
    kind: 'publisher',
    publisher_id: (
      await app.db.query<{ id: string }>('SELECT id FROM publishers WHERE slug = $1', [slug])
    ).rows[0]!.id,
  });
  harbour = await pub('harbour-ledger');
  quayside = await pub('quayside-gazette');
  await sign('buyerA', buyerA);
  await sign('buyerB', buyerB);
  await sign('harbour', harbour);
  await sign('quayside', quayside);
  await sign('opMfa', { kind: 'operator', operator_id: 'opr_w0', mfa: true });
  await sign('opPlain', { kind: 'operator', operator_id: 'opr_w0b', mfa: false });
});

const post = (s: Sess | null, body: unknown, over: { idem?: string | null; csrf?: boolean } = {}) =>
  issue(
    new Request(`${ORIGIN}/api/v1/api-keys`, {
      method: 'POST',
      headers: {
        origin: ORIGIN,
        'content-type': 'application/json',
        ...(s ? { cookie: s.cookie } : {}),
        ...(s && over.csrf !== false ? { 'x-csrf-token': s.csrf } : {}),
        ...(over.idem === null
          ? {}
          : { 'idempotency-key': over.idem ?? `issue-key-${++counter}-abcdef` }),
      },
      body: JSON.stringify(body),
    }),
  );
const get = (s: Sess | null, extra: Record<string, string> = {}) =>
  list(
    new Request(`${ORIGIN}/api/v1/api-keys`, {
      headers: { ...(s ? { cookie: s.cookie } : {}), ...extra },
    }),
  );
const del = (
  s: Sess | null,
  id: string,
  over: { csrf?: boolean; idem?: string | null; extra?: Record<string, string> } = {},
) =>
  revoke(
    new Request(`${ORIGIN}/api/v1/api-keys/${id}`, {
      method: 'DELETE',
      headers: {
        origin: ORIGIN,
        ...(s ? { cookie: s.cookie } : {}),
        ...(s && over.csrf !== false ? { 'x-csrf-token': s.csrf } : {}),
        ...(over.idem === null
          ? {}
          : { 'idempotency-key': over.idem ?? `revoke-key-${++counter}-abcdef` }),
        ...(over.extra ?? {}),
      },
    }),
    { params: { id } },
  );
interface Json {
  id: string;
  token: string;
  scopes: string[];
  error: { code: string; support_code?: string };
  items: { id: string; revoked_at: string | null }[];
  next_cursor: string | null;
  [k: string]: unknown;
}
const json = async (r: Response) => (await r.json()) as Json;

describe('issue', () => {
  it('a buyer session issues an agent key: 201, the token once, and the view', async () => {
    const res = await post(sess['buyerA']!, {
      key_kind: 'agent',
      scopes: ['agent:buy', 'catalogue:read'],
    });
    expect(res.status).toBe(201);
    const b = await json(res);
    expect(b['token']).toMatch(/^umk_[0-9a-hjkmnp-tv-z]{26}_[A-Za-z0-9_-]{43}$/);
    expect(b['key_kind']).toBe('agent');
    expect(b['owner_kind']).toBe('buyer');
    expect(b['scopes']).toEqual(['agent:buy', 'catalogue:read']);
    expect(Object.keys(b).sort()).toEqual(
      [
        'created_at',
        'id',
        'key_kind',
        'last_used_at',
        'owner_kind',
        'revoked_at',
        'scopes',
        'token',
      ].sort(),
    );
  });

  it('a publisher issues a seller key and an operator with a second factor an ops:read key', async () => {
    expect(
      (await post(sess['harbour']!, { key_kind: 'api_client', scopes: ['sales:read'] })).status,
    ).toBe(201);
    expect(
      (await post(sess['opMfa']!, { key_kind: 'api_client', scopes: ['ops:read'] })).status,
    ).toBe(201);
  });

  it('an operator without a second factor is refused (403 mfa_required) and nothing is stored', async () => {
    const res = await post(sess['opPlain']!, { key_kind: 'api_client', scopes: ['ops:read'] });
    expect(res.status).toBe(403);
    expect((await json(res))['error']['code']).toBe('mfa_required');
    const n = await app.db.query<{ n: number | string }>(
      `SELECT count(*) AS n FROM api_keys WHERE owner_id = 'opr_w0b'`,
    );
    expect(Number(n.rows[0]!.n)).toBe(0);
  });

  it('a scope outside the owner matrix is 403 scope_not_allowed; an unknown scope is 422', async () => {
    const out = await post(sess['buyerA']!, { key_kind: 'api_client', scopes: ['ops:read'] });
    expect(out.status).toBe(403);
    expect((await json(out))['error']['code']).toBe('scope_not_allowed');
    for (const scopes of [['ops:write'], ['*'], [], ['agent:buy', 'agent:buy']]) {
      const r = await post(sess['buyerA']!, { key_kind: 'agent', scopes });
      expect(r.status, JSON.stringify(scopes)).toBe(422);
    }
  });

  it('a publisher cannot ask for an agent key (403)', async () => {
    const res = await post(sess['harbour']!, { key_kind: 'agent', scopes: ['agent:buy'] });
    expect(res.status).toBe(403);
  });

  it('the body cannot name another owner or buyer', async () => {
    for (const extra of [
      { owner_id: 'buy_persona_b' },
      { agent_buyer_id: 'buy_persona_b' },
      { owner_kind: 'operator' },
    ]) {
      const r = await post(sess['buyerA']!, { key_kind: 'agent', scopes: ['agent:buy'], ...extra });
      expect(r.status, JSON.stringify(extra)).toBe(422);
    }
  });

  it('needs a session (401), the CSRF token (403) and an Idempotency-Key (400)', async () => {
    const body = { key_kind: 'api_client', scopes: ['catalogue:read'] };
    expect((await post(null, body)).status).toBe(401);
    expect((await post(sess['buyerB']!, body, { csrf: false })).status).toBe(403);
    expect((await post(sess['buyerB']!, body, { idem: null })).status).toBe(400);
  });

  it('a replay with the same Idempotency-Key answers the same status and the view, but never the token again', async () => {
    const body = { key_kind: 'api_client', scopes: ['catalogue:read'] };
    const key = 'replay-no-token-0001';
    const first = await post(sess['buyerB']!, body, { idem: key });
    const firstBody = await json(first);
    const again = await post(sess['buyerB']!, body, { idem: key });
    expect(again.status).toBe(201);
    expect(again.headers.get('idempotent-replay')).toBe('true');
    const replayBody = await json(again);
    expect(replayBody['id']).toBe(firstBody['id']);
    expect(replayBody['token']).toBeUndefined();
    expect(JSON.stringify(replayBody)).not.toContain(firstBody['token'].slice(-43));
    const stored = await app.db.query<{ response: unknown }>(
      `SELECT response FROM api_idempotency WHERE key = $1`,
      [key],
    );
    expect(JSON.stringify(stored.rows)).not.toContain(firstBody['token'].slice(-43));
    expect(JSON.stringify(stored.rows)).not.toContain('umk_');
    const n = await app.db.query<{ n: number | string }>(
      `SELECT count(*) AS n FROM api_keys WHERE id = $1`,
      [firstBody['id']],
    );
    expect(Number(n.rows[0]!.n)).toBe(1);
  });

  it('writes an audit row api_key.issued with the key id and no secret', async () => {
    const res = await post(sess['buyerB']!, { key_kind: 'api_client', scopes: ['library:read'] });
    const b = await json(res);
    const rows = await app.db.query<{ actor_id: string; target: string; detail: unknown }>(
      `SELECT actor_id, target, detail FROM audit_log WHERE action = 'api_key.issued' AND target = $1`,
      [b['id']],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]!.actor_id).toBe((buyerB as { buyer_id: string }).buyer_id);
    expect(JSON.stringify(rows.rows[0])).not.toContain(b['token'].slice(-43));
  });
});

describe('list', () => {
  it('shows the owner own keys with no hash and no secret, and not another owner keys', async () => {
    const mine = await post(sess['quayside']!, { key_kind: 'api_client', scopes: ['sales:read'] });
    const mineId = (await json(mine))['id'];
    const res = await get(sess['quayside']!);
    expect(res.status).toBe(200);
    const text = JSON.stringify(await res.clone().json());
    expect(text).not.toMatch(/secret|hash|umk_/i);
    const b = await json(res);
    expect(b['next_cursor']).toBeNull();
    const ids = (b['items'] as { id: string }[]).map((i) => i.id);
    expect(ids).toContain(mineId);
    const harbourRows = await get(sess['harbour']!);
    const harbourIds = ((await json(harbourRows))['items'] as { id: string }[]).map((i) => i.id);
    expect(harbourIds).not.toContain(mineId);
  });

  it('needs a session', async () => {
    expect((await get(null)).status).toBe(401);
  });

  it('an operator without a second factor may still list (a read), a key may not', async () => {
    expect((await get(sess['opPlain']!)).status).toBe(200);
  });
});

describe('revoke', () => {
  it('revokes an own key (200), keeps it in the list with revoked_at, and a repeat is still 200', async () => {
    const k = await json(
      await post(sess['harbour']!, { key_kind: 'api_client', scopes: ['sales:read'] }),
    );
    const first = await del(sess['harbour']!, k['id']);
    expect(first.status).toBe(200);
    expect((await del(sess['harbour']!, k['id'])).status).toBe(200);
    const items = (await json(await get(sess['harbour']!)))['items'] as {
      id: string;
      revoked_at: string | null;
    }[];
    expect(items.find((i) => i.id === k['id'])!.revoked_at).not.toBeNull();
  });

  it("DELETE of another owner's key is 404 and the key survives", async () => {
    const k = await json(
      await post(sess['harbour']!, { key_kind: 'api_client', scopes: ['sales:read'] }),
    );
    for (const who of ['quayside', 'buyerA', 'opMfa']) {
      const res = await del(sess[who]!, k['id']);
      expect(res.status, who).toBe(404);
    }
    const row = await app.db.query<{ revoked_at: unknown }>(
      'SELECT revoked_at FROM api_keys WHERE id = $1',
      [k['id']],
    );
    expect(row.rows[0]!.revoked_at).toBeNull();
    expect((await del(sess['quayside']!, 'key_doesnotexist')).status).toBe(404);
  });

  it('the 404 for someone else key and for a missing key look the same', async () => {
    const k = await json(
      await post(sess['harbour']!, { key_kind: 'api_client', scopes: ['sales:read'] }),
    );
    const other = await json(await del(sess['quayside']!, k['id']));
    const missing = await json(await del(sess['quayside']!, 'key_missing00000'));
    delete other['error'].support_code;
    delete missing['error'].support_code;
    expect(other).toEqual(missing);
  });

  it('needs a session, the CSRF token and an Idempotency-Key', async () => {
    const k = await json(
      await post(sess['harbour']!, { key_kind: 'api_client', scopes: ['sales:read'] }),
    );
    expect((await del(null, k['id'])).status).toBe(401);
    expect((await del(sess['harbour']!, k['id'], { csrf: false })).status).toBe(403);
    expect((await del(sess['harbour']!, k['id'], { idem: null })).status).toBe(400);
  });

  it('writes an audit row api_key.revoked', async () => {
    const k = await json(
      await post(sess['harbour']!, { key_kind: 'api_client', scopes: ['sales:read'] }),
    );
    await del(sess['harbour']!, k['id']);
    const rows = await app.db.query<{ n: number | string }>(
      `SELECT count(*) AS n FROM audit_log WHERE action = 'api_key.revoked' AND target = $1`,
      [k['id']],
    );
    expect(Number(rows.rows[0]!.n)).toBe(1);
  });
});

describe('a key cannot mint, list or revoke keys', () => {
  it('a valid bearer key alone is 401 on all three routes', async () => {
    const k = await json(
      await post(sess['buyerB']!, {
        key_kind: 'api_client',
        scopes: ['orders:write', 'mandates:write'],
      }),
    );
    const bearer = { authorization: `Bearer ${k['token']}` };
    const mint = await issue(
      new Request(`${ORIGIN}/api/v1/api-keys`, {
        method: 'POST',
        headers: {
          ...bearer,
          origin: ORIGIN,
          'content-type': 'application/json',
          'idempotency-key': 'bearer-mint-0001',
        },
        body: JSON.stringify({ key_kind: 'api_client', scopes: ['orders:read'] }),
      }),
    );
    expect(mint.status).toBe(401);
    expect((await get(null, bearer)).status).toBe(401);
    expect((await del(null, k['id'], { extra: bearer })).status).toBe(401);
  });

  it('a bearer key next to a good session is also refused on these routes', async () => {
    const k = await json(
      await post(sess['buyerB']!, { key_kind: 'api_client', scopes: ['orders:write'] }),
    );
    const bearer = { authorization: `Bearer ${k['token']}` };
    expect((await get(sess['buyerB']!, bearer)).status).toBe(401);
    expect((await del(sess['buyerB']!, k['id'], { extra: bearer })).status).toBe(401);
  });
});

describe('no clear secret anywhere after issue', () => {
  it('the table holds only digests: no column of any api_keys row contains a token secret', async () => {
    const k = await json(
      await post(sess['buyerB']!, { key_kind: 'api_client', scopes: ['library:read'] }),
    );
    const secret = (k['token'] as string).slice(-43);
    const rows = await app.db.query('SELECT * FROM api_keys');
    expect(JSON.stringify(rows.rows)).not.toContain(secret);
    const audit = await app.db.query('SELECT * FROM audit_log');
    expect(JSON.stringify(audit.rows)).not.toContain(secret);
    const idem = await app.db.query('SELECT * FROM api_idempotency');
    expect(JSON.stringify(idem.rows)).not.toContain(secret);
  });
});

describe('rate limits on the key routes', () => {
  it('the 11th issue in an hour by one owner is 429, and another owner is not affected', async () => {
    const heavy = await sign('rateIssue', {
      kind: 'operator',
      operator_id: 'opr_rate1',
      mfa: true,
    });
    for (let i = 0; i < 10; i += 1) {
      const r = await post(heavy, { key_kind: 'api_client', scopes: ['ops:read'] });
      expect(r.status, `issue ${i + 1}`).toBe(201);
    }
    const over = await post(heavy, { key_kind: 'api_client', scopes: ['ops:read'] });
    expect(over.status).toBe(429);
    expect((await json(over)).error.code).toBe('rate_limited');
    expect(over.headers.get('retry-after')).not.toBeNull();
    const other = await post(sess['harbour']!, { key_kind: 'api_client', scopes: ['sales:read'] });
    expect(other.status).toBe(201);
  });

  it('the 31st revoke in an hour by one owner is 429', async () => {
    const heavy = await sign('rateRevoke', {
      kind: 'operator',
      operator_id: 'opr_rate2',
      mfa: true,
    });
    const k = await json(await post(heavy, { key_kind: 'api_client', scopes: ['ops:read'] }));
    for (let i = 0; i < 30; i += 1) {
      const r = await del(heavy, k.id);
      expect(r.status, `revoke ${i + 1}`).toBe(200);
    }
    const over = await del(heavy, k.id);
    expect(over.status).toBe(429);
    expect((await json(over)).error.code).toBe('rate_limited');
  });
});
