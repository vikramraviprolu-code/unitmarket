// INT-TR0 / TR0.2: the entry points of the real offline app. A buyer web request, an agent MCP buy (with
// on_behalf_of and mandate_id), a job pass, a signed webhook and the boot seed each leave journal rows with
// the right actor_kind, channel and req_id; no write in any of them is unattributed. The two operator CLI
// cases (safety stop, privacy delete) live in scripts/trace-cli.state.test.ts because apps/web does not
// import scripts/lib (R2-9).
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Actor } from '@umsbx/contracts';
import { startLoop } from '@umsbx/jobs';
import { fakeClock } from '@umsbx/runtime';
import type { App } from '../composition.server';
import { bootPackApp, buyer } from './composite-support';
import { call, signIn } from './support';
import type { Session } from './support';
import { bootWebhookApp, delivery, eventBody, seedCapturingOrder } from './webhook-support';
import type { WebhookRig } from './webhook-support';
import {
  buyArgs,
  extraOffers,
  newAgent,
  setAgentBuy,
  tool,
} from './app/api/v1/mcp/agent-test-support';

vi.mock('server-only', () => ({}));
// The job pass case drives the real loop with the payments engine stubbed out: the loop must open the
// context, whatever the engine does.
vi.mock('@umsbx/payments', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@umsbx/payments')>()),
  runDue: vi.fn().mockResolvedValue({ processed: 0, still_unknown: 0, expired: 0, abandoned: 0 }),
  recoverOnStartup: vi.fn().mockResolvedValue({ resumed: 0, repaired: 0 }),
  nextDueAt: vi.fn().mockResolvedValue(null),
}));

interface Ev {
  actor_kind: string;
  actor_id: string | null;
  on_behalf_of: string | null;
  mandate_id: string | null;
  channel: string | null;
  ctx_id: string | null;
  source_table: string;
  source_id: string;
  event_type: string;
}
interface Cx {
  id: string;
  channel: string;
  actor_kind: string;
  req_id: string | null;
  ip_hash: string | null;
  ua_family: string | null;
  api_key_id: string | null;
  job: string | null;
  tool: string | null;
  on_behalf_of: string | null;
  mandate_id: string | null;
}

const events = async (app: App, sql: string, params: unknown[] = []): Promise<Ev[]> =>
  (
    await app.db.query<Ev>(
      `SELECT actor_kind, actor_id, on_behalf_of, mandate_id, channel, ctx_id, source_table, source_id, event_type
       FROM trace_events WHERE ${sql} ORDER BY occurred_at, chain_key, seq`,
      params,
    )
  ).rows;
const contextOf = async (app: App, id: string | null): Promise<Cx> => {
  const r = await app.db.query<Cx>('SELECT * FROM trace_context WHERE id = $1', [id]);
  expect(r.rows, `trace_context ${id}`).toHaveLength(1);
  return r.rows[0]!;
};
const unattributed = async (app: App): Promise<string[]> =>
  (
    await app.db.query<{ t: string }>(
      "SELECT source_table || ' ' || source_id AS t FROM trace_events WHERE actor_kind = 'unattributed' ORDER BY 1",
    )
  ).rows.map((r) => r.t);

describe('a buyer web request', () => {
  let app: App;
  let A: Session;
  beforeAll(async () => {
    app = await bootPackApp();
  }, 120_000);
  afterAll(async () => {
    await app.close();
  });

  it('writes the approval as the buyer, on the web channel, with the request id of the response', async () => {
    const sessionRoute = await import('./app/api/session/route');
    const quotes = await import('./app/api/quotes/route');
    const approvals = await import('./app/api/approvals/route');
    A = (await signIn(sessionRoute.POST, 'buyer-a'))!;
    const owner = (await buyer(app, 'a')) as Extract<Actor, { kind: 'buyer' }>;
    const ua = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36';
    const q = (await (
      await call(quotes.POST, {
        url: '/api/quotes',
        method: 'POST',
        session: A,
        headers: { 'user-agent': ua },
        body: { publisher: 'harbour-ledger', offer: 'tide-tables', option: 'keep_retrieve' },
      })
    ).json()) as { quote_id: string };
    const res = await call(approvals.POST, {
      url: '/api/approvals',
      method: 'POST',
      session: A,
      headers: { 'user-agent': ua },
      body: { quote_id: q.quote_id, consent: { terms: true, identity_share: false } },
    });
    expect(res.status).toBe(201);
    const reqId = res.headers.get('x-request-id')!;
    const a = (await res.json()) as { approval_id: string };
    const [e] = await events(app, "source_table = 'approvals' AND source_id = $1", [a.approval_id]);
    expect(e).toMatchObject({
      actor_kind: 'buyer',
      actor_id: owner.buyer_id,
      channel: 'web',
      on_behalf_of: null,
      event_type: 'approvals.created',
    });
    const cx = await contextOf(app, e!.ctx_id);
    expect(cx).toMatchObject({
      channel: 'web',
      actor_kind: 'buyer',
      req_id: reqId,
      ua_family: 'browser',
    });
    expect(cx.ip_hash).toMatch(/^[a-f0-9]{32}$/);
    expect(JSON.stringify(cx)).not.toContain('Mozilla');
  });

  it('the boot seed is journaled as system on the seed channel, and nothing in the app run is unattributed', async () => {
    const seeded = await events(app, "source_table = 'publishers'");
    expect(seeded.length).toBeGreaterThan(0);
    expect(
      seeded.every((e) => e.actor_kind === 'system' && e.channel === 'seed' && e.ctx_id !== null),
    ).toBe(true);
    expect(await unattributed(app)).toEqual([]);
  });
});

describe('an agent buy over MCP', () => {
  let app: App;
  beforeAll(async () => {
    app = await bootPackApp();
  }, 120_000);
  afterAll(async () => {
    await app.close();
  });

  it('is journaled as the agent, on behalf of the buyer, under the mandate, on the mcp channel with the tool name', async () => {
    const owner = (await buyer(app, 'a')) as Extract<Actor, { kind: 'buyer' }>;
    const [offer] = await extraOffers(app, {
      publisher: 'harbour-ledger',
      from: 'tide-tables',
      count: 1,
      price_minor: 30,
    });
    await setAgentBuy(app, true);
    const agent = await newAgent(app, owner, { mandate: { max_count: 5, max_total_minor: 1000 } });
    const before = (
      await app.db.query<{ n: number }>('SELECT count(*)::int AS n FROM trace_events')
    ).rows[0]!.n;
    const r = await tool(agent.token, 'buy_unit', buyArgs('harbour-ledger', offer!));
    expect(r.out.status).not.toBe('invalid_arguments');
    const after = await events(
      app,
      "source_table IN ('orders', 'mandate_reservations', 'mandates') AND actor_kind = 'agent'",
    );
    expect(after.length).toBeGreaterThan(0);
    for (const e of after) {
      expect(e).toMatchObject({
        actor_kind: 'agent',
        actor_id: agent.key_id,
        on_behalf_of: owner.buyer_id,
        mandate_id: agent.mandate!.id,
        channel: 'mcp',
      });
    }
    const cx = await contextOf(app, after[0]!.ctx_id);
    expect(cx).toMatchObject({
      channel: 'mcp',
      actor_kind: 'agent',
      tool: 'buy_unit',
      api_key_id: agent.key_id,
      mandate_id: agent.mandate!.id,
      on_behalf_of: owner.buyer_id,
    });
    expect(cx.req_id).toMatch(/\S/);
    expect(
      (await app.db.query<{ n: number }>('SELECT count(*)::int AS n FROM trace_events')).rows[0]!.n,
    ).toBeGreaterThan(before);
    expect(await unattributed(app)).toEqual([]);
  });
});

describe('a job pass', () => {
  let app: App;
  beforeAll(async () => {
    app = await bootPackApp();
  }, 120_000);
  afterAll(async () => {
    await app.close();
  });

  it('writes as system on the job channel, one context per pass', async () => {
    let n = 0;
    const deps = {
      db: app.db,
      clock: fakeClock('2026-11-04T10:00:00.000Z'),
      ids: { next: () => 'x', nonce: () => 'n' },
      log: {
        log: () => undefined,
        child() {
          return this;
        },
      },
      audit: { record: () => Promise.resolve() },
      switches: { isOn: () => Promise.resolve(true) },
      config: { abandoned_checkout_ms: 86_400_000 },
      environment: 'dryrun',
      paypal: {},
      content: {},
      sweepWindows: async () => {
        n += 1;
        await app.db.query(
          `INSERT INTO alerts (id, kind, detail, created_at, updated_at) VALUES ($1, 'job_probe', '{}', '2026-11-04T10:00:00Z', '2026-11-04T10:00:00Z')`,
          [`alr_job_${n}`],
        );
        return { ended: 0 };
      },
    } as unknown as Parameters<typeof startLoop>[0];
    const loop = startLoop(deps, { max_sleep_ms: 5, max_items: 3 });
    await vi.waitFor(() => expect(n).toBeGreaterThanOrEqual(2), { timeout: 5000 });
    await loop.stop();
    const rows = await events(app, "source_table = 'alerts' AND source_id LIKE 'alr_job_%'");
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows.every((e) => e.actor_kind === 'system' && e.channel === 'job')).toBe(true);
    const ctxIds = new Set(rows.map((e) => e.ctx_id));
    expect(ctxIds.size).toBe(rows.length); // a context per pass, not one for the life of the loop
    const cx = await contextOf(app, rows[0]!.ctx_id);
    expect(cx.job).toMatch(/\S/);
    expect(await unattributed(app)).toEqual([]);
  });
});

describe('a signed webhook', () => {
  let rig: WebhookRig;
  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.parse('2026-10-23T12:01:00.000Z'));
    rig = await bootWebhookApp();
  }, 120_000);
  afterAll(async () => {
    await rig.close();
    vi.useRealTimers();
  });

  it('writes its event as paypal on the webhook channel, on the order chain, with the request id', async () => {
    const { order_id } = await seedCapturingOrder(rig.app);
    const res = await rig.post(
      delivery(eventBody({ id: 'WH-TR0-1', type: 'CHECKOUT.ORDER.APPROVED' }), { id: 'TR-TR0-1' }),
    );
    expect(res.status).toBe(200);
    const reqId = res.headers.get('x-request-id')!;
    const rows = await rig.app.db.query<Ev & { chain_key: string }>(
      "SELECT actor_kind, actor_id, channel, ctx_id, source_table, chain_key FROM trace_events WHERE source_table = 'webhook_events'",
    );
    expect(rows.rows.length).toBeGreaterThan(0);
    for (const e of rows.rows) {
      expect(e).toMatchObject({
        actor_kind: 'paypal',
        channel: 'webhook',
        chain_key: `ord:${order_id}`,
      });
      expect(e.actor_id).toBeNull();
    }
    const cx = await contextOf(rig.app, rows.rows[0]!.ctx_id);
    expect(cx).toMatchObject({ channel: 'webhook', actor_kind: 'paypal', req_id: reqId });
    // The read-back operation the webhook queues is written inside the same context.
    const op = await events(rig.app, "source_table = 'operations'");
    expect(op.some((e) => e.actor_kind === 'paypal' && e.channel === 'webhook')).toBe(true);
  });
});
