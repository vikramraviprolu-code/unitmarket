// Test helper only (never exported from index.ts): migrated in-memory PGlite plus seeded catalogue.
import { migrate, openDatabase } from '@umsbx/db';
import { fakeClock, seededIds } from '@umsbx/runtime';
import { SEED_DATA, seedCatalogue } from '@umsbx/catalogue';
import type { CoreDeps, Database } from '@umsbx/contracts';

export const T0 = '2026-10-21T10:00:00.000Z';
export type TestDb = Database & { close(): Promise<void> };

export const IN_DOMESTIC = {
  corridors: [
    ...SEED_DATA.corridors,
    {
      id: 'in-usd',
      currency: 'USD',
      minor_units: 2,
      buyer_countries: ['IN'],
      payee_countries: ['IN'],
      domestic_supported: false,
      min_charge_minor: null,
      enabled: true,
    },
  ],
  publishers: [
    ...SEED_DATA.publishers,
    { slug: 'delhi-desk', display_name: 'Delhi Desk (fictional)', country: 'IN' },
  ],
  articles: [
    ...SEED_DATA.articles,
    {
      key: 'monsoon-notes',
      publisher_slug: 'delhi-desk',
      title: 'Monsoon notes for a city commuter',
      abstract: 'A fictional note on planning a commute in the wet season.',
      language: 'en',
      topics: ['transport'],
      published_at: '2025-12-15T09:00:00.000Z',
      text: 'Leave twenty minutes earlier and carry a dry bag.\n',
      rights_note: 'Written by the SBX team for the sandbox.',
    },
    ...['superseded', 'expired', 'notyet', 'onlyread'].map((k) => ({
      key: `x-${k}`,
      publisher_slug: 'harbour-ledger',
      title: `Edge case ${k}`,
      abstract: 'Fictional edge-case article.',
      language: 'en',
      topics: ['test'],
      published_at: '2025-12-16T09:00:00.000Z',
      text: `Edge case ${k}.\n`,
      rights_note: 'Written by the SBX team for the sandbox.',
    })),
  ],
  offers: [
    ...SEED_DATA.offers,
    {
      ...SEED_DATA.offers[0]!,
      code: 'monsoon-notes',
      article_key: 'monsoon-notes',
    },
    {
      ...SEED_DATA.offers[0]!,
      code: 'edge-superseded',
      article_key: 'x-superseded',
      superseded_by: 'ofr_other',
    },
    {
      ...SEED_DATA.offers[0]!,
      code: 'edge-expired',
      article_key: 'x-expired',
      valid_until: '2026-10-01T00:00:00.000Z',
    },
    {
      ...SEED_DATA.offers[0]!,
      code: 'edge-notyet',
      article_key: 'x-notyet',
      valid_from: '2026-11-01T00:00:00.000Z',
    },
    {
      ...SEED_DATA.offers[0]!,
      code: 'edge-onlyread',
      article_key: 'x-onlyread',
      options: [{ option: 'online_read', price_minor: 40 }],
    },
  ],
};

export async function seededDb(): Promise<{ db: TestDb; deps: CoreDeps }> {
  const db = await openDatabase({ kind: 'pglite-memory' });
  const clock = fakeClock(T0);
  await migrate(db, clock);
  const ids = seededIds('offer-entry');
  await seedCatalogue(db, clock, ids, { ...SEED_DATA, ...IN_DOMESTIC });
  // Only db, clock and ids are used by startFromOffer; the rest of CoreDeps is not touched.
  const deps = { db, clock, ids } as unknown as CoreDeps;
  return { db, deps };
}

let n = 0;
export async function addBuyer(db: TestDb, country = 'US'): Promise<string> {
  const id = `buy_test_${++n}`;
  await db.query(
    'INSERT INTO buyers (id, display_name, auth_subject, country, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$5)',
    [id, `Buyer ${n}`, `sub-${n}`, country, T0],
  );
  return id;
}

// Inserts the chain approval, order, unit, entitlement (and window) that makes a buyer hold an article.
export async function giveEntitlement(
  db: TestDb,
  i: {
    buyer_id: string;
    article_id: string;
    publisher_id: string;
    access_state: string;
    window: string | null;
    /** Default: captured when access is available or ended, else pending. */
    money_state?: string;
  },
): Promise<void> {
  const k = ++n;
  const h = 'a'.repeat(63) + String(k % 10);
  await db.query(
    'INSERT INTO approvals (id, buyer_id, snapshot, content_hash, nonce, expires_at, environment, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8)',
    [
      `apr_t${k}`,
      i.buyer_id,
      '{}',
      h,
      `nonce${k}`,
      new Date(Date.parse(T0) + 900_000).toISOString(), // created_at + 15 minutes (FIX-W1A M7)
      'dryrun',
      T0,
    ],
  );
  await db.query(
    'INSERT INTO orders (id, approval_id, buyer_id, content_hash, order_ref, expected, status, mismatch, corridor_id, currency, total_minor, environment, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,false,$8,$9,$10,$11,$12,$12)',
    [
      `ord_t${k}`,
      `apr_t${k}`,
      i.buyer_id,
      h,
      `ref${k}`,
      '{}',
      'paid',
      'us-usd',
      'USD',
      40,
      'dryrun',
      T0,
    ],
  );
  await db.query(
    'INSERT INTO order_units (id, order_id, publisher_id, reference_id, payee_merchant_id, amount_minor, platform_fee_minor, status, refunded_minor, capture_id, captured_verified_at, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,40,0,$6,0,$8,$7,$7,$7)',
    [
      `unt_t${k}`,
      `ord_t${k}`,
      i.publisher_id,
      `u${k}`,
      'SBXMERCHANT',
      'captured_verified',
      T0,
      `CAPT${k}`, // a captured unit carries its capture id (FIX-W1A M1)
    ],
  );
  const money =
    i.money_state ??
    (i.access_state === 'available' || i.access_state === 'ended' ? 'captured' : 'pending');
  const licensed = money === 'captured' || money === 'refunded' || money === 'reversed';
  await db.query(
    'INSERT INTO entitlements (id, buyer_id, article_id, unit_id, option, policy, money_state, access_state, licence_state, transition_log, environment, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12)',
    [
      `ent_t${k}`,
      i.buyer_id,
      i.article_id,
      `unt_t${k}`,
      'keep_retrieve',
      '{}',
      money,
      i.access_state,
      licensed ? 'granted' : null,
      '[]',
      'dryrun',
      T0,
    ],
  );
  if (i.window) {
    await db.query(
      'INSERT INTO access_windows (entitlement_id, state, credit_ms, created_at, updated_at) VALUES ($1,$2,0,$3,$3)',
      [`ent_t${k}`, i.window, T0],
    );
  }
}
