// Test helper for the DP-5 composite tests (MVP-D). Builds an isolated offline app (or a sandbox-mode
// app that never opens a socket: no test wire, nothing calls out), makes proposals over several
// offers, and drives a pack through the facade: place, checkout, one dry-run approval per PayPal
// order, return. Fictional ids and synthetic values only; no PayPal, no credentials.
import type { Actor } from '@umsbx/contracts';
import { createApp, installApp } from '../composition.server';
import type { App, AppOptions } from '../composition.server';
import { testEnv } from './support';

export type Offer = readonly [publisher: string, code: string];
export const HARBOUR_TIDE: Offer = ['harbour-ledger', 'tide-tables'];
export const HARBOUR_FERRY: Offer = ['harbour-ledger', 'ferry-timetables'];
export const HARBOUR_KNOTS: Offer = ['harbour-ledger', 'knot-notebook'];
export const HARBOUR_DOCK: Offer = ['harbour-ledger', 'dock-history'];
export const QUAY_MARKET: Offer = ['quayside-gazette', 'market-hall-move'];
export const QUAY_WALK: Offer = ['quayside-gazette', 'quay-walk'];
export const NORTH_ALLOTMENT: Offer = ['northfield-quarterly', 'allotment-diary'];

export const OWNER_ID = 'SBXOWNERTEST1';
export const OTHER_ID = 'SBXOWNERTEST2';

export async function bootPackApp(
  over: Record<string, string> = {},
  opts: AppOptions = {},
): Promise<App> {
  const app = createApp(await testEnv(over), { switch_cache_ms: 0, ...opts });
  installApp(app);
  await app.ready();
  return app;
}

export async function buyer(app: App, who: 'a' | 'b'): Promise<Actor> {
  const row = await app.db.query<{ id: string }>('SELECT id FROM buyers WHERE auth_subject = $1', [
    `persona:buyer-${who}`,
  ]);
  return { kind: 'buyer', buyer_id: row.rows[0]!.id };
}

/** Quotes for each offer and one stored proposal over them, as discovery would leave it. */
export async function proposalFor(
  app: App,
  actor: Actor,
  offers: readonly Offer[],
): Promise<{ proposal_id: string; offer_ids: string[] }> {
  if (actor.kind !== 'buyer') throw new Error('buyer expected');
  const quotes: { quote_id: string; offer_id: string }[] = [];
  for (const [publisher_slug, offer_code] of offers) {
    const page = await app.engine.offerPage({ publisher: publisher_slug, offer: offer_code });
    if (page === null) throw new Error(`no offer ${publisher_slug}/${offer_code}`);
    const q = await app.engine.quote({
      offer: { publisher_slug, offer_code },
      actor,
      source: 'direct',
      option: page.options[0]!.option,
    });
    if (!q.ok || q.value.kind !== 'quote') throw new Error(`no quote for ${offer_code}`);
    quotes.push({ quote_id: q.value.quote_id, offer_id: q.value.offer_id });
  }
  const n = (await app.db.query<{ c: string | number }>('SELECT count(*) AS c FROM proposals'))
    .rows[0]!.c;
  const proposal_id = `prp_pack_${String(n)}`;
  const at = '2026-10-29T00:00:00.000Z';
  await app.db.query(
    `INSERT INTO briefs (id, buyer_id, raw_text, structured, version, confirmed_at, created_at, updated_at)
     VALUES ($1, $2, 'need', '{}'::jsonb, '1', $3, $3, $3)`,
    [`brf_${proposal_id}`, actor.buyer_id, at],
  );
  await app.db.query(
    `INSERT INTO proposals (id, brief_id, buyer_id, items, fit, created_at, updated_at)
     VALUES ($1, $2, $3, $4::jsonb, '[]'::jsonb, $5, $5)`,
    [
      proposal_id,
      `brf_${proposal_id}`,
      actor.buyer_id,
      JSON.stringify(quotes.map((q) => ({ quote: q, fit: null, title: 't', publisher: 'p' }))),
      at,
    ],
  );
  return { proposal_id, offer_ids: quotes.map((q) => q.offer_id) };
}

export const CONSENT = { terms: true, identity_share: false } as const;

export async function approvalFor(app: App, actor: Actor, offers: readonly Offer[]) {
  const p = await proposalFor(app, actor, offers);
  return app.engine.requestApproval({
    actor,
    selection: { kind: 'proposal', proposal_id: p.proposal_id, offer_ids: p.offer_ids },
    consent: CONSENT,
  });
}

export interface StartedPack {
  approval_id: string;
  order_id: string;
  order_ref: string;
  checkout: { approve_url: string; progress: { step: number; of: number } | null };
}

/** Approval, order and eager checkout (both PayPal orders created) for a pack of offers. */
export async function startPack(
  app: App,
  actor: Actor,
  offers: readonly Offer[],
): Promise<StartedPack> {
  const g = await approvalFor(app, actor, offers);
  if (!g.ok) throw new Error(`approval: ${g.error.code}`);
  const placed = await app.engine.payments.placeOrder({
    approval_id: g.value.approval_id,
    token: g.value.token,
    actor,
  });
  if (!placed.ok) throw new Error(`place: ${JSON.stringify(placed.error)}`);
  const co = await app.engine.payments.beginCheckout({ order_id: placed.value.order_id, actor });
  if (!co.ok) throw new Error(`checkout: ${co.error.code}`);
  return {
    approval_id: g.value.approval_id,
    order_id: placed.value.order_id,
    order_ref: placed.value.order_ref,
    checkout: co.value,
  };
}

/**
 * One dry-run approval of the PayPal order at `position` with its own scenario, then the buyer's
 * return (no scenario of its own: each pretend PayPal order keeps the one it was approved with).
 */
export async function approveStep(
  app: App,
  actor: Actor,
  order_ref: string,
  position: number,
  scenario: string,
) {
  const done = await app.engine.dryRunApprove({ order_ref, actor, scenario, position });
  if (!done) throw new Error(`dry-run approve of step ${String(position)} refused`);
  return app.engine.payments.onBuyerReturn({ order_ref, actor, scenario: null });
}

/** Start a pack and approve every PayPal order in position order with the given scenarios. */
export async function runPack(
  app: App,
  actor: Actor,
  offers: readonly Offer[],
  scenarios: readonly string[],
): Promise<StartedPack & { returns: Awaited<ReturnType<typeof approveStep>>[] }> {
  const started = await startPack(app, actor, offers);
  const returns: Awaited<ReturnType<typeof approveStep>>[] = [];
  for (const [i, scenario] of scenarios.entries()) {
    returns.push(await approveStep(app, actor, started.order_ref, i + 1, scenario));
  }
  return { ...started, returns };
}

/** Every string a buyer is shown for an order, joined: the banner, the case and the item lines. */
export async function orderText(app: App, actor: Actor, order_ref: string): Promise<string[]> {
  const v = await app.engine.orderView({ order_ref, actor });
  if (v === null) throw new Error('no order view');
  return [v.buyer_message, ...v.items.map((i) => i.line ?? '')];
}

/**
 * Like runPack, but the scenario is chosen by the publisher's display name, so a journey does not
 * depend on which publisher id sorts first (the position of a PayPal order follows the publisher id).
 */
export async function runPackByPublisher(
  app: App,
  actor: Actor,
  offers: readonly Offer[],
  scenarioOf: Record<string, string>,
): Promise<StartedPack & { returns: Awaited<ReturnType<typeof approveStep>>[] }> {
  const started = await startPack(app, actor, offers);
  const steps = await app.engine.checkoutSteps({ order_ref: started.order_ref, actor });
  if (steps === null) throw new Error('no steps');
  const returns: Awaited<ReturnType<typeof approveStep>>[] = [];
  for (const s of steps) {
    const scenario = scenarioOf[s.publisher];
    if (scenario === undefined) throw new Error(`no scenario for ${s.publisher}`);
    returns.push(await approveStep(app, actor, started.order_ref, s.position, scenario));
  }
  return { ...started, returns };
}
