// Test data and builders for lane 06 (approval). Synthetic rows only; no real merchant ids.
// Imported by tests only; not exported from index.ts.
// The domain layering lint (S1) bars @umsbx/db and @umsbx/runtime in domain packages. State tests
// need a real PGlite database and the fake clock, so this one file opts out with a reason. See the
// change request in the lane 06 hand-off (add a test-only exemption to eslint.config.mjs).

import { migrate, openDatabase } from '@umsbx/db';
import { cryptoIds, fakeClock, seededIds } from '@umsbx/runtime';
import type {
  AuditEntry,
  CoreDeps,
  Database,
  Ids,
  IsoUtc,
  Secret,
  SqlExecutor,
} from '@umsbx/contracts';

export const T0: IsoUtc = '2026-10-22T10:00:00.000Z';
export const SEED_TIME = '2026-10-01T00:00:00Z';
const HASH = 'a'.repeat(64);

export type Db = Database & { close(): Promise<void> };

const secret = (value: string): Secret => ({
  reveal: () => value,
  toString: () => '[redacted]',
  toJSON: () => '[redacted]',
});

export interface Harness {
  db: Db;
  clock: ReturnType<typeof fakeClock>;
  deps: CoreDeps;
  audits: AuditEntry[];
}

export async function makeHarness(
  opts: { ids?: Ids; approvalSecret?: string; seed?: boolean } = {},
): Promise<Harness> {
  const db = await openDatabase({ kind: 'pglite-memory' });
  const clock = fakeClock(T0);
  await migrate(db, clock);
  if (opts.seed !== false) await seedCatalogue(db);
  const audits: AuditEntry[] = [];
  const log = { log: () => undefined, child: () => log };
  const deps: CoreDeps = {
    db,
    clock,
    ids: opts.ids ?? seededIds('approval-tests'),
    log,
    audit: {
      record: (_tx: SqlExecutor, e: AuditEntry) => {
        audits.push(e);
        return Promise.resolve();
      },
    },
    switches: { isOn: () => Promise.resolve(true) },
    config: {
      reconcile_window_ms: 86_400_000,
      reconcile_backoff_ms: [30_000, 120_000, 600_000, 3_600_000],
      idem_safe_window_ms: 18_000_000,
      abandoned_checkout_ms: 86_400_000,
      operation_lease_ms: 60_000,
      max_capture_retries: 1,
      link_ttl_ms: 600_000,
      public_origin: 'http://localhost:3000',
      approval_secret: secret(opts.approvalSecret ?? 'a'.repeat(32)),
      link_secret: secret('b'.repeat(32)),
      rule_version: 'rules-1',
      pricing_rule_version: 'pricing-1',
    },
    environment: 'dryrun',
  };
  return { db, clock, deps, audits };
}

export const realIds = cryptoIds;

async function ins(db: SqlExecutor, table: string, row: Record<string, unknown>): Promise<void> {
  const r: Record<string, unknown> = { created_at: SEED_TIME, updated_at: SEED_TIME, ...row };
  const cols = Object.keys(r);
  await db.query(
    `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`,
    cols.map((c) => r[c]),
  );
}
const j = (v: unknown): string => JSON.stringify(v);

export const OFFER_OPTIONS = [
  { option: 'keep_retrieve', price_minor: 400, policy_id: 'keep_retrieve', policy_version: '1' },
  { option: 'online_read', price_minor: 250, policy_id: 'online_read', policy_version: '1' },
];

export async function seedCatalogue(db: SqlExecutor): Promise<void> {
  await ins(db, 'corridors', {
    id: 'eu-eur',
    currency: 'EUR',
    minor_units: 2,
    buyer_countries: ['US'],
    payee_countries: ['US'],
    domestic_supported: true,
    min_charge_minor: null,
    enabled: true,
  });
  await ins(db, 'corridors', {
    id: 'off-usd',
    currency: 'USD',
    minor_units: 2,
    buyer_countries: ['US'],
    payee_countries: ['US'],
    domestic_supported: true,
    min_charge_minor: null,
    enabled: false,
  });
  await ins(db, 'buyers', { id: 'buy_A', display_name: 'A', auth_subject: 'sub-a', country: 'US' });
  await ins(db, 'buyers', { id: 'buy_B', display_name: 'B', auth_subject: 'sub-b', country: 'US' });
  const pubs: [string, string, string | null, string | null][] = [
    ['pub_1', 'p1', 'MERCH1', SEED_TIME],
    ['pub_2', 'p2', 'MERCH2', SEED_TIME],
    ['pub_unv', 'pu', 'MERCHU', null],
    ['pub_nom', 'pn', null, null],
  ];
  for (const [id, slug, merchant, verified] of pubs) {
    await ins(db, 'publishers', {
      id,
      slug,
      display_name: `Publisher ${slug}`,
      country: 'US',
      paypal_merchant_id: merchant,
      payee_verified_at: verified,
    });
  }
  const arts: [string, string][] = [
    ['art_1', 'pub_1'],
    ['art_2', 'pub_1'],
    ['art_3', 'pub_2'],
    ['art_4', 'pub_unv'],
    ['art_5', 'pub_2'],
    ['art_6', 'pub_2'],
    ['art_7', 'pub_2'],
    ['art_8', 'pub_nom'],
  ];
  for (const [id, publisher_id] of arts) {
    await ins(db, 'articles', {
      id,
      publisher_id,
      title: `Title ${id}`,
      abstract: 'abstract',
      language: 'en',
      topics: ['x'],
      published_at: SEED_TIME,
      sha256: id
        .charCodeAt(id.length - 1)
        .toString(16)
        .padStart(2, '0')
        .repeat(32),
      content_key: `key-${id}`,
      bytes: 10,
      mime: 'text/plain',
    });
  }
  // offer id -> article, publisher, currency
  const offers: [string, string, string, string][] = [
    ['ofr_1', 'art_1', 'pub_1', 'USD'],
    ['ofr_2', 'art_2', 'pub_1', 'USD'],
    ['ofr_3', 'art_3', 'pub_2', 'USD'],
    ['ofr_unv', 'art_4', 'pub_unv', 'USD'],
    ['ofr_5', 'art_5', 'pub_2', 'USD'],
    ['ofr_6', 'art_6', 'pub_2', 'USD'],
    ['ofr_7', 'art_7', 'pub_2', 'USD'],
    ['ofr_eur', 'art_3', 'pub_2', 'EUR'],
    ['ofr_nom', 'art_8', 'pub_nom', 'USD'],
  ];
  for (const [id, article_id, publisher_id, currency] of offers) {
    await ins(db, 'offers', {
      id,
      version: '1',
      publisher_id,
      article_id,
      status: 'authorised',
      currency,
      options: j(OFFER_OPTIONS),
      affordability: j({ renegotiation_allowed: false, floor_minor: null }),
      terms_version: 'terms-1',
      rights: j({ scope: 'personal_use', ai_scope: 'review', redistribution: false }),
      valid_from: SEED_TIME,
      valid_until: null,
      superseded_by: null,
    });
  }
}

export interface QuoteSeed {
  id: string;
  offer_id: string;
  offer_version?: string;
  option?: 'keep_retrieve' | 'online_read';
  price_minor?: number;
  currency?: string;
  corridor_id?: string;
  buyer_id?: string | null;
  expires_at?: string;
}

export async function addQuote(db: SqlExecutor, q: QuoteSeed): Promise<string> {
  const option = q.option ?? 'keep_retrieve';
  await ins(db, 'quotes', {
    id: q.id,
    buyer_id: q.buyer_id === undefined ? 'buy_A' : q.buyer_id,
    offer_id: q.offer_id,
    offer_version: q.offer_version ?? '1',
    option,
    price_minor: q.price_minor ?? (option === 'keep_retrieve' ? 400 : 250),
    currency: q.currency ?? 'USD',
    corridor_id: q.corridor_id ?? 'us-usd',
    source: 'direct',
    expires_at: q.expires_at ?? '2026-10-22T12:00:00.000Z',
  });
  return q.id;
}

export async function addProposal(
  db: SqlExecutor,
  id: string,
  buyer_id: string,
  quotes: { quote_id: string; offer_id: string }[],
): Promise<void> {
  await ins(db, 'briefs', {
    id: `brf_${id}`,
    buyer_id,
    raw_text: 'need',
    structured: j({}),
    version: '1',
    confirmed_at: SEED_TIME,
  });
  await ins(db, 'proposals', {
    id,
    brief_id: `brf_${id}`,
    buyer_id,
    items: j(quotes.map((q) => ({ quote: q, fit: null, title: 't', publisher: 'p' }))),
    fit: j([]),
  });
}

export const CONSENT = { terms: true, identity_share: true } as const;
export const BUYER_A = { kind: 'buyer', buyer_id: 'buy_A' } as const;
export const BUYER_B = { kind: 'buyer', buyer_id: 'buy_B' } as const;
export { HASH };
