// Origin: AIC_Hackathon_UnitMarket@a36ddc03fd0b962000f686291c145b50ee337f90:packages/core/approval/approval.ts. Adapted; owned by SBX.
// requestApproval freezes one accepted offer set; verifyApproval and markUsed guard the single use.
// Every fact later used to charge and deliver comes from the stored snapshot, never from a live
// offer row. This module writes no orders and calls no provider (payments owns that).
import {
  APPROVAL_TTL_MS,
  AccessPolicySchema,
  ApprovalSchema,
  ApprovalSnapshotSchema,
  RightsSchema,
  err,
  ok,
} from '@umsbx/contracts';
import type {
  AccessOption,
  AccessPolicy,
  Actor,
  Approval,
  ApprovalSnapshot,
  CoreDeps,
  Id,
  IsoUtc,
  Result,
  Rights,
  Sha256Hex,
  SnapshotItem,
  SnapshotPublisher,
  SqlExecutor,
} from '@umsbx/contracts';
import { approvalError } from './errors';
import type { ApprovalError, VerifyError } from './errors';
import { contentHash, minorUnitsFor } from './snapshot';
import { makeToken, tokenMatches } from './token';

export type Selection =
  | { kind: 'quote'; quote_id: Id }
  | { kind: 'proposal'; proposal_id: Id; offer_ids: Id[] /* 1..5 */ };

export interface ApprovalGranted {
  approval_id: Id;
  token: string;
  expires_at: IsoUtc;
  snapshot: ApprovalSnapshot;
  content_hash: Sha256Hex;
}

const MAX_ITEMS = 5;
// A pack settles as one PayPal order per publisher (MVP-D, D2); more than two is refused.
const MAX_PUBLISHERS = 2;

// ---------- row helpers ----------
// PGlite returns timestamptz as Date and jsonb as a parsed value; other drivers may return text.
const iso = (v: unknown): string => (v instanceof Date ? v : new Date(String(v))).toISOString();
const json = (v: unknown): unknown => (typeof v === 'string' ? (JSON.parse(v) as unknown) : v);

interface QuoteRow {
  id: string;
  buyer_id: string | null;
  offer_id: string;
  offer_version: string;
  option: AccessOption;
  price_minor: number;
  currency: string;
  corridor_id: string;
  expires_at: unknown;
}
interface OfferRow {
  id: string;
  version: string;
  publisher_id: string;
  article_id: string;
  status: string;
  currency: string;
  options: unknown;
  terms_version: string;
  rights: unknown;
  valid_from: unknown;
  valid_until: unknown;
  superseded_by: string | null;
}
interface PublisherRow {
  id: string;
  country: string;
  paypal_merchant_id: string | null;
  payee_verified_at: unknown;
}
interface CorridorRow {
  id: string;
  currency: string;
  minor_units: number;
  payee_countries: string[];
  min_charge_minor: number | null;
  enabled: boolean;
}

// Resolve the selection to quote ids, in the order given.
async function quoteIds(
  tx: SqlExecutor,
  actor: Extract<Actor, { kind: 'buyer' }>,
  selection: Selection,
): Promise<Result<string[], ApprovalError>> {
  if (selection.kind === 'quote') return ok([selection.quote_id]);
  const offerIds = selection.offer_ids;
  if (offerIds.length > MAX_ITEMS) return approvalError('too_many_items');
  if (offerIds.length === 0 || new Set(offerIds).size !== offerIds.length) {
    return approvalError('unknown_selection');
  }
  const found = await tx.query<{ buyer_id: string; items: unknown }>(
    'SELECT buyer_id, items FROM proposals WHERE id = $1',
    [selection.proposal_id],
  );
  const proposal = found.rows[0];
  if (proposal === undefined) return approvalError('unknown_selection');
  if (proposal.buyer_id !== actor.buyer_id) return approvalError('not_owner');
  // A proposal item carries its quote (DiscoveryResult shape) or the ids flat.
  const items = json(proposal.items);
  const byOffer = new Map<string, string>();
  if (Array.isArray(items)) {
    for (const raw of items as unknown[]) {
      const rec = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
      const q = (
        typeof rec['quote'] === 'object' && rec['quote'] !== null ? rec['quote'] : rec
      ) as Record<string, unknown>;
      const offer_id = q['offer_id'];
      const quote_id = q['quote_id'];
      if (typeof offer_id === 'string' && typeof quote_id === 'string' && !byOffer.has(offer_id)) {
        byOffer.set(offer_id, quote_id);
      }
    }
  }
  const ids: string[] = [];
  for (const offer_id of offerIds) {
    const quote_id = byOffer.get(offer_id);
    if (quote_id === undefined) return approvalError('unknown_selection');
    ids.push(quote_id);
  }
  return ok(ids);
}

export async function requestApproval(
  d: CoreDeps,
  i: {
    actor: Actor;
    selection: Selection;
    consent: { terms: boolean; identity_share: boolean };
    /** API-B: the mandate an agent buys under. Frozen into the snapshot (inside the hash); none for a person. */
    mandate_id?: Id;
  },
): Promise<Result<ApprovalGranted, ApprovalError>> {
  const actor = i.actor;
  if (actor.kind !== 'buyer') return approvalError('not_owner');
  if (!i.consent.terms) return approvalError('consent_missing');
  if (i.selection.kind === 'proposal' && i.selection.offer_ids.length > MAX_ITEMS) {
    return approvalError('too_many_items');
  }
  const buyer = actor;

  return d.db.transaction(async (tx): Promise<Result<ApprovalGranted, ApprovalError>> => {
    const now = d.clock.now();
    const nowMs = now.getTime();

    const ids = await quoteIds(tx, buyer, i.selection);
    if (!ids.ok) return ids;
    if (new Set(ids.value).size !== ids.value.length) return approvalError('unknown_selection');

    // 1. Quotes: exist, belong to this buyer (or to nobody yet), not expired.
    const quotes: QuoteRow[] = [];
    for (const id of ids.value) {
      const r = await tx.query<QuoteRow>(
        `SELECT id, buyer_id, offer_id, offer_version, option, price_minor, currency, corridor_id, expires_at
           FROM quotes WHERE id = $1`,
        [id],
      );
      const q = r.rows[0];
      if (q === undefined) return approvalError('unknown_selection');
      if (q.buyer_id !== null && q.buyer_id !== buyer.buyer_id) return approvalError('not_owner');
      quotes.push(q);
    }
    for (const q of quotes) {
      if (nowMs >= Date.parse(iso(q.expires_at))) return approvalError('quote_expired');
    }

    // The buyer must exist: an anonymous quote passes the ownership check above, and a missing buyer row
    // would otherwise reach the INSERT and fail on the foreign key as a thrown error, not a typed refusal.
    const bx = await tx.query('SELECT 1 FROM buyers WHERE id = $1', [buyer.buyer_id]);
    if (bx.rows.length === 0) return approvalError('not_owner');

    // 2. One currency, one corridor.
    const first = quotes[0];
    if (first === undefined) return approvalError('unknown_selection');
    if (quotes.some((q) => q.currency !== first.currency)) return approvalError('mixed_currency');
    if (quotes.some((q) => q.corridor_id !== first.corridor_id)) {
      return approvalError('corridor_unsupported');
    }
    const cr = await tx.query<CorridorRow>(
      `SELECT id, currency, minor_units, payee_countries, min_charge_minor, enabled
         FROM corridors WHERE id = $1`,
      [first.corridor_id],
    );
    const corridor = cr.rows[0];
    if (
      corridor === undefined ||
      !corridor.enabled ||
      corridor.currency !== first.currency ||
      minorUnitsFor(corridor.currency) !== corridor.minor_units
    ) {
      return approvalError('corridor_unsupported');
    }

    // 3. Offers, publishers, policies: every fact comes from the database, not from the caller.
    const items: SnapshotItem[] = [];
    for (const q of quotes) {
      const or = await tx.query<OfferRow>(
        `SELECT id, version, publisher_id, article_id, status, currency, options, terms_version,
                rights, valid_from, valid_until, superseded_by
           FROM offers WHERE id = $1 AND version = $2`,
        [q.offer_id, q.offer_version],
      );
      const offer = or.rows[0];
      if (offer === undefined) return approvalError('unknown_selection');
      if (
        offer.status !== 'authorised' ||
        offer.superseded_by !== null ||
        offer.currency !== q.currency ||
        nowMs < Date.parse(iso(offer.valid_from)) ||
        (offer.valid_until !== null && nowMs >= Date.parse(iso(offer.valid_until)))
      ) {
        return approvalError('offer_changed');
      }
      const options = json(offer.options);
      const offered = (Array.isArray(options) ? (options as Record<string, unknown>[]) : []).find(
        (o) => o['option'] === q.option,
      );
      if (
        offered === undefined ||
        offered['price_minor'] !== q.price_minor ||
        typeof offered['policy_id'] !== 'string' ||
        typeof offered['policy_version'] !== 'string'
      ) {
        return approvalError('offer_changed');
      }
      const pr = await tx.query<AccessPolicy>(
        `SELECT id, version, option, window_ms, start_rule FROM access_policies
          WHERE id = $1 AND version = $2`,
        [offered['policy_id'], offered['policy_version']],
      );
      const policy = AccessPolicySchema.safeParse(pr.rows[0]);
      if (!policy.success || policy.data.option !== q.option) return approvalError('offer_changed');
      const rights: Rights | null = (() => {
        const parsed = RightsSchema.safeParse(json(offer.rights));
        return parsed.success ? parsed.data : null;
      })();
      if (rights === null) return approvalError('offer_changed');

      const ur = await tx.query<PublisherRow>(
        'SELECT id, country, paypal_merchant_id, payee_verified_at FROM publishers WHERE id = $1',
        [offer.publisher_id],
      );
      const publisher = ur.rows[0];
      if (publisher === undefined) return approvalError('unknown_selection');
      if (publisher.paypal_merchant_id === null || publisher.payee_verified_at === null) {
        return approvalError('publisher_unverified');
      }
      if (!corridor.payee_countries.includes(publisher.country)) {
        return approvalError('corridor_unsupported');
      }
      const ar = await tx.query<{ sha256: string }>(
        'SELECT sha256 FROM articles WHERE id = $1 AND publisher_id = $2',
        [offer.article_id, offer.publisher_id],
      );
      const article = ar.rows[0];
      if (article === undefined) return approvalError('unknown_selection');

      items.push({
        article_id: offer.article_id,
        article_sha256: article.sha256,
        offer_id: offer.id,
        offer_version: offer.version,
        terms_version: offer.terms_version,
        publisher_id: offer.publisher_id,
        payee_merchant_id: publisher.paypal_merchant_id,
        option: q.option,
        policy: policy.data,
        rights,
        amount_minor: q.price_minor,
      });
    }

    // 4. Publisher blocks (platform fee is always 0, D-3) and the total.
    const blocks = new Map<string, SnapshotPublisher>();
    for (const item of items) {
      const block = blocks.get(item.publisher_id);
      if (block === undefined) {
        blocks.set(item.publisher_id, {
          publisher_id: item.publisher_id,
          payee_merchant_id: item.payee_merchant_id,
          amount_minor: item.amount_minor,
          platform_fee_minor: 0,
        });
      } else {
        block.amount_minor += item.amount_minor;
      }
    }
    const publishers = [...blocks.values()].sort((a, b) =>
      a.publisher_id < b.publisher_id ? -1 : a.publisher_id > b.publisher_id ? 1 : 0,
    );
    if (publishers.length > MAX_PUBLISHERS) return approvalError('too_many_publishers');
    const total_minor = publishers.reduce((sum, p) => sum + p.amount_minor, 0);
    if (corridor.min_charge_minor !== null && total_minor < corridor.min_charge_minor) {
      return approvalError('corridor_unsupported');
    }
    const parsed = ApprovalSnapshotSchema.safeParse({
      snapshot_version: '1',
      items: [...items].sort((a, b) =>
        a.article_id < b.article_id ? -1 : a.article_id > b.article_id ? 1 : 0,
      ),
      publishers,
      total_minor,
      currency: first.currency,
      corridor_id: corridor.id,
      reader: { buyer_id: buyer.buyer_id },
      rule_version: d.config.rule_version,
      pricing_rule_version: d.config.pricing_rule_version,
      // Two publishers: the settlement route is frozen with the snapshot (inside the hash). One
      // publisher: no key at all, so the snapshot and its hash are exactly what they were before.
      ...(publishers.length >= 2
        ? { settlement: { route: 'per_publisher', payments: publishers.length } }
        : {}),
      // API-B: only an agent purchase carries a mandate; a person's snapshot and hash are what they were.
      ...(i.mandate_id !== undefined ? { mandate_id: i.mandate_id } : {}),
    });
    // A duplicate article (two offers for one article) is the one way a built snapshot can fail.
    if (!parsed.success) return approvalError('unknown_selection');
    const snapshot = parsed.data;

    // 5. Hash, id, nonce, expiry, token, row.
    const content_hash = contentHash(snapshot);
    const approval_id = d.ids.next('apr');
    const nonce = d.ids.nonce();
    const created_at = now.toISOString();
    const expires_at = new Date(nowMs + APPROVAL_TTL_MS).toISOString();
    await tx.query(
      `INSERT INTO approvals (id, buyer_id, snapshot, content_hash, nonce, expires_at, used_at, environment, created_at, updated_at)
       VALUES ($1, $2, $3::jsonb, $4, $5, $6, NULL, $7, $8, $8)`,
      [
        approval_id,
        buyer.buyer_id,
        JSON.stringify(snapshot),
        content_hash,
        nonce,
        expires_at,
        d.environment,
        created_at,
      ],
    );
    await d.audit.record(tx, {
      actor: buyer,
      action: 'approval.requested',
      target: approval_id,
      reason: null,
      detail: {
        terms: true,
        identity_share: i.consent.identity_share,
        content_hash,
        total_minor,
        currency: snapshot.currency,
        items: snapshot.items.length,
      },
    });
    const token = makeToken(d.config.approval_secret.reveal(), {
      approval_id,
      nonce,
      content_hash,
      expires_at,
    });
    return ok({ approval_id, token, expires_at, snapshot, content_hash });
  });
}

interface ApprovalRow {
  id: string;
  buyer_id: string;
  snapshot: unknown;
  content_hash: string;
  nonce: string;
  created_at: unknown;
  expires_at: unknown;
  used_at: unknown;
  environment: string;
}

const verifyError = (error: VerifyError): { ok: false; error: VerifyError } => err(error);

// Order of checks: unknown, stored snapshot against its hash and its reader, token, owner (404),
// expiry (now >= expires_at is 410), single use. Reads the stored row only; nothing is taken from live offers.
export async function verifyApproval(
  tx: SqlExecutor,
  d: CoreDeps,
  i: { approval_id: Id; token: string; actor: Actor },
): Promise<Result<Approval, VerifyError>> {
  const r = await tx.query<ApprovalRow>(
    `SELECT id, buyer_id, snapshot, content_hash, nonce, created_at, expires_at, used_at, environment
       FROM approvals WHERE id = $1`,
    [i.approval_id],
  );
  const row = r.rows[0];
  if (row === undefined) return verifyError({ code: 'unknown_approval', http: 404 });

  const snapshot = ApprovalSnapshotSchema.safeParse(json(row.snapshot));
  if (!snapshot.success) return verifyError({ code: 'snapshot_tampered', http: 403 });
  let recomputed: string;
  try {
    recomputed = contentHash(snapshot.data);
  } catch {
    return verifyError({ code: 'snapshot_tampered', http: 403 });
  }
  if (recomputed !== row.content_hash) return verifyError({ code: 'snapshot_tampered', http: 403 });
  // The buyer the snapshot was frozen for must be the buyer who owns the row.
  if (snapshot.data.reader.buyer_id !== row.buyer_id) {
    return verifyError({ code: 'snapshot_tampered', http: 403 });
  }

  const expires_at = iso(row.expires_at);
  const ok_token = tokenMatches(
    d.config.approval_secret.reveal(),
    { approval_id: row.id, nonce: row.nonce, content_hash: row.content_hash, expires_at },
    i.token,
  );
  if (!ok_token) return verifyError({ code: 'bad_token', http: 403 });

  // Owner before expiry and use: another buyer must not learn the state of this approval.
  if (i.actor.kind !== 'buyer' || i.actor.buyer_id !== row.buyer_id) {
    return verifyError({ code: 'not_owner', http: 404 });
  }
  if (d.clock.now().getTime() >= Date.parse(expires_at)) {
    return verifyError({ code: 'expired', http: 410 });
  }
  if (row.used_at !== null) return verifyError({ code: 'already_used', http: 409 });

  const approval = ApprovalSchema.safeParse({
    approval_id: row.id,
    buyer_id: row.buyer_id,
    snapshot: snapshot.data,
    content_hash: row.content_hash,
    nonce: row.nonce,
    created_at: iso(row.created_at),
    expires_at,
    used_at: null,
    environment: row.environment,
  });
  if (!approval.success) return verifyError({ code: 'snapshot_tampered', http: 403 });
  return ok(approval.data);
}

// Compare-and-set: used_at goes from NULL to now exactly once. The row guard in the database
// refuses every other change to an approval. An unknown id changes nothing and is also refused.
export async function markUsed(
  tx: SqlExecutor,
  d: CoreDeps,
  i: { approval_id: Id },
): Promise<Result<void, { code: 'already_used' }>> {
  const at = d.clock.now().toISOString();
  const r = await tx.query<{ id: string }>(
    'UPDATE approvals SET used_at = $2, updated_at = $2 WHERE id = $1 AND used_at IS NULL RETURNING id',
    [i.approval_id, at],
  );
  return r.rows.length === 1 ? ok(undefined) : err({ code: 'already_used' });
}
