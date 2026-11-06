// Offer writes for a publisher: list its own offers, change the price and the options, withdraw (PUB-B,
// decisions D-065 items 35 and 37; assumption A-08: a snapshot freezes the offer version and the price).
//
// Nothing here updates a price in place. Every change inserts a NEW offer version (the old row only gets
// `superseded_by`), together with one publisher_authorisations row and one audit row, in one transaction.
// A quote or an approval that holds the old version keeps the price it saw; startFromOffer and the
// authorised list read the newest version only. Currency, article, terms, rights, affordability and the
// validity window are copied from the newest version and cannot be given by the caller: the input type
// has no such fields and only the named ones are read (mass assignment).
//
// Every query filters by the actor's publisher id in SQL. Another publisher's offer, a guessed id and a
// missing id give the same answer (not_found), so the id space does not leak.
//
// Locks: the newest offer row is taken FOR UPDATE (two changes from one base take turns, the second sees
// a newer row and answers conflict) and the article row FOR SHARE before an authorised version is
// inserted. The share lock matters for migration 0012: the article content freeze trigger looks for an
// authorised offer, and an uncommitted insert is invisible to it. With the share lock, a concurrent
// write of the article bytes waits for this commit and then finds the offer (PUB-A1 review note).
import { IdSchema, OfferOptionSchema, RightsSchema, err, ok } from '@umsbx/contracts';
import { recordOfferParts } from './fee';
import type { FeeParts } from './fee';
import type {
  AccessOption,
  Actor,
  CoreDeps,
  Database,
  Id,
  Offer,
  Result,
  SqlExecutor,
} from '@umsbx/contracts';

/** The text version of the attestation a publisher ticks when it authorises a price (stored per version). */
export const PUB_ATTEST_1 = 'PUB-ATTEST-1';

/** `offer_max_minor` comes from config (UMS_OFFER_MAX_MINOR, default 2000): the caller passes it in. */
export type OfferWriteDeps = Pick<CoreDeps, 'db' | 'clock' | 'ids' | 'audit'> & {
  offer_max_minor: number;
};

export type OfferWriteErrorCode =
  | 'not_publisher'
  | 'publisher_not_active'
  | 'not_found'
  | 'conflict'
  | 'withdrawn'
  | 'not_live'
  | 'invalid_price'
  | 'invalid_options'
  | 'attestation_required'
  | 'invalid_reason'
  | 'already_offered'
  | 'no_corridor';
export interface OfferWriteError {
  code: OfferWriteErrorCode;
}

export interface PriceInput {
  option: AccessOption;
  price_minor: number;
}
export type PriceCheck =
  { ok: true } | { ok: false; reason: 'not_integer' | 'below_one' | 'above_cap' };

/** Pure: an offer price is an integer number of minor units from 1 to the cap. */
export function checkPrice(minor: number, cap: number): PriceCheck {
  if (typeof minor !== 'number' || !Number.isInteger(minor)) {
    return { ok: false, reason: 'not_integer' };
  }
  if (minor < 1) return { ok: false, reason: 'below_one' };
  if (minor > cap) return { ok: false, reason: 'above_cap' };
  return { ok: true };
}

// ---------------------------------------------------------------------------------------------
// Reads

export interface OwnOffer {
  offer_id: Id;
  version: string;
  status: Offer['status'];
  currency: string;
  article_id: Id;
  article_title: string;
  /** Read only article facts (PUB-E5), taken from the articles row of this offer. */
  article_abstract: string;
  article_language: string;
  article_bytes: number;
  article_sha256: string;
  options: { option: AccessOption; price_minor: number }[];
  valid_until: string | null;
  created_at: string;
}
export interface OwnOfferVersion {
  version: string;
  status: Offer['status'];
  created_at: string;
  options: { option: AccessOption; price_minor: number }[];
}
export interface OwnOfferDetail extends OwnOffer {
  terms_version: string;
  rights: Offer['rights'];
  valid_from: string;
  /** Newest first. */
  history: OwnOfferVersion[];
}

type Row = Record<string, unknown>;
const iso = (v: unknown): string => new Date(v as string | number | Date).toISOString();
const isoOrNull = (v: unknown): string | null => (v == null ? null : iso(v));

// Versions are text like 9 and 10: compare the number (the same order getOffer uses).
const VERNUM = (alias: string): string =>
  `COALESCE(NULLIF(regexp_replace(${alias}.version, '[^0-9]', '', 'g'), '')::numeric, 0)`;
const NEWEST_ORDER = (alias: string): string =>
  `${alias}.created_at DESC, ${VERNUM(alias)} DESC, ${alias}.version DESC`;

function parseOptions(raw: unknown): OwnOffer['options'] {
  const value: unknown = typeof raw === 'string' ? JSON.parse(raw) : raw;
  return OfferOptionSchema.array()
    .parse(value)
    .map((o) => ({ option: o.option, price_minor: o.price_minor }));
}

function toOwn(r: Row): OwnOffer {
  return {
    offer_id: r.id as Id,
    version: r.version as string,
    status: r.status as Offer['status'],
    currency: r.currency as string,
    article_id: r.article_id as Id,
    article_title: r.title as string,
    article_abstract: r.abstract as string,
    article_language: r.language as string,
    article_bytes: Number(r.bytes),
    article_sha256: r.sha256 as string,
    options: parseOptions(r.options),
    valid_until: isoOrNull(r.valid_until),
    created_at: iso(r.created_at),
  };
}

/**
 * The newest version of each offer of the signed-in publisher, ordered by article title: status and the
 * price of each option. Null for any actor that is not a publisher. Every row is filtered by the
 * actor's publisher id.
 */
export async function listOwnOffers(db: Database, actor: Actor): Promise<OwnOffer[] | null> {
  if (actor.kind !== 'publisher') return null;
  const { rows } = await db.query<Row>(
    `SELECT * FROM (
       SELECT DISTINCT ON (o.id) o.id, o.version, o.status, o.currency, o.article_id, a.title,
              a.abstract, a.language, a.bytes, a.sha256, o.options, o.valid_until, o.created_at
         FROM offers o JOIN articles a ON a.id = o.article_id
        WHERE o.publisher_id = $1
        ORDER BY o.id, ${NEWEST_ORDER('o')}
     ) newest
     ORDER BY newest.title, newest.id`,
    [actor.publisher_id],
  );
  return rows.map(toOwn);
}

/**
 * One offer of the signed-in publisher with its licence, terms and version history. Null for a
 * publisher id that names no row, for an offer of someone else and for an id that does not exist: the
 * three look the same.
 */
export async function getOwnOffer(
  db: Database,
  actor: Actor,
  offer_id: string,
): Promise<OwnOfferDetail | null> {
  if (actor.kind !== 'publisher' || !IdSchema.safeParse(offer_id).success) return null;
  const { rows } = await db.query<Row>(
    `SELECT o.id, o.version, o.status, o.currency, o.article_id, a.title, a.abstract, a.language, a.bytes,
            a.sha256, o.options, o.valid_from, o.valid_until, o.created_at, o.terms_version, o.rights
       FROM offers o JOIN articles a ON a.id = o.article_id
      WHERE o.id = $1 AND o.publisher_id = $2
      ORDER BY ${NEWEST_ORDER('o')}`,
    [offer_id, actor.publisher_id],
  );
  const newest = rows[0];
  if (newest === undefined) return null;
  return {
    ...toOwn(newest),
    terms_version: newest.terms_version as string,
    rights: RightsSchema.parse(
      typeof newest.rights === 'string' ? JSON.parse(newest.rights) : newest.rights,
    ),
    valid_from: iso(newest.valid_from),
    history: rows.map((r) => ({
      version: r.version as string,
      status: r.status as Offer['status'],
      created_at: iso(r.created_at),
      options: parseOptions(r.options),
    })),
  };
}

// ---------------------------------------------------------------------------------------------
// Writes

/** Thrown inside a transaction to roll it back; the caller turns it into an error value. */
class Refused extends Error {
  // Declared field, not a parameter property: the offline scripts run this file in Node's strip-only TypeScript mode.
  readonly code: OfferWriteErrorCode;
  constructor(code: OfferWriteErrorCode) {
    super(code);
    this.code = code;
  }
}
const isUniqueViolation = (e: unknown): boolean =>
  typeof e === 'object' && e !== null && (e as { code?: unknown }).code === '23505';
const fail = (code: OfferWriteErrorCode): Result<never, OfferWriteError> => err({ code });

/** The next version in the style of the current one: 1 gives 2, v7 gives v8. Null when it has no number. */
function nextVersion(v: string): string | null {
  const m = /^(v?)(\d{1,9})$/.exec(v);
  return m === null ? null : `${m[1] ?? ''}${String(Number(m[2]) + 1)}`;
}

const ORDER: readonly AccessOption[] = ['keep_retrieve', 'online_read'];
const pricesText = (o: { option: string; price_minor: number }[]): string =>
  o.map((x) => `${x.option}=${String(x.price_minor)}`).join(',');

interface Mark {
  /** What the authorisation row records as the accepted attestation (null for a withdrawal). */
  attestation_version: string | null;
  /** The audit reason of a revise (a withdraw takes the publisher's own reason). */
  reason: string | null;
  /**
   * True for a change the platform made on its own (the demo price step): the authorisation row and the
   * audit row then name the system, not the publisher, so no one is shown a version they did not make.
   */
  by_system?: boolean;
}

export interface ReviseInput {
  offer_id: Id;
  expected_version: string;
  options: PriceInput[];
  attestation: boolean;
}

/** Validates the option list and returns a clean copy with only the two named fields, in canonical order. */
function cleanOptions(raw: unknown, cap: number): Result<PriceInput[], OfferWriteError> {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > ORDER.length) {
    return fail('invalid_options');
  }
  const seen = new Set<string>();
  const picked: PriceInput[] = [];
  for (const item of raw as unknown[]) {
    if (typeof item !== 'object' || item === null) return fail('invalid_options');
    const { option, price_minor } = item as { option?: unknown; price_minor?: unknown };
    if (typeof option !== 'string' || !(ORDER as readonly string[]).includes(option)) {
      return fail('invalid_options');
    }
    if (seen.has(option)) return fail('invalid_options');
    seen.add(option);
    picked.push({ option: option as AccessOption, price_minor: price_minor as number });
  }
  for (const p of picked) {
    if (!checkPrice(p.price_minor, cap).ok) return fail('invalid_price');
  }
  return ok(picked.sort((a, b) => ORDER.indexOf(a.option) - ORDER.indexOf(b.option)));
}

type Change =
  { kind: 'revise'; options: PriceInput[]; mark: Mark } | { kind: 'withdraw'; reason: string };

async function writeVersion(
  deps: OfferWriteDeps,
  actor: Extract<Actor, { kind: 'publisher' }>,
  offer_id: string,
  expected_version: string,
  change: Change,
): Promise<Result<{ version: string }, OfferWriteError>> {
  if (typeof offer_id !== 'string' || !IdSchema.safeParse(offer_id).success)
    return fail('not_found');
  if (typeof expected_version !== 'string') return fail('conflict');
  try {
    return await deps.db.transaction(async (tx: SqlExecutor) => {
      // 1. The newest version of this offer, as this publisher, locked. A row of someone else is not seen.
      const found = await tx.query<Row & { p_status: string }>(
        `SELECT o.version, o.article_id, o.status, o.currency, o.options, o.affordability,
                o.terms_version, o.rights, o.valid_from, o.valid_until, o.superseded_by,
                p.status AS p_status
           FROM offers o JOIN publishers p ON p.id = o.publisher_id
          WHERE o.id = $1 AND o.publisher_id = $2
          ORDER BY ${NEWEST_ORDER('o')}
          LIMIT 1
            FOR UPDATE OF o`,
        [offer_id, actor.publisher_id],
      );
      const cur = found.rows[0];
      if (cur === undefined) throw new Refused('not_found');
      if (cur.p_status !== 'active') throw new Refused('publisher_not_active');
      // After a wait on the lock the row may have been superseded in the meantime.
      if (cur.version !== expected_version || cur.superseded_by != null)
        throw new Refused('conflict');
      if (cur.status === 'withdrawn') throw new Refused('withdrawn');
      if (cur.status !== 'authorised') throw new Refused('not_live');
      const version = nextVersion(cur.version as string);
      if (version === null) throw new Refused('conflict');

      const oldOptions = parseOptions(cur.options);
      let newOptionsJson: string;
      let status: 'authorised' | 'withdrawn';
      let newPrices = pricesText(oldOptions);
      if (change.kind === 'revise') {
        status = 'authorised';
        const stored = (
          typeof cur.options === 'string' ? JSON.parse(cur.options) : cur.options
        ) as { option: string; policy_id: string; policy_version: string }[];
        const built = [];
        for (const p of change.options) {
          const kept = stored.find((s) => s.option === p.option);
          let policy_id = kept?.policy_id ?? p.option;
          let policy_version = kept?.policy_version ?? '1';
          if (kept === undefined) {
            // An option the offer did not carry before: the access policy of that option, version 1.
            const pol = await tx.query(
              'SELECT 1 AS x FROM access_policies WHERE id = $1 AND version = $2 AND option = $3',
              [p.option, '1', p.option],
            );
            if (pol.rows.length === 0) throw new Refused('invalid_options');
            policy_id = p.option;
            policy_version = '1';
          }
          built.push({
            option: p.option,
            price_minor: p.price_minor,
            policy_id,
            policy_version,
          });
        }
        newOptionsJson = JSON.stringify(built);
        newPrices = pricesText(built);
        // The article freeze (migration 0012) looks for an authorised offer. Share lock first, so a
        // concurrent write of the article bytes waits for this commit.
        const art = await tx.query('SELECT id FROM articles WHERE id = $1 FOR SHARE', [
          cur.article_id,
        ]);
        if (art.rows.length === 0) throw new Refused('not_found');
      } else {
        status = 'withdrawn';
        newOptionsJson =
          typeof cur.options === 'string' ? cur.options : JSON.stringify(cur.options);
      }

      const at = deps.clock.now().toISOString();
      const json = (v: unknown): string => (typeof v === 'string' ? v : JSON.stringify(v));
      try {
        await tx.query(
          `INSERT INTO offers (id, version, publisher_id, article_id, status, currency, options, affordability,
                               terms_version, rights, valid_from, valid_until, superseded_by, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NULL,$13,$13)`,
          [
            offer_id,
            version,
            actor.publisher_id,
            cur.article_id,
            status,
            cur.currency,
            newOptionsJson,
            json(cur.affordability),
            cur.terms_version,
            json(cur.rights),
            iso(cur.valid_from),
            isoOrNull(cur.valid_until),
            at,
          ],
        );
      } catch (e) {
        if (isUniqueViolation(e)) throw new Refused('conflict');
        throw e;
      }
      await tx.query(
        'UPDATE offers SET superseded_by = $3, updated_at = $4 WHERE id = $1 AND version = $2',
        [offer_id, cur.version, `${offer_id}@${version}`, at],
      );
      await tx.query(
        `INSERT INTO publisher_authorisations (id, offer_id, offer_version, authorised_by, at, created_at, updated_at, attestation_version)
         VALUES ($1,$2,$3,$4,$5,$5,$5,$6)`,
        [
          `auth_${offer_id}_${version}`,
          offer_id,
          version,
          change.kind === 'revise' && change.mark.by_system === true
            ? 'system'
            : actor.publisher_id,
          at,
          change.kind === 'revise' ? change.mark.attestation_version : null,
        ],
      );
      await deps.audit.record(tx, {
        actor:
          change.kind === 'revise' && change.mark.by_system === true ? { kind: 'system' } : actor,
        action: change.kind === 'revise' ? 'offer.revised' : 'offer.withdrawn',
        target: offer_id,
        reason: change.kind === 'revise' ? change.mark.reason : change.reason,
        detail: {
          from_version: cur.version as string,
          to_version: version,
          currency: cur.currency as string,
          old_prices: pricesText(oldOptions),
          new_prices: newPrices,
        },
      });
      return ok({ version });
    });
  } catch (e) {
    if (e instanceof Refused) return fail(e.code);
    throw e;
  }
}

/**
 * Not exported from the package root: the revise path with a caller supplied mark. reviseOffer is the
 * publisher's call; the demo price step uses it with its own attestation text and audit reason.
 */
export async function reviseWithMark(
  deps: OfferWriteDeps,
  actor: Actor,
  input: ReviseInput,
  mark: Mark,
): Promise<Result<{ version: string }, OfferWriteError>> {
  if (actor.kind !== 'publisher') return fail('not_publisher');
  if (input.attestation !== true) return fail('attestation_required');
  const options = cleanOptions(input.options, deps.offer_max_minor);
  if (!options.ok) return options;
  return writeVersion(deps, actor, input.offer_id, input.expected_version, {
    kind: 'revise',
    options: options.value,
    mark,
  });
}

/**
 * The publisher changes the price or the offered options of its own offer. The offer must belong to the
 * actor and `expected_version` must be the newest, else conflict. Each price is an integer from 1 to the
 * cap; the options are a non empty subset of keep_retrieve and online_read; the attestation must be true.
 * Writes version n+1 (status authorised), sets superseded_by on version n, adds one authorisation row
 * with the attestation text version and one audit row, all in one transaction.
 */
export function reviseOffer(
  deps: OfferWriteDeps,
  actor: Actor,
  input: ReviseInput,
): Promise<Result<{ version: string }, OfferWriteError>> {
  return reviseWithMark(deps, actor, input, { attestation_version: PUB_ATTEST_1, reason: null });
}

/**
 * The publisher takes its own offer off sale: a new version with status withdrawn. After it a new buyer
 * gets no match (reason withdrawn); a quote or approval already taken keeps the version it saw.
 */
export async function withdrawOffer(
  deps: OfferWriteDeps,
  actor: Actor,
  input: { offer_id: Id; expected_version: string; reason: string },
): Promise<Result<{ version: string }, OfferWriteError>> {
  if (actor.kind !== 'publisher') return fail('not_publisher');
  const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
  if (reason.length < 3 || reason.length > 200) return fail('invalid_reason');
  return writeVersion(deps, actor, input.offer_id, input.expected_version, {
    kind: 'withdraw',
    reason,
  });
}

// ---------------------------------------------------------------------------------------------
// Create an offer for an article the publisher already owns (PUB-E1)

/** The terms version a new offer carries (the terms every seeded offer carries). */
export const NEW_OFFER_TERMS = 'terms-1';
/** The licence of a new offer: personal use, no redistribution, AI assistants after the buyer reviews. */
export const NEW_OFFER_RIGHTS = {
  scope: 'personal_use',
  ai_scope: 'review',
  redistribution: false,
} as const;

export interface OfferableArticle {
  article_id: Id;
  title: string;
}

/**
 * The articles of the signed-in publisher that have no current offer on sale or in draft (a withdrawn offer
 * does not count). Null for any actor that is not a publisher. Filtered by the actor's publisher id.
 */
export async function listOfferableArticles(
  db: Database,
  actor: Actor,
): Promise<OfferableArticle[] | null> {
  if (actor.kind !== 'publisher') return null;
  const { rows } = await db.query<Row>(
    `SELECT a.id, a.title FROM articles a
      WHERE a.publisher_id = $1
        AND NOT EXISTS (SELECT 1 FROM offers o
                         WHERE o.article_id = a.id AND o.superseded_by IS NULL
                           AND o.status IN ('authorised', 'draft'))
      ORDER BY a.title, a.id`,
    [actor.publisher_id],
  );
  return rows.map((r) => ({ article_id: r.id as Id, title: r.title as string }));
}

/**
 * The currency a new offer of the signed-in publisher would carry: the enabled corridor of the publisher's
 * country. Null when there is none, and for any actor that is not a publisher.
 */
export async function offerCurrencyFor(db: Database, actor: Actor): Promise<string | null> {
  if (actor.kind !== 'publisher') return null;
  const { rows } = await db.query<{ currency: string }>(
    `SELECT c.currency FROM corridors c JOIN publishers p ON p.country = ANY (c.payee_countries)
      WHERE p.id = $1 AND c.enabled ORDER BY c.id LIMIT 1`,
    [actor.publisher_id],
  );
  return rows[0]?.currency ?? null;
}

export interface CreateInput {
  article_id: Id;
  options: PriceInput[];
  attestation: boolean;
}

/**
 * The publisher puts one of its own articles on sale. The publisher must be active; the article must be the
 * actor's (another publisher's article and a guessed id both give not_found) and have no current offer on
 * sale or in draft (already_offered). Each price is an integer from 1 to the cap; the options are a non empty
 * subset of keep_retrieve and online_read; the attestation must be true. The currency is the one of the
 * enabled corridor of the publisher's country; terms, licence, affordability and validity are fixed here and
 * cannot be given by the caller. Writes offer version 1 (status authorised), one authorisation row with the
 * attestation text version and one audit row, all in one transaction, with the article row locked so two
 * creates for one article take turns and the article freeze of migration 0012 sees the new offer.
 */
export async function createOffer(
  deps: OfferWriteDeps,
  actor: Actor,
  input: CreateInput,
): Promise<Result<{ offer_id: Id; version: string }, OfferWriteError>> {
  if (actor.kind !== 'publisher') return fail('not_publisher');
  if (input.attestation !== true) return fail('attestation_required');
  const options = cleanOptions(input.options, deps.offer_max_minor);
  if (!options.ok) return options;
  const article_id = input.article_id;
  if (typeof article_id !== 'string' || !IdSchema.safeParse(article_id).success)
    return fail('not_found');
  try {
    return await deps.db.transaction(async (tx: SqlExecutor) =>
      ok(await createOfferInTx(deps, tx, actor, article_id, options.value)),
    );
  } catch (e) {
    if (e instanceof Refused) return fail(e.code);
    throw e;
  }
}

/**
 * The write of createOffer, inside a transaction the caller owns (the web import creates the article and
 * its first offer in one transaction per item). `options` must be the output of cleanOptions. Throws a
 * Refused (code in OfferWriteErrorCode) to roll the caller's transaction back; the caller turns it into an
 * error value or counts the failure.
 */
export async function createOfferInTx(
  deps: OfferWriteDeps,
  tx: SqlExecutor,
  actor: Extract<Actor, { kind: 'publisher' }>,
  article_id: Id,
  options: PriceInput[],
  /**
   * POB-G: the split of the listed price when the caller adds a fee on top (the web import). Every option is listed at
   * `parts.buyer_minor` and its parts are recorded in this transaction, after the offer row. Absent: no parts row, as before.
   */
  parts?: FeeParts,
): Promise<{ offer_id: Id; version: string }> {
  const pub = await tx.query<{ slug: string; status: string; country: string }>(
    'SELECT slug, status, country FROM publishers WHERE id = $1',
    [actor.publisher_id],
  );
  const p = pub.rows[0];
  if (p === undefined) throw new Refused('not_found');
  if (p.status !== 'active') throw new Refused('publisher_not_active');
  const art = await tx.query(
    'SELECT id FROM articles WHERE id = $1 AND publisher_id = $2 FOR UPDATE',
    [article_id, actor.publisher_id],
  );
  if (art.rows.length === 0) throw new Refused('not_found');
  const live = await tx.query(
    `SELECT 1 AS x FROM offers WHERE article_id = $1 AND superseded_by IS NULL
        AND status IN ('authorised', 'draft') LIMIT 1`,
    [article_id],
  );
  if (live.rows.length > 0) throw new Refused('already_offered');
  const corridor = await tx.query<{ currency: string }>(
    'SELECT currency FROM corridors WHERE enabled AND $1 = ANY (payee_countries) ORDER BY id LIMIT 1',
    [p.country],
  );
  const currency = corridor.rows[0]?.currency;
  if (currency === undefined) throw new Refused('no_corridor');
  for (const o of options) {
    const pol = await tx.query(
      'SELECT 1 AS x FROM access_policies WHERE id = $1 AND version = $2 AND option = $1',
      [o.option, '1'],
    );
    if (pol.rows.length === 0) throw new Refused('invalid_options');
  }
  // The offer id carries the publisher slug and the article (the public offer address); an article that
  // had an offer before gets a fresh id with a suffix, so no earlier history is reused.
  const base = `ofr_${p.slug}_${article_id.startsWith('art_') ? article_id.slice(4) : article_id}`;
  let offer_id = base;
  for (let n = 2; ; n += 1) {
    const taken = await tx.query('SELECT 1 AS x FROM offers WHERE id = $1 LIMIT 1', [offer_id]);
    if (taken.rows.length === 0) break;
    if (n > 50) throw new Refused('conflict');
    offer_id = `${base}-r${String(n)}`;
  }
  if (!IdSchema.safeParse(offer_id).success) throw new Refused('not_found');
  const at = deps.clock.now().toISOString();
  const built = options.map((o) => ({
    option: o.option,
    price_minor: o.price_minor,
    policy_id: o.option,
    policy_version: '1',
  }));
  try {
    await tx.query(
      `INSERT INTO offers (id, version, publisher_id, article_id, status, currency, options, affordability,
                           terms_version, rights, valid_from, valid_until, superseded_by, created_at, updated_at)
       VALUES ($1,'1',$2,$3,'authorised',$4,$5,$6,$7,$8,$9,NULL,NULL,$9,$9)`,
      [
        offer_id,
        actor.publisher_id,
        article_id,
        currency,
        JSON.stringify(built),
        JSON.stringify({ renegotiation_allowed: false, floor_minor: null }),
        NEW_OFFER_TERMS,
        JSON.stringify(NEW_OFFER_RIGHTS),
        at,
      ],
    );
  } catch (e) {
    if (isUniqueViolation(e)) throw new Refused('conflict');
    throw e;
  }
  if (parts !== undefined) {
    for (const o of built) {
      if (o.price_minor !== parts.buyer_minor) throw new Refused('invalid_price');
      await recordOfferParts(tx, deps, {
        offer_id,
        offer_version: '1',
        option: o.option,
        parts,
      });
    }
  }
  await tx.query(
    `INSERT INTO publisher_authorisations (id, offer_id, offer_version, authorised_by, at, created_at, updated_at, attestation_version)
     VALUES ($1,$2,'1',$3,$4,$4,$4,$5)`,
    [`auth_${offer_id}_1`, offer_id, actor.publisher_id, at, PUB_ATTEST_1],
  );
  await deps.audit.record(tx, {
    actor,
    action: 'offer.created',
    target: offer_id,
    reason: null,
    detail: {
      to_version: '1',
      article_id,
      currency,
      new_prices: pricesText(built),
    },
  });
  return { offer_id, version: '1' };
}
