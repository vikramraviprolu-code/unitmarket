// Adapted from AIC_Hackathon_UnitMarket packages/core/payments/store.ts at
// a36ddc03fd0b962000f686291c145b50ee337f90. Owned by SBX lane 05a.
// Row types, loaders and small helpers shared by the files of domain/payments. Reads only; every
// write is in the file that owns the rule. PGlite returns timestamptz as Date and jsonb as a parsed
// value; other drivers may return text, so both are normalised once, here.
import { ExpectedTransactionSchema } from '@umsbx/contracts';
import type {
  DomainConfig,
  EnvironmentLabel,
  ExpectedTransaction,
  Id,
  OperationKind,
  OperationState,
  OrderStatus,
  SqlExecutor,
  UnitStatus,
} from '@umsbx/contracts';

export interface OrderRow {
  id: Id;
  approval_id: Id;
  buyer_id: Id;
  order_ref: Id;
  content_hash: string;
  expected: ExpectedTransaction;
  status: OrderStatus;
  mismatch: boolean;
  currency: string;
  total_minor: number;
  environment: EnvironmentLabel;
}
export interface UnitRow {
  id: Id;
  order_id: Id;
  provider_order_ref: Id | null;
  publisher_id: Id;
  reference_id: Id;
  payee_merchant_id: string;
  amount_minor: number;
  capture_id: string | null;
  status: UnitStatus;
  status_reason: string | null;
  paypal_fee_minor: number | null;
  captured_verified_at: string | null;
  mismatch_reason: string | null;
  updated_at: string;
}
export interface OperationRow {
  id: Id;
  order_id: Id;
  kind: OperationKind;
  state: OperationState;
  attempt: number;
  request_id: string;
  first_sent_at: string | null;
  idem_safe_until: string | null;
  lease_until: string | null;
  next_retry_at: string | null;
  reconcile_until: string | null;
}
export interface ProviderOrderRow {
  id: Id;
  order_id: Id;
  provider_order_id: string | null;
  approve_url: string | null;
}

type Raw = Record<string, unknown>;
export const isoOf = (v: unknown): string | null =>
  v === null || v === undefined
    ? null
    : (v instanceof Date ? v : new Date(String(v))).toISOString();
const isoReq = (v: unknown): string => isoOf(v) as string;
const json = (v: unknown): unknown => (typeof v === 'string' ? (JSON.parse(v) as unknown) : v);

export const addMs = (at: string, ms: number): string =>
  new Date(Date.parse(at) + ms).toISOString();

const toOrder = (r: Raw): OrderRow => ({
  id: r['id'] as string,
  approval_id: r['approval_id'] as string,
  buyer_id: r['buyer_id'] as string,
  order_ref: r['order_ref'] as string,
  content_hash: r['content_hash'] as string,
  expected: ExpectedTransactionSchema.parse(json(r['expected'])),
  status: r['status'] as OrderStatus,
  mismatch: r['mismatch'] as boolean,
  currency: r['currency'] as string,
  total_minor: Number(r['total_minor']),
  environment: r['environment'] as EnvironmentLabel,
});
const toUnit = (r: Raw): UnitRow => ({
  id: r['id'] as string,
  order_id: r['order_id'] as string,
  provider_order_ref: (r['provider_order_ref'] as string | null) ?? null,
  publisher_id: r['publisher_id'] as string,
  reference_id: r['reference_id'] as string,
  payee_merchant_id: r['payee_merchant_id'] as string,
  amount_minor: Number(r['amount_minor']),
  capture_id: (r['capture_id'] as string | null) ?? null,
  status: r['status'] as UnitStatus,
  status_reason: (r['status_reason'] as string | null) ?? null,
  paypal_fee_minor: r['paypal_fee_minor'] === null ? null : Number(r['paypal_fee_minor']),
  captured_verified_at: isoOf(r['captured_verified_at']),
  mismatch_reason: (r['mismatch_reason'] as string | null) ?? null,
  updated_at: isoReq(r['updated_at']),
});
const toOperation = (r: Raw): OperationRow => ({
  id: r['id'] as string,
  order_id: r['order_id'] as string,
  kind: r['kind'] as OperationKind,
  state: r['state'] as OperationState,
  attempt: Number(r['attempt']),
  request_id: r['request_id'] as string,
  first_sent_at: isoOf(r['first_sent_at']),
  idem_safe_until: isoOf(r['idem_safe_until']),
  lease_until: isoOf(r['lease_until']),
  next_retry_at: isoOf(r['next_retry_at']),
  reconcile_until: isoOf(r['reconcile_until']),
});

export async function loadOrder(
  db: SqlExecutor,
  order_id: Id,
  opts: { lock?: boolean } = {},
): Promise<OrderRow | null> {
  const found = await db.query<Raw>(
    `SELECT * FROM orders WHERE id = $1${opts.lock === true ? ' FOR UPDATE' : ''}`,
    [order_id],
  );
  const row = found.rows[0];
  return row === undefined ? null : toOrder(row);
}
/** The buyer's own order by its reference, or null (another buyer's order answers like a missing one). */
export async function loadOrderByRef(
  db: SqlExecutor,
  order_ref: Id,
  buyer_id: Id,
): Promise<OrderRow | null> {
  const found = await db.query<Raw>('SELECT * FROM orders WHERE order_ref = $1 AND buyer_id = $2', [
    order_ref,
    buyer_id,
  ]);
  const row = found.rows[0];
  return row === undefined ? null : toOrder(row);
}
export async function loadUnits(db: SqlExecutor, order_id: Id): Promise<UnitRow[]> {
  const found = await db.query<Raw>(
    'SELECT * FROM order_units WHERE order_id = $1 ORDER BY reference_id, id',
    [order_id],
  );
  return found.rows.map(toUnit);
}
/**
 * LOCK ORDER (docs/READINESS.md "Lock order"). Every transaction that moves money takes its row
 * locks in one order: orders (and provider_orders), then operations, then order_units, then
 * refund_requests, then entitlements (with their windows and events), then ledger_entries and receipts.
 * This is the first step of that order: the order row, then every operation row of the order.
 * Taking all the operation rows at once means a later statement on any of them waits for nothing.
 */
export async function lockOrderRows(db: SqlExecutor, order_id: Id): Promise<OrderRow | null> {
  const order = await loadOrder(db, order_id, { lock: true });
  if (order === null) return null;
  await db.query('SELECT id FROM operations WHERE order_id = $1 ORDER BY id FOR UPDATE', [
    order_id,
  ]);
  return order;
}

/** The order of a unit, locked first (see lockOrderRows); null when the unit does not exist. */
export async function lockOrderOfUnit(db: SqlExecutor, unit_id: Id): Promise<Id | null> {
  const found = await db.query<{ order_id: string }>(
    'SELECT order_id FROM order_units WHERE id = $1',
    [unit_id],
  );
  const order_id = found.rows[0]?.order_id;
  if (order_id === undefined) return null;
  return (await lockOrderRows(db, order_id)) === null ? null : order_id;
}

/** One operation by its own request id: refund operations belong to one refund request each. */
export async function loadOperationByRequestId(
  db: SqlExecutor,
  request_id: string,
  opts: { lock?: boolean } = {},
): Promise<OperationRow | null> {
  const found = await db.query<Raw>(
    `SELECT * FROM operations WHERE request_id = $1${opts.lock === true ? ' FOR UPDATE' : ''}`,
    [request_id],
  );
  const row = found.rows[0];
  return row === undefined ? null : toOperation(row);
}

export async function loadOperation(
  db: SqlExecutor,
  order_id: Id,
  kind: OperationKind,
  opts: { lock?: boolean } = {},
): Promise<OperationRow | null> {
  const found = await db.query<Raw>(
    `SELECT * FROM operations WHERE order_id = $1 AND kind = $2 ORDER BY created_at, id LIMIT 1${
      opts.lock === true ? ' FOR UPDATE' : ''
    }`,
    [order_id, kind],
  );
  const row = found.rows[0];
  return row === undefined ? null : toOperation(row);
}
export async function loadProviderOrders(
  db: SqlExecutor,
  order_id: Id,
): Promise<ProviderOrderRow[]> {
  const found = await db.query<Raw>(
    'SELECT id, order_id, provider_order_id, approve_url FROM provider_orders WHERE order_id = $1 ORDER BY id',
    [order_id],
  );
  return found.rows.map((r) => ({
    id: r['id'] as string,
    order_id: r['order_id'] as string,
    provider_order_id: (r['provider_order_id'] as string | null) ?? null,
    approve_url: (r['approve_url'] as string | null) ?? null,
  }));
}

// Delay before the nth poll (1 based): the last configured value repeats.
export function backoffMs(
  config: Pick<DomainConfig, 'reconcile_backoff_ms'>,
  attempt: number,
): number {
  const list = config.reconcile_backoff_ms;
  const index = Math.min(Math.max(attempt, 1) - 1, list.length - 1);
  return list[index] ?? 30_000;
}

// The claim of each unit as stored by the capture call. `claimed_at` is the time the claim (or the
// last read that changed the unit while it was unverified) was stored: a read taken before it
// cannot be evidence of the claim. A verified unit keeps its capture id only (claimed_at null).
export function claimsOf(
  units: UnitRow[],
): { reference_id: Id; capture_id: string | null; status: null; claimed_at: string | null }[] {
  return units.map((u) => ({
    reference_id: u.reference_id,
    capture_id: u.capture_id,
    status: null,
    claimed_at: u.captured_verified_at === null && u.capture_id !== null ? u.updated_at : null,
  }));
}

// Capture ids held by units of other orders, among the ones the read shows. The match tests a read
// capture id against this list and nothing else, so only those ids are asked for (unique index).
export async function foreignCaptureIds(
  db: SqlExecutor,
  order_id: Id,
  shown: (string | null)[],
): Promise<string[]> {
  const ids = [...new Set(shown.filter((id): id is string => id !== null))];
  if (ids.length === 0) return [];
  const found = await db.query<{ capture_id: string }>(
    'SELECT capture_id FROM order_units WHERE capture_id = ANY($2::text[]) AND order_id <> $1 ORDER BY capture_id',
    [order_id, ids],
  );
  return found.rows.map((r) => r.capture_id);
}

/** A capture id may be held by one unit only (unique column): true when no other unit holds it. */
export async function canStoreCaptureId(
  db: SqlExecutor,
  unit_id: Id,
  capture_id: string,
): Promise<boolean> {
  const found = await db.query(
    'SELECT 1 FROM order_units WHERE capture_id = $1 AND id <> $2 LIMIT 1',
    [capture_id, unit_id],
  );
  return found.rows.length === 0;
}

/** Insert an operation row unless its request id exists. Returns true when this call inserted it. */
export async function insertOperation(
  tx: SqlExecutor,
  r: {
    id: Id;
    order_id: Id;
    kind: OperationKind;
    state: OperationState;
    request_id: string;
    lease_until: string | null;
    reconcile_until: string | null;
    next_retry_at: string | null;
    at: string;
  },
): Promise<boolean> {
  const done = await tx.query(
    `INSERT INTO operations (id, order_id, unit_id, kind, state, attempt, request_id, first_sent_at,
       idem_safe_until, lease_until, next_retry_at, reconcile_until, failure_reason, created_at, updated_at)
     VALUES ($1, $2, NULL, $3, $4, 1, $5, NULL, NULL, $6, $7, $8, NULL, $9, $9)
     ON CONFLICT (request_id) DO NOTHING RETURNING id`,
    [
      r.id,
      r.order_id,
      r.kind,
      r.state,
      r.request_id,
      r.lease_until,
      r.next_retry_at,
      r.reconcile_until,
      r.at,
    ],
  );
  return done.rows.length > 0;
}
