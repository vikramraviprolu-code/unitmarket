// Writing the access_events log and keeping the materialised access_windows row, and the access
// state of the entitlement, equal to computeWindow of the log. Everything here runs inside the
// caller's transaction (or opens one for recordDeliveryEvent) and reads time from d.clock only.
import { AccessPolicySchema } from '@umsbx/contracts';
import type {
  AccessEvent,
  AccessEventKind,
  AccessPolicy,
  CoreDeps,
  Id,
  MoneyState,
  AccessState,
  SqlExecutor,
  WindowState,
} from '@umsbx/contracts';
import { computeWindow, deriveAccessState } from './compute';

export interface EntitlementHead {
  id: string;
  money: MoneyState;
  access: AccessState;
  policy: AccessPolicy;
}

/**
 * Locks the entitlement row for the rest of the transaction. Null when it does not exist, or, with
 * skipLocked, when another transaction holds it.
 */
export async function lockEntitlement(
  tx: SqlExecutor,
  id: Id,
  o: { skipLocked?: boolean } = {},
): Promise<EntitlementHead | null> {
  const found = await tx.query<{
    id: string;
    money_state: MoneyState;
    access_state: AccessState;
    policy: unknown;
  }>(
    `SELECT id, money_state, access_state, policy FROM entitlements WHERE id = $1 FOR UPDATE${o.skipLocked === true ? ' SKIP LOCKED' : ''}`,
    [id],
  );
  const r = found.rows[0];
  if (r === undefined) return null;
  return {
    id: r.id,
    money: r.money_state,
    access: r.access_state,
    policy: AccessPolicySchema.parse(r.policy),
  };
}

export async function loadEvents(tx: SqlExecutor, id: Id): Promise<AccessEvent[]> {
  // Insertion order (the identity column seq) breaks ties between events at the same instant.
  const rows = await tx.query<{
    kind: AccessEventKind;
    at: Date | string;
    source: AccessEvent['source'];
    evidence: AccessEvent['evidence'];
  }>(
    'SELECT kind, at, source, evidence FROM access_events WHERE entitlement_id = $1 ORDER BY at, seq',
    [id],
  );
  return rows.rows.map((r) => ({
    entitlement_id: id,
    kind: r.kind,
    at: new Date(r.at).toISOString(),
    source: r.source,
    evidence: r.evidence,
  }));
}

/**
 * Appends one event. False when the link_issued-once-per-link index already holds it.
 * Event time is monotonic per entitlement (CO-5b, ASM-62): without an explicit `at` the event is
 * stamped max(now, the latest `at` already in the log), so a clock that steps back can never put a
 * new fact before an earlier one (computeWindow sorts by `at`; a delivery_restored slipped in before
 * a revoke used to earn credit on a revoked window). An explicit `at` is the caller's decision (the
 * sweep stamps window_ended at ends_at) and is stored as given.
 */
export async function insertEvent(
  tx: SqlExecutor,
  d: CoreDeps,
  i: {
    entitlement_id: Id;
    kind: AccessEventKind;
    link_id: Id | null;
    source: AccessEvent['source'];
    evidence: AccessEvent['evidence'];
    at?: Date;
  },
): Promise<boolean> {
  const now = d.clock.now();
  const stamp = now.toISOString();
  let when = i.at;
  if (when === undefined) {
    const last = await tx.query<{ last: Date | string | null }>(
      'SELECT max(at) AS last FROM access_events WHERE entitlement_id = $1',
      [i.entitlement_id],
    );
    const latest = last.rows[0]?.last;
    when = latest != null && new Date(latest).getTime() > now.getTime() ? new Date(latest) : now;
  }
  const inserted = await tx.query(
    `INSERT INTO access_events (id, entitlement_id, link_id, kind, at, source, evidence, environment, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $9)
     ON CONFLICT DO NOTHING RETURNING id`,
    [
      d.ids.next('aev'),
      i.entitlement_id,
      i.link_id,
      i.kind,
      when.toISOString(),
      i.source,
      JSON.stringify(i.evidence),
      d.environment,
      stamp,
    ],
  );
  return inserted.rows.length === 1;
}

/** Recomputes the window from the log, writes the access_windows row and moves the access state. */
export async function materialise(
  tx: SqlExecutor,
  d: CoreDeps,
  head: EntitlementHead,
): Promise<WindowState> {
  const now = d.clock.now();
  const stamp = now.toISOString();
  const window = computeWindow(await loadEvents(tx, head.id), head.policy, now);
  await tx.query(
    `INSERT INTO access_windows (entitlement_id, state, started_at, base_ends_at, ends_at, paused_at, credit_ms, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)
     ON CONFLICT (entitlement_id) DO UPDATE SET state = EXCLUDED.state, started_at = EXCLUDED.started_at,
       base_ends_at = EXCLUDED.base_ends_at, ends_at = EXCLUDED.ends_at, paused_at = EXCLUDED.paused_at,
       credit_ms = EXCLUDED.credit_ms, updated_at = EXCLUDED.updated_at`,
    [
      head.id,
      window.state,
      window.started_at,
      window.base_ends_at,
      window.ends_at,
      window.paused_at,
      window.credit_ms,
      stamp,
    ],
  );
  const access = deriveAccessState(head.money, window);
  if (access !== head.access) {
    await tx.query(
      `UPDATE entitlements SET access_state = $2, updated_at = $3, transition_log = transition_log || $4::jsonb WHERE id = $1`,
      [
        head.id,
        access,
        stamp,
        JSON.stringify([{ record: 'access', from: head.access, to: access, at: stamp }]),
      ],
    );
  }
  return window;
}

export class UnknownEntitlementError extends Error {
  constructor(id: string) {
    super(`unknown entitlement ${id}`);
    this.name = 'UnknownEntitlementError';
  }
}

export async function requireEntitlement(tx: SqlExecutor, id: Id): Promise<EntitlementHead> {
  const head = await lockEntitlement(tx, id);
  if (head === null) throw new UnknownEntitlementError(id);
  return head;
}

type DeliveryKind = Exclude<
  AccessEventKind,
  'access_ready' | 'credit_granted' | 'window_ended' | 'revoked'
>;

/**
 * Records a delivery fact (link issued, download, render, failure, restoration, beacon) and
 * re-materialises the window. A buyer-sourced event is stored but never moves the window.
 * `inserted` is false when the event was a replay of link_issued for the same link.
 */
export async function recordDeliveryEvent(
  d: CoreDeps,
  i: {
    entitlement_id: Id;
    kind: DeliveryKind;
    link_id: Id | null;
    source: 'system' | 'buyer';
    evidence: AccessEvent['evidence'];
  },
): Promise<WindowState & { inserted: boolean }> {
  return d.db.transaction(async (tx) => {
    const head = await requireEntitlement(tx, i.entitlement_id);
    const before = computeWindow(await loadEvents(tx, head.id), head.policy, d.clock.now());
    const inserted = await insertEvent(tx, d, {
      entitlement_id: i.entitlement_id,
      kind: i.kind,
      link_id: i.link_id,
      source: i.source,
      evidence: i.evidence,
    });
    // A revoked window is final: the fact is kept as evidence, the window row is not rewritten.
    if (before.state === 'revoked') return { ...before, inserted };
    return { ...(await materialise(tx, d, head)), inserted };
  });
}

/**
 * Starts the clock: payment verified (money captured) and delivery verified possible. Calling it
 * again never restarts the window.
 */
export async function markAccessReady(
  tx: SqlExecutor,
  d: CoreDeps,
  i: {
    entitlement_id: Id;
    evidence: { capture_id: string; content_sha256: string; link_probe: 'ok' };
  },
): Promise<WindowState> {
  const head = await requireEntitlement(tx, i.entitlement_id);
  if (head.money !== 'captured') {
    throw new Error(
      `money_not_captured: access_ready refused, money is ${head.money}, not captured`,
    );
  }
  const current = computeWindow(await loadEvents(tx, head.id), head.policy, d.clock.now());
  if (current.state === 'not_started') {
    await insertEvent(tx, d, {
      entitlement_id: head.id,
      kind: 'access_ready',
      link_id: null,
      source: 'system',
      evidence: { ...i.evidence },
    });
  }
  return materialise(tx, d, head);
}

/** Ends access into history on refund or reversal. Idempotent. */
export async function revokeWindow(
  tx: SqlExecutor,
  d: CoreDeps,
  i: { entitlement_id: Id; reason: 'refund' | 'reversal' },
): Promise<WindowState> {
  const head = await requireEntitlement(tx, i.entitlement_id);
  const current = computeWindow(await loadEvents(tx, head.id), head.policy, d.clock.now());
  if (current.state !== 'revoked') {
    await insertEvent(tx, d, {
      entitlement_id: head.id,
      kind: 'revoked',
      link_id: null,
      source: 'system',
      evidence: { reason: i.reason },
    });
  }
  return materialise(tx, d, head);
}
