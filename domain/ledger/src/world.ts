// Test-only world for the ledger state tests. Synthetic rows only. No resetDatabase: every test
// takes a fresh order number n, so one database serves the whole file.
import type { CoreDeps, Database, LedgerEntryInput } from '@umsbx/contracts';
import { migrate, openDatabase } from '@umsbx/db';
import { fakeClock, seededIds } from '@umsbx/runtime';

export const START = '2026-10-22T10:00:00.000Z';
export const HASH = 'a'.repeat(64);

export interface World {
  db: Database & { close(): Promise<void> };
  clock: ReturnType<typeof fakeClock>;
  deps: Pick<CoreDeps, 'clock' | 'ids' | 'environment'>;
  insert(table: string, row: Record<string, unknown>): Promise<void>;
  /** order ord_n with one captured unit unt_n (capture CAPn, 500 USD minor units). */
  order(
    n: number,
    over?: { currency?: string; amount_minor?: number },
  ): Promise<{ order_id: string; unit_id: string; capture_id: string }>;
  input(n: number, over: Partial<LedgerEntryInput>): LedgerEntryInput;
  close(): Promise<void>;
}

export async function makeWorld(seed = 'led'): Promise<World> {
  const db = await openDatabase({ kind: 'pglite-memory' });
  const clock = fakeClock(START);
  await migrate(db, clock);
  const T = () => clock.now().toISOString();
  const insert = async (table: string, row: Record<string, unknown>): Promise<void> => {
    const r: Record<string, unknown> = { created_at: T(), updated_at: T(), ...row };
    const cols = Object.keys(r);
    await db.query(
      `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`,
      cols.map((c) => r[c]),
    );
  };
  await insert('corridors', {
    id: 'us-usd',
    currency: 'USD',
    minor_units: 2,
    buyer_countries: ['US'],
    payee_countries: ['US'],
    domestic_supported: true,
    min_charge_minor: null,
    enabled: true,
  }).catch(() => undefined);
  // Since 0034 (WW-COR) de-eur is on for every country but India; this fixture's eu-eur row serves payee US, and the
  // guard refuses two enabled EUR rows that overlap, so the fixture first switches de-eur off (the pre-0034 world).
  await db.query("UPDATE corridors SET enabled = false WHERE id = 'de-eur'");
  await insert('corridors', {
    id: 'eu-eur',
    currency: 'EUR',
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
  await insert('buyers', { id: 'buy_1', display_name: 'A', auth_subject: 'sub_a', country: 'US' });
  const world: World = {
    db,
    clock,
    deps: { clock, ids: seededIds(seed), environment: 'dryrun' },
    insert,
    async order(n, over = {}) {
      const currency = over.currency ?? 'USD';
      const amount = over.amount_minor ?? 500;
      await insert('approvals', {
        id: `apr_${n}`,
        buyer_id: 'buy_1',
        snapshot: '{}',
        content_hash: HASH,
        nonce: `nonce${n}`,
        expires_at: '2026-10-22T10:15:00.000Z',
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
        status: 'paid',
        mismatch: false,
        corridor_id: currency === 'EUR' ? 'eu-eur' : 'us-usd',
        currency,
        total_minor: amount,
        environment: 'dryrun',
      });
      await insert('order_units', {
        id: `unt_${n}`,
        order_id: `ord_${n}`,
        provider_order_ref: null,
        publisher_id: 'pub_1',
        reference_id: `refid_${n}`,
        payee_merchant_id: 'MERCH1',
        amount_minor: amount,
        platform_fee_minor: 0,
        capture_id: `CAP${n}`,
        status: 'captured_verified',
        status_reason: null,
        paypal_fee_minor: null,
        refunded_minor: 0,
        captured_verified_at: T(),
        mismatch_reason: null,
      });
      return { order_id: `ord_${n}`, unit_id: `unt_${n}`, capture_id: `CAP${n}` };
    },
    input(n, over) {
      return {
        unit_id: `unt_${n}`,
        capture_id: `CAP${n}`,
        kind: 'sale',
        amount: { currency: 'USD', minor: 500 },
        refund_id: null,
        ref_entry_id: null,
        ...over,
      };
    },
    async close() {
      await db.close();
    },
  };
  return world;
}
