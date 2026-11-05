// INT-SEL test data (not product code, N2): the world every SEL suite reads. No page and no route imports
// this file. It sits on SR1's views-seed (buyers vs_b1 and vs_b2, the agent key and mandate of vs_b2) and adds:
//   two sellers          sl_pa "Alder Press" and sl_pb "Birch Notes", and sl_pc with no sale at all
//   a two-seller order   bought by an agent (vs_b2): unit A 3331 and unit B 4442 under an order total of 7773,
//                        a number no single unit has (CANARY.total)
//   a multi-article unit uM (601 minor) holds both articles of seller A, so it counts toward two offers
//   a refund             uR: 800 sold, 300 refunded, and the refund reason text holds a canary buyer name
//   a reversal           uW: 700 sold 15 days ago, 100 reversed
//   windows              7 days: uA, uM, uR.  30 days: those and uW.  Older: uO (45 days).  Pending: uP (no sale yet).
// Two versions of offer sl_oa1 make the join repeat a unit once per version if it is not grouped (R2-2).
// Every figure the suites expect is written out in EXPECTED and re-derived from the ledger in the tests.
import type { Actor, SqlExecutor } from '@umsbx/contracts';
import { bootSearch } from './search-support';
import type { SearchRig } from './search-support';

export const CANARY = {
  /** The total of the two-seller order. No unit has this amount. */
  total: 7773,
  totalText: '77.73',
  buyerName: 'CANARY-BUYER-NAME',
  reason: 'CANARY-BUYER-NAME asked for this refund by phone',
} as const;

const DAY = 86_400_000;

export const IDS = {
  pa: 'sl_pa',
  pb: 'sl_pb',
  pc: 'sl_pc',
  uA: 'sl_uA',
  uB: 'sl_uB',
  uM: 'sl_uM',
  uR: 'sl_uR',
  uW: 'sl_uW',
  uO: 'sl_uO',
  uP: 'sl_uP',
  uB2: 'sl_uB2',
  oa1: 'sl_oa1',
  oa2: 'sl_oa2',
  ob1: 'sl_ob1',
} as const;

/** What the suites expect for seller A (sl_pa), in minor units of USD, dry run. */
export const EXPECTED = {
  /** Every unit of seller A, newest first by creation: uP, uA, uM, uR, uW, uO. */
  all: 6,
  pending: 1,
  refunds: 1,
  /** Units with a sale inside the 7 and 30 day windows. */
  week: { units: 3, gross: 3331 + 601 + 800, refunds: 300, reversals: 0, net: 3331 + 601 + 500 },
  month: {
    units: 4,
    gross: 3331 + 601 + 800 + 700,
    refunds: 300,
    reversals: 100,
    net: 3331 + 601 + 500 + 600,
  },
  agent: { agent_units: 1, total_units: 4 },
  /** Top offers over 30 days. uM (601) splits 301 to sl_oa1 (lowest id) and 300 to sl_oa2. */
  top: [
    { offer_id: IDS.oa1, units: 3, net: 3331 + 301 + 600 },
    { offer_id: IDS.oa2, units: 2, net: 300 + 500 },
  ],
} as const;

export interface SellerRig extends SearchRig {
  A: Actor;
  B: Actor;
  C: Actor;
  /** The clock of the app: every date below is derived from it. */
  at(daysAgo: number, minutesAgo?: number): string;
}

const hex = (n: number): string => n.toString(16).padStart(64, '0');

interface UnitSpec {
  id: string;
  order: string;
  buyer: 'vs_b1' | 'vs_b2';
  seller: 'sl_pa' | 'sl_pb';
  amount: number;
  status: string;
  /** Days before now that the unit was created and captured. */
  days: number;
  minutes?: number;
  articles: readonly string[];
  option: 'keep_retrieve' | 'online_read';
  /** Share an existing order (the two-seller order) instead of making one. */
  sharedOrder?: boolean;
  orderTotal?: number;
  position: number;
}

let seq = 0;

export async function bootSeller(): Promise<SellerRig> {
  const rig = await bootSearch();
  const db: SqlExecutor = rig.app.db;
  const now = rig.now;
  const at = (d: number, m = 0): string =>
    new Date(now.getTime() - d * DAY - m * 60_000).toISOString();
  const base = at(60);

  await db.query(`UPDATE buyers SET display_name = $1 WHERE id = 'vs_b2'`, [CANARY.buyerName]);

  for (const [id, slug, name, merchant] of [
    ['sl_pa', 'sl-alder', 'Alder Press', 'MERCHSLPA'],
    ['sl_pb', 'sl-birch', 'Birch Notes', 'MERCHSLPB'],
    ['sl_pc', 'sl-cedar', 'Cedar Letters', null],
  ] as const) {
    await db.query(
      `INSERT INTO publishers (id, slug, display_name, country, paypal_merchant_id, created_at, updated_at)
       VALUES ($1, $2, $3, 'US', $4, $5, $5)`,
      [id, slug, name, merchant, base],
    );
  }
  const articles: [string, string, string][] = [
    ['sl_a1', 'sl_pa', 'Alder Atlas'],
    ['sl_a2', 'sl_pa', 'Alder Almanac'],
    ['sl_b1', 'sl_pb', 'Birch Bulletin'],
  ];
  for (const [i, [id, pub, title]] of articles.entries()) {
    await db.query(
      `INSERT INTO articles (id, publisher_id, title, abstract, language, topics, published_at, sha256, content_key, bytes, mime, created_at, updated_at)
       VALUES ($1, $2, $3, 'abstract', 'en', ARRAY['news'], $4, $5, $6, 10, 'text/plain', $4, $4)`,
      [id, pub, title, base, hex(9500 + i), `content-${id}`],
    );
  }
  // Offers copy the shape of a seeded offer. sl_oa1 has two versions (the second supersedes the first).
  const shape = (
    await db.query<{
      options: unknown;
      affordability: unknown;
      terms_version: string;
      rights: unknown;
      currency: string;
    }>(`SELECT options, affordability, terms_version, rights, currency FROM offers LIMIT 1`)
  ).rows[0]!;
  const offer = async (
    id: string,
    version: string,
    pub: string,
    article: string,
    status: string,
    when: string,
    superseded: string | null,
  ): Promise<void> => {
    await db.query(
      `INSERT INTO offers (id, version, publisher_id, article_id, status, currency, options, affordability, terms_version, rights, valid_from, valid_until, superseded_by, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10::jsonb, $11, NULL, $12, $11, $11)`,
      [
        id,
        version,
        pub,
        article,
        status,
        shape.currency,
        JSON.stringify(shape.options),
        JSON.stringify(shape.affordability),
        shape.terms_version,
        JSON.stringify(shape.rights),
        when,
        superseded,
      ],
    );
  };
  await offer(IDS.oa1, 'v1', 'sl_pa', 'sl_a1', 'withdrawn', at(50), IDS.oa1);
  await offer(IDS.oa1, 'v2', 'sl_pa', 'sl_a1', 'authorised', at(40), null);
  await offer(IDS.oa2, 'v1', 'sl_pa', 'sl_a2', 'authorised', at(50), null);
  await offer(IDS.ob1, 'v1', 'sl_pb', 'sl_b1', 'authorised', at(50), null);

  const corridor = (
    await db.query<{ id: string }>(
      `SELECT id FROM corridors WHERE currency = 'USD' AND enabled LIMIT 1`,
    )
  ).rows[0]!.id;
  const merchant: Record<string, string> = { sl_pa: 'MERCHSLPA', sl_pb: 'MERCHSLPB' };

  const makeOrder = async (u: UnitSpec, created: string, total: number): Promise<void> => {
    seq += 1;
    await db.query(
      `INSERT INTO approvals (id, buyer_id, snapshot, content_hash, nonce, expires_at, used_at, environment, created_at, updated_at)
       VALUES ($1, $2, '{}'::jsonb, $3, $4, $5, NULL, 'dryrun', $6, $6)`,
      [
        `apr_${u.order}`,
        u.buyer,
        hex(9600 + seq),
        `nonce-${u.order}`,
        new Date(Date.parse(created) + 900_000).toISOString(),
        created,
      ],
    );
    await db.query(
      `INSERT INTO orders (id, approval_id, buyer_id, content_hash, order_ref, expected, status, mismatch, corridor_id, currency, total_minor, environment, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, '{}'::jsonb, 'paid_partial', false, $6, 'USD', $7, 'dryrun', $8, $8)`,
      [
        u.order,
        `apr_${u.order}`,
        u.buyer,
        hex(9700 + seq),
        `ref_${u.order}`,
        corridor,
        total,
        created,
      ],
    );
    if (u.buyer === 'vs_b2') {
      await db.query(
        `INSERT INTO mandate_reservations (id, mandate_id, order_id, amount_minor, state, created_at, settled_at)
         VALUES ($1, 'vs_man', $2, 100, 'committed', $3, $3)`,
        [`rsv_${u.order}`, u.order, created],
      );
    }
  };

  const addUnit = async (u: UnitSpec): Promise<void> => {
    const created = at(u.days, u.minutes ?? 0);
    if (u.sharedOrder !== true) await makeOrder(u, created, u.orderTotal ?? u.amount);
    const captured = u.status !== 'pending';
    const po = `po_${u.id}`;
    const split = u.order === 'sl_o1';
    await db.query(
      `INSERT INTO provider_orders (id, order_id, provider_order_id, route, approve_url, status, created_at, updated_at, position, po_ref, publisher_id, state, first_approved_at)
       VALUES ($1, $2, $3, $4, NULL, NULL, $5, $5, $6, $7, $8, 'prepared', NULL)`,
      [
        po,
        u.order,
        `PAYPALSL${u.id.toUpperCase().replace(/[^A-Z0-9]/g, '')}`,
        split ? 'per_publisher' : 'single',
        created,
        u.position,
        `ref_${u.order}_${u.id}`,
        split ? u.seller : null,
      ],
    );
    const refunded = u.status === 'partially_refunded' ? 300 : 0;
    await db.query(
      `INSERT INTO order_units (id, order_id, provider_order_ref, publisher_id, reference_id, payee_merchant_id, amount_minor, platform_fee_minor, capture_id, status, status_reason, paypal_fee_minor, refunded_minor, captured_verified_at, mismatch_reason, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 0, $8, $9, NULL, NULL, $10, $11, NULL, $12, $12)`,
      [
        u.id,
        u.order,
        po,
        u.seller,
        `reference-${u.id}`,
        merchant[u.seller],
        u.amount,
        captured ? `CAP_${u.id}` : null,
        u.status,
        refunded,
        captured ? created : null,
        created,
      ],
    );
    for (const art of u.articles) {
      await db.query(
        `INSERT INTO entitlements (id, buyer_id, article_id, unit_id, option, policy, money_state, access_state, licence_state, transition_log, environment, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, '{}'::jsonb, 'denied', 'locked', NULL, '[]'::jsonb, 'dryrun', $6, $6)`,
        [`ent_${u.id}_${art}`, u.buyer, art, u.id, u.option, created],
      );
    }
    if (captured) {
      await db.query(
        `INSERT INTO ledger_entries (id, unit_id, capture_id, kind, amount_minor, currency, refund_id, ref_entry_id, environment, created_at, updated_at)
         VALUES ($1, $2, $3, 'sale', $4, 'USD', NULL, NULL, 'dryrun', $5, $5)`,
        [`led_${u.id}_sale`, u.id, `CAP_${u.id}`, u.amount, created],
      );
    }
  };

  // The two-seller order, bought by an agent: its total (7773) is no unit's amount.
  await addUnit({
    id: IDS.uA,
    order: 'sl_o1',
    buyer: 'vs_b2',
    seller: 'sl_pa',
    amount: 3331,
    status: 'captured_verified',
    days: 1,
    articles: ['sl_a1'],
    option: 'keep_retrieve',
    orderTotal: CANARY.total,
    position: 1,
  });
  await addUnit({
    id: IDS.uB,
    order: 'sl_o1',
    buyer: 'vs_b2',
    seller: 'sl_pb',
    amount: 4442,
    status: 'captured_verified',
    days: 1,
    articles: ['sl_b1'],
    option: 'keep_retrieve',
    sharedOrder: true,
    position: 2,
  });
  await addUnit({
    id: IDS.uM,
    order: 'sl_o2',
    buyer: 'vs_b1',
    seller: 'sl_pa',
    amount: 601,
    status: 'captured_verified',
    days: 2,
    articles: ['sl_a1', 'sl_a2'],
    option: 'keep_retrieve',
    position: 1,
  });
  await addUnit({
    id: IDS.uR,
    order: 'sl_o3',
    buyer: 'vs_b1',
    seller: 'sl_pa',
    amount: 800,
    status: 'partially_refunded',
    days: 3,
    articles: ['sl_a2'],
    option: 'online_read',
    position: 1,
  });
  await addUnit({
    id: IDS.uP,
    order: 'sl_o4',
    buyer: 'vs_b1',
    seller: 'sl_pa',
    amount: 500,
    status: 'pending',
    days: 0,
    minutes: 20,
    articles: ['sl_a1'],
    option: 'online_read',
    position: 1,
  });
  await addUnit({
    id: IDS.uW,
    order: 'sl_o5',
    buyer: 'vs_b1',
    seller: 'sl_pa',
    amount: 700,
    status: 'reversal_suspected',
    days: 15,
    articles: ['sl_a1'],
    option: 'keep_retrieve',
    position: 1,
  });
  await addUnit({
    id: IDS.uO,
    order: 'sl_o6',
    buyer: 'vs_b1',
    seller: 'sl_pa',
    amount: 900,
    status: 'captured_verified',
    days: 45,
    articles: ['sl_a2'],
    option: 'online_read',
    position: 1,
  });
  await addUnit({
    id: IDS.uB2,
    order: 'sl_o7',
    buyer: 'vs_b1',
    seller: 'sl_pb',
    amount: 1000,
    status: 'captured_verified',
    days: 2,
    articles: ['sl_b1'],
    option: 'online_read',
    position: 1,
  });

  // The refund of uR: the ledger row and the request, whose reason text holds a canary buyer name.
  await db.query(
    `INSERT INTO ledger_entries (id, unit_id, capture_id, kind, amount_minor, currency, refund_id, ref_entry_id, environment, created_at, updated_at)
     VALUES ('led_sl_uR_refund', $1, 'CAP_sl_uR', 'refund', 300, 'USD', 'RFD_SL_UR', 'led_sl_uR_sale', 'dryrun', $2, $2)`,
    [IDS.uR, at(2)],
  );
  await db.query(
    `INSERT INTO refund_requests (id, unit_id, capture_id, amount_minor, currency, reason, requested_by, state, refund_id, created_at, updated_at)
     VALUES ('rfr_sl_uR', $1, 'CAP_sl_uR', 300, 'USD', $2, 'operator', 'completed', 'RFD_SL_UR', $3, $3)`,
    [IDS.uR, CANARY.reason, at(2)],
  );
  // The reversal of uW.
  await db.query(
    `INSERT INTO ledger_entries (id, unit_id, capture_id, kind, amount_minor, currency, refund_id, ref_entry_id, environment, created_at, updated_at)
     VALUES ('led_sl_uW_reversal', $1, 'CAP_sl_uW', 'reversal', 100, 'USD', NULL, 'led_sl_uW_sale', 'dryrun', $2, $2)`,
    [IDS.uW, at(14)],
  );

  return {
    ...rig,
    A: { kind: 'publisher', publisher_id: 'sl_pa' },
    B: { kind: 'publisher', publisher_id: 'sl_pb' },
    C: { kind: 'publisher', publisher_id: 'sl_pc' },
    at,
  };
}
