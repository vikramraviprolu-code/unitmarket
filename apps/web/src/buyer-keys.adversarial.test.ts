// INT-BUY / BUY.8 (L): the API keys page, over the existing owner routes /api/v1/api-keys. The secret appears in the
// create answer once. It is never in a list, in the list model of lib/buyer-keys-view.ts, in a replay or in the
// journal. Buyer A cannot revoke buyer B's key, and an agent key cannot mint keys.
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { Actor, ApiKeyView } from '@umsbx/contracts';
import { bootA, idemKey, json } from './api-v1/a-support';
import type { ARig, Handler, Sess } from './api-v1/a-support';
import { expectOffline } from './api-v1/offline-guard';
import { KEYS_EMPTY, KEY_PRESETS, issuedState, keyRequest, keysModel } from './lib/buyer-keys-view';
import { readKeyViews } from './composition/buyer';

vi.mock('server-only', () => ({}));
vi.mock('node:net', async (orig) => (await import('./api-v1/offline-guard')).netMock(await orig()));
vi.mock('node:dns', async (orig) => (await import('./api-v1/offline-guard')).dnsMock(await orig()));
expectOffline();

type Buyer = Extract<Actor, { kind: 'buyer' }>;
interface Issued {
  id: string;
  token: string;
  scopes: string[];
  key_kind: string;
}
const NOW = new Date('2026-11-05T12:00:00.000Z');
let rig: ARig;
let A: Buyer;
let B: Buyer;
let sessA: Sess;
let sessB: Sess;
let issue: Handler;
let list: Handler;
let revoke: Handler;

beforeAll(async () => {
  rig = await bootA();
  A = rig.buyerA as Buyer;
  B = rig.buyerB as Buyer;
  sessA = await rig.session(A);
  sessB = await rig.session(B);
  const keys = await import('./app/api/v1/api-keys/route');
  const one = await import('./app/api/v1/api-keys/[id]/route');
  issue = keys.POST as Handler;
  list = keys.GET as Handler;
  revoke = one.DELETE as Handler;
}, 120_000);

const create = (s: Sess | null, preset: keyof typeof KEY_PRESETS, idem = idemKey()) =>
  rig.old(issue, s, {
    method: 'POST',
    url: '/api/v1/api-keys',
    body: keyRequest(preset),
    idem,
  });

describe('BUY.8 the request a preset sends', () => {
  it('the agent preset is an agent key with the four agent scopes; the client preset reads only', () => {
    expect(keyRequest('agent')).toEqual({
      key_kind: 'agent',
      scopes: ['catalogue:read', 'orders:read', 'library:read', 'agent:buy'],
    });
    const c = keyRequest('read_only');
    expect(c.key_kind).toBe('api_client');
    expect(c.scopes.every((s) => s.endsWith(':read'))).toBe(true);
    expect(c.scopes.join(',')).not.toMatch(/write|buy|admin/);
  });
});

describe('BUY.8 the secret is shown once', () => {
  it('the create answer holds the token once; the list, the list model and a replay do not', async () => {
    const idem = idemKey();
    const first = await create(sessA, 'agent', idem);
    expect(first.status).toBe(201);
    const made = await json<Issued>(first);
    expect(made.token).toMatch(/\S{16,}/);

    const views = await readKeyViews(A.buyer_id);
    const model = keysModel(views, NOW);
    expect(JSON.stringify(views)).not.toContain(made.token);
    expect(JSON.stringify(model)).not.toContain(made.token);
    expect(Object.keys(model.rows[0] ?? {})).not.toContain('token');

    const listed = await rig.old(list, sessA, { method: 'GET', url: '/api/v1/api-keys' });
    expect(JSON.stringify(await json(listed))).not.toContain(made.token);

    const replay = await create(sessA, 'agent', idem);
    expect(await replay.text()).not.toContain(made.token);

    const stored = await rig.app.db.query('SELECT * FROM api_keys WHERE id = $1', [made.id]);
    expect(JSON.stringify(stored.rows)).not.toContain(made.token);
  });

  it('the token reaches the client state only from a create answer, and is dropped from what is kept', () => {
    const s = issuedState({
      id: 'key_x1',
      token: 'tok_secret_value_123456',
      key_kind: 'agent',
      owner_kind: 'buyer',
      scopes: ['agent:buy'],
      created_at: '2026-11-05T11:00:00.000Z',
      revoked_at: null,
      last_used_at: null,
    });
    expect(s.shown.token).toBe('tok_secret_value_123456');
    expect(JSON.stringify(s.kept)).not.toContain('tok_secret_value_123456');
    expect(s.kept.id).toBe('key_x1');
  });
});

describe('BUY.8 the list model', () => {
  const view = (over: Partial<ApiKeyView> = {}): ApiKeyView => ({
    id: 'key_lm0001',
    key_kind: 'agent',
    owner_kind: 'buyer',
    scopes: ['catalogue:read', 'agent:buy'],
    created_at: '2026-11-05T09:00:00.000Z',
    revoked_at: null,
    last_used_at: null,
    ...over,
  });
  it('shows kind, scopes in words, state and when last used; only an active key can be revoked', () => {
    const m = keysModel(
      [
        view(),
        view({
          id: 'key_lm0002',
          revoked_at: '2026-11-05T10:00:00.000Z',
          last_used_at: '2026-11-05T09:30:00.000Z',
        }),
      ],
      NOW,
    );
    expect(m.empty).toBeNull();
    expect(m.rows.map((r) => [r.id, r.state_word, r.can_revoke])).toEqual([
      ['key_lm0001', 'Active', true],
      ['key_lm0002', 'Revoked', false],
    ]);
    expect(m.rows[0]).toMatchObject({ kind_word: 'Agent key', last_used_text: 'Never used' });
  });
  it('no keys gives words, not a blank', () => {
    expect(keysModel([], NOW)).toMatchObject({ rows: [], empty: KEYS_EMPTY });
  });
});

describe('BUY.8 who may mint and revoke', () => {
  it("buyer A cannot revoke buyer B's key: the same 404 as an unknown id", async () => {
    const made = await json<Issued>(await create(sessB, 'read_only'));
    const del = (id: string) =>
      rig.old(revoke, sessA, {
        method: 'DELETE',
        url: `/api/v1/api-keys/${id}`,
        idem: idemKey(),
        params: { id },
      });
    const other = await del(made.id);
    const unknown = await del('key_does_not_exist');
    expect(other.status).toBe(404);
    const code = async (r: Response) => {
      const e = ((await r.json()) as { error: { code: string; message: string } }).error;
      return { code: e.code, message: e.message };
    };
    expect(await code(other)).toEqual(await code(unknown));
    const mine = (await readKeyViews(B.buyer_id)).find((k) => k.id === made.id);
    expect(mine?.revoked_at).toBeNull();
  });

  it('an agent key cannot mint keys', async () => {
    const issued = await json<Issued>(await create(sessA, 'agent'));
    const asKey = await rig.old(issue, null, {
      method: 'POST',
      url: '/api/v1/api-keys',
      body: keyRequest('agent'),
      idem: idemKey(),
      headers: { authorization: `Bearer ${issued.token}` },
    });
    expect([401, 403]).toContain(asKey.status);
  });

  it('a signed-out caller cannot create or list', async () => {
    expect((await create(null, 'agent')).status).toBe(401);
    expect((await rig.old(list, null, { method: 'GET', url: '/api/v1/api-keys' })).status).toBe(
      401,
    );
  });
});
