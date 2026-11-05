// POB-I1 (D-089, journey J9): the publisher publishes the staged items they chose. One transaction per item
// through the existing publisher offer path: the article (with the hosted copy made at staging), offer
// version 1 live, the authorisation row and an audit row. The attestation of rights is asked once per batch.
//
// The price is the publisher's own (set at review) and obeys the same bounds as any offer price, 1 to the
// offer cap. An item with no price stays staged ("needs a price"). The fee of the buyer is not written here:
// the offer carries the publisher price, and the fee is decided at the quote by the fee lane.
//
// Each offer carries both access options (keep and read online) at the publisher's price, so a buyer gets the
// copy UnitMarket hosts. An item whose transaction fails stays staged and is counted; the others go on.
import { IdSchema, err, ok } from '@umsbx/contracts';
import type { Actor, Result } from '@umsbx/contracts';
import { PUB_ATTEST_1, checkPrice, createOfferInTx } from './write';
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
    try {
      const done = await publishOne(deps, actor, row.id as string, price);
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
  price: number,
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
    const made = await createOfferInTx(deps, tx, actor, article_id, [
      { option: 'keep_retrieve', price_minor: price },
      { option: 'online_read', price_minor: price },
    ]);
    await tx.query(
      `UPDATE import_items SET state = 'published', article_id = $2, offer_id = $3, updated_at = $4 WHERE id = $1`,
      [item_id, article_id, made.offer_id, at],
    );
    return true;
  });
}
