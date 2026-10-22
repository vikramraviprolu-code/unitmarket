// Lane 10 wiring: the web library and help routes over the real recovery and library functions.
// Purchases are inserted raw because the payments facade is still the lane 15 stub (TEMP-until-05a).
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { App } from '../composition.server';
import { bootTestApp, call, signIn } from './support';
import type { Session } from './support';

vi.mock('server-only', () => ({}));

let app: App;
let sessionRoute: typeof import('./app/api/session/route');
let library: typeof import('./app/api/library/route');
let cases: typeof import('./app/api/cases/route');
let A: Session;
let B: Session;
let entitlement_id = '';
let order_id = '';
// Time comes from the database: web tests may not import the runtime (Z1) or read the clock (S6).
let NOW = 0;

const HASH = 'a'.repeat(64);

async function insert(table: string, row: Record<string, unknown>): Promise<void> {
  const at = new Date(NOW).toISOString();
  const r: Record<string, unknown> = { created_at: at, updated_at: at, ...row };
  const cols = Object.keys(r);
  await app.db.query(
    `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`,
    cols.map((c) => r[c]),
  );
}

beforeAll(async () => {
  app = await bootTestApp();
  NOW = Date.parse(
    String((await app.db.query<{ n: string }>('SELECT now()::timestamptz::text AS n')).rows[0]!.n),
  );
  sessionRoute = await import('./app/api/session/route');
  library = await import('./app/api/library/route');
  cases = await import('./app/api/cases/route');
  A = (await signIn(sessionRoute.POST, 'buyer-a'))!;
  B = (await signIn(sessionRoute.POST, 'buyer-b'))!;
  const art = (
    await app.db.query<{ id: string; publisher_id: string }>(
      'SELECT id, publisher_id FROM articles ORDER BY id LIMIT 1',
    )
  ).rows[0]!;
  const corridor = (await app.db.query<{ id: string }>('SELECT id FROM corridors LIMIT 1'))
    .rows[0]!;
  const now = new Date(NOW);
  await insert('approvals', {
    id: 'apr_w10',
    buyer_id: 'buy_persona_a',
    snapshot: '{}',
    content_hash: HASH,
    nonce: 'nonce_w10',
    expires_at: new Date(now.getTime() + 900_000).toISOString(),
    used_at: null,
    environment: 'dryrun',
  });
  order_id = 'ord_w10';
  await insert('orders', {
    id: order_id,
    approval_id: 'apr_w10',
    buyer_id: 'buy_persona_a',
    content_hash: HASH,
    order_ref: 'ref_w10',
    expected: '{}',
    status: 'paid',
    mismatch: false,
    corridor_id: corridor.id,
    currency: 'USD',
    total_minor: 500,
    environment: 'dryrun',
  });
  await insert('order_units', {
    id: 'unt_w10',
    order_id,
    provider_order_ref: null,
    publisher_id: art.publisher_id,
    reference_id: 'refid_w10',
    payee_merchant_id: 'DRYRUNX',
    amount_minor: 500,
    platform_fee_minor: 0,
    capture_id: 'CAPW10',
    status: 'captured_verified',
    status_reason: null,
    paypal_fee_minor: null,
    refunded_minor: 0,
    captured_verified_at: now.toISOString(),
    mismatch_reason: null,
  });
  entitlement_id = 'ent_w10';
  await insert('entitlements', {
    id: entitlement_id,
    buyer_id: 'buy_persona_a',
    article_id: art.id,
    unit_id: 'unt_w10',
    option: 'keep_retrieve',
    policy: JSON.stringify({
      id: 'pol_x',
      version: 'v1',
      option: 'keep_retrieve',
      window_ms: 432_000_000,
      start_rule: 'payment_verified_and_delivery_ready',
    }),
    money_state: 'captured',
    access_state: 'available',
    licence_state: 'granted',
    transition_log: '[]',
    environment: 'dryrun',
  });
  await insert('access_windows', {
    entitlement_id,
    state: 'running',
    started_at: now.toISOString(),
    base_ends_at: new Date(now.getTime() + 432_000_000).toISOString(),
    ends_at: new Date(now.getTime() + 432_000_000).toISOString(),
    paused_at: null,
    credit_ms: 0,
  });
});
afterAll(async () => {
  await app.close();
});

describe('library through the real read model', () => {
  it('shows the buyer their item with words, receipts and no case; the other buyer sees nothing', async () => {
    const res = await call(library.GET, { url: '/api/library', session: A });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: {
        entitlement_id: string;
        status_text: string;
        can_open: boolean;
        open_case: unknown;
      }[];
    };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({ entitlement_id, can_open: true, open_case: null });
    expect(body.items[0]?.status_text).toMatch(
      /^Ready, 4 days 2\d hours left$|^Ready, 5 days left$|^Ready, 4 days/,
    );
    const other = await call(library.GET, { url: '/api/library', session: B });
    expect(((await other.json()) as { items: unknown[] }).items).toEqual([]);
  });
});

describe('help requests open real cases', () => {
  it('opens one case for the owner, answers duplicates with 409 and hides it from the other buyer', async () => {
    const mine = await call(cases.POST, {
      url: '/api/cases',
      method: 'POST',
      session: A,
      body: { entitlement_id, note: 'help:delivery' },
    });
    expect(mine.status).toBe(201);
    expect(((await mine.json()) as { case_id: string }).case_id).toMatch(/^cas_/);

    const again = await call(cases.POST, {
      url: '/api/cases',
      method: 'POST',
      session: A,
      body: { entitlement_id },
    });
    expect(again.status).toBe(409);

    const theirs = await call(cases.POST, {
      url: '/api/cases',
      method: 'POST',
      session: B,
      body: { entitlement_id },
    });
    const unknown = await call(cases.POST, {
      url: '/api/cases',
      method: 'POST',
      session: B,
      body: { entitlement_id: 'ent_unknown' },
    });
    expect(theirs.status).toBe(404);
    const plain = async (r: Response) => {
      const e = ((await r.json()) as { error: { code: string; message: string } }).error;
      return { code: e.code, message: e.message };
    };
    expect(await plain(theirs)).toEqual(await plain(unknown));

    const shown = await call(library.GET, { url: '/api/library', session: A });
    const items = ((await shown.json()) as { items: { open_case: { kind: string } | null }[] })
      .items;
    expect(items[0]?.open_case?.kind).toBe('delivery_failed');
  });

  it('a request that names nothing opens nothing', async () => {
    const res = await call(cases.POST, {
      url: '/api/cases',
      method: 'POST',
      session: A,
      body: { note: 'help:payment' },
    });
    expect(res.status).toBe(404);
  });

  it('the in-process loop turns a frozen-order alert into a case', async () => {
    await insert('alerts', {
      id: 'alr_w10',
      kind: 'frozen_order',
      order_id,
      unit_id: null,
      detail: JSON.stringify({ reason: 'mismatch' }),
    });
    await app.engine.sweep();
    const rows = await app.db.query<{ kind: string; opened_by: string }>(
      "SELECT kind, opened_by FROM recovery_cases WHERE kind = 'frozen_order'",
    );
    expect(rows.rows).toEqual([{ kind: 'frozen_order', opened_by: 'system' }]);
  });
});
