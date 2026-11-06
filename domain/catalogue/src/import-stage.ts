// POB-I1 (D-089, journey J7 and J8): the publisher begins an import, a background run reads the source through
// the guarded fetcher into a staging list, and the publisher reviews it. Nothing here touches the catalogue:
// publishing is import-publish.ts.
//
//   begin   startVerifiedImport  proves the domain AGAIN (the two fixed paths), then queues one batch. If the
//                                token no longer holds, or the host now resolves to a private address, it
//                                answers proof_lost, audits import.proof_failed, writes no batch and fetches no
//                                item.
//   run     runNextBatch         takes one queued batch (one UPDATE, so two runners never share it), reads the
//                                source, then each item page and picture of this host, one transaction per
//                                item with the progress. The may-fetch check is asked before EVERY fetch; the
//                                run stops after BATCH_DEADLINE_MS. A batch that recovery has ended is never
//                                overwritten: every write says WHERE state = 'running'.
//   review  getBatch, editItem   the staged list, the price, the buyer price (publisher price plus the fee of
//                                the injected port), edit and hide in one transaction.
//
// What is fetched, from where: the allow list of every call is the one verified host of the batch. A picture
// or a page on another host is refused, never fetched, never hotlinked. Pictures: jpeg, png or webp by
// content type AND by their first bytes, 2 MB at most. Text is the plain text the extractor made, hashed.
import { IdSchema, err, ok } from '@umsbx/contracts';
import type { Actor, Result, SqlExecutor } from '@umsbx/contracts';
import { parseWebAddress, proveDomain } from './domain-proof';
import { sanitiseFeedText } from './feed-parse';
import { extractSource } from './extract-structured';
import type { Candidate } from './extract-structured';
import { fetchChecked, sha256Hex, sha256Text } from './import-fetch';
import { UNREADABLE_FEE_POLICY, buyerPriceOf, resolveImportFee } from './import-fee';
import type { ImportDeps, ImportError, ImportErrorCode } from './import-types';

export const BATCH_DEADLINE_MS = 120_000;
export const MAX_BATCH_ITEMS = 100;
export const IMAGE_MAX_BYTES = 2 * 1024 * 1024;

type Row = Record<string, unknown>;
const fail = (code: ImportErrorCode, detail?: string): Result<never, ImportError> =>
  err(detail === undefined ? { code } : { code, detail });
const isUnique = (e: unknown): boolean =>
  typeof e === 'object' && e !== null && (e as { code?: unknown }).code === '23505';
const iso = (v: unknown): string => new Date(v as string | number | Date).toISOString();
const isoOrNull = (v: unknown): string | null => (v == null ? null : iso(v));
const encoder = new TextEncoder();

/** Thrown inside an item's transaction when the batch is no longer running (recovery ended it). */
class Ended extends Error {}

type StopState = 'done' | 'failed' | 'interrupted';
interface Stop {
  state: StopState;
  note: string | null;
}

// ---------------------------------------------------------------------------------------------
// Begin

/**
 * The publisher begins an import from a web address on a domain it has proved. See the file comment.
 * Errors: not_publisher, publisher_not_active, invalid_address, no_corridor, domain_not_verified,
 * import_off, paused, import_active, proof_lost.
 */
export async function startVerifiedImport(
  deps: ImportDeps,
  actor: Actor,
  input: { source_url: string },
): Promise<Result<{ batch_id: string }, ImportError>> {
  if (actor.kind !== 'publisher') return fail('not_publisher');
  const addr = parseWebAddress(input.source_url);
  if (addr === null) return fail('invalid_address');
  const pub = await deps.db.query<{ status: string; country: string }>(
    'SELECT status, country FROM publishers WHERE id = $1',
    [actor.publisher_id],
  );
  const p = pub.rows[0];
  if (p === undefined) return fail('not_publisher');
  if (p.status !== 'active') return fail('publisher_not_active');
  const corridor = await deps.db.query(
    'SELECT 1 AS x FROM corridors WHERE enabled AND $1 = ANY (payee_countries) LIMIT 1',
    [p.country],
  );
  if (corridor.rows.length === 0) return fail('no_corridor');
  const dom = await deps.db.query<{ token_hash: string }>(
    `SELECT token_hash FROM publisher_domains WHERE publisher_id = $1 AND host = $2 AND state = 'verified'`,
    [actor.publisher_id, addr.host],
  );
  if (dom.rows[0] === undefined) return fail('domain_not_verified');
  const active = await deps.db.query(
    `SELECT 1 AS x FROM import_batches WHERE publisher_id = $1 AND state IN ('queued', 'running') LIMIT 1`,
    [actor.publisher_id],
  );
  if (active.rows.length > 0) return fail('import_active');
  if (deps.fetcher === null) return fail('import_off');

  // The proof is fetched again on every begin.
  const proof = await proveDomain(deps, addr.host, dom.rows[0].token_hash);
  if (proof.kind === 'paused') return fail('paused');
  if (proof.kind !== 'ok') {
    await deps.db.transaction(async (tx) => {
      await deps.audit.record(tx, {
        actor,
        action: 'import.proof_failed',
        target: null,
        reason: null,
        detail: {
          host: addr.host,
          detail: proof.kind === 'refused' ? proof.reason : 'missing',
        },
      });
    });
    return fail('proof_lost');
  }

  const id = `imb_${deps.ids.nonce()}`;
  try {
    await deps.db.transaction(async (tx) => {
      const at = deps.clock.now().toISOString();
      await tx.query(
        `INSERT INTO import_batches (id, publisher_id, source_host, source_url, state, note, total, done, refused, existing, changed,
                                     attested_at, attestation_version, created_by, created_at, started_at, finished_at, updated_at)
         VALUES ($1,$2,$3,$4,'queued',NULL,0,0,0,0,0,NULL,NULL,$2,$5,NULL,NULL,$5)`,
        [id, actor.publisher_id, addr.host, addr.url, at],
      );
      await deps.audit.record(tx, {
        actor,
        action: 'import.begun',
        target: id,
        reason: null,
        detail: { host: addr.host },
      });
    });
  } catch (e) {
    if (isUnique(e)) return fail('import_active');
    throw e;
  }
  return ok({ batch_id: id });
}

// ---------------------------------------------------------------------------------------------
// The run

interface Claimed {
  id: string;
  publisher_id: string;
  source_host: string;
  source_url: string;
}

/** Takes one queued batch and runs it. `ran: false` when nothing is queued or the feature is off. */
export async function runNextBatch(
  deps: ImportDeps,
): Promise<{ ran: boolean; batch_id: string | null }> {
  if (deps.fetcher === null) return { ran: false, batch_id: null };
  const at = deps.clock.now().toISOString();
  const claimed = await deps.db.query<Row>(
    `UPDATE import_batches SET state = 'running', started_at = $1, updated_at = $1
      WHERE id = (SELECT id FROM import_batches WHERE state = 'queued' ORDER BY created_at, id LIMIT 1 FOR UPDATE SKIP LOCKED)
        AND state = 'queued'
      RETURNING id, publisher_id, source_host, source_url`,
    [at],
  );
  const row = claimed.rows[0];
  if (row === undefined) return { ran: false, batch_id: null };
  const b: Claimed = {
    id: row.id as string,
    publisher_id: row.publisher_id as string,
    source_host: row.source_host as string,
    source_url: row.source_url as string,
  };
  try {
    await runBatch(deps, b);
  } catch (e) {
    if (!(e instanceof Ended)) {
      // An unexpected error ends the batch as failed; the words say nothing about its cause.
      await finishBatch(deps, b.id, 'failed', 'error').catch(() => undefined);
    }
  }
  return { ran: true, batch_id: b.id };
}

/**
 * At a start: every queued or running batch is marked interrupted (restart). This assumes one process: it
 * is called by the job loop at the start of the term of the one leader.
 */
export async function recoverImports(deps: ImportDeps): Promise<{ interrupted: number }> {
  return deps.db.transaction(async (tx) => {
    const at = deps.clock.now().toISOString();
    const r = await tx.query<{ id: string; state: string }>(
      `UPDATE import_batches SET state = 'interrupted', note = 'restart', finished_at = $1, updated_at = $1
        WHERE state IN ('queued', 'running') RETURNING id, state`,
      [at],
    );
    for (const row of r.rows) {
      await deps.audit.record(tx, {
        actor: { kind: 'system' },
        action: 'import.interrupted',
        target: row.id,
        reason: null,
        detail: { note: 'restart' },
      });
    }
    return { interrupted: r.rows.length };
  });
}

async function finishBatch(
  deps: ImportDeps,
  id: string,
  state: StopState,
  note: string | null,
): Promise<void> {
  await deps.db.transaction(async (tx) => {
    const at = deps.clock.now().toISOString();
    // Only a batch that is still running is ended here: one that recovery ended keeps its state and gets
    // no second audit row.
    const r = await tx.query<Row>(
      `UPDATE import_batches SET state = $2, note = $3, finished_at = $4, updated_at = $4
        WHERE id = $1 AND state = 'running' RETURNING total, done, refused, existing, changed`,
      [id, state, note, at],
    );
    const row = r.rows[0];
    if (row === undefined) return;
    await deps.audit.record(tx, {
      actor: { kind: 'system' },
      action: 'import.finished',
      target: id,
      reason: null,
      detail: {
        state,
        note,
        total: Number(row.total),
        done: Number(row.done),
        refused: Number(row.refused),
        existing: Number(row.existing),
        changed: Number(row.changed),
      },
    });
  });
}

interface Ctx {
  deps: ImportDeps;
  b: Claimed;
  slug: string;
  currency: string;
  started: number;
}

type Step =
  | { ok: true; body: string; bytes: Uint8Array; content_type: string }
  | { ok: false; stop: Stop }
  | { ok: false; refused: string };

/** One fetch of this host, with the deadline and the may-fetch check in front of it. */
async function step(ctx: Ctx, url: string, kind: 'text' | 'image'): Promise<Step> {
  if (ctx.deps.clock.now().getTime() - ctx.started > BATCH_DEADLINE_MS)
    return { ok: false, stop: { state: 'interrupted', note: 'deadline' } };
  const r = await fetchChecked(ctx.deps, ctx.b.source_host, url, kind);
  switch (r.kind) {
    case 'ok':
      return { ok: true, body: r.body, bytes: r.bytes, content_type: r.content_type };
    case 'paused':
      return { ok: false, stop: { state: 'interrupted', note: 'paused' } };
    case 'check_failed':
      return { ok: false, stop: { state: 'failed', note: 'check_failed' } };
    case 'off':
      return { ok: false, stop: { state: 'failed', note: 'import_off' } };
    case 'refused':
      return { ok: false, refused: r.reason };
  }
}

async function runBatch(deps: ImportDeps, b: Claimed): Promise<void> {
  const end = (s: Stop): Promise<void> => finishBatch(deps, b.id, s.state, s.note);
  const pub = await deps.db.query<{ status: string; slug: string; country: string }>(
    'SELECT status, slug, country FROM publishers WHERE id = $1',
    [b.publisher_id],
  );
  const p = pub.rows[0];
  if (p === undefined || p.status !== 'active')
    return end({ state: 'failed', note: 'publisher_not_active' });
  const cur = await deps.db.query<{ currency: string }>(
    'SELECT currency FROM corridors WHERE enabled AND $1 = ANY (payee_countries) ORDER BY id LIMIT 1',
    [p.country],
  );
  const currency = cur.rows[0]?.currency;
  if (currency === undefined) return end({ state: 'failed', note: 'no_corridor' });
  const ctx: Ctx = { deps, b, slug: p.slug, currency, started: deps.clock.now().getTime() };

  const src = await step(ctx, b.source_url, 'text');
  if (!src.ok) {
    if ('stop' in src) return end(src.stop);
    return end({ state: 'failed', note: src.refused });
  }
  const ex = extractSource(src.body, src.content_type, b.source_host);
  if (ex.candidates.length === 0 && ex.links.length === 0)
    return end({ state: 'done', note: ex.reason ?? 'no_structured_data' });
  const total = ex.candidates.length + ex.links.length;
  if (total > MAX_BATCH_ITEMS) return end({ state: 'done', note: 'too_many_items' });
  const set = await deps.db.query(
    `UPDATE import_batches SET total = $2, updated_at = $3 WHERE id = $1 AND state = 'running' RETURNING id`,
    [b.id, total, deps.clock.now().toISOString()],
  );
  if (set.rows.length === 0) return;

  for (const c of ex.candidates) {
    const stop = await handleCandidate(ctx, c);
    if (stop !== null) return end(stop);
  }
  for (const link of ex.links) {
    const stop = await handleLink(ctx, link);
    if (stop !== null) return end(stop);
  }
  return end({ state: 'done', note: null });
}

// ---- one item

interface Staged {
  kind: 'article' | 'image';
  source_key: string;
  title: string;
  summary: string;
  language: string;
  topics: string[];
  price_minor: number | null;
  source_price_minor: number | null;
  published_at: string | null;
  state: 'staged' | 'refused';
  reason: string | null;
  content: { key: string; mime: string; bytes: Uint8Array; sha256: string } | null;
}

async function known(
  ctx: Ctx,
  source_key: string,
): Promise<{ content_sha256: string | null; content_mime: string | null } | null> {
  const r = await ctx.deps.db.query<Row>(
    'SELECT content_sha256, content_mime FROM import_items WHERE publisher_id = $1 AND source_key = $2',
    [ctx.b.publisher_id, source_key],
  );
  const row = r.rows[0];
  if (row === undefined) return null;
  return {
    content_sha256: (row.content_sha256 as string | null) ?? null,
    content_mime: (row.content_mime as string | null) ?? null,
  };
}

/** The price proposal of the source, kept only if it is in the currency of the corridor and in range. */
function priceOf(ctx: Ctx, c: Candidate): number | null {
  const p = c.price_minor;
  if (p === null || !Number.isSafeInteger(p) || p < 1 || p > ctx.deps.offer_max_minor) return null;
  if (c.price_currency !== null && c.price_currency !== ctx.currency) return null;
  return p;
}

function sniff(bytes: Uint8Array): { mime: string; ext: string } | null {
  const at = (i: number, ...v: number[]): boolean => v.every((x, k) => bytes[i + k] === x);
  if (bytes.length >= 8 && at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))
    return { mime: 'image/png', ext: 'png' };
  if (bytes.length >= 3 && at(0, 0xff, 0xd8, 0xff)) return { mime: 'image/jpeg', ext: 'jpg' };
  if (bytes.length >= 12 && at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50))
    return { mime: 'image/webp', ext: 'webp' };
  return null;
}

async function handleCandidate(ctx: Ctx, c: Candidate): Promise<Stop | null> {
  const old = await known(ctx, c.source_key);
  if (old !== null) {
    let changed = 0;
    if (c.body !== null && old.content_mime === 'text/plain' && old.content_sha256 !== null)
      if ((await sha256Text(c.body)) !== old.content_sha256) changed = 1;
    await persist(ctx, null, { existing: 1, changed });
    return null;
  }
  const price = priceOf(ctx, c);
  const base = {
    kind: c.kind,
    source_key: c.source_key,
    title: c.title,
    summary: c.summary,
    language: c.language,
    topics: c.topics,
    price_minor: price,
    source_price_minor: price,
    published_at: c.published_at,
  } as const;
  const refuse = (reason: string): Staged => ({
    ...base,
    state: 'refused',
    reason,
    content: null,
  });
  const keyHash = (await sha256Text(c.source_key)).slice(0, 32);

  let staged: Staged;
  if (c.kind === 'article') {
    let body = c.body;
    let missing: string | null = null;
    if (body === null && c.page_url !== null) {
      // The item's own page, same host: the only content link that is ever fetched.
      const page = await step(ctx, c.page_url, 'text');
      if (!page.ok) {
        if ('stop' in page) return page.stop;
        missing = 'page_failed';
      } else {
        const got = extractSource(page.body, page.content_type, ctx.b.source_host).candidates.find(
          (x) => x.kind === 'article' && x.body !== null,
        );
        body = got?.body ?? null;
      }
    }
    if (missing !== null) staged = refuse(missing);
    else if (body === null) staged = refuse('no_text');
    else {
      const bytes = encoder.encode(body);
      staged = {
        ...base,
        state: 'staged',
        reason: null,
        content: {
          key: `import/${ctx.slug}/${keyHash}.txt`,
          mime: 'text/plain',
          bytes,
          sha256: await sha256Hex(bytes),
        },
      };
    }
  } else if (c.image_url === null) {
    staged = refuse('no_image');
  } else {
    let host = '';
    try {
      host = new URL(c.image_url).hostname;
    } catch {
      host = '';
    }
    if (host !== ctx.b.source_host) {
      staged = refuse('image_off_host');
    } else {
      const img = await step(ctx, c.image_url, 'image');
      if (!img.ok) {
        if ('stop' in img) return img.stop;
        staged = refuse('image_failed');
      } else if (img.bytes.length > IMAGE_MAX_BYTES) {
        staged = refuse('too_large');
      } else {
        const seen = sniff(img.bytes);
        const claimed = img.content_type.split(';')[0]!.trim().toLowerCase();
        if (seen === null || seen.mime !== claimed) staged = refuse('bad_image');
        else {
          staged = {
            ...base,
            state: 'staged',
            reason: null,
            content: {
              key: `import/${ctx.slug}/${keyHash}.${seen.ext}`,
              mime: seen.mime,
              bytes: img.bytes,
              sha256: await sha256Hex(img.bytes),
            },
          };
        }
      }
    }
  }
  await persist(ctx, staged, {});
  return null;
}

async function handleLink(ctx: Ctx, url: string): Promise<Stop | null> {
  if ((await known(ctx, url)) !== null) {
    await persist(ctx, null, { existing: 1 });
    return null;
  }
  const page = await step(ctx, url, 'text');
  if (!page.ok) {
    if ('stop' in page) return page.stop;
    return refuseLink(ctx, url, 'page_failed');
  }
  const first = extractSource(page.body, page.content_type, ctx.b.source_host).candidates[0];
  if (first === undefined) return refuseLink(ctx, url, 'no_structured_data');
  return handleCandidate(ctx, first);
}

async function refuseLink(ctx: Ctx, url: string, reason: string): Promise<Stop | null> {
  const title = sanitiseFeedText(url, { max: 200 }) || 'Page';
  await persist(
    ctx,
    {
      kind: 'article',
      source_key: url.slice(0, 500),
      title,
      summary: title,
      language: 'und',
      topics: [],
      price_minor: null,
      source_price_minor: null,
      published_at: null,
      state: 'refused',
      reason,
      content: null,
    },
    {},
  );
  return null;
}

/**
 * One transaction: the progress of the batch (only while it is still running), the hosted copy and the item.
 * `counts` is for an item that is only counted (already known).
 */
async function persist(
  ctx: Ctx,
  item: Staged | null,
  counts: { existing?: number; changed?: number },
): Promise<void> {
  const { deps, b } = ctx;
  const id = `imi_${deps.ids.nonce()}`;
  await deps.db.transaction(async (tx: SqlExecutor) => {
    const at = deps.clock.now().toISOString();
    const upd = await tx.query(
      `UPDATE import_batches SET done = done + 1, refused = refused + $2, existing = existing + $3,
              changed = changed + $4, updated_at = $5
        WHERE id = $1 AND state = 'running' RETURNING id`,
      [
        b.id,
        item !== null && item.state === 'refused' ? 1 : 0,
        counts.existing ?? 0,
        counts.changed ?? 0,
        at,
      ],
    );
    if (upd.rows.length === 0) throw new Ended();
    if (item === null) return;
    const blob = item.content;
    if (blob !== null) {
      await tx.query(
        `INSERT INTO content_blobs (content_key, sha256, mime, bytes, data, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$6) ON CONFLICT (content_key) DO NOTHING`,
        [blob.key, blob.sha256, blob.mime, blob.bytes.length, blob.bytes, at],
      );
    }
    await tx.query(
      `INSERT INTO import_items (id, batch_id, publisher_id, source_key, kind, title, summary, language, topics,
                                 price_minor, source_price_minor, currency, image_ref, content_ref, content_sha256,
                                 content_mime, content_bytes, source_published_at, state, reason, article_id, offer_id,
                                 created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,NULL,NULL,$21,$21)`,
      [
        id,
        b.id,
        b.publisher_id,
        item.source_key,
        item.kind,
        item.title,
        item.summary,
        item.language,
        item.topics,
        item.price_minor,
        item.source_price_minor,
        ctx.currency,
        blob !== null && item.kind === 'image' ? blob.key : null,
        blob?.key ?? null,
        blob?.sha256 ?? null,
        blob?.mime ?? null,
        blob?.bytes.length ?? null,
        item.published_at,
        item.state,
        item.reason,
        at,
      ],
    );
  });
}

// ---------------------------------------------------------------------------------------------
// Review

export interface BatchView {
  id: string;
  source_host: string;
  source_url: string;
  state: 'queued' | 'running' | 'done' | 'failed' | 'interrupted';
  /** A fixed word (see the copy file), or null. */
  note: string | null;
  total: number;
  done: number;
  refused: number;
  existing: number;
  changed: number;
  attested: boolean;
  created_at: string;
  finished_at: string | null;
}

export interface ItemView {
  id: string;
  kind: 'article' | 'image';
  source_key: string;
  title: string;
  summary: string;
  language: string;
  topics: string[];
  /** The publisher's own price in minor units, or null (the publisher must set one before publishing). */
  price_minor: number | null;
  currency: string | null;
  /** Through the fee port. Null when there is no price or the port gave no usable answer. */
  fee_minor: number | null;
  buyer_price_minor: number | null;
  state: 'staged' | 'hidden' | 'published' | 'refused';
  reason: string | null;
  has_image: boolean;
  content_bytes: number | null;
  article_id: string | null;
  offer_id: string | null;
}

const BATCH_COLS =
  'id, source_host, source_url, state, note, total, done, refused, existing, changed, attested_at, created_at, finished_at';
const ITEM_COLS =
  'id, kind, source_key, title, summary, language, topics, price_minor, currency, state, reason, image_ref, content_bytes, article_id, offer_id';

function toBatch(r: Row): BatchView {
  return {
    id: r.id as string,
    source_host: r.source_host as string,
    source_url: r.source_url as string,
    state: r.state as BatchView['state'],
    note: (r.note as string | null) ?? null,
    total: Number(r.total),
    done: Number(r.done),
    refused: Number(r.refused),
    existing: Number(r.existing),
    changed: Number(r.changed),
    attested: r.attested_at != null,
    created_at: iso(r.created_at),
    finished_at: isoOrNull(r.finished_at),
  };
}

function toItem(r: Row, fee: ImportDeps['fee']): ItemView {
  const price = r.price_minor == null ? null : Number(r.price_minor);
  const currency = (r.currency as string | null) ?? null;
  const priced = price !== null && currency !== null ? buyerPriceOf(fee, price, currency) : null;
  return {
    id: r.id as string,
    kind: r.kind as ItemView['kind'],
    source_key: r.source_key as string,
    title: r.title as string,
    summary: r.summary as string,
    language: r.language as string,
    topics: r.topics as string[],
    price_minor: price,
    currency,
    fee_minor: priced?.fee_minor ?? null,
    buyer_price_minor: priced?.buyer_minor ?? null,
    state: r.state as ItemView['state'],
    reason: (r.reason as string | null) ?? null,
    has_image: r.image_ref != null,
    content_bytes: r.content_bytes == null ? null : Number(r.content_bytes),
    article_id: (r.article_id as string | null) ?? null,
    offer_id: (r.offer_id as string | null) ?? null,
  };
}

/** The own batches, newest first. Null for any actor that is not a publisher. */
export async function listBatches(db: ImportDeps['db'], actor: Actor): Promise<BatchView[] | null> {
  if (actor.kind !== 'publisher') return null;
  const { rows } = await db.query<Row>(
    `SELECT ${BATCH_COLS} FROM import_batches WHERE publisher_id = $1 ORDER BY created_at DESC, id DESC LIMIT 50`,
    [actor.publisher_id],
  );
  return rows.map(toBatch);
}

/**
 * One own batch with its items. Null for another publisher's batch, for an id that does not exist and for any
 * actor that is not a publisher: the three look the same.
 */
export async function getBatch(
  deps: Pick<ImportDeps, 'db' | 'fee' | 'loadFee'>,
  actor: Actor,
  batch_id: string,
): Promise<{ batch: BatchView; items: ItemView[] } | null> {
  if (actor.kind !== 'publisher' || !IdSchema.safeParse(batch_id).success) return null;
  const b = await deps.db.query<Row>(
    `SELECT ${BATCH_COLS} FROM import_batches WHERE id = $1 AND publisher_id = $2`,
    [batch_id, actor.publisher_id],
  );
  const row = b.rows[0];
  if (row === undefined) return null;
  const items = await deps.db.query<Row>(
    `SELECT ${ITEM_COLS} FROM import_items WHERE batch_id = $1 AND publisher_id = $2 ORDER BY created_at, source_key, id`,
    [batch_id, actor.publisher_id],
  );
  const fee = (await resolveImportFee(deps)) ?? UNREADABLE_FEE_POLICY;
  return { batch: toBatch(row), items: items.rows.map((r) => toItem(r, fee)) };
}

export interface EditInput {
  item_id: string;
  title?: string;
  price_minor?: number;
  hidden?: boolean;
}

/**
 * The publisher edits a staged or hidden item of its own: the title, its own price, and whether it is shown,
 * in ONE transaction (a bad price leaves the title and the hiding unchanged). Only these three fields are
 * read. A refused or published item is not_editable; another publisher's item is not_found.
 */
export async function editItem(
  deps: Pick<ImportDeps, 'db' | 'clock' | 'audit' | 'fee' | 'loadFee' | 'offer_max_minor'>,
  actor: Actor,
  input: EditInput,
): Promise<Result<{ item: ItemView }, ImportError>> {
  if (actor.kind !== 'publisher') return fail('not_publisher');
  const { item_id, title, price_minor, hidden } = input;
  if (typeof item_id !== 'string' || !IdSchema.safeParse(item_id).success) return fail('not_found');
  if (title === undefined && price_minor === undefined && hidden === undefined)
    return fail('invalid_input');
  let cleanTitle: string | null = null;
  if (title !== undefined) {
    cleanTitle = sanitiseFeedText(title, { max: 200 });
    if (cleanTitle === '') return fail('invalid_title');
  }
  if (price_minor !== undefined) {
    if (
      typeof price_minor !== 'number' ||
      !Number.isSafeInteger(price_minor) ||
      price_minor < 1 ||
      price_minor > deps.offer_max_minor
    )
      return fail('invalid_price');
  }
  if (hidden !== undefined && typeof hidden !== 'boolean') return fail('invalid_input');
  // Read before the transaction opens: the setting is read on the database, never inside the item's transaction.
  const fee = (await resolveImportFee(deps)) ?? UNREADABLE_FEE_POLICY;
  return deps.db.transaction(async (tx): Promise<Result<{ item: ItemView }, ImportError>> => {
    const cur = await tx.query<Row>(
      `SELECT ${ITEM_COLS}, batch_id FROM import_items WHERE id = $1 AND publisher_id = $2 FOR UPDATE`,
      [item_id, actor.publisher_id],
    );
    const row = cur.rows[0];
    if (row === undefined) return fail('not_found');
    if (row.state !== 'staged' && row.state !== 'hidden') return fail('not_editable');
    const at = deps.clock.now().toISOString();
    const nextState = hidden === undefined ? (row.state as string) : hidden ? 'hidden' : 'staged';
    const upd = await tx.query<Row>(
      `UPDATE import_items SET title = $2, price_minor = $3, state = $4, updated_at = $5
        WHERE id = $1 RETURNING ${ITEM_COLS}`,
      [
        item_id,
        cleanTitle ?? (row.title as string),
        price_minor ?? (row.price_minor == null ? null : Number(row.price_minor)),
        nextState,
        at,
      ],
    );
    await deps.audit.record(tx, {
      actor,
      action: 'import.item_edited',
      target: item_id,
      reason: null,
      detail: {
        item_id,
        batch_id: row.batch_id as string,
        title_changed: cleanTitle !== null,
        price_minor: price_minor ?? null,
        hidden: hidden ?? null,
      },
    });
    return ok({ item: toItem(upd.rows[0]!, fee) });
  });
}
