// INT-E2E (item E2E.1): the integrated story, told through the public route handlers and the web composition of
// the booted dry-run app. Not a test file: integrated-story.integration.test.ts runs each step as one titled
// test, offline.adversarial.test.ts runs the same steps again under a recorder of every way to open a socket,
// and tamper.adversarial.test.ts reuses steps 1 to 5 to get a ledger row.
//
// The story (spec docs/specs/int-e2e.md, the numbered steps):
//   1. a buyer buys two units as a person (order P1, a two-unit selection from discovery, scenario happy);
//   2. the buyer creates an agent key; 3. an MFA operator turns agent buying on; 4. the buyer gives the key a
//   $5.00 / 10 purchase cap; 5. the agent buys three $0.10 units over MCP (A1 to A3); 6. the buyer downloads
//   A1; 7. an MFA operator refunds P1's second unit; 8. a person order P2 stays pending, a payment_unresolved
//   alert is forced for it, acknowledged by an MFA operator, and auto-resolved after a job pass reconciles P2;
//   9. the agent buys six more (9 of 10) and a job pass raises mandate_near_cap; 10. the 10th buy exhausts the
//   cap and the next pass auto-resolves the near-cap alert; 11. the 11th buy answers cap_exhausted and writes
//   nothing; 12. an MFA operator makes an ops:read key and the seller a sales:read key.
//
// Rules (F2): the only direct writes are the seed offers (extraOffers, inside a system/seed context), the forced
// alert of step 8 (raiseAlert, inside a system/job context) and, in the tamper proof, the tamper edits. Every
// other write goes through a route, the return page's composition call (engine.asPageActor, as
// apps/web/src/app/checkout/return/page.tsx does) or a job pass. Nothing here reaches PayPal or any network:
// the app runs in dry-run mode, every value is synthetic.
import { hashPasscode } from '@umsbx/security';
import { raiseAlert } from '@umsbx/payments';
import type { Actor } from '@umsbx/contracts';
import { expect } from 'vitest';
import type { App } from '../../apps/web/composition.server';
import { bootPackApp } from '../../apps/web/src/composite-support';
import { PASSCODE, call } from '../../apps/web/src/support';
import type { Session } from '../../apps/web/src/support';
import { extraOffers } from '../../apps/web/src/app/api/v1/mcp/agent-test-support';
import { VIKRAM_B32, totpCode } from '../mvp-c/c-support';
import {
  asJob,
  asSeed,
  bearer,
  count,
  json,
  runJobPass,
  sessionGet,
  sessionPost,
  tick,
} from './support';
import type { Handler } from './support';

export const PUBLISHER = 'harbour-ledger';
/** Passcode of the publisher personas. Synthetic, and not the demo passcode. */
const PUBLISHER_PASSCODE = 'publisher passcode for the int story only';
export const UNIT_MINOR = 10;
export const CAP_MINOR = 500;
/** The count cap binds first: 10 purchases at $0.10 is $1.00, well under the $5.00 money cap (F4). */
export const COUNT_CAP = 10;
/** The agent's offers: 3 + 6 + 1 bought, the 11th refused, one spare. */
const AGENT_OFFERS = 12;

type BuyerActor = Extract<Actor, { kind: 'buyer' }>;

export interface KeyPair {
  id: string;
  token: string;
}
export interface Order {
  order_id: string;
  order_ref: string;
}
export interface Rig {
  app: App;
  routes: Record<string, Handler>;
  offers: string[];
  buyer?: Session;
  buyerActor?: BuyerActor;
  operatorMfa?: Session;
  seller?: Session;
  agent?: KeyPair;
  mandateId?: string;
  p1?: Order & { units: string[] };
  p2?: Order;
  /** The agent's orders, in the order they were bought (A1 to A10). */
  agentOrders: Order[];
  p2AlertId?: string;
  nearCapAlertId?: string;
  opsKey?: KeyPair;
  sellerKey?: KeyPair;
  /** Journal rows before the refused 11th buy (step 11). */
  eventsBefore11?: number;
}

const pick = (m: Record<string, unknown>, method: 'GET' | 'POST'): Handler => m[method] as Handler;

// ---------------------------------------------------------------------------------------------
// Boot.
// ---------------------------------------------------------------------------------------------
export async function bootStory(): Promise<Rig> {
  const app = await bootPackApp({
    UMS_OPERATOR_TOTP_KEYS: `vikram:${VIKRAM_B32}`,
    UMS_PUBLISHER_PASSCODE_HASH: await hashPasscode(
      PUBLISHER_PASSCODE,
      '6b5a4c3d2e1f00998877665544332211',
    ),
  });
  const routes: Record<string, Handler> = {
    session: pick(await import('../../apps/web/src/app/api/session/route'), 'POST'),
    discover: pick(await import('../../apps/web/src/app/api/discover/route'), 'POST'),
    quotes: pick(await import('../../apps/web/src/app/api/quotes/route'), 'POST'),
    approvals: pick(await import('../../apps/web/src/app/api/approvals/route'), 'POST'),
    orders: pick(await import('../../apps/web/src/app/api/orders/route'), 'POST'),
    checkout: pick(await import('../../apps/web/src/app/api/orders/[ref]/checkout/route'), 'POST'),
    orderGet: pick(await import('../../apps/web/src/app/api/orders/[ref]/route'), 'GET'),
    apiKeys: pick(await import('../../apps/web/src/app/api/v1/api-keys/route'), 'POST'),
    agentBuy: pick(await import('../../apps/web/src/app/api/ops/agent-buy/route'), 'POST'),
    mandates: pick(await import('../../apps/web/src/app/api/buyer/mandates/route'), 'POST'),
    mcp: pick(await import('../../apps/web/src/app/api/v1/mcp/route'), 'POST'),
    link: pick(await import('../../apps/web/src/app/api/library/[id]/link/route'), 'POST'),
    refunds: pick(await import('../../apps/web/src/app/api/refunds/route'), 'POST'),
    acknowledge: pick(
      await import('../../apps/web/src/app/api/ops/alerts/[id]/acknowledge/route'),
      'POST',
    ),
    activity: pick(await import('../../apps/web/src/app/api/ops/activity/route'), 'GET'),
    opsTimeline: pick(
      await import('../../apps/web/src/app/api/ops/orders/[ref]/timeline/route'),
      'GET',
    ),
    // the deep scans
    sellerTimeline: pick(
      await import('../../apps/web/src/app/api/v1/seller/sales/[unit]/timeline/route'),
      'GET',
    ),
    sellerExport: pick(
      await import('../../apps/web/src/app/api/v1/seller/sales/export/route'),
      'GET',
    ),
    publisherExport: pick(
      await import('../../apps/web/src/app/api/publisher/sales/export/route'),
      'GET',
    ),
    v1OpsTimeline: pick(
      await import('../../apps/web/src/app/api/v1/ops/orders/[ref]/timeline/route'),
      'GET',
    ),
    v1OpsTransactions: pick(
      await import('../../apps/web/src/app/api/v1/ops/transactions/route'),
      'GET',
    ),
    v1OpsAlerts: pick(await import('../../apps/web/src/app/api/v1/ops/alerts/route'), 'GET'),
    v1OpsAlert: pick(await import('../../apps/web/src/app/api/v1/ops/alerts/[id]/route'), 'GET'),
    v1OpsNeedsYou: pick(await import('../../apps/web/src/app/api/v1/ops/needs-you/route'), 'GET'),
    v1OpsCases: pick(await import('../../apps/web/src/app/api/v1/ops/cases/route'), 'GET'),
    v1OpsVerify: pick(await import('../../apps/web/src/app/api/v1/ops/trace/verify/route'), 'GET'),
  };
  // The seed offers: $0.10 each, each its own article (a buyer holds an article once). One of the three
  // allowed direct writes, journaled as system on the seed channel.
  const offers = await asSeed(app, 'int_offers', () =>
    extraOffers(app, {
      publisher: PUBLISHER,
      from: 'tide-tables',
      count: AGENT_OFFERS,
      price_minor: UNIT_MINOR,
      prefix: 'int',
    }),
  );
  return { app, routes, offers, agentOrders: [] };
}

// ---------------------------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------------------------
async function signIn(
  rig: Rig,
  body: Record<string, string>,
): Promise<Session & { mfa?: boolean }> {
  const res = await call(rig.routes['session']!, { url: '/api/session', method: 'POST', body });
  const j = await json<{ csrf_token: string; mfa?: boolean }>(res, 200, 'sign in');
  return {
    cookie: (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '',
    csrf: j.csrf_token,
    ...(j.mfa === undefined ? {} : { mfa: j.mfa }),
  };
}

const orderIdOf = async (app: App, order_ref: string): Promise<string> =>
  (await app.db.query<{ id: string }>('SELECT id FROM orders WHERE order_ref = $1', [order_ref]))
    .rows[0]!.id;

/** Approve, place, check out and return: the buyer's whole payment as the browser and the return page do it. */
async function payAsPerson(
  rig: Rig,
  approvalBody: Record<string, unknown>,
  scenario: string,
): Promise<Order> {
  const buyer = rig.buyer!;
  const g = await json<{ approval_id: string; token: string }>(
    sessionPost(rig.routes['approvals']!, buyer, '/api/approvals', approvalBody),
    201,
    'approval',
  );
  const placed = await json<{ order_ref: string }>(
    sessionPost(rig.routes['orders']!, buyer, '/api/orders', {
      approval_id: g.approval_id,
      token: g.token,
    }),
    201,
    'place order',
  );
  const ref = placed.order_ref;
  const co = await json<{ progress: { step: number; of: number } | null }>(
    sessionPost(
      rig.routes['checkout']!,
      buyer,
      `/api/orders/${ref}/checkout`,
      { scenario },
      { ref },
    ),
    200,
    'checkout',
  );
  // The return page (src/app/checkout/return/page.tsx): the pretend approval and the return, inside the
  // buyer's own journal context. Dry run captures inline here; no job pass is needed. A selection over two
  // publishers is a pack of two PayPal orders: the page runs once per PayPal order (`po` 1 and 2), each
  // approval with its own scenario and the return with none, exactly as the page passes them.
  const actor = rig.buyerActor!;
  const steps =
    co.progress === null ? [undefined] : [...Array(co.progress.of).keys()].map((i) => i + 1);
  for (const position of steps) {
    const r = await rig.app.engine.asPageActor(actor, async () => {
      await rig.app.engine.dryRunApprove({
        order_ref: ref,
        actor,
        scenario,
        ...(position === undefined ? {} : { position }),
      });
      return rig.app.engine.payments.onBuyerReturn({
        order_ref: ref,
        actor,
        scenario: position === undefined ? scenario : null,
      });
    });
    expect(r.ok, `return of ${ref} step ${String(position ?? 1)}`).toBe(true);
  }
  return { order_ref: ref, order_id: await orderIdOf(rig.app, ref) };
}

interface ToolOut {
  status: string;
  [k: string]: unknown;
}
/** One MCP tool call as the agent makes it: JSON-RPC 2.0 over POST /api/v1/mcp with the agent's key. */
async function mcpTool(rig: Rig, name: string, args: unknown = {}): Promise<ToolOut> {
  const res = await bearer(rig.routes['mcp']!, rig.agent!.token, {
    method: 'POST',
    url: '/api/v1/mcp',
    body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
  });
  const body = (await res.json()) as { result?: { structuredContent?: ToolOut } };
  return body.result?.structuredContent ?? { status: 'no_result' };
}

let agentBuys = 0;
/** The agent buys the next seed offer. */
async function agentBuy(rig: Rig): Promise<ToolOut> {
  const offer = rig.offers[agentBuys]!;
  agentBuys += 1;
  tick(1_000);
  return mcpTool(rig, 'buy_unit', {
    publisher: PUBLISHER,
    offer,
    idempotency_key: `int-agent-buy-${String(agentBuys).padStart(3, '0')}-story`,
  });
}
async function agentBuysOk(rig: Rig, n: number): Promise<void> {
  for (let i = 0; i < n; i += 1) {
    const r = await agentBuy(rig);
    expect(r.status, `agent purchase ${String(rig.agentOrders.length + 1)}`).toBe('bought');
    expect(r['environment']).toBe('dryrun');
    const ref = r['order_ref'] as string;
    rig.agentOrders.push({ order_ref: ref, order_id: await orderIdOf(rig.app, ref) });
  }
}

const alertOf = async (app: App, kind: string, reason: string) =>
  (
    await app.db.query<{ id: string }>(
      "SELECT id FROM alerts WHERE kind = $1 AND detail->>'reason' = $2",
      [kind, reason],
    )
  ).rows;
const alertEventKinds = async (app: App, alert_id: string): Promise<string[]> =>
  (
    await app.db.query<{ kind: string }>(
      'SELECT kind FROM alert_events WHERE alert_id = $1 ORDER BY seq',
      [alert_id],
    )
  ).rows.map((r) => r.kind);

/** Issues a key from a signed-in session through POST /api/v1/api-keys (the route BUY.8's page uses). */
async function issueKey(
  rig: Rig,
  session: Session,
  key_kind: string,
  scopes: string[],
): Promise<KeyPair> {
  const k = await json<{ id: string; token: string; key_kind: string }>(
    sessionPost(rig.routes['apiKeys']!, session, '/api/v1/api-keys', { key_kind, scopes }),
    201,
    `issue ${key_kind} key`,
  );
  expect(k.key_kind).toBe(key_kind);
  return { id: k.id, token: k.token };
}

// ---------------------------------------------------------------------------------------------
// The steps.
// ---------------------------------------------------------------------------------------------
export const STEPS: { id: string; title: string; run: (rig: Rig) => Promise<void> }[] = [];
const step = (id: string, title: string, run: (rig: Rig) => Promise<void>): void => {
  STEPS.push({
    id,
    title,
    run: async (rig) => {
      tick(60_000);
      await run(rig);
    },
  });
};

step('S01', 'a buyer signs in and buys two units as a person (order P1, happy)', async (rig) => {
  rig.buyer = await signIn(rig, { persona: 'buyer-a', passcode: PASSCODE });
  const id = (
    await rig.app.db.query<{ id: string }>('SELECT id FROM buyers WHERE auth_subject = $1', [
      'persona:buyer-a',
    ])
  ).rows[0]!.id;
  rig.buyerActor = { kind: 'buyer', buyer_id: id };
  // A two-unit selection, as the discovery page leaves it: one stored proposal over two offers.
  const found = await json<{
    kind: string;
    proposal_id: string;
    items: { quote: { offer_id: string } }[];
  }>(
    sessionPost(rig.routes['discover']!, rig.buyer, '/api/discover', {
      need: 'tide tables and the quayside market hall move, under $5',
    }),
    200,
    'discover',
  );
  expect(found.kind).toBe('proposal');
  const offer_ids = found.items.map((i) => i.quote.offer_id).slice(0, 2);
  expect(offer_ids).toHaveLength(2);
  rig.p1 = {
    ...(await payAsPerson(
      rig,
      {
        proposal_id: found.proposal_id,
        offer_ids,
        consent: { terms: true, identity_share: false },
      },
      'happy',
    )),
    units: [],
  };
  const units = await rig.app.db.query<{ id: string; status: string }>(
    'SELECT id, status FROM order_units WHERE order_id = $1 ORDER BY id',
    [rig.p1.order_id],
  );
  expect(units.rows.map((u) => u.status)).toEqual(['captured_verified', 'captured_verified']);
  rig.p1.units = units.rows.map((u) => u.id);
  expect(
    await count(rig.app, 'SELECT count(*) AS c FROM orders WHERE id = $1 AND status = $2', [
      rig.p1.order_id,
      'paid',
    ]),
  ).toBe(1);
});

step('S02', 'the buyer creates an agent key through POST /api/v1/api-keys', async (rig) => {
  rig.agent = await issueKey(rig, rig.buyer!, 'agent', ['catalogue:read', 'agent:buy']);
});

step(
  'S03',
  'an MFA operator turns agent buying on through POST /api/ops/agent-buy',
  async (rig) => {
    expect(await rig.app.engine.agentBuyEnabled()).toBe(false);
    const s = await signIn(rig, {
      persona: 'operator',
      passcode: PASSCODE,
      operator: 'vikram',
      code: totpCode(VIKRAM_B32, rig.app.security.clock.now().getTime()),
    });
    expect(s.mfa).toBe(true);
    rig.operatorMfa = s;
    const on = await json(
      sessionPost(rig.routes['agentBuy']!, s, '/api/ops/agent-buy', {
        on: true,
        reason: 'int story: dry-run agent purchases',
      }),
      200,
      'agent buy on',
    );
    expect(on).toEqual({ agent_buy_on: true });
    expect(await rig.app.engine.agentBuyEnabled()).toBe(true);
  },
);

step(
  'S04',
  'the buyer gives the key a cap of $5.00 and 10 purchases (POST /api/buyer/mandates)',
  async (rig) => {
    const expires = new Date(rig.app.security.clock.now().getTime() + 24 * 3_600_000).toISOString();
    const m = await json<Record<string, unknown>>(
      sessionPost(rig.routes['mandates']!, rig.buyer!, '/api/buyer/mandates', {
        agent_key_id: rig.agent!.id,
        currency: 'USD',
        max_total_minor: CAP_MINOR,
        max_count: COUNT_CAP,
        expires_at: expires,
        terms_accepted: true,
      }),
      201,
      'mandate',
    );
    expect(m).toMatchObject({
      agent_key_id: rig.agent!.id,
      max_total_minor: CAP_MINOR,
      max_count: COUNT_CAP,
      used_count: 0,
    });
    rig.mandateId = m['id'] as string;
  },
);

step('S05', 'the agent buys three units over MCP buy_unit (A1 to A3)', async (rig) => {
  await agentBuysOk(rig, 3);
  expect(rig.agentOrders).toHaveLength(3);
});

step('S06', "the buyer downloads A1's unit (POST /api/library/[id]/link)", async (rig) => {
  const ent = (
    await rig.app.db.query<{ id: string }>(
      `SELECT e.id FROM entitlements e JOIN order_units u ON u.id = e.unit_id WHERE u.order_id = $1`,
      [rig.agentOrders[0]!.order_id],
    )
  ).rows;
  expect(ent).toHaveLength(1);
  const id = ent[0]!.id;
  const link = await json<Record<string, unknown>>(
    sessionPost(rig.routes['link']!, rig.buyer!, `/api/library/${id}/link`, {}, { id }),
    200,
    'download link',
  );
  expect(JSON.stringify(link)).toMatch(/\S/);
});

step(
  'S07',
  "an MFA operator refunds P1's second unit; dry-run completes it inside the POST",
  async (rig) => {
    const unit = rig.p1!.units[1]!;
    const r = await json<Record<string, unknown>>(
      sessionPost(rig.routes['refunds']!, rig.operatorMfa!, '/api/refunds', {
        unit_id: unit,
        amount_minor: null,
        reason: 'int story: refund the second unit',
      }),
      200,
      'refund',
    );
    expect(r).toMatchObject({ state: 'completed', unit_status: 'refunded' });
  },
);

step(
  'S08',
  'P2 stays pending; a forced payment_unresolved alert is acknowledged, then auto-resolved after reconcile',
  async (rig) => {
    const q = await json<{ quote_id: string }>(
      sessionPost(rig.routes['quotes']!, rig.buyer!, '/api/quotes', {
        publisher: PUBLISHER,
        offer: 'harbour-fees',
        option: 'online_read',
      }),
      200,
      'quote',
    );
    rig.p2 = await payAsPerson(
      rig,
      { quote_id: q.quote_id, consent: { terms: true, identity_share: false } },
      'pending_then_completed',
    );
    const status = async () =>
      (
        await rig.app.db.query<{ status: string }>('SELECT status FROM orders WHERE id = $1', [
          rig.p2!.order_id,
        ])
      ).rows[0]!.status;
    expect(['paid', 'paid_partial', 'failed', 'abandoned']).not.toContain(await status());

    // The one named seam: raiseAlert from @umsbx/payments with the app's clock and ids, as a job would.
    const raised = await asJob(rig.app, 'int_force_alert', () =>
      raiseAlert(
        rig.app.db,
        { clock: rig.app.security.clock, ids: rig.app.security.ids },
        {
          kind: 'payment_unresolved',
          order_id: rig.p2!.order_id,
          unit_id: null,
          reason: 'int_forced',
        },
      ),
    );
    expect(raised).toBe('payment_unresolved');
    const [alert] = await alertOf(rig.app, 'payment_unresolved', 'int_forced');
    rig.p2AlertId = alert!.id;

    tick(1_000);
    await json(
      sessionPost(
        rig.routes['acknowledge']!,
        rig.operatorMfa!,
        `/api/ops/alerts/${rig.p2AlertId}/acknowledge`,
        {},
        { id: rig.p2AlertId },
      ),
      200,
      'acknowledge',
    );

    // The clock moves on; job passes (at most three) reconcile P2 to paid and auto-resolve the alert.
    let passes = 0;
    while (passes < 3) {
      tick(10 * 60_000);
      await runJobPass(rig.app);
      passes += 1;
      if (
        (await status()) === 'paid' &&
        (await alertEventKinds(rig.app, rig.p2AlertId)).includes('auto_resolved')
      )
        break;
    }
    expect(await status(), `P2 after ${String(passes)} passes`).toBe('paid');
    expect(await alertEventKinds(rig.app, rig.p2AlertId)).toEqual([
      'acknowledged',
      'auto_resolved',
    ]);
  },
);

step(
  'S09',
  'the agent buys six more (9 of 10); a job pass raises mandate_near_cap',
  async (rig) => {
    await agentBuysOk(rig, 6);
    expect(rig.agentOrders).toHaveLength(9);
    tick(60_000);
    await runJobPass(rig.app);
    const rows = await alertOf(rig.app, 'mandate_near_cap', `cap90_${rig.mandateId!}`);
    expect(rows).toHaveLength(1);
    rig.nearCapAlertId = rows[0]!.id;
  },
);

step(
  'S10',
  'the 10th buy exhausts the cap; the next pass auto-resolves the near-cap alert',
  async (rig) => {
    await agentBuysOk(rig, 1);
    const m = (
      await rig.app.db.query<{ exhausted_at: string | null; used_count: number }>(
        'SELECT exhausted_at, used_count FROM mandates WHERE id = $1',
        [rig.mandateId],
      )
    ).rows[0]!;
    expect(m.exhausted_at).not.toBeNull();
    expect(Number(m.used_count)).toBe(COUNT_CAP);
    tick(60_000);
    await runJobPass(rig.app);
    expect(await alertEventKinds(rig.app, rig.nearCapAlertId!)).toEqual(['auto_resolved']);
  },
);

step(
  'S11',
  'the 11th buy answers cap_exhausted: no money row; only the approval and its audit rows are journaled',
  async (rig) => {
    const MONEY = [
      'orders',
      'order_units',
      'mandate_reservations',
      'ledger_entries',
      'provider_calls',
    ];
    const before: Record<string, number> = {};
    for (const t of MONEY) before[t] = await count(rig.app, `SELECT count(*) AS c FROM ${t}`);
    const keys = async (): Promise<Set<string>> =>
      new Set(
        (
          await rig.app.db.query<{ k: string }>(
            "SELECT chain_key || '#' || seq::text AS k FROM trace_events",
          )
        ).rows.map((x) => x.k),
      );
    const seen = await keys();
    rig.eventsBefore11 = await count(rig.app, 'SELECT count(*) AS c FROM trace_events');
    const r = await agentBuy(rig);
    expect(r.status).toBe('cap_exhausted');
    for (const t of MONEY)
      expect(await count(rig.app, `SELECT count(*) AS c FROM ${t}`), `${t} after the refusal`).toBe(
        before[t],
      );
    // B2 ruling: the only new journal rows are one approvals insert and the request's audit_log rows
    // (approval.requested and api.request), all written by the agent.
    const added = (
      await rig.app.db.query<{
        k: string;
        source_table: string;
        source_id: string;
        event_type: string;
        actor_kind: string;
        action: string | null;
      }>(
        `SELECT e.chain_key || '#' || e.seq::text AS k, e.source_table, e.source_id, e.event_type,
                e.actor_kind, e.body->'cols'->'action'->>1 AS action
           FROM trace_events e ORDER BY e.occurred_at, e.chain_key, e.seq`,
      )
    ).rows.filter((e) => !seen.has(e.k));
    expect(added.every((e) => e.actor_kind === 'agent')).toBe(true);
    expect(added.filter((e) => e.source_table === 'approvals').map((e) => e.event_type)).toEqual([
      'approvals.created',
    ]);
    const audit = added.filter((e) => e.source_table === 'audit_log');
    expect(audit.every((e) => e.event_type === 'audit_log.created')).toBe(true);
    expect([...new Set(audit.map((e) => e.action))].sort()).toEqual([
      'api.request',
      'approval.requested',
    ]);
    expect(added).toHaveLength(1 + audit.length);
    // B5: the refused agent approval is not the buyer's to act on, so it is not in the pending approvals.
    const refused = added.find((e) => e.source_table === 'approvals')!.source_id;
    const { readPendingApprovals } = await import('../../apps/web/src/composition/buyer');
    const pending = await readPendingApprovals(rig.buyerActor!.buyer_id);
    expect(pending.map((p) => p.approval_id)).not.toContain(refused);
  },
);

step(
  'S12',
  'an MFA operator creates an ops:read key and the seller a sales:read key',
  async (rig) => {
    rig.opsKey = await issueKey(rig, rig.operatorMfa!, 'api_client', ['ops:read']);
    rig.seller = await signIn(rig, {
      persona: `publisher-${PUBLISHER}`,
      passcode: PUBLISHER_PASSCODE,
    });
    rig.sellerKey = await issueKey(rig, rig.seller, 'api_client', ['sales:read']);
  },
);

// ---------------------------------------------------------------------------------------------
// The journal table (F5). Fixed by the spec; never copied from a run (R2-4).
// ---------------------------------------------------------------------------------------------
export type View =
  | { kind: 'buyer'; orders: (rig: Rig) => Order[] }
  | { kind: 'ops'; orders: (rig: Rig) => Order[] }
  | { kind: 'activity'; chain: (rig: Rig) => string };

export interface Marker {
  step: number;
  view: string;
  marker: string;
  where: View;
  /** Matches one entry of the view. */
  match: (e: Entry, rig: Rig) => boolean;
  /** How many entries per view instance ("exactly once" unless the table says ×n). */
  times: number;
  actor_kind: string[];
  channel: string;
  mfa: boolean[];
  /** Extra checks on the journal row of each match (on_behalf_of, mandate_id). */
  row?: (r: JournalRow, rig: Rig) => void;
}

/** One entry of a view as the routes and the composition answer it. */
export interface Entry {
  event_type: string;
  actor: { kind: string };
  channel: string;
  source: { table: string; id: string };
  state_to?: string;
  /** The sentence key: for access events it names the kind (the download is `link_issued`). */
  words_key: string;
  seq: number;
  mfa?: boolean;
  chain_key?: string;
  details?: Record<string, unknown>;
}
export interface JournalRow {
  actor_kind: string;
  channel: string | null;
  mfa: boolean;
  on_behalf_of: string | null;
  mandate_id: string | null;
  /** From the row's context: null for a session, the key id for a key. */
  api_key_id: string | null;
}

const p1 = (r: Rig): Order[] => [r.p1!];
const ins = (table: string) => (e: Entry) =>
  e.source.table === table && e.event_type === `${table}.created`;
const alertEvent = (kind: string) => (e: Entry) =>
  e.source.table === 'alert_events' && e.details?.['kind'] === kind;

export const TABLE: Marker[] = [
  {
    step: 1,
    view: 'buyer timeline of P1',
    marker: '`orders` insert',
    where: { kind: 'buyer', orders: p1 },
    match: ins('orders'),
    times: 1,
    actor_kind: ['buyer'],
    channel: 'web',
    mfa: [false],
  },
  {
    step: 1,
    view: 'buyer timeline of P1',
    marker: '`order_units` to `captured_verified` (×2)',
    where: { kind: 'buyer', orders: p1 },
    match: (e) => e.source.table === 'order_units' && e.state_to === 'captured_verified',
    times: 2,
    actor_kind: ['buyer'],
    channel: 'web',
    mfa: [false],
  },
  {
    step: 2,
    view: '`/api/ops/activity` chain `key:<id>`',
    marker: '`api_keys` insert (context `api_key_id` null)',
    where: { kind: 'activity', chain: (r) => `key:${r.agent!.id}` },
    match: ins('api_keys'),
    times: 1,
    actor_kind: ['buyer'],
    channel: 'api',
    mfa: [false],
    row: (j) => {
      // B1 ruling: a session call on /api/v1 is channel api; the context carries no key, so it is a session.
      expect(j.api_key_id).toBeNull();
    },
  },
  {
    step: 3,
    view: '`/api/ops/activity` chain `plat`',
    marker: '`safety_switches` `agent_buy_enabled` on',
    where: { kind: 'activity', chain: () => 'plat' },
    match: (e) =>
      e.source.table === 'safety_switches' &&
      e.source.id === 'agent_buy_enabled' &&
      e.details?.['on'] === true,
    times: 1,
    actor_kind: ['operator'],
    channel: 'web',
    mfa: [true],
  },
  {
    step: 4,
    view: '`/api/ops/activity` chain `mdt:<id>`',
    marker: '`mandates` insert',
    where: { kind: 'activity', chain: (r) => `mdt:${r.mandateId!}` },
    match: ins('mandates'),
    times: 1,
    actor_kind: ['buyer'],
    channel: 'web',
    mfa: [false],
  },
  {
    step: 5,
    view: 'operator MFA timeline of A1, A2, A3',
    marker: '`orders` insert (on_behalf_of buyer, mandate_id set)',
    where: { kind: 'ops', orders: (r) => r.agentOrders.slice(0, 3) },
    match: ins('orders'),
    times: 1,
    actor_kind: ['agent'],
    channel: 'mcp',
    mfa: [false],
    row: (j, r) => {
      expect(j.on_behalf_of).toBe(r.buyerActor!.buyer_id);
      expect(j.mandate_id).toBe(r.mandateId);
    },
  },
  {
    step: 6,
    view: 'buyer timeline of A1',
    marker: '`access_events` insert',
    where: { kind: 'buyer', orders: (r) => [r.agentOrders[0]!] },
    match: (e) => ins('access_events')(e) && e.words_key === 'access_events.created:link_issued',
    times: 1,
    actor_kind: ['buyer'],
    channel: 'web',
    mfa: [false],
  },
  {
    step: 7,
    view: 'operator MFA timeline of P1',
    marker: '`refund_requests` insert',
    where: { kind: 'ops', orders: p1 },
    match: ins('refund_requests'),
    times: 1,
    actor_kind: ['operator'],
    channel: 'web',
    mfa: [true],
  },
  {
    step: 7,
    view: 'operator MFA timeline of P1',
    marker: '`refund_requests` to `completed`',
    where: { kind: 'ops', orders: p1 },
    match: (e) => e.source.table === 'refund_requests' && e.state_to === 'completed',
    times: 1,
    actor_kind: ['operator'],
    channel: 'web',
    mfa: [true],
  },
  {
    step: 8,
    view: 'operator MFA timeline of P2',
    marker: '`alerts` insert `payment_unresolved`',
    where: { kind: 'ops', orders: (r) => [r.p2!] },
    match: (e) => ins('alerts')(e) && e.details?.['kind'] === 'payment_unresolved',
    times: 1,
    actor_kind: ['system'],
    channel: 'job',
    mfa: [false],
  },
  {
    step: 8,
    view: '`/api/ops/activity` chain of P2',
    marker: '`alert_events` `acknowledged`',
    where: { kind: 'activity', chain: (r) => `ord:${r.p2!.order_id}` },
    match: alertEvent('acknowledged'),
    times: 1,
    actor_kind: ['operator'],
    channel: 'web',
    mfa: [true],
  },
  {
    step: 8,
    view: '`/api/ops/activity` chain of P2',
    marker: '`alert_events` `auto_resolved`',
    where: { kind: 'activity', chain: (r) => `ord:${r.p2!.order_id}` },
    match: alertEvent('auto_resolved'),
    times: 1,
    actor_kind: ['system'],
    channel: 'job',
    mfa: [false],
  },
  {
    step: 9,
    view: 'operator MFA timelines of the six orders',
    marker: '`orders` insert (×6)',
    where: { kind: 'ops', orders: (r) => r.agentOrders.slice(3, 9) },
    match: ins('orders'),
    times: 1,
    actor_kind: ['agent'],
    channel: 'mcp',
    mfa: [false],
    row: (j, r) => {
      expect(j.on_behalf_of).toBe(r.buyerActor!.buyer_id);
      expect(j.mandate_id).toBe(r.mandateId);
    },
  },
  {
    step: 9,
    view: '`/api/ops/activity` chain `plat`',
    marker: '`alerts` insert `mandate_near_cap`',
    where: { kind: 'activity', chain: () => 'plat' },
    match: (e) => ins('alerts')(e) && e.details?.['kind'] === 'mandate_near_cap',
    times: 1,
    actor_kind: ['system'],
    channel: 'job',
    mfa: [false],
  },
  {
    step: 10,
    view: '`/api/ops/activity` chain `mdt:<id>`',
    marker: '`mandates` `exhausted_at` set',
    where: { kind: 'activity', chain: (r) => `mdt:${r.mandateId!}` },
    match: (e) =>
      e.source.table === 'mandates' &&
      e.event_type === 'mandates.updated' &&
      typeof e.details?.['exhausted_at'] === 'string',
    times: 1,
    actor_kind: ['agent'],
    channel: 'mcp',
    mfa: [false],
  },
  {
    step: 10,
    view: '`/api/ops/activity` chain `plat`',
    marker: '`alert_events` `auto_resolved`',
    where: { kind: 'activity', chain: () => 'plat' },
    match: alertEvent('auto_resolved'),
    times: 1,
    actor_kind: ['system'],
    channel: 'job',
    mfa: [false],
  },
  {
    step: 12,
    view: '`/api/ops/activity`',
    marker: '`api_keys` insert (×2) (context `api_key_id` null)',
    where: { kind: 'activity', chain: (r) => `key:${r.opsKey!.id}` },
    match: ins('api_keys'),
    times: 1,
    actor_kind: ['operator'],
    channel: 'api',
    mfa: [true],
    row: (j) => {
      // B1 ruling: a session call on /api/v1 is channel api; the context carries no key, so it is a session.
      expect(j.api_key_id).toBeNull();
    },
  },
  {
    step: 12,
    view: '`/api/ops/activity`',
    marker: '`api_keys` insert (×2) (context `api_key_id` null)',
    where: { kind: 'activity', chain: (r) => `key:${r.sellerKey!.id}` },
    match: ins('api_keys'),
    times: 1,
    actor_kind: ['publisher'],
    channel: 'api',
    mfa: [false],
    row: (j) => {
      // B1 ruling: a session call on /api/v1 is channel api; the context carries no key, so it is a session.
      expect(j.api_key_id).toBeNull();
    },
  },
];

/** The entries of one view instance. */
async function viewEntries(rig: Rig, v: View, inst: Order | string): Promise<Entry[]> {
  if (v.kind === 'buyer') {
    const { readBuyerTimeline } = await import('../../apps/web/src/composition/buyer');
    const t = await readBuyerTimeline(rig.buyerActor!.buyer_id, (inst as Order).order_ref);
    expect(t, `buyer timeline of ${(inst as Order).order_ref}`).not.toBeNull();
    return t!.entries as Entry[];
  }
  if (v.kind === 'ops') {
    const ref = (inst as Order).order_ref;
    const t = await json<{ entries: Entry[] }>(
      sessionGet(rig.routes['opsTimeline']!, rig.operatorMfa!, `/api/ops/orders/${ref}/timeline`, {
        ref,
      }),
      200,
      `ops timeline of ${ref}`,
    );
    return t.entries;
  }
  const chain = inst as string;
  const out: Entry[] = [];
  let cursor: string | null = null;
  do {
    const q = new URLSearchParams({ chain_key: chain, limit: '200' });
    if (cursor !== null) q.set('cursor', cursor);
    const page: { items: Entry[]; next_cursor: string | null } = await json(
      sessionGet(rig.routes['activity']!, rig.operatorMfa!, `/api/ops/activity?${q.toString()}`),
      200,
      `activity ${chain}`,
    );
    out.push(...page.items);
    cursor = page.next_cursor;
  } while (cursor !== null);
  return out;
}

/** The journal row behind an entry, for the columns a view does not show (mfa on the buyer view, on_behalf_of). */
async function journalRow(rig: Rig, e: Entry): Promise<JournalRow> {
  const r = await rig.app.db.query<JournalRow>(
    `SELECT e.actor_kind, e.channel, e.mfa, e.on_behalf_of, e.mandate_id, c.api_key_id
       FROM trace_events e LEFT JOIN trace_context c ON c.id = e.ctx_id
      WHERE e.source_table = $1 AND e.source_id = $2 AND e.seq = $3 AND e.event_type = $4`,
    [e.source.table, e.source.id, e.seq, e.event_type],
  );
  expect(
    r.rows,
    `journal row of ${e.source.table} ${e.source.id} seq ${String(e.seq)}`,
  ).toHaveLength(1);
  return r.rows[0]!;
}

export interface TableLine {
  step: number;
  view: string;
  marker: string;
  found: string;
  actor_kind: string;
  channel: string;
  mfa: string;
}

/**
 * Checks every row of the table against its view and returns the printed table. Each view instance holds the
 * marker exactly `times` times, with the actor kind, channel and mfa of the row (mfa read from the view where it
 * shows it, and from the journal row behind the entry in every case).
 */
export async function checkTable(rig: Rig): Promise<{ lines: TableLine[]; problems: string[] }> {
  const lines: TableLine[] = [];
  const problems: string[] = [];
  for (const m of TABLE) {
    const insts: (Order | string)[] =
      m.where.kind === 'activity' ? [m.where.chain(rig)] : m.where.orders(rig);
    const seen: { actor: string; channel: string; mfa: boolean }[] = [];
    const say = (what: string): void => {
      problems.push(`step ${String(m.step)} ${m.marker} in ${m.view}: ${what}`);
    };
    for (const inst of insts) {
      const hits = (await viewEntries(rig, m.where, inst)).filter((e) => m.match(e, rig));
      if (hits.length !== m.times)
        say(`found ${String(hits.length)}, expected exactly ${String(m.times)}`);
      for (const h of hits) {
        const j = await journalRow(rig, h);
        if (j.actor_kind !== h.actor.kind)
          say(`view actor ${h.actor.kind}, journal ${j.actor_kind}`);
        if (!m.actor_kind.includes(h.actor.kind))
          say(`actor_kind ${h.actor.kind}, expected ${m.actor_kind.join(' or ')}`);
        if (h.channel !== m.channel) say(`channel ${h.channel}, expected ${m.channel}`);
        if (h.mfa !== undefined && h.mfa !== j.mfa)
          say(`view mfa ${String(h.mfa)}, journal ${String(j.mfa)}`);
        if (!m.mfa.includes(j.mfa)) say(`mfa ${String(j.mfa)}, expected ${m.mfa.join(' or ')}`);
        try {
          m.row?.(j, rig);
        } catch (e) {
          say(e instanceof Error ? e.message : String(e));
        }
        seen.push({ actor: h.actor.kind, channel: h.channel, mfa: j.mfa });
      }
    }
    lines.push({
      step: m.step,
      view: m.view,
      marker: m.marker,
      found: `${String(seen.length)} in ${String(insts.length)} view${insts.length === 1 ? '' : 's'}`,
      actor_kind: [...new Set(seen.map((s) => s.actor))].join('; '),
      channel: [...new Set(seen.map((s) => s.channel))].join('; '),
      mfa: [...new Set(seen.map((s) => String(s.mfa)))].join('; '),
    });
  }
  return { lines, problems };
}

export function printTable(lines: TableLine[]): string {
  const head = '| Step | View | Marker | Found | actor_kind | channel | mfa |';
  const rule = '| ---- | ---- | ------ | ----- | ---------- | ------- | --- |';
  return [
    head,
    rule,
    ...lines.map(
      (l) =>
        `| ${String(l.step)} | ${l.view} | ${l.marker} | ${l.found} | ${l.actor_kind} | ${l.channel} | ${l.mfa} |`,
    ),
    '| 11 | none | no new `orders`, `order_units`, `mandate_reservations`, `ledger_entries` or `provider_calls` row; only one `approvals` insert and its `audit_log` rows; the refused approval is not pending for the buyer | checked in S11 | agent | mcp; api | false |',
  ].join('\n');
}

// ---------------------------------------------------------------------------------------------
// Deep scans (F11).
// ---------------------------------------------------------------------------------------------
/** The canaries: values that must never reach a seller answer or a v1 operator answer. */
export async function canaries(rig: Rig): Promise<{ name: string; value: string }[]> {
  const app = rig.app;
  const out: { name: string; value: string }[] = [];
  const buyerId = rig.buyerActor!.buyer_id;
  out.push({ name: 'buyer id', value: buyerId });
  const name = (
    await app.db.query<{ display_name: string }>('SELECT display_name FROM buyers WHERE id = $1', [
      buyerId,
    ])
  ).rows[0]!.display_name;
  out.push({ name: 'buyer display name', value: name });
  out.push({ name: 'agent key id', value: rig.agent!.id });
  const cx = await app.db.query<{ req_id: string | null; ip_hash: string | null }>(
    `SELECT DISTINCT c.req_id, c.ip_hash FROM trace_context c
       JOIN trace_events e ON e.ctx_id = c.id WHERE e.actor_kind IN ('buyer', 'agent')`,
  );
  for (const r of cx.rows) {
    if (r.req_id !== null) out.push({ name: 'req_id', value: r.req_id });
    if (r.ip_hash !== null) {
      out.push({ name: 'ip_hash', value: r.ip_hash });
      // the operator view cuts the address hash to 8 characters: that prefix must not leak either
      out.push({ name: 'ip_hash prefix', value: r.ip_hash.slice(0, 8) });
    }
  }
  const ids = await app.db.query<{ v: string }>(
    `SELECT provider_order_id AS v FROM provider_orders WHERE provider_order_id IS NOT NULL
     UNION SELECT capture_id FROM order_units WHERE capture_id IS NOT NULL
     UNION SELECT refund_id FROM refund_requests WHERE refund_id IS NOT NULL`,
  );
  for (const r of ids.rows) out.push({ name: 'PayPal id', value: r.v });
  return out;
}

/** Every answer the deep scan reads, by name. */
export async function scannedAnswers(rig: Rig): Promise<{ name: string; text: string }[]> {
  const out: { name: string; text: string }[] = [];
  const get = async (name: string, res: Promise<Response>): Promise<void> => {
    const r = await res;
    const text = await r.text();
    expect(r.status, `${name}: ${text.slice(0, 300)}`).toBe(200);
    out.push({ name, text });
  };
  const sk = rig.sellerKey!.token;
  const ok = rig.opsKey!.token;
  const units = (
    await rig.app.db.query<{ id: string }>(
      `SELECT u.id FROM order_units u JOIN publishers p ON p.id = u.publisher_id WHERE p.slug = $1 ORDER BY u.id`,
      [PUBLISHER],
    )
  ).rows.map((r) => r.id);
  expect(units.length).toBeGreaterThan(10);
  for (const unit of units)
    await get(
      `GET /api/v1/seller/sales/${unit}/timeline`,
      bearer(rig.routes['sellerTimeline']!, sk, {
        url: `/api/v1/seller/sales/${unit}/timeline`,
        params: { unit },
      }),
    );
  await get(
    'GET /api/v1/seller/sales/export',
    bearer(rig.routes['sellerExport']!, sk, { url: '/api/v1/seller/sales/export' }),
  );
  await get(
    'GET /api/publisher/sales/export',
    sessionGet(rig.routes['publisherExport']!, rig.seller!, '/api/publisher/sales/export'),
  );
  const orders = [rig.p1!, rig.p2!, ...rig.agentOrders];
  for (const o of orders)
    await get(
      `GET /api/v1/ops/orders/${o.order_ref}/timeline`,
      bearer(rig.routes['v1OpsTimeline']!, ok, {
        url: `/api/v1/ops/orders/${o.order_ref}/timeline`,
        params: { ref: o.order_ref },
      }),
    );
  await get(
    'GET /api/v1/ops/transactions',
    bearer(rig.routes['v1OpsTransactions']!, ok, { url: '/api/v1/ops/transactions' }),
  );
  await get(
    'GET /api/v1/ops/alerts',
    bearer(rig.routes['v1OpsAlerts']!, ok, { url: '/api/v1/ops/alerts' }),
  );
  for (const id of [rig.p2AlertId!, rig.nearCapAlertId!])
    await get(
      `GET /api/v1/ops/alerts/${id}`,
      bearer(rig.routes['v1OpsAlert']!, ok, { url: `/api/v1/ops/alerts/${id}`, params: { id } }),
    );
  await get(
    'GET /api/v1/ops/needs-you',
    bearer(rig.routes['v1OpsNeedsYou']!, ok, { url: '/api/v1/ops/needs-you' }),
  );
  await get(
    'GET /api/v1/ops/cases',
    bearer(rig.routes['v1OpsCases']!, ok, { url: '/api/v1/ops/cases' }),
  );
  await get(
    'GET /api/v1/ops/trace/verify',
    bearer(rig.routes['v1OpsVerify']!, ok, { url: '/api/v1/ops/trace/verify' }),
  );
  return out;
}
