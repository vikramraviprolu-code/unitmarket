// Recovery cases (architecture 4.5, 9.7). A case opens from system evidence (alerts payments raised,
// delivery_failed access events) or from a buyer report, and resolves by restoring access, crediting
// lost time, closing as not charged, closing with no fault, or an operator's refund offer.
//
// Boundaries: payments and delivery never import this package; recovery only reads their rows and
// calls their public functions. A case never creates an order, an approval or a ledger entry, and
// never charges. Every action appends recovery_actions and audit_log.
import {
  computeWindow,
  grantCredit,
  MAX_CREDIT_MS,
  recordDeliveryEvent,
} from '@umsbx/access-clock';
import { AccessPolicySchema, IdSchema, err, ok } from '@umsbx/contracts';
import type {
  AccessEvent,
  AccessEventKind,
  AccessPolicy,
  Actor,
  CaseKind,
  CaseState,
  CaseView,
  ContentStore,
  CoreDeps,
  Id,
  Money,
  OrderStatus,
  Result,
  SqlExecutor,
  WindowState,
} from '@umsbx/contracts';
import { issueLink } from '@umsbx/delivery';
import {
  ACTION_STATE,
  ALERT_CASE_KINDS,
  BUYER_KINDS,
  RESOLVABLE_STATES,
  RESUME_KINDS,
  UNRESOLVED_STATES,
  VERIFIED_UNIT_STATUSES,
  slaDueAt,
} from './rules';
import type { ResolveAction } from './rules';
import {
  NOT_CHARGED_MESSAGE,
  REFUND_PENDING_MESSAGE,
  creditMessage,
  noFaultMessage,
  openedMessage,
  restoredMessage,
} from './messages';

export type CaseError = {
  code: 'not_found' | 'not_owner' | 'wrong_state' | 'not_operator' | 'duplicate_open';
};

/** Lane 05b's requestRefund, bound to its deps by the composition root. Absent: no refund path. */
export type RefundRequester = (i: {
  unit_id: Id;
  amount: Money | null;
  reason: string;
  actor: Actor;
}) => Promise<Result<{ refund_request_id: Id }, { code: string }>>;

/** resolve needs the content store (restore probes it) and, for offer_refund, the refund path. */
export type ResolveDeps = CoreDeps & { content: ContentStore; requestRefund?: RefundRequester };

type Opener = 'system' | 'buyer' | 'operator';
interface CaseRow {
  id: string;
  kind: CaseKind;
  state: CaseState;
  order_id: string | null;
  entitlement_id: string | null;
  buyer_id: string | null;
  opened_by: Opener;
  credit_ms: number;
  buyer_message: string;
  created_at: Date | string;
}

const CASE_COLUMNS =
  'id, kind, state, order_id, entitlement_id, buyer_id, opened_by, credit_ms, buyer_message, created_at';
const isId = (v: unknown): v is string => typeof v === 'string' && IdSchema.safeParse(v).success;
const toView = (r: CaseRow): CaseView => ({
  case_id: r.id,
  kind: r.kind,
  state: r.state,
  order_id: r.order_id,
  entitlement_id: r.entitlement_id,
  opened_by: r.opened_by,
  opened_at: new Date(r.created_at).toISOString(),
  buyer_message: r.buyer_message,
  credit_ms: r.credit_ms,
});

function actorLabel(a: Actor): string {
  switch (a.kind) {
    case 'buyer':
      return `buyer:${a.buyer_id}`;
    case 'publisher':
      return `publisher:${a.publisher_id}`;
    case 'operator':
      return `operator:${a.operator_id}`;
    case 'system':
      return 'system';
  }
}

type Detail = Record<string, string | number | boolean | null>;

async function addAction(
  tx: SqlExecutor,
  d: CoreDeps,
  i: { case_id: Id; action: string; actor: Actor; detail: Detail; reason?: string | null },
): Promise<void> {
  const at = d.clock.now().toISOString();
  await tx.query(
    `INSERT INTO recovery_actions (id, case_id, action, actor, detail, at, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $6, $6)`,
    [d.ids.next('cac'), i.case_id, i.action, actorLabel(i.actor), JSON.stringify(i.detail), at],
  );
  await d.audit.record(tx, {
    actor: i.actor,
    action: `recovery.${i.action}`,
    target: i.case_id,
    reason: i.reason ?? null,
    detail: i.detail,
  });
}

async function loadCase(tx: SqlExecutor, id: string, lock: boolean): Promise<CaseRow | null> {
  if (!isId(id)) return null;
  const r = await tx.query<CaseRow>(
    `SELECT ${CASE_COLUMNS} FROM recovery_cases WHERE id = $1${lock ? ' FOR UPDATE' : ''}`,
    [id],
  );
  return r.rows[0] ?? null;
}

/** Compare-and-set on the state; null when somebody else resolved the case first. */
async function moveCase(
  tx: SqlExecutor,
  d: CoreDeps,
  c: CaseRow,
  to: { state: CaseState; credit_ms?: number; message?: string },
): Promise<CaseView | null> {
  const r = await tx.query<CaseRow>(
    `UPDATE recovery_cases SET state = $2, credit_ms = $3, buyer_message = $4, updated_at = $5
      WHERE id = $1 AND state = $6 RETURNING ${CASE_COLUMNS}`,
    [
      c.id,
      to.state,
      to.credit_ms ?? c.credit_ms,
      to.message ?? c.buyer_message,
      d.clock.now().toISOString(),
      c.state,
    ],
  );
  const row = r.rows[0];
  return row === undefined ? null : toView(row);
}

// ---------------------------------------------------------------------------------------------
// Opening
// ---------------------------------------------------------------------------------------------
interface OpenInput {
  kind: CaseKind;
  order_id?: Id;
  entitlement_id?: Id;
  opened_by: Opener;
  actor: Actor;
  note?: string;
}

/** The unresolved case for the same kind and item, if any. An entitlement case keys on the entitlement. */
async function findUnresolved(
  tx: SqlExecutor,
  i: { kind: CaseKind; order_id: string | null; entitlement_id: string | null },
): Promise<CaseRow | null> {
  const r =
    i.entitlement_id !== null
      ? await tx.query<CaseRow>(
          `SELECT ${CASE_COLUMNS} FROM recovery_cases WHERE kind = $1 AND entitlement_id = $2 AND state = ANY($3::text[]) ORDER BY created_at, id LIMIT 1`,
          [i.kind, i.entitlement_id, [...UNRESOLVED_STATES]],
        )
      : await tx.query<CaseRow>(
          `SELECT ${CASE_COLUMNS} FROM recovery_cases WHERE kind = $1 AND order_id = $2 AND entitlement_id IS NULL AND state = ANY($3::text[]) ORDER BY created_at, id LIMIT 1`,
          [i.kind, i.order_id, [...UNRESOLVED_STATES]],
        );
  return r.rows[0] ?? null;
}

interface Target {
  order_id: string;
  entitlement_id: string | null;
  buyer_id: string;
}

/** Finds the order or item and locks its row, so two openers of one item run one after the other. */
async function lockTarget(
  tx: SqlExecutor,
  i: { order_id?: Id; entitlement_id?: Id },
): Promise<Target | null> {
  if (i.entitlement_id !== undefined) {
    if (!isId(i.entitlement_id)) return null;
    const r = await tx.query<{ id: string; buyer_id: string; order_id: string }>(
      `SELECT e.id, e.buyer_id, u.order_id FROM entitlements e JOIN order_units u ON u.id = e.unit_id
        WHERE e.id = $1 FOR UPDATE OF e`,
      [i.entitlement_id],
    );
    const row = r.rows[0];
    if (row === undefined) return null;
    if (i.order_id !== undefined && i.order_id !== row.order_id) return null;
    return { order_id: row.order_id, entitlement_id: row.id, buyer_id: row.buyer_id };
  }
  if (i.order_id === undefined || !isId(i.order_id)) return null;
  const r = await tx.query<{ id: string; buyer_id: string }>(
    'SELECT id, buyer_id FROM orders WHERE id = $1 FOR UPDATE',
    [i.order_id],
  );
  const row = r.rows[0];
  return row === undefined
    ? null
    : { order_id: row.id, entitlement_id: null, buyer_id: row.buyer_id };
}

/** Who may open: the actor must be the kind that `opened_by` names. */
function checkOpener(i: OpenInput): CaseError | null {
  switch (i.opened_by) {
    case 'buyer':
      if (i.actor.kind !== 'buyer') return { code: 'not_owner' };
      return BUYER_KINDS.includes(i.kind) ? null : { code: 'not_operator' };
    case 'system':
      return i.actor.kind === 'system' ? null : { code: 'not_operator' };
    case 'operator':
      return i.actor.kind === 'operator' ? null : { code: 'not_operator' };
  }
}

/**
 * Opens a case inside the caller's transaction. `extra` goes into the opened action (the alert or
 * access event the case came from). Another buyer's item answers not_found, as an unknown id does.
 */
async function openIn(
  tx: SqlExecutor,
  d: CoreDeps,
  i: OpenInput,
  extra: Detail,
): Promise<Result<CaseView, CaseError>> {
  const bad = checkOpener(i);
  if (bad !== null) return err(bad);
  const target = await lockTarget(tx, i);
  if (target === null) return err({ code: 'not_found' });
  if (i.actor.kind === 'buyer' && i.actor.buyer_id !== target.buyer_id) {
    return err({ code: 'not_found' });
  }
  const dup = await findUnresolved(tx, { kind: i.kind, ...target });
  if (dup !== null) return err({ code: 'duplicate_open' });
  const now = d.clock.now();
  const stamp = now.toISOString();
  const id = d.ids.next('cas');
  const message = openedMessage(i.kind, i.opened_by);
  await tx.query(
    `INSERT INTO recovery_cases (id, kind, state, order_id, entitlement_id, buyer_id, opened_by, sla_due_at, credit_ms, buyer_message, created_at, updated_at)
     VALUES ($1, $2, 'open', $3, $4, $5, $6, $7, 0, $8, $9, $9)`,
    [
      id,
      i.kind,
      target.order_id,
      target.entitlement_id,
      target.buyer_id,
      i.opened_by,
      slaDueAt(i.kind, now),
      message,
      stamp,
    ],
  );
  await addAction(tx, d, {
    case_id: id,
    action: 'opened',
    actor: i.actor,
    detail: { kind: i.kind, ...(i.note !== undefined ? { note: i.note } : {}), ...extra },
  });
  return ok({
    case_id: id,
    kind: i.kind,
    state: 'open',
    order_id: target.order_id,
    entitlement_id: target.entitlement_id,
    opened_by: i.opened_by,
    opened_at: stamp,
    buyer_message: message,
    credit_ms: 0,
  });
}

/** One open case per (kind, order or entitlement). */
export function openCase(d: CoreDeps, i: OpenInput): Promise<Result<CaseView, CaseError>> {
  return d.db.transaction((tx) => openIn(tx, d, i, {}));
}

// ---------------------------------------------------------------------------------------------
// Reading evidence
// ---------------------------------------------------------------------------------------------
interface EventRow {
  id: string;
  kind: AccessEventKind;
  at: Date | string;
  source: AccessEvent['source'];
  evidence: AccessEvent['evidence'];
}
interface Evidence {
  rows: EventRow[];
  events: AccessEvent[];
}

async function loadEvidence(tx: SqlExecutor, entitlement_id: string): Promise<Evidence> {
  const r = await tx.query<EventRow>(
    'SELECT id, kind, at, source, evidence FROM access_events WHERE entitlement_id = $1 ORDER BY at, seq',
    [entitlement_id],
  );
  return {
    rows: r.rows,
    events: r.rows.map((e) => ({
      entitlement_id,
      kind: e.kind,
      at: new Date(e.at).toISOString(),
      source: e.source,
      evidence: e.evidence,
    })),
  };
}

async function policyOf(tx: SqlExecutor, entitlement_id: string): Promise<AccessPolicy | null> {
  const r = await tx.query<{ policy: unknown }>('SELECT policy FROM entitlements WHERE id = $1', [
    entitlement_id,
  ]);
  const row = r.rows[0];
  return row === undefined ? null : AccessPolicySchema.parse(row.policy);
}

export async function diagnose(
  d: CoreDeps,
  i: { case_id: Id },
): Promise<{
  evidence: AccessEvent[];
  window: WindowState | null;
  order_status: OrderStatus | null;
}> {
  return d.db.transaction(async (tx) => {
    const c = await loadCase(tx, i.case_id, true);
    if (c === null) return { evidence: [], window: null, order_status: null };
    let evidence: AccessEvent[] = [];
    let window: WindowState | null = null;
    if (c.entitlement_id !== null) {
      evidence = (await loadEvidence(tx, c.entitlement_id)).events;
      const policy = await policyOf(tx, c.entitlement_id);
      if (policy !== null) window = computeWindow(evidence, policy, d.clock.now());
    }
    let order_status: OrderStatus | null = null;
    if (c.order_id !== null) {
      const o = await tx.query<{ status: OrderStatus }>('SELECT status FROM orders WHERE id = $1', [
        c.order_id,
      ]);
      order_status = o.rows[0]?.status ?? null;
    }
    if (c.state === 'open') {
      const moved = await moveCase(tx, d, c, { state: 'diagnosing' });
      if (moved !== null) {
        await addAction(tx, d, {
          case_id: c.id,
          action: 'diagnosed',
          actor: { kind: 'system' },
          detail: { events: evidence.length, order_status },
        });
      }
    }
    return { evidence, window, order_status };
  });
}

// ---------------------------------------------------------------------------------------------
// Resolving
// ---------------------------------------------------------------------------------------------
const WRONG: Result<never, CaseError> = err({ code: 'wrong_state' });

async function verifiedUnits(tx: SqlExecutor, c: CaseRow): Promise<string[]> {
  if (c.entitlement_id !== null) {
    const r = await tx.query<{ id: string; status: string }>(
      `SELECT u.id, u.status FROM entitlements e JOIN order_units u ON u.id = e.unit_id WHERE e.id = $1`,
      [c.entitlement_id],
    );
    return r.rows.filter((u) => VERIFIED_UNIT_STATUSES.includes(u.status)).map((u) => u.id);
  }
  if (c.order_id === null) return [];
  const r = await tx.query<{ id: string; status: string }>(
    'SELECT id, status FROM order_units WHERE order_id = $1 ORDER BY id',
    [c.order_id],
  );
  return r.rows.filter((u) => VERIFIED_UNIT_STATUSES.includes(u.status)).map((u) => u.id);
}

/**
 * Applies one resolution. Buyers and publishers never resolve (not_operator, even for an unknown
 * case id, so the answer reveals nothing). A rule (`system`) may only restore.
 */
export async function resolve(
  d: ResolveDeps,
  i: {
    case_id: Id;
    action: ResolveAction;
    credit_ms?: number;
    by: Actor;
    reason: string;
  },
): Promise<Result<CaseView, CaseError>> {
  const allowed = i.by.kind === 'operator' || (i.by.kind === 'system' && i.action === 'restore');
  if (!allowed) return err({ code: 'not_operator' });
  const first = await d.db.transaction((tx) => loadCase(tx, i.case_id, false));
  if (first === null) return err({ code: 'not_found' });
  if (!RESOLVABLE_STATES.includes(first.state)) return WRONG;

  switch (i.action) {
    case 'restore':
      return restoreCase(d, first, i.by, i.reason);
    case 'credit':
      return creditCase(d, first, i.by, i.reason, i.credit_ms);
    case 'close_not_charged':
      return d.db.transaction(async (tx) => {
        const c = await loadCase(tx, first.id, true);
        if (c === null || !RESOLVABLE_STATES.includes(c.state)) return WRONG;
        if (c.order_id === null) return WRONG;
        // Not charged is only true when no unit of the order holds a verified capture.
        const units = await tx.query<{ status: string }>(
          'SELECT status FROM order_units WHERE order_id = $1',
          [c.order_id],
        );
        if (units.rows.some((u) => VERIFIED_UNIT_STATUSES.includes(u.status))) return WRONG;
        return finish(
          tx,
          d,
          c,
          i,
          { state: ACTION_STATE.close_not_charged, message: NOT_CHARGED_MESSAGE },
          {},
        );
      });
    case 'close_no_fault':
      if (i.reason.trim() === '') return WRONG;
      return d.db.transaction(async (tx) => {
        const c = await loadCase(tx, first.id, true);
        if (c === null || !RESOLVABLE_STATES.includes(c.state)) return WRONG;
        return finish(
          tx,
          d,
          c,
          i,
          { state: ACTION_STATE.close_no_fault, message: noFaultMessage(i.reason) },
          {},
        );
      });
    case 'offer_refund':
      return offerRefund(d, first, i.by, i.reason);
  }
}

async function finish(
  tx: SqlExecutor,
  d: CoreDeps,
  c: CaseRow,
  i: { action: ResolveAction; by: Actor; reason: string; label?: string },
  to: { state: CaseState; message: string; credit_ms?: number },
  detail: Detail,
): Promise<Result<CaseView, CaseError>> {
  const moved = await moveCase(tx, d, c, {
    state: to.state,
    message: to.message,
    ...(to.credit_ms !== undefined ? { credit_ms: to.credit_ms } : {}),
  });
  if (moved === null) return WRONG;
  await addAction(tx, d, {
    case_id: c.id,
    action: i.label ?? i.action,
    actor: i.by,
    detail,
    reason: i.reason,
  });
  return ok(moved);
}

/**
 * Restore: a fresh link (free; never an order, approval or ledger row), then delivery_restored. The
 * access clock credits the measured pause; the case reports it. The link and the event are written
 * by delivery and the clock, so this runs before the case update, not inside one transaction.
 */
async function restoreCase(
  d: ResolveDeps,
  c: CaseRow,
  by: Actor,
  reason: string,
): Promise<Result<CaseView, CaseError>> {
  if (c.entitlement_id === null || c.buyer_id === null) return WRONG;
  const entitlement_id = c.entitlement_id;
  const policy = await policyOf(d.db, entitlement_id);
  if (policy === null) return WRONG;
  const before = computeWindow(
    (await loadEvidence(d.db, entitlement_id)).events,
    policy,
    d.clock.now(),
  );
  // The link is issued for the owning buyer; the operator never sees it.
  const issued = await issueLink(d, {
    entitlement_id,
    actor: { kind: 'buyer', buyer_id: c.buyer_id },
  });
  if (!issued.ok) return WRONG;
  const after = await recordDeliveryEvent(d, {
    entitlement_id,
    kind: 'delivery_restored',
    link_id: issued.value.link_id,
    source: 'system',
    evidence: { case_id: c.id, probe: 'ok' },
  });
  const credit = Math.max(0, after.credit_ms - before.credit_ms);
  return d.db.transaction(async (tx) => {
    const locked = await loadCase(tx, c.id, true);
    if (locked === null || !RESOLVABLE_STATES.includes(locked.state)) return WRONG;
    return finish(
      tx,
      d,
      locked,
      { action: 'restore', by, reason },
      {
        state: ACTION_STATE.restore,
        message: restoredMessage(credit),
        credit_ms: locked.credit_ms + credit,
      },
      { credit_ms: credit, link_id: issued.value.link_id },
    );
  });
}

async function creditCase(
  d: CoreDeps,
  c: CaseRow,
  by: Actor,
  reason: string,
  credit_ms: number | undefined,
): Promise<Result<CaseView, CaseError>> {
  if (c.entitlement_id === null) return WRONG;
  const entitlement_id = c.entitlement_id;
  if (credit_ms === undefined || !Number.isSafeInteger(credit_ms) || credit_ms <= 0) return WRONG;
  return d.db.transaction(async (tx) => {
    const locked = await loadCase(tx, c.id, true);
    if (locked === null || !RESOLVABLE_STATES.includes(locked.state)) return WRONG;
    if (locked.credit_ms + credit_ms > MAX_CREDIT_MS) return WRONG;
    const policy = await policyOf(tx, entitlement_id);
    if (policy === null) return WRONG;
    // Only a live window takes credit (running or paused); an ended or revoked one takes none.
    const window = computeWindow(
      (await loadEvidence(tx, entitlement_id)).events,
      policy,
      d.clock.now(),
    );
    if (window.state !== 'running' && window.state !== 'paused') return WRONG;
    const granted = await grantCredit(tx, d, {
      entitlement_id,
      credit_ms,
      case_id: c.id,
      by,
    });
    if (!granted.ok) return WRONG;
    return finish(
      tx,
      d,
      locked,
      { action: 'credit', by, reason },
      {
        state: ACTION_STATE.credit,
        message: creditMessage(credit_ms),
        credit_ms: locked.credit_ms + credit_ms,
      },
      { credit_ms },
    );
  });
}

/** Offer a refund through lane 05b's requestRefund (operator only). The read-back closes it later. */
async function offerRefund(
  d: ResolveDeps,
  c: CaseRow,
  by: Actor,
  reason: string,
): Promise<Result<CaseView, CaseError>> {
  if (d.requestRefund === undefined) return WRONG;
  const units = await verifiedUnits(d.db, c);
  if (units.length === 0) return WRONG;
  const requested: string[] = [];
  for (const unit_id of units) {
    const r = await d.requestRefund({ unit_id, amount: null, reason, actor: by });
    if (!r.ok) return WRONG;
    requested.push(r.value.refund_request_id);
  }
  return d.db.transaction(async (tx) => {
    const locked = await loadCase(tx, c.id, true);
    if (locked === null || !RESOLVABLE_STATES.includes(locked.state)) return WRONG;
    return finish(
      tx,
      d,
      locked,
      { action: 'offer_refund', by, reason },
      { state: ACTION_STATE.offer_refund, message: REFUND_PENDING_MESSAGE },
      { refund_request_ids: requested.join(',') },
    );
  });
}

// ---------------------------------------------------------------------------------------------
// Automatic rules (run by the job loop)
// ---------------------------------------------------------------------------------------------
const SYSTEM: Actor = { kind: 'system' };

/** Opens the case for a piece of evidence, or links the evidence to the case already open. */
async function openOrLink(
  d: CoreDeps,
  i: { kind: CaseKind; order_id?: Id; entitlement_id?: Id },
  marker: { key: 'alert_id' | 'event_id'; id: string },
): Promise<boolean> {
  return d.db.transaction(async (tx) => {
    const target = await lockTarget(tx, i);
    if (target === null) return false;
    const existing = await findUnresolved(tx, { kind: i.kind, ...target });
    const detail: Detail = { [marker.key]: marker.id };
    if (existing !== null) {
      await addAction(tx, d, {
        case_id: existing.id,
        action: marker.key === 'alert_id' ? 'alert_linked' : 'event_linked',
        actor: SYSTEM,
        detail,
      });
      return false;
    }
    const r = await openIn(tx, d, { ...i, opened_by: 'system', actor: SYSTEM }, detail);
    return r.ok;
  });
}

/** Closes a delivery case once the clock has resumed; the credit is what the clock measured. */
async function autoRestore(d: CoreDeps, c: CaseRow): Promise<boolean> {
  if (c.entitlement_id === null) return false;
  const entitlement_id = c.entitlement_id;
  return d.db.transaction(async (tx) => {
    const locked = await loadCase(tx, c.id, true);
    if (locked === null || !RESOLVABLE_STATES.includes(locked.state)) return false;
    const linked = await tx.query<{ event_id: string }>(
      `SELECT detail ->> 'event_id' AS event_id FROM recovery_actions
        WHERE case_id = $1 AND detail ->> 'event_id' IS NOT NULL`,
      [c.id],
    );
    const ids = new Set(linked.rows.map((r) => r.event_id));
    const policy = await policyOf(tx, entitlement_id);
    if (ids.size === 0 || policy === null) return false;
    const { rows, events } = await loadEvidence(tx, entitlement_id);
    let f = -1;
    rows.forEach((r, idx) => {
      if (ids.has(r.id)) f = idx;
    });
    if (f < 0) return false;
    const r = events.findIndex(
      (e, idx) => idx > f && e.source !== 'buyer' && RESUME_KINDS.has(e.kind),
    );
    const failedAt = events[f];
    const resumedAt = events[r];
    if (r < 0 || failedAt === undefined || resumedAt === undefined) return false;
    const paused = computeWindow(events.slice(0, f), policy, new Date(failedAt.at));
    const resumed = computeWindow(events.slice(0, r + 1), policy, new Date(resumedAt.at));
    const credit = Math.max(0, resumed.credit_ms - paused.credit_ms);
    const done = await finish(
      tx,
      d,
      locked,
      { action: 'restore', by: SYSTEM, reason: 'delivery restored', label: 'auto_restored' },
      {
        state: ACTION_STATE.restore,
        message: restoredMessage(credit),
        credit_ms: locked.credit_ms + credit,
      },
      { credit_ms: credit, resumed_by: resumedAt.kind },
    );
    return done.ok;
  });
}

/**
 * Opens one case per new alert (frozen_order, payment_unresolved, partial_composite, reversal) and per
 * delivery_failed event, then closes the delivery cases whose clock has resumed. Each run handles
 * at most `max_items` pieces of evidence and never handles one twice.
 */
export async function applyAutomaticRules(
  d: CoreDeps,
  i: { max_items: number },
): Promise<{ opened: number; restored: number }> {
  let budget = Math.max(0, Math.floor(i.max_items));
  let opened = 0;
  let restored = 0;

  const alerts = await d.db.query<{ id: string; kind: CaseKind; order_id: string }>(
    `SELECT a.id, a.kind, a.order_id FROM alerts a
      WHERE a.kind = ANY($1::text[]) AND a.order_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM recovery_actions ra WHERE ra.detail ->> 'alert_id' = a.id)
      ORDER BY a.created_at, a.id LIMIT $2`,
    [[...ALERT_CASE_KINDS], budget],
  );
  for (const a of alerts.rows) {
    if (budget <= 0) break;
    budget -= 1;
    if (
      await openOrLink(d, { kind: a.kind, order_id: a.order_id }, { key: 'alert_id', id: a.id })
    ) {
      opened += 1;
    }
  }

  if (budget > 0) {
    const failures = await d.db.query<{ id: string; entitlement_id: string }>(
      `SELECT ev.id, ev.entitlement_id FROM access_events ev
        WHERE ev.kind = 'delivery_failed' AND ev.source = 'system'
          AND NOT EXISTS (SELECT 1 FROM recovery_actions ra WHERE ra.detail ->> 'event_id' = ev.id)
        ORDER BY ev.at, ev.id LIMIT $1`,
      [budget],
    );
    for (const f of failures.rows) {
      budget -= 1;
      if (
        await openOrLink(
          d,
          { kind: 'delivery_failed', entitlement_id: f.entitlement_id },
          { key: 'event_id', id: f.id },
        )
      ) {
        opened += 1;
      }
    }
  }

  if (budget > 0) {
    const candidates = await d.db.query<CaseRow>(
      `SELECT ${CASE_COLUMNS} FROM recovery_cases c
        WHERE c.kind = 'delivery_failed' AND c.state = ANY($1::text[]) AND c.entitlement_id IS NOT NULL
          AND EXISTS (SELECT 1 FROM recovery_actions ra WHERE ra.case_id = c.id AND ra.detail ->> 'event_id' IS NOT NULL)
        ORDER BY c.created_at, c.id LIMIT $2`,
      [[...RESOLVABLE_STATES], budget],
    );
    for (const c of candidates.rows) {
      if (budget <= 0) break;
      budget -= 1;
      if (await autoRestore(d, c)) restored += 1;
    }
  }
  return { opened, restored };
}

export async function listCasesForBuyer(db: SqlExecutor, i: { buyer_id: Id }): Promise<CaseView[]> {
  if (!isId(i.buyer_id)) return [];
  const r = await db.query<CaseRow>(
    `SELECT ${CASE_COLUMNS} FROM recovery_cases WHERE buyer_id = $1 ORDER BY created_at DESC, id`,
    [i.buyer_id],
  );
  return r.rows.map(toView);
}
