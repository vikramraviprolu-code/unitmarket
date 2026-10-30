// Test-only world for the publisher console tests (PUB-C). Synthetic rows only: two publishers,
// units in any status, ledger rows written straight into the tables (this package never writes).
// A fresh order number n per call, so one database serves a whole file.
import type { Database } from '@umsbx/contracts';
import { migrate, openDatabase } from '@umsbx/db';
import { fakeClock } from '@umsbx/runtime';

export const START = '2026-10-22T10:00:00.000Z';
const HASH = 'a'.repeat(64);

export interface UnitSeed {
  n: number;
  publisher: 'pub_1' | 'pub_2';
  status?: string;
  amount_minor?: number;
  currency?: 'USD' | 'EUR';
  environment?: 'dryrun' | 'sandbox';
  paypal_fee_minor?: number | null;
  captured?: boolean;
  /** buyer who owns the order: a test for PRIV-1 looks for these values in every result. */
  buyer?: 'buy_1' | 'buy_2';
  title?: string;
  option?: 'keep_retrieve' | 'online_read';
}

export interface World {
  db: Database & { close(): Promise<void> };
  insert(table: string, row: Record<string, unknown>): Promise<void>;
  unit(s: UnitSeed): Promise<{ unit_id: string; order_ref: string; capture_id: string | null }>;
  ledger(
    unit_id: string,
    capture_id: string,
    kind: string,
    minor: number,
    over?: { currency?: string; environment?: string; refund_id?: string | null; at?: string },
  ): Promise<void>;
  close(): Promise<void>;
}

export async function makeWorld(): Promise<World> {
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
    id: 'eu-eur',
    currency: 'EUR',
    minor_units: 2,
    buyer_countries: ['US'],
    payee_countries: ['US'],
    domestic_supported: true,
    min_charge_minor: null,
    enabled: true,
  });
  for (const [id, slug, name, merchant] of [
    ['pub_1', 'p1', 'Pub One', 'MERCHANT0001A'],
    ['pub_2', 'p2', 'Pub Two', 'MERCHANT0002B'],
  ] as const) {
    await insert('publishers', {
      id,
      slug,
      display_name: name,
      country: 'US',
      paypal_merchant_id: merchant,
      payee_verified_at: T(),
    });
  }
  await insert('buyers', {
    id: 'buy_1',
    display_name: 'Ann Buyer',
    auth_subject: 'sub_a',
    country: 'US',
  });
  await insert('buyers', {
    id: 'buy_2',
    display_name: 'Bob Buyer',
    auth_subject: 'sub_b',
    country: 'US',
  });
  const world: World = {
    db,
    insert,
    async unit(s) {
      const { n } = s;
      const currency = s.currency ?? 'USD';
      const amount = s.amount_minor ?? 500;
      const environment = s.environment ?? 'dryrun';
      const buyer = s.buyer ?? 'buy_1';
      const captured = s.captured ?? true;
      const status = s.status ?? (captured ? 'captured_verified' : 'expected');
      const hasCapture = captured && status !== 'declined' && status !== 'expected';
      const stamp = `2026-10-22T10:${String(n % 60).padStart(2, '0')}:00.000Z`;
      await insert('approvals', {
        id: `apr_${n}`,
        buyer_id: buyer,
        snapshot: '{}',
        content_hash: HASH,
        nonce: `nonce${n}`,
        expires_at: '2026-10-22T10:15:00.000Z',
        used_at: null,
        environment,
      });
      await insert('orders', {
        id: `ord_${n}`,
        approval_id: `apr_${n}`,
        buyer_id: buyer,
        content_hash: HASH.slice(0, 60) + String(n).padStart(4, '0'),
        order_ref: `ordref_abc${String(n).padStart(3, '0')}`,
        expected: '{}',
        status: 'paid',
        mismatch: false,
        corridor_id: currency === 'EUR' ? 'eu-eur' : 'us-usd',
        currency,
        total_minor: amount,
        environment,
        created_at: stamp,
      });
      await insert('order_units', {
        id: `unt_${n}`,
        order_id: `ord_${n}`,
        provider_order_ref: null,
        publisher_id: s.publisher,
        reference_id: `refid_${n}`,
        payee_merchant_id: s.publisher === 'pub_1' ? 'MERCHANT0001A' : 'MERCHANT0002B',
        amount_minor: amount,
        platform_fee_minor: 0,
        capture_id: hasCapture ? `CAP${n}` : null,
        status,
        status_reason: null,
        paypal_fee_minor: s.paypal_fee_minor ?? null,
        refunded_minor: 0,
        captured_verified_at: hasCapture ? stamp : null,
        mismatch_reason: null,
        created_at: stamp,
      });
      const articleId = `art_${n}`;
      await insert('articles', {
        id: articleId,
        publisher_id: s.publisher,
        title: s.title ?? `Article ${n}`,
        abstract: 'x',
        language: 'en',
        topics: ['t'],
        published_at: START,
        sha256: HASH,
        content_key: `key_${n}`,
        bytes: 1,
        mime: 'text/plain',
      });
      await insert('entitlements', {
        id: `ent_${n}`,
        buyer_id: buyer,
        article_id: articleId,
        unit_id: `unt_${n}`,
        option: s.option ?? 'keep_retrieve',
        policy: '{}',
        money_state: 'pending',
        access_state: 'locked',
        licence_state: null,
        transition_log: '[]',
        environment,
      });
      return {
        unit_id: `unt_${n}`,
        order_ref: `ordref_abc${String(n).padStart(3, '0')}`,
        capture_id: hasCapture ? `CAP${n}` : null,
      };
    },
    async ledger(unit_id, capture_id, kind, minor, over = {}) {
      const unit = (
        await db.query<{ currency: string; environment: string }>(
          `SELECT o.currency, o.environment FROM order_units u JOIN orders o ON o.id = u.order_id WHERE u.id = $1`,
          [unit_id],
        )
      ).rows[0]!;
      const isRefundKind = kind === 'refund' || kind === 'commission_reversal';
      await insert('ledger_entries', {
        id: `led_${unit_id}_${kind}_${over.refund_id ?? minor}`,
        unit_id,
        capture_id,
        kind,
        amount_minor: minor,
        currency: over.currency ?? unit.currency,
        refund_id: isRefundKind ? (over.refund_id ?? `rf_${minor}`) : null,
        ref_entry_id: null,
        environment: over.environment ?? unit.environment,
        ...(over.at === undefined ? {} : { created_at: over.at }),
      });
    },
    async close() {
      await db.close();
    },
  };
  return world;
}
