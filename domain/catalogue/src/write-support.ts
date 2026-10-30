// Test helper only (never exported from index.ts): a migrated in-memory database holding the base seed
// and the composite supplement, a recording audit sink and the dependency bundle the offer write module
// takes (PUB-B). The clock is a fake one; ids are seeded.
import type { Actor, AuditEntry, AuditSink, Database, Id, SqlExecutor } from '@umsbx/contracts';
import { fakeClock, seededIds, T0, testDb } from './support';
import { SEED_DATA, SEED_SUPPLEMENT_COMPOSITE, seedCatalogue, seedSupplement } from './index';
import type { OfferWriteDeps } from './write';

export const CAP = 2000;

export interface OffersWorld {
  db: Database & { close(): Promise<void> };
  clock: ReturnType<typeof fakeClock>;
  /** Dependency bundle; `cap` defaults to the configured default of 2000. */
  deps(cap?: number): OfferWriteDeps;
  /** Publisher ids and actors by slug. */
  pubId: Record<'harbour-ledger' | 'quayside-gazette' | 'northfield-quarterly', Id>;
  harbour: Actor;
  quayside: Actor;
  northfield: Actor;
  buyer: Actor;
  operator: Actor;
  system: Actor;
}

export async function offersWorld(): Promise<OffersWorld> {
  const db = await testDb();
  const clock = fakeClock(T0);
  const ids = seededIds('offers');
  const auditIds = seededIds('offers-audit');
  const audit: AuditSink = {
    async record(tx: SqlExecutor, e: AuditEntry): Promise<void> {
      const actorId =
        e.actor.kind === 'buyer'
          ? e.actor.buyer_id
          : e.actor.kind === 'publisher'
            ? e.actor.publisher_id
            : e.actor.kind === 'operator'
              ? e.actor.operator_id
              : null;
      await tx.query(
        `INSERT INTO audit_log (id, actor_kind, actor_id, action, target, reason, detail, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $8)`,
        [
          auditIds.next('aud'),
          e.actor.kind,
          actorId,
          e.action,
          e.target,
          e.reason,
          JSON.stringify(e.detail),
          clock.now().toISOString(),
        ],
      );
    },
  };
  await seedCatalogue(db, clock, seededIds('seed'), SEED_DATA);
  await seedSupplement(db, clock, seededIds('supp'), SEED_SUPPLEMENT_COMPOSITE);
  const idOf = async (slug: string): Promise<Id> =>
    (await db.query<{ id: string }>('SELECT id FROM publishers WHERE slug = $1', [slug])).rows[0]!
      .id;
  const pubId = {
    'harbour-ledger': await idOf('harbour-ledger'),
    'quayside-gazette': await idOf('quayside-gazette'),
    'northfield-quarterly': await idOf('northfield-quarterly'),
  };
  return {
    db,
    clock,
    deps: (cap = CAP) => ({ db, clock, ids, audit, offer_max_minor: cap }),
    pubId,
    harbour: { kind: 'publisher', publisher_id: pubId['harbour-ledger'] },
    quayside: { kind: 'publisher', publisher_id: pubId['quayside-gazette'] },
    northfield: { kind: 'publisher', publisher_id: pubId['northfield-quarterly'] },
    buyer: { kind: 'buyer', buyer_id: 'buy_someone' },
    operator: { kind: 'operator', operator_id: 'opr_vikram', mfa: true },
    system: { kind: 'system' },
  };
}

export const TIDE = 'ofr_harbour-ledger_tide-tables';
export const FERRY = 'ofr_harbour-ledger_ferry-timetables';
export const FEES = 'ofr_harbour-ledger_harbour-fees';
export const KNOT = 'ofr_harbour-ledger_knot-notebook';
export const DOCK = 'ofr_harbour-ledger_dock-history';
export const QUAY = 'ofr_quayside-gazette_quay-walk';
export const HALL = 'ofr_quayside-gazette_market-hall-move';

export const count = async (db: Database, sql: string, params: unknown[] = []): Promise<number> =>
  Number((await db.query<{ c: string | number }>(sql, params)).rows[0]?.c ?? 0);

/** All versions of one offer, oldest first, with the fields the tests compare. */
export async function versionsOf(
  db: Database,
  offer_id: Id,
): Promise<
  {
    version: string;
    status: string;
    currency: string;
    options: { option: string; price_minor: number; policy_id: string; policy_version: string }[];
    superseded_by: string | null;
    terms_version: string;
    article_id: string;
    publisher_id: string;
    valid_from: unknown;
    valid_until: unknown;
    rights: unknown;
    affordability: unknown;
  }[]
> {
  return (
    await db.query<{
      version: string;
      status: string;
      currency: string;
      options: { option: string; price_minor: number; policy_id: string; policy_version: string }[];
      superseded_by: string | null;
      terms_version: string;
      article_id: string;
      publisher_id: string;
      valid_from: unknown;
      valid_until: unknown;
      rights: unknown;
      affordability: unknown;
    }>(
      `SELECT version, status, currency, options, superseded_by, terms_version, article_id, publisher_id,
              valid_from, valid_until, rights, affordability
         FROM offers WHERE id = $1 ORDER BY NULLIF(regexp_replace(version, '[^0-9]', '', 'g'), '')::numeric`,
      [offer_id],
    )
  ).rows;
}

export const prices = (
  options: { option: string; price_minor: number }[],
): Record<string, number> => Object.fromEntries(options.map((o) => [o.option, o.price_minor]));
