// INT-AL test world (test data, never imported by product code): one migrated PGlite database, a fake clock,
// seeded ids, a switchable trace context (so a write is attributed the way a request or a job pass would), and
// raw inserts for the rows an alert points at. Rows are built in foreign-key order. Nothing here reads the
// environment or opens a socket.
import type { Clock, Database, IsoUtc, TraceContext } from '@umsbx/contracts';
import { migrate, openDatabase, withTraceDb } from '@umsbx/db';
import { resetDatabase } from '@umsbx/db/testing';
import { fakeClock, seededIds } from '@umsbx/runtime';

export const START: IsoUtc = '2026-11-05T10:00:00.000Z';
export const HOUR = 3_600_000;
export const HASH = 'a'.repeat(64);

type Raw = Database & { close(): Promise<void> };
export interface AlertDeps {
  db: Database;
  clock: Clock;
  ids: ReturnType<typeof seededIds>;
}

let ctxCounter = 0;
/** A context as the app opens it. The default is an operator with the second factor, on the web channel. */
export function ctxOf(over: Partial<TraceContext> = {}): TraceContext {
  ctxCounter += 1;
  return {
    id: `ctx_al_${String(ctxCounter).padStart(6, '0')}`,
    at: START,
    channel: 'web',
    actor_kind: 'operator',
    actor_id: 'opr_vikram',
    on_behalf_of: null,
    mandate_id: null,
    mfa: true,
    req_id: `req_al_${ctxCounter}`,
    ip_hash: 'f'.repeat(32),
    ua_family: 'browser',
    api_key_id: null,
    job: null,
    tool: null,
    ...over,
  };
}
/** The job-pass context of packages/jobs: system, channel job. */
export const jobCtx = (): TraceContext =>
  ctxOf({
    channel: 'job',
    actor_kind: 'system',
    actor_id: null,
    mfa: false,
    job: 'pass',
    ip_hash: null,
    ua_family: null,
  });

export interface World {
  raw: Raw;
  /** The traced database: writes through it carry the current context. */
  db: Database;
  clock: ReturnType<typeof fakeClock>;
  ids: ReturnType<typeof seededIds>;
  deps: AlertDeps;
  /** The context the traced database writes under (undefined: unattributed). */
  as(c: TraceContext | undefined): void;
  insert(table: string, row: Record<string, unknown>): Promise<void>;
  /** Order n with one unit of `amount` minor units, status default `unresolved`. */
  order(n: number, o?: { status?: string; amount?: number; unit_status?: string }): Promise<void>;
  alert(i: {
    kind: string;
    order?: number | null;
    unit?: number | null;
    reason: string;
    detail?: Record<string, unknown>;
    at?: string;
  }): Promise<string>;
  refundRequest(i: {
    id: string;
    unit: number;
    state: string;
    refund_id?: string | null;
    amount?: number | null;
  }): Promise<void>;
  /** A sale and a refund row in the ledger of unit n (needs order(n) with a captured unit). */
  ledgerRefund(i: { unit: number; refund_id: string; amount: number }): Promise<void>;
  mandate(i: {
    id: string;
    max_total?: number | null;
    max_count?: number | null;
    spent?: number;
    used?: number;
    revoked?: boolean;
    exhausted?: boolean;
    expires_at?: string;
  }): Promise<void>;
  subscription(i: { id: string; disabled?: boolean }): Promise<void>;
  /** One delivery row; `n` orders them by created_at. */
  delivery(i: { id: string; sub: string; status: string; n: number }): Promise<void>;
  caseRow(i: {
    id: string;
    kind?: string;
    state?: string;
    order?: number | null;
    sla_due_at?: string;
    buyer_message?: string;
  }): Promise<void>;
  applicant(id: string, decided?: 'approved' | 'rejected'): Promise<void>;
  payeeRequest(id: string, publisher: string, decided?: boolean): Promise<void>;
  events(alert_id: string): Promise<
    {
      id: string;
      kind: string;
      reason_code: string | null;
      note_sha256: string | null;
      at: string;
    }[]
  >;
  /** The journal rows of one source row: who and on which channel. */
  trace(
    table: string,
    id: string,
  ): Promise<{ actor_kind: string; actor_id: string | null; channel: string | null }[]>;
  count(table: string): Promise<number>;
  close(): Promise<void>;
}

export async function makeWorld(seed = 'al'): Promise<World> {
  const raw = (await openDatabase({ kind: 'pglite-memory' })) as Raw;
  const clock = fakeClock(START);
  await migrate(raw, clock);
  const ids = seededIds(seed);
  let current: TraceContext | undefined;
  const db = withTraceDb(raw, () => current, clock);
  const T = (): string => clock.now().toISOString();
  const insert = async (table: string, row: Record<string, unknown>): Promise<void> => {
    const r: Record<string, unknown> = { created_at: T(), updated_at: T(), ...row };
    const cols = Object.keys(r).filter((c) => r[c] !== undefined);
    await raw.query(
      `INSERT INTO ${table} (${cols.map((c) => (c === 'on' ? '"on"' : c)).join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`,
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
    await insert('buyers', {
      id: 'buy_1',
      display_name: 'b1',
      auth_subject: 'sub_b1',
      country: 'US',
    });
  };
  const world: World = {
    raw,
    db,
    clock,
    ids,
    deps: { db, clock, ids },
    as(c) {
      current = c;
    },
    insert,
    async order(n, o = {}) {
      const amount = o.amount ?? 500;
      const captured = (o.unit_status ?? 'captured_verified') === 'captured_verified';
      await insert('approvals', {
        id: `apr_${n}`,
        buyer_id: 'buy_1',
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
        buyer_id: 'buy_1',
        content_hash: HASH.slice(0, 60) + String(n).padStart(4, '0'),
        order_ref: `ref_${n}`,
        expected: '{}',
        status: o.status ?? 'unresolved',
        mismatch: false,
        corridor_id: 'us-usd',
        currency: 'USD',
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
        capture_id: captured ? `CAP${n}` : null,
        status: o.unit_status ?? 'captured_verified',
        status_reason: null,
        paypal_fee_minor: null,
        refunded_minor: 0,
        captured_verified_at: captured ? T() : null,
        mismatch_reason: null,
      });
    },
    async alert(i) {
      const id = ids.next('alr');
      await insert('alerts', {
        id,
        kind: i.kind,
        order_id: i.order === null || i.order === undefined ? null : `ord_${i.order}`,
        unit_id: i.unit === null || i.unit === undefined ? null : `unt_${i.unit}`,
        detail: JSON.stringify({ ...(i.detail ?? {}), reason: i.reason }),
        ...(i.at !== undefined ? { created_at: i.at, updated_at: i.at } : {}),
      });
      return id;
    },
    async refundRequest(i) {
      await insert('refund_requests', {
        id: i.id,
        unit_id: `unt_${i.unit}`,
        capture_id: `CAP${i.unit}`,
        amount_minor: i.amount === undefined ? 100 : i.amount,
        currency: 'USD',
        reason: 'test refund',
        requested_by: 'operator:opr_vikram',
        state: i.state,
        refund_id: i.refund_id ?? null,
      });
    },
    async ledgerRefund(i) {
      const sale = await raw.query(
        "SELECT id FROM ledger_entries WHERE capture_id = $1 AND kind = 'sale'",
        [`CAP${i.unit}`],
      );
      let saleId = (sale.rows[0] as { id: string } | undefined)?.id;
      if (saleId === undefined) {
        saleId = ids.next('led');
        await insert('ledger_entries', {
          id: saleId,
          unit_id: `unt_${i.unit}`,
          capture_id: `CAP${i.unit}`,
          kind: 'sale',
          amount_minor: 500,
          currency: 'USD',
          refund_id: null,
          ref_entry_id: null,
          environment: 'dryrun',
        });
      }
      await insert('ledger_entries', {
        id: ids.next('led'),
        unit_id: `unt_${i.unit}`,
        capture_id: `CAP${i.unit}`,
        kind: 'refund',
        amount_minor: i.amount,
        currency: 'USD',
        refund_id: i.refund_id,
        ref_entry_id: saleId,
        environment: 'dryrun',
      });
    },
    async mandate(i) {
      const key = `key_${i.id}`;
      await insert('api_keys', {
        id: key,
        owner_kind: 'buyer',
        owner_id: 'buy_1',
        key_kind: 'agent',
        agent_buyer_id: 'buy_1',
        scopes: ['orders:write'],
        secret_hash: HASH,
        updated_at: undefined,
      });
      await insert('mandates', {
        id: i.id,
        buyer_id: 'buy_1',
        agent_key_id: key,
        currency: 'USD',
        max_total_minor: i.max_total === undefined ? 1000 : i.max_total,
        max_count: i.max_count === undefined ? null : i.max_count,
        max_per_purchase_minor: null,
        expires_at: i.expires_at ?? new Date(clock.now().getTime() + 24 * HOUR).toISOString(),
        revoked_at: i.revoked === true ? T() : null,
        spent_minor: i.spent ?? 0,
        used_count: i.used ?? 0,
        exhausted_at: i.exhausted === true ? T() : null,
      });
    },
    async subscription(i) {
      await insert('webhook_subscriptions', {
        id: i.id,
        owner_kind: 'buyer',
        owner_id: 'buy_1',
        url: 'https://hooks.example.test/in',
        event_types: ['order.paid'],
        signing_secret: `whsec_${'a'.repeat(64)}`,
        disabled_at: i.disabled === true ? T() : null,
      });
    },
    async delivery(i) {
      const evt = `evt_${i.id}`;
      const at = new Date(Date.parse(START) + i.n * 1000).toISOString();
      await raw.query(
        'INSERT INTO event_outbox (id, type, payload, occurred_at) VALUES ($1, $2, $3, $4)',
        [evt, 'order.paid', '{}', at],
      );
      const pending = i.status === 'pending' || i.status === 'failed';
      await insert('webhook_deliveries', {
        id: i.id,
        event_id: evt,
        subscription_id: i.sub,
        attempt: i.status === 'pending' ? 0 : 1,
        status: i.status,
        next_at: pending ? at : null,
        last_error: i.status === 'failed' || i.status === 'dead' ? 'http_5xx' : null,
        created_at: at,
        updated_at: at,
      });
    },
    async caseRow(i) {
      await insert('recovery_cases', {
        id: i.id,
        kind: i.kind ?? 'payment_unresolved',
        state: i.state ?? 'open',
        order_id: i.order === null || i.order === undefined ? null : `ord_${i.order}`,
        entitlement_id: null,
        buyer_id: 'buy_1',
        opened_by: 'system',
        sla_due_at: i.sla_due_at ?? new Date(clock.now().getTime() + 4 * HOUR).toISOString(),
        credit_ms: 0,
        buyer_message: i.buyer_message ?? 'We are looking into your payment.',
      });
    },
    async applicant(id, decided) {
      await insert('publishers', {
        id,
        slug: id,
        display_name: id,
        country: 'US',
        paypal_merchant_id: null,
        payee_verified_at: null,
        status: 'applied',
      });
      if (decided !== undefined) {
        await insert('publisher_applicant_decisions', {
          id: ids.next('aud'),
          publisher_id: id,
          decision: decided,
          operator_id: 'opr_vikram',
          reason: 'test',
        });
      }
    },
    async payeeRequest(id, publisher, decided) {
      await insert('payee_change_requests', {
        id,
        publisher_id: publisher,
        requested_merchant_id: 'MERCH2',
        note: 'n',
        created_by: 'publisher',
      });
      if (decided === true) {
        await insert('payee_decisions', {
          id: ids.next('aud'),
          request_id: id,
          decision: 'verified',
          operator_id: 'opr_vikram',
          reason: 'test',
        });
      }
    },
    async events(alert_id) {
      const r = await raw.query<{
        id: string;
        kind: string;
        reason_code: string | null;
        note_sha256: string | null;
        at: string | Date;
      }>(
        'SELECT id, kind, reason_code, note_sha256, at FROM alert_events WHERE alert_id = $1 ORDER BY seq',
        [alert_id],
      );
      return r.rows.map((x) => ({ ...x, at: new Date(x.at).toISOString() }));
    },
    async trace(table, id) {
      const r = await raw.query<{
        actor_kind: string;
        actor_id: string | null;
        channel: string | null;
      }>(
        'SELECT actor_kind, actor_id, channel FROM trace_events WHERE source_table = $1 AND source_id = $2 ORDER BY occurred_at, seq',
        [table, id],
      );
      return r.rows;
    },
    async count(table) {
      const r = await raw.query<{ c: string | number }>(`SELECT count(*) AS c FROM ${table}`);
      return Number(r.rows[0]?.c ?? 0);
    },
    close: () => raw.close(),
  };
  await resetDatabase(raw);
  await seedBase();
  return world;
}
