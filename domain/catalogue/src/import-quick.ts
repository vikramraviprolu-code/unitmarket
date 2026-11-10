// POB-Q1 (bulk photo onboarding): the publisher gives ONE address and does not come back to paste it again.
//
//   quickImport     The page sends the gallery address. A new site gets a proof code and a ready-made proof
//                   file (step 'prove'); nothing is fetched. The page then sends the same address every few
//                   seconds: while the proof is not up the answer is 'waiting' (no new code, so the uploaded
//                   file stays valid); once it is up the domain is verified and the import is begun in the same
//                   call ('started'). A site already proved starts at once. It only composes requestDomain,
//                   checkDomain and startVerifiedImport, so every guard of those (one owner per host, the two
//                   fixed proof paths, the proof fetched again at begin, one active import) still holds.
//   setPriceForAll  One price for every staged item of a finished batch that has none (or, when asked, for
//                   every staged item), in ONE transaction with one audit row. Hidden, refused and published
//                   items are never touched. Publishing stays a separate, explicit step.
import { IdSchema, err, ok } from '@umsbx/contracts';
import type { Actor, Result } from '@umsbx/contracts';
import {
  PROOF_META_NAME,
  WELL_KNOWN_PATH,
  checkDomain,
  parseWebAddress,
  requestDomain,
} from './domain-proof';
import { startVerifiedImport } from './import-stage';
import type { ImportDeps, ImportError, ImportErrorCode } from './import-types';

export type QuickStep =
  | {
      step: 'prove';
      host: string;
      /** Shown once; only its hash is stored. */
      token: string;
      /** Where the file goes on the site, and what it holds. */
      file_path: string;
      file_body: string;
      /** The other way: this tag in the head of the front page. */
      meta_tag: string;
    }
  | { step: 'waiting'; host: string; detail?: string }
  | { step: 'started'; host: string; batch_id: string };

const fail = (code: ImportErrorCode, detail?: string): Result<never, ImportError> =>
  err(detail === undefined ? { code } : { code, detail });

/** See the file comment. `new_code` replaces the code of a pending site (the old one stops working). */
export async function quickImport(
  deps: ImportDeps,
  actor: Actor,
  input: { source_url: string; new_code?: boolean },
): Promise<Result<QuickStep, ImportError>> {
  if (actor.kind !== 'publisher') return fail('not_publisher');
  const addr = parseWebAddress(input.source_url);
  if (addr === null) return fail('invalid_address');
  const host = addr.host;

  const own = await deps.db.query<{ state: string }>(
    'SELECT state FROM publisher_domains WHERE publisher_id = $1 AND host = $2',
    [actor.publisher_id, host],
  );
  const state = own.rows[0]?.state;

  if (state === undefined || (state === 'pending' && input.new_code === true)) {
    const asked = await requestDomain(deps, actor, { host });
    if (!asked.ok) return asked;
    if (asked.value.token === null) return begin(deps, actor, host, addr.url);
    const token = asked.value.token;
    return ok({
      step: 'prove',
      host,
      token,
      file_path: WELL_KNOWN_PATH,
      file_body: `${token}\n`,
      meta_tag: `<meta name="${PROOF_META_NAME}" content="${token}">`,
    });
  }

  if (state === 'pending') {
    const checked = await checkDomain(deps, actor, { host });
    if (!checked.ok) {
      if (checked.error.code === 'proof_missing') return ok({ step: 'waiting', host });
      if (checked.error.code === 'proof_refused')
        return ok({
          step: 'waiting',
          host,
          ...(checked.error.detail === undefined ? {} : { detail: checked.error.detail }),
        });
      return checked;
    }
  }
  return begin(deps, actor, host, addr.url);
}

async function begin(
  deps: ImportDeps,
  actor: Actor,
  host: string,
  url: string,
): Promise<Result<QuickStep, ImportError>> {
  const r = await startVerifiedImport(deps, actor, { source_url: url });
  if (!r.ok) return r;
  return ok({ step: 'started', host, batch_id: r.value.batch_id });
}

/** See the file comment. Errors: not_publisher, invalid_price, not_found, batch_not_ready. */
export async function setPriceForAll(
  deps: Pick<ImportDeps, 'db' | 'clock' | 'audit' | 'offer_max_minor'>,
  actor: Actor,
  input: {
    batch_id: string;
    price_minor: number;
    replace_existing?: boolean;
    /** POB-Q2: every batch of this publisher from the same address (the chunks of one import). */
    all_from_source?: boolean;
  },
): Promise<Result<{ priced: number }, ImportError>> {
  if (actor.kind !== 'publisher') return fail('not_publisher');
  const { batch_id, price_minor } = input;
  if (
    typeof price_minor !== 'number' ||
    !Number.isSafeInteger(price_minor) ||
    price_minor < 1 ||
    price_minor > deps.offer_max_minor
  )
    return fail('invalid_price');
  if (typeof batch_id !== 'string' || !IdSchema.safeParse(batch_id).success)
    return fail('not_found');
  const replace = input.replace_existing === true;
  return deps.db.transaction(async (tx): Promise<Result<{ priced: number }, ImportError>> => {
    const b = await tx.query<{ state: string; source_url: string }>(
      'SELECT state, source_url FROM import_batches WHERE id = $1 AND publisher_id = $2 FOR UPDATE',
      [batch_id, actor.publisher_id],
    );
    const row = b.rows[0];
    if (row === undefined) return fail('not_found');
    if (row.state === 'queued' || row.state === 'running') return fail('batch_not_ready');
    let ids = [batch_id];
    if (input.all_from_source === true) {
      const same = await tx.query<{ id: string; state: string }>(
        'SELECT id, state FROM import_batches WHERE publisher_id = $1 AND source_url = $2 ORDER BY id FOR UPDATE',
        [actor.publisher_id, row.source_url],
      );
      if (same.rows.some((x) => x.state === 'queued' || x.state === 'running'))
        return fail('batch_not_ready');
      ids = same.rows.map((x) => x.id);
    }
    const at = deps.clock.now().toISOString();
    const upd = await tx.query<{ id: string }>(
      `UPDATE import_items SET price_minor = $3, updated_at = $4
        WHERE batch_id = ANY ($1) AND publisher_id = $2 AND state = 'staged'
          AND ($5 OR price_minor IS NULL)
        RETURNING id`,
      [ids, actor.publisher_id, price_minor, at, replace],
    );
    const priced = upd.rows.length;
    await deps.audit.record(tx, {
      actor,
      action: 'import.price_all',
      target: batch_id,
      reason: null,
      detail: {
        batch_id,
        price_minor,
        priced,
        replace_existing: replace,
        batches: ids.length,
      },
    });
    return ok({ priced });
  });
}
