// Shared helpers for the MVP-B offline acceptance tests: boot the dry-run app, run one order up to a
// chosen step. Offline only: the app is in dry-run mode, its transport is the fixture-backed
// dry-run model, and no test here reads a credential.
import type { Actor } from '@umsbx/contracts';
import type { App } from '../../apps/web/composition.server';
import { createApp, installApp } from '../../apps/web/composition.server';
import { testEnv } from '../../apps/web/src/support';

export async function bootApp(log_sink?: (line: string) => void): Promise<App> {
  const app = createApp(await testEnv(), { switch_cache_ms: 0, ...(log_sink ? { log_sink } : {}) });
  installApp(app);
  await app.ready();
  return app;
}

export async function buyerOf(app: App, subject = 'buyer-a'): Promise<Actor> {
  const row = await app.db.query<{ id: string }>(
    `SELECT id FROM buyers WHERE auth_subject = $1`,
    [`persona:${subject}`],
  );
  return { kind: 'buyer', buyer_id: row.rows[0]!.id };
}

export async function placeOrder(
  app: App,
  actor: Actor,
  offerIndex = 0,
): Promise<{ order_ref: string; order_id: string }> {
  const offers = (await app.engine.listOffers()).filter(
    (o) => o.publisher_slug === 'harbour-ledger',
  );
  const offer = offers[offerIndex]!.offer_code;
  const page = await app.engine.offerPage({ publisher: 'harbour-ledger', offer });
  const q = await app.engine.quote({
    offer: { publisher_slug: 'harbour-ledger', offer_code: offer },
    actor,
    source: 'direct',
    option: page!.options[0]!.option,
  });
  if (!q.ok || q.value.kind !== 'quote') throw new Error('no quote');
  const g = await app.engine.requestApproval({
    actor,
    selection: { kind: 'quote', quote_id: q.value.quote_id },
    consent: { terms: true, identity_share: false },
  });
  if (!g.ok) throw new Error('no approval');
  const placed = await app.engine.payments.placeOrder({
    approval_id: g.value.approval_id,
    token: g.value.token,
    actor,
  });
  if (!placed.ok) throw new Error('place failed');
  return placed.value;
}

/** Create the PayPal order (checkout) and let the dry-run buyer approve it. */
export async function checkoutAndApprove(
  app: App,
  actor: Actor,
  order: { order_ref: string; order_id: string },
  scenario: string,
): Promise<void> {
  const co = await app.engine.payments.beginCheckout({ order_id: order.order_id, actor, scenario });
  if (!co.ok) throw new Error(`checkout: ${co.error.code}`);
  const ok = await app.engine.dryRunApprove({ order_ref: order.order_ref, actor, scenario });
  if (!ok) throw new Error('dry-run approve failed');
}

export async function callRows(
  app: App,
): Promise<{ operation: string; method: string; outcome: string; http_status: number | null }[]> {
  return (
    await app.db.query<{
      operation: string;
      method: string;
      outcome: string;
      http_status: number | null;
    }>(`SELECT operation, method, outcome, http_status FROM provider_calls ORDER BY created_at, id`)
  ).rows;
}

export async function one(app: App, sql: string, params: unknown[] = []): Promise<number> {
  return Number((await app.db.query<{ c: string }>(sql, params)).rows[0]?.c);
}
