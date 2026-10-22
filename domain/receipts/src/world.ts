/* eslint-disable no-restricted-imports -- test-only helper (imported by *.test.ts only): opens a migrated PGlite database from @umsbx/db and the fake clock from @umsbx/runtime, as the lane 06 and 07 test harnesses do (TEMP-until-lane-16 testkit). */
// Test-only world for the receipt tests. Synthetic rows only; no real merchant or payer data.
import { contentHash } from '@umsbx/approval';
import type {
  ApprovalSnapshot,
  CoreDeps,
  Database,
  EnvironmentLabel,
  Result,
} from '@umsbx/contracts';
import { appendLedgerEntry } from '@umsbx/ledger';
import { migrate, openDatabase } from '@umsbx/db';
import { fakeClock, seededIds } from '@umsbx/runtime';

export const START = '2026-10-22T10:00:00.000Z';
export const FIVE_DAYS_MS = 432_000_000;
export const DEBUG_ID = 'ABCDEF1234567890';

export interface PaidOrder {
  n: number;
  order_id: string;
  unit_id: string;
  capture_id: string;
  buyer_id: string;
  entitlements: string[];
  articles: string[];
  snapshot: ApprovalSnapshot;
}

export interface World {
  db: Database & { close(): Promise<void> };
  clock: ReturnType<typeof fakeClock>;
  deps: Pick<CoreDeps, 'clock' | 'ids' | 'environment'>;
  insert(table: string, row: Record<string, unknown>): Promise<void>;
  /** An order with two items (400 + 250 USD minor units) on one unit. captured=false leaves the unit unpaid. */
  order(n: number, over?: { captured?: boolean; booked?: boolean }): Promise<PaidOrder>;
  event(entitlement_id: string, kind: string, at: string, n: number): Promise<void>;
  refund(o: PaidOrder, refund_id: string, minor: number): Promise<Result<unknown, unknown>>;
  close(): Promise<void>;
}

function snapshotFor(n: number): ApprovalSnapshot {
  const item = (k: number, option: 'keep_retrieve' | 'online_read', amount: number) => ({
    article_id: `art_${n}_${k}`,
    article_sha256: String(k).repeat(64),
    offer_id: `ofr_${n}_${k}`,
    offer_version: '1',
    terms_version: 'terms-1',
    publisher_id: 'pub_1',
    payee_merchant_id: 'MERCH1',
    option,
    policy: {
      id: `pol_${option}`,
      version: 'v1',
      option,
      window_ms: FIVE_DAYS_MS,
      start_rule: 'payment_verified_and_delivery_ready' as const,
    },
    rights: {
      scope: 'personal_use' as const,
      ai_scope: 'review' as const,
      redistribution: false as const,
    },
    amount_minor: amount,
  });
  return {
    snapshot_version: '1',
    items: [item(1, 'keep_retrieve', 400), item(2, 'online_read', 250)],
    publishers: [
      {
        publisher_id: 'pub_1',
        payee_merchant_id: 'MERCH1',
        amount_minor: 650,
        platform_fee_minor: 0,
      },
    ],
    total_minor: 650,
    currency: 'USD',
    corridor_id: 'us-usd',
    reader: { buyer_id: 'buy_A' },
    rule_version: 'rules-1',
    pricing_rule_version: 'pricing-1',
  };
}

export async function makeWorld(
  seed = 'rct',
  environment: EnvironmentLabel = 'dryrun',
): Promise<World> {
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
  await insert('publishers', {
    id: 'pub_1',
    slug: 'p1',
    display_name: 'Pub One',
    country: 'US',
    paypal_merchant_id: 'MERCH1',
    payee_verified_at: T(),
  });
  for (const b of ['buy_A', 'buy_B']) {
    await insert('buyers', { id: b, display_name: b, auth_subject: `sub_${b}`, country: 'US' });
  }
  const deps = { clock, ids: seededIds(seed), environment } as World['deps'];
  const world: World = {
    db,
    clock,
    deps,
    insert,
    async order(n, over = {}) {
      const env = environment;
      const captured = over.captured ?? true;
      const snapshot = snapshotFor(n);
      const hash = contentHash(snapshot);
      await insert('approvals', {
        id: `apr_${n}`,
        buyer_id: 'buy_A',
        snapshot: JSON.stringify(snapshot),
        content_hash: hash,
        nonce: `nonce${n}`,
        expires_at: '2026-10-22T10:15:00.000Z',
        used_at: null,
        environment: env,
      });
      const articles: string[] = [];
      for (const it of snapshot.items) {
        articles.push(it.article_id);
        await insert('articles', {
          id: it.article_id,
          publisher_id: 'pub_1',
          title: 't',
          abstract: 'a',
          language: 'en',
          topics: ['x'],
          published_at: T(),
          sha256: it.article_sha256,
          content_key: `k_${it.article_id}`,
          bytes: 10,
          mime: 'text/plain',
        });
      }
      await insert('orders', {
        id: `ord_${n}`,
        approval_id: `apr_${n}`,
        buyer_id: 'buy_A',
        content_hash: hash,
        order_ref: `ref_${n}`,
        expected: '{}',
        status: captured ? 'paid' : 'awaiting_buyer',
        mismatch: false,
        corridor_id: 'us-usd',
        currency: 'USD',
        total_minor: 650,
        environment: env,
      });
      await insert('order_units', {
        id: `unt_${n}`,
        order_id: `ord_${n}`,
        provider_order_ref: null,
        publisher_id: 'pub_1',
        reference_id: `refid_${n}`,
        payee_merchant_id: 'MERCH1',
        amount_minor: 650,
        platform_fee_minor: 0,
        capture_id: captured ? `CAP${n}` : null,
        status: captured ? 'captured_verified' : 'expected',
        status_reason: null,
        paypal_fee_minor: null,
        refunded_minor: 0,
        captured_verified_at: captured ? T() : null,
        mismatch_reason: null,
      });
      const entitlements: string[] = [];
      for (const [i, it] of snapshot.items.entries()) {
        const id = `ent_${n}_${i + 1}`;
        entitlements.push(id);
        await insert('entitlements', {
          id,
          buyer_id: 'buy_A',
          article_id: it.article_id,
          unit_id: `unt_${n}`,
          option: it.option,
          policy: JSON.stringify(it.policy),
          money_state: captured ? 'captured' : 'pending',
          access_state: captured ? 'available' : 'locked',
          licence_state: captured ? 'granted' : null,
          transition_log: '[]',
          environment: env,
        });
        await insert('access_windows', {
          entitlement_id: id,
          state: captured ? 'running' : 'not_started',
          started_at: captured ? START : null,
          base_ends_at: captured ? '2026-10-27T10:00:00.000Z' : null,
          ends_at: captured ? '2026-10-27T10:00:00.000Z' : null,
          paused_at: null,
          credit_ms: 0,
        });
      }
      if (captured) {
        await insert('operations', {
          id: `opr_${n}`,
          order_id: `ord_${n}`,
          unit_id: `unt_${n}`,
          kind: 'capture',
          state: 'confirmed',
          attempt: 0,
          request_id: `req_${n}`,
        });
        await insert('provider_calls', {
          id: `pcl_${n}`,
          operation_id: `opr_${n}`,
          operation: 'capture',
          method: 'POST',
          path_template: '/v2/checkout/orders/{id}/capture',
          http_status: 201,
          outcome: 'ok',
          debug_id: DEBUG_ID,
          duration_ms: 5,
          transport_kind: 'dryrun',
          request_redacted: '{}',
          response_redacted: '{}',
          environment: env,
        });
        if (over.booked !== false) {
          await appendLedgerEntry(db, deps, {
            unit_id: `unt_${n}`,
            capture_id: `CAP${n}`,
            kind: 'sale',
            amount: { currency: 'USD', minor: 650 },
            refund_id: null,
            ref_entry_id: null,
          });
        }
      }
      return {
        n,
        order_id: `ord_${n}`,
        unit_id: `unt_${n}`,
        capture_id: `CAP${n}`,
        buyer_id: 'buy_A',
        entitlements,
        articles,
        snapshot,
      };
    },
    async event(entitlement_id, kind, at, n) {
      await insert('access_events', {
        id: `aev_${entitlement_id}_${kind}_${n}`,
        entitlement_id,
        link_id: null,
        kind,
        at,
        source: 'system',
        evidence: '{}',
        environment: 'dryrun',
      });
    },
    refund(o, refund_id, minor) {
      return appendLedgerEntry(db, deps, {
        unit_id: o.unit_id,
        capture_id: o.capture_id,
        kind: 'refund',
        amount: { currency: 'USD', minor },
        refund_id,
        ref_entry_id: null,
      });
    },
    async close() {
      await db.close();
    },
  };
  return world;
}
