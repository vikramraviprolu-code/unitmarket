// POB-I1 (D-089, journey J9): the publisher publishes the staged items they chose. One transaction per item
// through the existing publisher offer path: the article (with the hosted copy made at staging), offer
// version 1 live, the authorisation row and an audit row. The attestation of rights is asked once per batch.
//
// The price set at review is the publisher's own and obeys the same bounds as any offer price, 1 to the offer
// cap. An item with no price stays staged ("needs a price"). POB-G (D-089 item 3, D-096 item 2): the offer is
// listed at the BUYER price, the publisher's price plus the fee in force, and the split is recorded in the same
// transaction as the offer (recordOfferParts), so the sale carries it to the ledger (POB-M1). The rate is read
// once for the batch (`loadFee`); a fee that cannot be read refuses the publish before anything is written
// (fail closed: never a price listed without its fee). A buyer price over the offer cap is `bad_price`.
//
// Each offer carries both access options (keep and read online) at the buyer price, so a buyer gets the
// copy UnitMarket hosts. An item whose transaction fails stays staged and is counted; the others go on.
import { IdSchema, err, ok } from '@umsbx/contracts';
import type { Actor, Result } from '@umsbx/contracts';
import { buyerPriceOf, resolveImportFee } from './import-fee';
import type { ImportFeePolicy } from './import-fee';
import { PUB_ATTEST_1, checkPrice, createOfferInTx, offerCurrencyFor } from './write';
import type { FeeParts } from './fee';
import type { ImportDeps, ImportError, ImportErrorCode } from './import-types';

export interface PublishSummary {
  published: number;
  /** Staged items without a price: left staged. */
  needs_price: number;
  /** Staged items whose price is outside 1 to the offer cap: left staged. */
  bad_price: number;
  /** Items whose transaction failed: left staged. */
  failed: number;
}

type Row = Record<string, unknown>;
const fail = (code: ImportErrorCode): Result<never, ImportError> => err({ code });

export async function publishBatch(
  deps: ImportDeps,
  actor: Actor,
  input: { batch_id: string; attestation: boolean; item_ids?: string[] },
): Promise<Result<PublishSummary, ImportError>> {
  if (actor.kind !== 'publisher') return fail('not_publisher');
  if (typeof input.batch_id !== 'string' || !IdSchema.safeParse(input.batch_id).success)
    return fail('not_found');
  const batch = await deps.db.query<Row>(
    'SELECT state, attested_at FROM import_batches WHERE id = $1 AND publisher_id = $2',
    [input.batch_id, actor.publisher_id],
  );
  const b = batch.rows[0];
  if (b === undefined) return fail('not_found');
  const pub = await deps.db.query<{ status: string }>(
    'SELECT status FROM publishers WHERE id = $1',
    [actor.publisher_id],
  );
  if (pub.rows[0]?.status !== 'active') return fail('publisher_not_active');
  if (b.state === 'queued' || b.state === 'running') return fail('batch_not_ready');

  // The rate in force, read once for the batch; the currency is the one of the publisher's corridor.
  const policy = await resolveImportFee(deps);
  if (policy === null) return fail('fee_unavailable');
  const currency = await offerCurrencyFor(deps.db, actor);
  if (currency === null) return fail('no_corridor');

  const wanted =
    input.item_ids === undefined
      ? null
      : Array.isArray(input.item_ids)
        ? input.item_ids.filter((x): x is string => typeof x === 'string' && x.length <= 200)
        : [];
  const staged =
    wanted === null
      ? await deps.db.query<Row>(
          `SELECT id, price_minor FROM import_items WHERE batch_id = $1 AND publisher_id = $2 AND state = 'staged'
            ORDER BY created_at, source_key, id`,
          [input.batch_id, actor.publisher_id],
        )
      : await deps.db.query<Row>(
          `SELECT id, price_minor FROM import_items WHERE batch_id = $1 AND publisher_id = $2 AND state = 'staged'
              AND id = ANY ($3) ORDER BY created_at, source_key, id`,
          [input.batch_id, actor.publisher_id, wanted],
        );

  // A fee the policy cannot give for a price about to be listed refuses the whole publish, before the attestation is
  // recorded or anything is written (a price is never listed without its fee).
  for (const row of staged.rows) {
    if (row.price_minor == null) continue;
    const price = Number(row.price_minor);
    if (checkPrice(price, deps.offer_max_minor).ok && partsOf(policy, price, currency) === null)
      return fail('fee_unavailable');
  }

  // The attestation of rights: ticked once per batch, then remembered.
  if (b.attested_at == null) {
    if (input.attestation !== true) return fail('attestation_required');
    const at = deps.clock.now().toISOString();
    await deps.db.query(
      `UPDATE import_batches SET attested_at = $2, attestation_version = $3, updated_at = $2
        WHERE id = $1 AND attested_at IS NULL`,
      [input.batch_id, at, PUB_ATTEST_1],
    );
  }

  const summary: PublishSummary = { published: 0, needs_price: 0, bad_price: 0, failed: 0 };
  for (const row of staged.rows) {
    const price = row.price_minor == null ? null : Number(row.price_minor);
    if (price === null) {
      summary.needs_price += 1;
      continue;
    }
    if (!checkPrice(price, deps.offer_max_minor).ok) {
      summary.bad_price += 1;
      continue;
    }
    const parts = partsOf(policy, price, currency);
    if (parts === null) {
      // Answered fine in the check above and not now: a policy that changes its mind. Nothing is written for it.
      summary.failed += 1;
      continue;
    }
    if (!checkPrice(parts.buyer_minor, deps.offer_max_minor).ok) {
      summary.bad_price += 1;
      continue;
    }
    try {
      const done = await publishOne(deps, actor, row.id as string, parts, currency);
      if (done) summary.published += 1;
    } catch {
      summary.failed += 1;
    }
  }
  await deps.db.transaction(async (tx) => {
    await deps.audit.record(tx, {
      actor,
      action: 'import.published',
      target: input.batch_id,
      reason: null,
      detail: { batch_id: input.batch_id, ...summary },
    });
  });
  return ok(summary);
}

/** One item, one transaction. False when the item is no longer staged (another call was first). */
async function publishOne(
  deps: ImportDeps,
  actor: Extract<Actor, { kind: 'publisher' }>,
  item_id: string,
  parts: FeeParts,
  currency: string,
): Promise<boolean> {
  return deps.db.transaction(async (tx) => {
    const cur = await tx.query<Row>(
      `SELECT title, summary, language, topics, content_ref, content_sha256, content_mime, content_bytes,
              source_published_at, state
         FROM import_items WHERE id = $1 AND publisher_id = $2 FOR UPDATE`,
      [item_id, actor.publisher_id],
    );
    const it = cur.rows[0];
    if (it === undefined || it.state !== 'staged') return false;
    const at = deps.clock.now().toISOString();
    const src =
      it.source_published_at == null
        ? null
        : new Date(it.source_published_at as string).toISOString();
    const published = src !== null && src <= at ? src : at;
    const article_id = deps.ids.next('art');
    await tx.query(
      `INSERT INTO articles (id, publisher_id, title, abstract, language, topics, published_at, sha256, content_key, bytes, mime, created_at, updated_at, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12,$13)`,
      [
        article_id,
        actor.publisher_id,
        it.title,
        it.summary,
        it.language,
        it.topics,
        published,
        it.content_sha256,
        it.content_ref,
        it.content_bytes,
        it.content_mime,
        at,
        `web_import:${actor.publisher_id}`,
      ],
    );
    const made = await createOfferInTx(
      deps,
      tx,
      actor,
      article_id,
      [
        { option: 'keep_retrieve', price_minor: parts.buyer_minor },
        { option: 'online_read', price_minor: parts.buyer_minor },
      ],
      parts,
      currency,
    );
    await tx.query(
      `UPDATE import_items SET state = 'published', article_id = $2, offer_id = $3, updated_at = $4 WHERE id = $1`,
      [item_id, article_id, made.offer_id, at],
    );
    return true;
  });
}

/**
 * The split of one publisher price through the policy, or null when the policy gives no usable answer (it throws, answers
 * something that is not a whole fee, or charges a fee without naming its rate). Fee 0 with no rate records rate 0.
 */
function partsOf(policy: ImportFeePolicy, seller_minor: number, currency: string): FeeParts | null {
  const priced = buyerPriceOf(policy, seller_minor, currency);
  if (priced === null) return null;
  const fee_bps = policy.fee_bps ?? (priced.fee_minor === 0 ? 0 : null);
  if (fee_bps === null || !Number.isSafeInteger(fee_bps) || fee_bps < 0) return null;
  return {
    seller_minor,
    fee_minor: priced.fee_minor,
    buyer_minor: priced.buyer_minor,
    fee_bps,
    tax_minor: 0,
  };
}
