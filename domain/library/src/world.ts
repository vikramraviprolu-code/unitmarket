/* eslint-disable no-restricted-imports -- TEMP-until-lane-16: the testkit does not yet offer a migrated test database, so this test-only helper (imported by *.test.ts files only) opens one from @umsbx/db and @umsbx/runtime. Replace with the testkit helper when lane 16 merges. */
// Adapted from domain/delivery/src/world.ts at main 0451c44 (SBX lane 09); owned by SBX lane 10.
// (copy of domain/recovery/src/world.ts; packages may not import each other's helpers)
// Test-only world for the library state and adversarial tests: one PGlite database, the supply
// and money rows a case points at, a CoreDeps with a fake clock and seeded ids, and an audit sink
// that really writes audit_log rows.
import { createHash } from 'node:crypto';
import type { AccessPolicy, CoreDeps, Database, IsoUtc, Secret } from '@umsbx/contracts';
import { markAccessReady } from '@umsbx/access-clock';
import { createPgContentStore } from '@umsbx/delivery';
import { openDatabase, migrate } from '@umsbx/db';
import { resetDatabase } from '@umsbx/db/testing';
import { fakeClock, seededIds } from '@umsbx/runtime';

export const START: IsoUtc = '2026-10-21T10:00:00.000Z';
export const HOUR = 3_600_000;
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

function secretOf(v: string): Secret {
  return { reveal: () => v, toString: () => '[redacted]', toJSON: () => '[redacted]' };
}

export interface ItemOptions {
  buyer_id?: string;
  /** unit status; default captured_verified (a verified capture) */
  unit_status?: string;
  option?: 'keep_retrieve' | 'online_read';
  /** start the clock (access_ready) at the current fake time; default true for captured items */
  ready?: boolean;
  title?: string;
  /** write bytes into content_blobs so a link can be issued; default true */
  content?: boolean;
}
export interface Item {
  n: number;
  order_id: string;
  unit_id: string;
  article_id: string;
  entitlement_id: string;
  buyer_id: string;
}

export interface World {
  db: Database & { close(): Promise<void> };
  clock: ReturnType<typeof fakeClock>;
  deps: CoreDeps & { content: ReturnType<typeof createPgContentStore> };
  reset(): Promise<void>;
  insert(table: string, row: Record<string, unknown>): Promise<void>;
  /** Order, unit, article and entitlement n, inserted raw (only access_ready goes through code). */
  item(n: number, o?: ItemOptions): Promise<Item>;
  /** Removes the stored bytes of article n, so the store probe fails. */
  breakContent(n: number): Promise<void>;
  rawAlert(i: {
    kind: string;
    order_id: string;
    unit_id?: string | null;
    reason?: string;
  }): Promise<string>;
  count(table: string): Promise<number>;
  close(): Promise<void>;
}

export async function makeWorld(seed = 'w'): Promise<World> {
  const db = await openDatabase({ kind: 'pglite-memory' });
  const clock = fakeClock(START);
  await migrate(db, clock);
  const noop = () => undefined;
  const ids = seededIds(seed);
  const audit = {
    record: async (
      tx: { query: Database['query'] },
      e: {
        actor: { kind: string; buyer_id?: string; operator_id?: string };
        action: string;
        target: string | null;
        reason: string | null;
        detail: Record<string, unknown>;
      },
    ): Promise<void> => {
      const id = e.actor.buyer_id ?? e.actor.operator_id ?? null;
      await tx.query(
        `INSERT INTO audit_log (id, actor_kind, actor_id, action, target, reason, detail, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $8)`,
        [
          ids.next('aud'),
          e.actor.kind,
          id,
          e.action,
          e.target,
          e.reason,
          JSON.stringify(e.detail),
          clock.now().toISOString(),
        ],
      );
    },
  };
  const content = createPgContentStore(db);
  const deps = {
    db,
    clock,
    ids,
    log: { debug: noop, info: noop, warn: noop, error: noop },
    audit,
    switches: { isOn: () => Promise.resolve(true) },
    config: {
      link_ttl_ms: 600_000,
      link_secret: secretOf('test-link-secret-0123456789abcdef'),
      public_origin: 'http://localhost:3000',
    },
    environment: 'dryrun',
    content,
  } as unknown as World['deps'];
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
  const world: World = {
    db,
    clock,
    deps,
    insert,
    async reset() {
      await resetDatabase(db);
      await seedBase();
    },
    async item(n, o = {}) {
      const buyer_id = o.buyer_id ?? 'buy_1';
      const unit_status = o.unit_status ?? 'captured_verified';
      const verified = [
        'captured_verified',
        'partially_refunded',
        'refunded',
        'reversal_suspected',
        'reversed',
      ].includes(unit_status);
      const option = o.option ?? 'keep_retrieve';
      const body = new TextEncoder().encode(`article body number ${n}`);
      const sha256 = createHash('sha256').update(body).digest('hex');
      await insert('articles', {
        id: `art_${n}`,
        publisher_id: 'pub_1',
        title: o.title ?? `Title ${n}`,
        abstract: 'a',
        language: 'en',
        topics: ['x'],
        published_at: T(),
        sha256,
        content_key: `k${n}`,
        bytes: body.length,
        mime: 'text/plain',
      });
      if (o.content ?? true) {
        await insert('content_blobs', {
          content_key: `k${n}`,
          sha256,
          mime: 'text/plain',
          bytes: body.length,
          data: body,
        });
      }
      await insert('approvals', {
        id: `apr_${n}`,
        buyer_id,
        snapshot: '{}',
        content_hash: HASH,
        nonce: `nonce${n}`,
        expires_at: new Date(clock.now().getTime() + 15 * 60_000).toISOString(),
        used_at: null,
        environment: 'dryrun',
      });
      await insert('orders', {
        id: `ord_${n}`,
        approval_id: `apr_${n}`,
        buyer_id,
        content_hash: HASH.slice(0, 60) + String(n).padStart(4, '0'),
        order_ref: `ref_${n}`,
        expected: '{}',
        status: verified ? 'paid' : 'unresolved',
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
        capture_id: verified ? `CAP${n}` : null,
        status: unit_status,
        status_reason: null,
        paypal_fee_minor: null,
        refunded_minor: unit_status === 'refunded' ? 500 : 0,
        captured_verified_at: verified ? T() : null,
        mismatch_reason: null,
      });
      const money = verified
        ? unit_status === 'refunded'
          ? 'refunded'
          : unit_status === 'reversed'
            ? 'reversed'
            : 'captured'
        : unit_status === 'declined'
          ? 'denied'
          : 'pending';
      const access = money === 'refunded' || money === 'reversed' ? 'revoked' : 'locked';
      const licence = ['captured', 'refunded', 'reversed'].includes(money)
        ? money === 'captured'
          ? 'granted'
          : 'terminated'
        : null;
      const entitlement_id = `ent_${n}`;
      await insert('entitlements', {
        id: entitlement_id,
        buyer_id,
        article_id: `art_${n}`,
        unit_id: `unt_${n}`,
        option,
        policy: JSON.stringify(policyFor(option)),
        money_state: money,
        access_state: access,
        licence_state: licence,
        transition_log: '[]',
        environment: 'dryrun',
      });
      await insert('access_windows', {
        entitlement_id,
        state: 'not_started',
        started_at: null,
        base_ends_at: null,
        ends_at: null,
        paused_at: null,
        credit_ms: 0,
      });
      if (money === 'captured' && (o.ready ?? true)) {
        await db.transaction((tx) =>
          markAccessReady(tx, deps, {
            entitlement_id,
            evidence: { capture_id: `CAP${n}`, content_sha256: sha256, link_probe: 'ok' },
          }),
        );
      }
      return {
        n,
        order_id: `ord_${n}`,
        unit_id: `unt_${n}`,
        article_id: `art_${n}`,
        entitlement_id,
        buyer_id,
      };
    },
    async breakContent(n) {
      await db.query('DELETE FROM content_blobs WHERE content_key = $1', [`k${n}`]);
    },
    async rawAlert(i) {
      const id = ids.next('alr');
      await insert('alerts', {
        id,
        kind: i.kind,
        order_id: i.order_id,
        unit_id: i.unit_id ?? null,
        detail: JSON.stringify({ reason: i.reason ?? 'test' }),
      });
      return id;
    },
    async count(table) {
      const r = await db.query<{ c: string | number }>(`SELECT count(*) AS c FROM ${table}`);
      return Number(r.rows[0]?.c ?? 0);
    },
    close: () => db.close(),
  };
  await world.reset();
  return world;
}
