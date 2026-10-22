/* eslint-disable no-restricted-imports -- TEMP-until-lane-16: the testkit does not yet offer a migrated test database, so this test-only helper (imported by *.test.ts files only) opens one from @umsbx/db and @umsbx/runtime. Replace with the testkit helper when lane 16 merges. */
// Test-only world for the entitlement and access-clock state tests: one PGlite database, the supply
// and money rows an entitlement points at, and a CoreDeps with a fake clock and seeded ids.
import type { AccessPolicy, CoreDeps, Database, IsoUtc } from '@umsbx/contracts';
import { openDatabase, migrate, resetDatabase } from '@umsbx/db';
import { fakeClock, seededIds } from '@umsbx/runtime';

export const START: IsoUtc = '2026-10-21T10:00:00.000Z';
export const FIVE_DAYS_MS = 432_000_000;
export const HASH = 'a'.repeat(64);

export function policyFor(option: 'keep_retrieve' | 'online_read'): AccessPolicy {
  return {
    id: `pol_${option}`,
    version: 'v1',
    option,
    window_ms: FIVE_DAYS_MS,
    start_rule: 'payment_verified_and_delivery_ready',
  };
}

export interface World {
  db: Database & { close(): Promise<void> };
  clock: ReturnType<typeof fakeClock>;
  deps: CoreDeps;
  reset(): Promise<void>;
  insert(table: string, row: Record<string, unknown>): Promise<void>;
  /** n-th article, unit and a captured-or-not entitlement row inserted raw (no code under test). */
  rawEntitlement(
    n: number,
    over?: {
      buyer_id?: string;
      money_state?: string;
      access_state?: string;
      licence_state?: string | null;
      option?: 'keep_retrieve' | 'online_read';
    },
  ): Promise<string>;
  /** article art_n and order unit unt_n (no entitlement). */
  supply(n: number): Promise<{ article_id: string; unit_id: string }>;
  rawLink(id: string, entitlementId: string, buyerId?: string): Promise<void>;
  close(): Promise<void>;
}

export async function makeWorld(seed = 'w'): Promise<World> {
  const db = await openDatabase({ kind: 'pglite-memory' });
  const clock = fakeClock(START);
  await migrate(db, clock);
  const noop = () => undefined;
  const deps = {
    db,
    clock,
    ids: seededIds(seed),
    log: { debug: noop, info: noop, warn: noop, error: noop },
    audit: { record: () => Promise.resolve() },
    switches: { isOn: () => Promise.resolve(true) },
    config: {},
    environment: 'dryrun',
  } as unknown as CoreDeps;
  const T = () => clock.now().toISOString();
  const insert = async (table: string, row: Record<string, unknown>): Promise<void> => {
    const r: Record<string, unknown> = { created_at: T(), updated_at: T(), ...row };
    const cols = Object.keys(r);
    await db.query(
      `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`,
      cols.map((c) => r[c]),
    );
  };
  const seedBase = async (): Promise<void> => {
    await insert('corridors', {
      id: 'us-usd',
      currency: 'USD',
      minor_units: 2,
      buyer_countries: ['US'],
      payee_countries: ['US'],
      domestic_supported: true,
      min_charge_minor: null,
      enabled: true,
    });
    await insert('publishers', {
      id: 'pub_1',
      slug: 'p1',
      display_name: 'Pub One',
      country: 'US',
      paypal_merchant_id: 'MERCH1',
      payee_verified_at: T(),
    });
    for (const b of ['buy_1', 'buy_2']) {
      await insert('buyers', { id: b, display_name: b, auth_subject: `sub_${b}`, country: 'US' });
    }
  };
  const seeded = new Set<number>();
  const world: World = {
    db,
    clock,
    deps,
    insert,
    async reset() {
      await resetDatabase(db);
      seeded.clear();
      await seedBase();
    },
    async supply(n) {
      if (!seeded.has(n)) {
        seeded.add(n);
        await insert('articles', {
          id: `art_${n}`,
          publisher_id: 'pub_1',
          title: 't',
          abstract: 'a',
          language: 'en',
          topics: ['x'],
          published_at: T(),
          sha256: HASH,
          content_key: `k${n}`,
          bytes: 10,
          mime: 'text/plain',
        });
        await insert('approvals', {
          id: `apr_${n}`,
          buyer_id: 'buy_1',
          snapshot: '{}',
          content_hash: HASH,
          nonce: `nonce${n}`,
          expires_at: '2027-01-01T00:00:00.000Z',
          used_at: null,
          environment: 'dryrun',
        });
        await insert('orders', {
          id: `ord_${n}`,
          approval_id: `apr_${n}`,
          buyer_id: 'buy_1',
          content_hash: HASH.slice(0, 60) + String(n).padStart(4, '0'),
          order_ref: `ref_${n}`,
          expected: '{}',
          status: 'created',
          mismatch: false,
          corridor_id: 'us-usd',
          currency: 'USD',
          total_minor: 500,
          environment: 'dryrun',
        });
        await insert('order_units', {
          id: `unt_${n}`,
          order_id: `ord_${n}`,
          provider_order_ref: null,
          publisher_id: 'pub_1',
          reference_id: `refid_${n}`,
          payee_merchant_id: 'MERCH1',
          amount_minor: 500,
          platform_fee_minor: 0,
          capture_id: `CAP${n}`,
          status: 'captured_verified',
          status_reason: null,
          paypal_fee_minor: null,
          refunded_minor: 0,
          captured_verified_at: T(),
          mismatch_reason: null,
        });
      }
      return { article_id: `art_${n}`, unit_id: `unt_${n}` };
    },
    async rawEntitlement(n, over = {}) {
      await world.supply(n);
      const option = over.option ?? 'keep_retrieve';
      const money = over.money_state ?? 'captured';
      const licence =
        over.licence_state !== undefined
          ? over.licence_state
          : ['captured', 'refunded', 'reversed'].includes(money)
            ? 'granted'
            : null;
      const id = `ent_raw${n}`;
      await insert('entitlements', {
        id,
        buyer_id: over.buyer_id ?? 'buy_1',
        article_id: `art_${n}`,
        unit_id: `unt_${n}`,
        option,
        policy: JSON.stringify(policyFor(option)),
        money_state: money,
        access_state: over.access_state ?? 'locked',
        licence_state: licence,
        transition_log: '[]',
        environment: 'dryrun',
      });
      await insert('access_windows', {
        entitlement_id: id,
        state: 'not_started',
        started_at: null,
        base_ends_at: null,
        ends_at: null,
        paused_at: null,
        credit_ms: 0,
      });
      return id;
    },
    async rawLink(id, entitlementId, buyerId = 'buy_1') {
      await insert('links', {
        id,
        entitlement_id: entitlementId,
        buyer_id: buyerId,
        token_hash: Buffer.from(id).toString('hex').padEnd(64, '0').slice(0, 64),
        expires_at: '2027-01-01T00:00:00.000Z',
        uses: 0,
      });
    },
    close: () => db.close(),
  };
  await world.reset();
  return world;
}
