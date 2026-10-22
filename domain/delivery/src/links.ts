// Issuing signed links. A link never creates an order or a ledger entry and never touches the
// access window: the window is driven only by the evidence log (lane 07).
// Adapted from packages/core/entitlements/links.ts at a36ddc03fd0b962000f686291c145b50ee337f90 (refusal codes, re-issue never restarts the window); owned by SBX lane 09.
import { recordDeliveryEvent } from '@umsbx/access-clock';
import { getEntitlementForBuyer } from '@umsbx/entitlements';
import type { EntitlementView } from '@umsbx/entitlements';
import { err, ok } from '@umsbx/contracts';
import type {
  AccessState,
  Actor,
  ContentHead,
  ContentStore,
  CoreDeps,
  Id,
  IsoUtc,
  MoneyState,
  Result,
} from '@umsbx/contracts';
import { hashToken, makeLinkToken } from './link-token';

export type LinkError =
  | { code: 'not_found' }
  | { code: 'not_available'; access: AccessState; money: MoneyState }
  | { code: 'window_ended' }
  | { code: 'store_unavailable' };

export type DeliveryDeps = CoreDeps & { content: ContentStore };

export interface Article {
  content_key: string;
  title: string;
}

/**
 * Resolves the entitlement for the acting buyer. Another buyer, a non-buyer or an unknown id are
 * all `not_found` (P13); the buyer's own item that cannot be served gives a plain reason.
 */
export async function gateEntitlement(
  d: CoreDeps,
  i: { entitlement_id: Id; actor: Actor },
): Promise<Result<EntitlementView, LinkError>> {
  if (i.actor.kind !== 'buyer') return err({ code: 'not_found' });
  const view = await getEntitlementForBuyer(d.db, {
    entitlement_id: i.entitlement_id,
    buyer_id: i.actor.buyer_id,
  });
  if (view === null) return err({ code: 'not_found' });
  const now = d.clock.now().getTime();
  const w = view.window;
  const overdue = w.state === 'running' && w.ends_at !== null && Date.parse(w.ends_at) <= now;
  if (view.access === 'ended' || w.state === 'ended' || overdue) {
    return err({ code: 'window_ended' });
  }
  if (view.access !== 'available') {
    return err({ code: 'not_available', access: view.access, money: view.money });
  }
  return ok(view);
}

export async function loadArticle(d: CoreDeps, article_id: Id): Promise<Article | null> {
  const r = await d.db.query<Article>('SELECT content_key, title FROM articles WHERE id = $1', [
    article_id,
  ]);
  return r.rows[0] ?? null;
}

/** The stored object's head, or null when missing or when the store errors. */
export async function safeHead(content: ContentStore, key: string): Promise<ContentHead | null> {
  try {
    return await content.head(key);
  } catch {
    return null;
  }
}

export async function issueLink(
  d: DeliveryDeps,
  i: { entitlement_id: Id; actor: Actor },
): Promise<Result<{ link_id: Id; url: string; expires_at: IsoUtc }, LinkError>> {
  const gate = await gateEntitlement(d, i);
  if (!gate.ok) return gate;
  const view = gate.value;
  const article = await loadArticle(d, view.article_id);
  if (article === null || (await safeHead(d.content, article.content_key)) === null) {
    return err({ code: 'store_unavailable' });
  }
  const now = d.clock.now();
  const exp_unix = Math.floor((now.getTime() + d.config.link_ttl_ms) / 1000);
  const expires_at = new Date(exp_unix * 1000).toISOString();
  const link_id = d.ids.next('lnk');
  let token: string;
  try {
    token = makeLinkToken(d.config.link_secret, { link_id, exp_unix });
  } catch {
    return err({ code: 'store_unavailable' });
  }
  const stamp = now.toISOString();
  await d.db.query(
    `INSERT INTO links (id, entitlement_id, buyer_id, token_hash, expires_at, uses, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, 0, $6, $6)`,
    [link_id, view.entitlement_id, view.buyer_id, hashToken(token), expires_at, stamp],
  );
  await recordDeliveryEvent(d, {
    entitlement_id: view.entitlement_id,
    kind: 'link_issued',
    link_id,
    source: 'system',
    evidence: { expires_at },
  });
  return ok({ link_id, url: `/c/${token}`, expires_at });
}
